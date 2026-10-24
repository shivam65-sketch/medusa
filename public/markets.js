// MEDUSA Markets: the live scanner, downloaded only when the page is opened (app.js).
//
// Two layers meet here (a Lambda-style design):
//   batch  each coin's normal and the evidence, from the market data lakehouse's daily copy
//          (GET /api/market/scanner: market_baseline and market_evidence; ADR-024, ADR-025)
//   live   prices straight from Binance to this browser: one stream with every coin that changed,
//          about once a second. MEDUSA's server never sees them.
// The rule is the lakehouse's own (lakehouse/dbt/models/gold/intraday_events.sql), so the evidence
// describes exactly the moves flagged here:
//   move today = price now / yesterday's close - 1
//   z          = (move today - the coin's average daily return) / the spread of its daily returns,
//                over its last 30 days with trades (scored from 20 of them)
//   unusual    = |z| >= 3; size bands 3-4, 4-6, 6+; liquidity by average daily volume in USDT
// Live numbers are unchecked: the next day's batch run replaces them with checked ones.

const RULE = { z: 3, bands: [4, 6], large: 1e8, mid: 1e7, minDays: 20 };
const STREAM = 'wss://fstream.binance.com/market/ws/!miniTicker@arr';
const REST = 'https://fapi.binance.com/fapi/v1';
const DAY = 86_400_000;
const HORIZONS = [1, 4, 24];

/* ---------- the rule (no page code: testable on its own) ---------- */

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const zBand = (z) => (Math.abs(z) < RULE.bands[0] ? '3-4' : Math.abs(z) < RULE.bands[1] ? '4-6' : '6+');
export const liquidity = (usdtPerDay) => (usdtPerDay >= RULE.large ? 'large' : usdtPerDay >= RULE.mid ? 'mid' : 'small');
export const evKey = (direction, band, liq, hours) => `${direction}|${band}|${liq}|${hours}`;

/** A coin's move today and its z, or null without a price and a reference close. z is null when the
 * coin has too little history to have a normal. */
export function score(b, price, close) {
  if (!(price > 0) || !(close > 0)) return null;
  const move = price / close - 1;
  const z = b.history_days >= RULE.minDays && b.sd_return_30d > 0 ? (move - (b.avg_return_30d || 0)) / b.sd_return_30d : null;
  return { move, z, unusual: z != null && Math.abs(z) >= RULE.z };
}

/** The evidence rows (1, 4 and 24 hours) for a scored move. */
export function evidenceFor(ev, z, liq) {
  const dir = z > 0 ? 'up' : 'down', band = zBand(z);
  return HORIZONS.map((h) => ev.get(evKey(dir, band, liq, h)) || null);
}

/* ---------- state ---------- */

let api = null, host = null;
const S = {
  data: null, loadErr: null, loading: null,          // the lakehouse's copy: {published, base, ev, at}
  live: new Map(), snapAt: 0,                        // symbol -> {price, q (USDT traded in the last 24 h), t}
  ref: null, refBusy: null, refDone: 0, refTotal: 0, // yesterday's closes: {day, close: Map, src}
  ws: null, wsState: 'off', everOpen: false, fails: 0, lastMsg: 0, retry: 0, tick: 0, stopped: true,
  seen: new Map(),                                   // symbol -> when this page first saw it unusual
  sort: 'z', q: '', limit: 50, open: null,
  painted: 0, paintTimer: 0, html: new Map(),
};

/* ---------- formatting ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = (x) => (x > 0 ? '+' : x < 0 ? '−' : '');
const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '–' : `${sign(x)}${Math.abs(x * 100).toFixed(d)}%`);
const size = (x) => (x == null || !Number.isFinite(x) ? '–' : `${Math.abs(x * 100).toFixed(2)}%`);   // no sign: a spread or a cost
const sig = (z) => (z == null || !Number.isFinite(z) ? '–' : `${sign(z)}${Math.abs(z).toFixed(1)}σ`);
const tone = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
function price(p) {
  if (!(p > 0)) return '–';
  if (p >= 1) return p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 2 : 4 });
  return p.toFixed(Math.min(8, 3 - Math.floor(Math.log10(p))));
}
const shortDay = (ymd) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '–');
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const coin = (sym) => esc(sym.replace(/USDT$/, ''));
const volx = (x) => (x == null ? '–' : `×${x >= 10 ? x.toFixed(0) : x.toFixed(1)}`);
const LIQ = { large: 'Large', mid: 'Mid', small: 'Small' };
const LIQ_WORDS = { large: 'large', mid: 'mid-sized', small: 'small' };

/* ---------- the page ---------- */

const CSS = `
.mkt-status { flex-direction: column; gap: 4px; }
.mkt-status .row { display: flex; flex-wrap: wrap; gap: 4px 18px; align-items: center; }
.mkt-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); margin-right: 7px; vertical-align: 1px; }
.mkt-dot.live { background: var(--green); box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18); }
.mkt-dot.warn { background: #eab308; }
.mkt-dot.off { background: var(--red); }
.kpis.mkt-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.mkt-kpis .kpi, .mkt-kpis .kpi:nth-child(n+4) { grid-column: auto; }   /* not the journal's five-card layout */
@media (max-width: 900px) { .kpis.mkt-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
table.mkt-table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
.mkt-table th { text-align: right; font-weight: 600; color: var(--text-2); font-size: 13px; padding: 10px 12px; border-bottom: 1px solid var(--border-2); white-space: nowrap; }
.mkt-table td { text-align: right; padding: 10px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; font-variant-numeric: tabular-nums; }
.mkt-table th:first-child, .mkt-table td:first-child, .mkt-table .l { text-align: left; }
.mkt-table tr:last-child td { border-bottom: 0; }
.mkt-table tr[data-mkt="row"] { cursor: pointer; }
.mkt-table tr[data-mkt="row"]:hover td { background: #2b2b2b; }
.mkt-table td.sym { font-weight: 700; }
.mkt-ev { font-weight: 600; color: var(--green); }
.mkt-tag { display: inline-block; padding: 1px 7px; border-radius: 5px; font-size: 12px; font-weight: 700; background: #2f2f2f; color: var(--text-2); }
.mkt-tag.up { background: rgba(34, 197, 94, 0.15); color: var(--green); }
.mkt-tag.down { background: rgba(240, 75, 75, 0.15); color: var(--red); }
.mkt-table tr[aria-selected="true"] td { background: #2b2b2b; }
.mkt-more { margin-top: 12px; padding: 12px 14px 8px; border-radius: 9px; background: #202020; color: var(--text-2); font-size: 13.5px; line-height: 1.55; }
.mkt-more p { margin: 0 0 6px; }
.mkt-more b { color: var(--text); }
.mkt-movers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.mkt-movers h3 { font-size: 15px; margin: 0 0 6px; color: var(--text-2); }
@media (max-width: 760px) { .mkt-movers { grid-template-columns: minmax(0, 1fr); } }
.mkt-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; max-width: 100%; }
.mkt-tools .input { width: 170px; height: 38px; }
.mkt-tools .toggle { flex-wrap: wrap; gap: 6px; }
@media (max-width: 640px) {
  .mkt-tools .input { width: 100%; }
  .mkt-tools .toggle button { height: 32px; padding: 0 10px; font-size: 13.5px; }
}
.mkt-empty { padding: 18px 2px; color: var(--text-2); }
.mkt-more-btn { margin-top: 12px; }
.mkt-how summary { cursor: pointer; font-size: 17px; font-weight: 700; }
.mkt-how ul { margin: 12px 0 0; padding-left: 20px; display: grid; gap: 8px; color: var(--text-2); font-size: 14px; line-height: 1.55; }
`;

function shell() {
  host.innerHTML = `
  <div class="banner mkt-status" id="mkt-status" aria-live="polite"></div>
  <section class="kpis mkt-kpis" id="mkt-kpis" aria-label="The market today"></section>
  <section class="card">
    <div class="card-head"><div><h2>Unusual right now</h2><p>Coins that have moved at least ${RULE.z} of their usual daily moves today, and what similar moves did next. Tap a row for the details.</p></div></div>
    <div id="mkt-unusual"></div>
  </section>
  <section class="card">
    <div class="card-head"><div><h2>Movers today</h2><p>The biggest moves since yesterday's close (UTC)</p></div></div>
    <div id="mkt-movers"></div>
  </section>
  <section class="card">
    <div class="card-head">
      <div><h2>Every coin</h2><p id="mkt-all-sub">Today against each coin's normal</p></div>
      <div class="mkt-tools">
        <input class="input" type="search" id="mkt-q" placeholder="Find a coin" aria-label="Find a coin" autocomplete="off" spellcheck="false">
        <div class="toggle" role="group" aria-label="Sort">
          <button data-mkt="sort" data-v="z" aria-pressed="true">Most unusual</button>
          <button data-mkt="sort" data-v="up" aria-pressed="false">Gainers</button>
          <button data-mkt="sort" data-v="down" aria-pressed="false">Losers</button>
          <button data-mkt="sort" data-v="vol" aria-pressed="false">Volume</button>
        </div>
      </div>
    </div>
    <div id="mkt-all"></div>
  </section>
  <details class="card mkt-how">
    <summary>How the scanner works</summary>
    <ul>
      <li><b>Each coin's normal</b> comes from MEDUSA's market data lakehouse: the average and spread of its daily moves over its last 30 days with trades, built from Binance's checked daily files and published once a day (about 13:30 UTC).</li>
      <li><b>Live prices</b> come straight from Binance to this browser, about once a second. MEDUSA's server never sees them.</li>
      <li><b>Today's move</b> is measured from yesterday's close (UTC). A move of ${RULE.z} or more of the coin's usual daily moves (|z| ≥ ${RULE.z}) is flagged as unusual: the same rule the lakehouse applies to every hour since 2020.</li>
      <li><b>The evidence</b> shows what similar moves (same direction, size and coin liquidity) did over the next 1, 4 and 24 hours since 2020. Each side (follow the move or fade it) was chosen on 2020–2024 and checked on 2025 onwards, which played no part in choosing it, after 0.10% trading costs. Most kinds of move show no pattern that held.</li>
      <li><b>Live numbers are unchecked</b> until the next day's batch run. History is no promise: costs differ by coin and funding isn't counted. This is research, not trading advice.</li>
    </ul>
  </details>`;
  S.html.clear();
}

/** Replace a part of the page only when it changed (keeps focus, hover and text selection). */
function put(id, html) {
  if (S.html.get(id) === html) return;
  S.html.set(id, html);
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function schedule() {
  if (S.paintTimer) return;
  S.paintTimer = setTimeout(() => { S.paintTimer = 0; paint(); }, Math.max(0, 1000 - (Date.now() - S.painted)));
}

function paint() {
  if (!host || host.hidden || document.hidden || !document.getElementById('mkt-status')) return;
  S.painted = Date.now();
  host.querySelectorAll('[data-mkt="sort"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === S.sort)));
  if (S.loadErr || !S.data) {
    put('mkt-status', S.loadErr
      ? `<div><b>The market data couldn't be loaded.</b> ${esc(S.loadErr)} <button class="btn btn-sm" data-mkt="retry">Try again</button></div>`
      : '<div>Loading the market data…</div>');
    return;
  }
  const rows = compute();
  paintStatus(rows);
  paintKpis(rows);
  paintUnusual(rows);
  paintMovers(rows);
  paintAll(rows);
}

/** Every trading coin with its live price, move today, z, liquidity and volume against normal. */
function compute() {
  const out = [], now = Date.now();
  for (const b of S.data.base.values()) {
    if (b.status === 'not trading') continue;
    const l = S.live.get(b.symbol);
    const s = l && S.ref ? score(b, l.price, S.ref.close.get(b.symbol)) : null;
    const avgVol = b.avg_quote_volume_30d || 0;
    const r = {
      b, sym: b.symbol, price: l ? l.price : null, move: s ? s.move : null, z: s ? s.z : null, unusual: !!(s && s.unusual),
      liq: liquidity(avgVol), volx: l && l.q > 0 && avgVol > 0 ? l.q / avgVol : null,
    };
    if (r.unusual) { if (!S.seen.has(r.sym)) S.seen.set(r.sym, now); } else S.seen.delete(r.sym);
    out.push(r);
  }
  return out;
}

function paintStatus(rows) {
  const pub = S.data.published.market_baseline || {};
  const priced = rows.filter((r) => r.price != null).length;
  const ago = S.lastMsg ? Math.max(0, Math.round((Date.now() - S.lastMsg) / 1000)) : null;
  const live = {
    live: `<span class="mkt-dot live"></span><b>Live from Binance</b>${ago != null ? ` · updated ${ago < 2 ? 'just now' : `${ago} s ago`}` : ''}`,
    connecting: '<span class="mkt-dot warn"></span>Connecting to Binance…',
    reconnecting: '<span class="mkt-dot warn"></span>Live prices paused: reconnecting to Binance…',
    refused: '<span class="mkt-dot off"></span><b>Binance\'s live prices can\'t be reached from here</b> (Binance refuses some regions and networks). Prices below are from when they last arrived; the daily numbers are unaffected.',
    off: '<span class="mkt-dot"></span>Not connected',
  }[S.wsState] || '';
  const y = utcDay(Date.now() - DAY);
  const ref = !S.ref
    ? (S.refTotal ? `Getting yesterday's closes from Binance: ${S.refDone} of ${S.refTotal}…` : 'Getting yesterday\'s closes…')
    : S.ref.src === 'lakehouse' ? `Today's move is measured from yesterday's (${shortDay(y)}) close, from the lakehouse`
      : S.ref.src === 'binance' ? `Today's move is measured from yesterday's (${shortDay(y)}) close, from Binance (the lakehouse publishes ${shortDay(y)} at about 13:30 UTC)${S.ref.missing ? `; ${S.ref.missing} coins without it aren't scored` : ''}`
        : `Yesterday's closes couldn't be fetched from Binance, so ${S.ref.missing} coins aren't scored until the lakehouse publishes ${shortDay(y)} (about 13:30 UTC)`;
  put('mkt-status', `
    <div class="row"><span>${live}</span><span class="faint">${priced} coins priced</span></div>
    <div class="row faint"><span>Each coin's normal: lakehouse day ${shortDay(pub.as_of)}${pub.published_at ? `, published ${clock(pub.published_at)}` : ''}</span><span>${ref}</span></div>
    <div class="row faint"><span>Live numbers are unchecked until the next daily run; the evidence is history, not a trading signal.</span></div>`);
}

function paintKpis(rows) {
  const moved = rows.filter((r) => r.move != null);
  const up = moved.filter((r) => r.move > 0).length, down = moved.filter((r) => r.move < 0).length;
  const sorted = moved.map((r) => r.move).sort((a, b) => a - b);
  const median = sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : null;
  const uUp = rows.filter((r) => r.unusual && r.z > 0).length, uDown = rows.filter((r) => r.unusual && r.z < 0).length;
  const btc = rows.find((r) => r.sym === 'BTCUSDT');
  const kpi = (k, v, s) => `<div class="kpi"><div class="k"><span class="kt">${k}</span></div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  put('mkt-kpis', [
    kpi('Breadth', moved.length ? `${Math.round((up / moved.length) * 100)}% up` : '–', `${up} up · ${down} down`),
    kpi('Median move today', `<span class="${tone(median)}">${pct(median)}</span>`, `of ${moved.length} coins`),
    kpi('Unusual now', `${uUp + uDown}`, `<span class="pos">${uUp} up</span> · <span class="neg">${uDown} down</span>`),
    kpi('Bitcoin', btc && btc.price ? price(btc.price) : '–', btc ? `<span class="${tone(btc.move)}">${pct(btc.move)}</span> · ${sig(btc.z)}` : '–'),
  ].join(''));
}

/** One evidence cell: a side and its held-back result when the pattern held up, else the verdict. */
function evCell(e) {
  if (!e) return '<span class="faint">–</span>';
  if (e.verdict === 'held up') return `<span class="mkt-ev">${e.side === 'fade' ? 'Fade' : 'Follow'} ${pct(e.held_back_net_after_cost)}</span>`;
  return `<span class="faint">${esc(e.verdict)}</span>`;
}

/** The evidence in words, for the details under the table. */
function evWords(e, h) {
  const span = h === 1 ? 'the next hour' : `the next ${h} hours`;
  if (!e) return `<p><b>${span[0].toUpperCase() + span.slice(1)}:</b> no evidence for this kind of move.</p>`;
  const t = (x) => (x == null ? '–' : `${sign(Math.round(x * 10))}${Math.abs(x).toFixed(1)}`);
  const went = e.avg_continuation == null ? '' : e.avg_continuation >= 0 ? `Over all those years it kept going on average (${pct(e.avg_continuation)})` : `Over all those years it turned back on average (${pct(e.avg_continuation)})`;
  const head = `<b>Over ${span}:</b> ${e.events ?? 0} similar moves on ${e.days ?? 0} days since 2020. ${went}${e.hit_rate != null ? `, and kept going ${Math.round(e.hit_rate * 100)}% of the time` : ''}.`;
  const side = e.side === 'fade' ? 'fade the move, betting it turns back' : 'follow the move';
  const verdict = {
    'held up': `2020–2024 chose to ${side} (t ${t(e.in_sample_t)}). From 2025 it still worked: ${pct(e.held_back_net_after_cost)} a trade after ${size(e.round_trip_cost)} costs (t ${t(e.held_back_t)} over ${e.held_back_days} days). <b>Held up.</b>`,
    'did not hold': `2020–2024 pointed to ${side} (t ${t(e.in_sample_t)}), but from 2025 it didn't pay after ${size(e.round_trip_cost)} costs (${pct(e.held_back_net_after_cost)}, t ${t(e.held_back_t)}). <b>Did not hold.</b>`,
    'no pattern': `In 2020–2024 alone, where the side is chosen, there was no clear pattern (t ${t(e.in_sample_t)}), so there is no side to take. <b>No pattern.</b>`,
    'too few': `Too few days to judge (${e.in_sample_days ?? 0} in 2020–2024, ${e.held_back_days ?? 0} from 2025; 20 needed in each). <b>Too few.</b>`,
  }[e.verdict] || esc(e.verdict);
  return `<p>${head} ${verdict}</p>`;
}

function paintUnusual(rows) {
  const list = rows.filter((r) => r.unusual).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  if (!list.length) {
    put('mkt-unusual', `<div class="mkt-empty">${S.ref && S.live.size ? `No coin is unusual right now: none has moved ${RULE.z} or more of its usual daily moves today.` : 'Waiting for prices…'}</div>`);
    return;
  }
  const body = list.map((r) => `<tr data-mkt="row" data-sym="${esc(r.sym)}" aria-selected="${S.open === r.sym}">
      <td class="sym">${coin(r.sym)}</td><td>${price(r.price)}</td><td class="${tone(r.move)}">${pct(r.move)}</td>
      <td><span class="mkt-tag ${r.z > 0 ? 'up' : 'down'}">${sig(r.z)}</span></td><td class="l">${LIQ[r.liq]}</td>
      ${evidenceFor(S.data.ev, r.z, r.liq).map((e) => `<td>${evCell(e)}</td>`).join('')}<td class="faint">${clock(S.seen.get(r.sym))}</td></tr>`).join('');
  // The chosen coin's details sit under the table (not in it), so the text always fits the screen.
  const r = list.find((x) => x.sym === S.open);
  const more = r ? `<div class="mkt-more">
      <p>${coin(r.sym)} has moved ${pct(r.move)} since yesterday's close: ${sig(r.z)}, ${Math.abs(r.z).toFixed(1)} times its usual daily move (${size(r.b.sd_return_30d)} over its last ${r.b.history_days} days). Similar moves: ${r.z > 0 ? 'up' : 'down'}, ${zBand(r.z)}σ, ${LIQ_WORDS[r.liq]} coins (average ${Math.round((r.b.avg_quote_volume_30d || 0) / 1e6).toLocaleString('en-US')} million USDT a day).</p>
      ${evidenceFor(S.data.ev, r.z, r.liq).map((e, i) => evWords(e, HORIZONS[i])).join('')}
      <p><b>Every ${r.z > 0 ? 'up' : 'down'} move together</b> (any size, any coin): ${HORIZONS.map((h) => `next ${h} h ${evCell(S.data.ev.get(evKey(r.z > 0 ? 'up' : 'down', 'all', 'all', h)))}`).join(' · ')}.</p></div>` : '';
  put('mkt-unusual', `<div class="scroll-x"><table class="mkt-table"><thead><tr><th>Coin</th><th>Price</th><th>Today</th><th>z</th><th class="l">Liquidity</th><th>Next 1 h</th><th>Next 4 h</th><th>Next 24 h</th><th>Since</th></tr></thead><tbody>${body}</tbody></table></div>${more}`);
}

function paintMovers(rows) {
  const moved = rows.filter((r) => r.move != null);
  const table = (list) => (list.length
    ? `<div class="scroll-x"><table class="mkt-table"><thead><tr><th>Coin</th><th>Price</th><th>Today</th><th>z</th></tr></thead><tbody>${list.map((r) => `<tr><td class="sym">${coin(r.sym)}</td><td>${price(r.price)}</td><td class="${tone(r.move)}">${pct(r.move)}</td><td>${sig(r.z)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="mkt-empty">Waiting for prices…</div>');
  const gain = [...moved].sort((a, b) => b.move - a.move).slice(0, 8).filter((r) => r.move > 0);
  const lose = [...moved].sort((a, b) => a.move - b.move).slice(0, 8).filter((r) => r.move < 0);
  put('mkt-movers', `<div class="mkt-movers"><div><h3>Up the most</h3>${table(gain)}</div><div><h3>Down the most</h3>${table(lose)}</div></div>`);
}

function paintAll(rows) {
  let list = S.q ? rows.filter((r) => r.sym.includes(S.q)) : rows;
  const key = { z: (r) => (r.z == null ? -1 : Math.abs(r.z)), up: (r) => (r.move == null ? -Infinity : r.move), down: (r) => (r.move == null ? -Infinity : -r.move), vol: (r) => (r.volx == null ? -1 : r.volx) }[S.sort];
  list = [...list].sort((a, b) => key(b) - key(a) || a.sym.localeCompare(b.sym));
  put('mkt-all-sub', `${list.length} coins${S.q ? ` matching “${esc(S.q)}”` : ''}; z is today's move in the coin's usual daily moves; volume is the last 24 hours against its usual day`);
  if (!list.length) { put('mkt-all', '<div class="mkt-empty">No coin matches.</div>'); return; }
  const shown = list.slice(0, S.limit);
  const body = shown.map((r) => `<tr><td class="sym">${coin(r.sym)}</td><td>${price(r.price)}</td><td class="${tone(r.move)}">${pct(r.move)}</td>
    <td>${r.unusual ? `<span class="mkt-tag ${r.z > 0 ? 'up' : 'down'}">${sig(r.z)}</span>` : sig(r.z)}</td>
    <td>${size(r.b.sd_return_30d)}</td><td>${volx(r.volx)}</td><td class="l">${LIQ[r.liq]}</td></tr>`).join('');
  const more = list.length > S.limit ? `<button class="btn btn-sm mkt-more-btn" data-mkt="more">Show ${Math.min(50, list.length - S.limit)} more (of ${list.length - S.limit})</button>` : '';
  put('mkt-all', `<div class="scroll-x"><table class="mkt-table"><thead><tr><th>Coin</th><th>Price</th><th>Today</th><th>z</th><th>Usual day</th><th>Volume</th><th class="l">Liquidity</th></tr></thead><tbody>${body}</tbody></table></div>${more}`);
}

/* ---------- data: the lakehouse's copy, yesterday's closes, live prices ---------- */

async function load() {
  if (S.loading) return S.loading;
  S.loading = (async () => {
    try {
      const d = await api.call('GET', '/api/market/scanner');
      const rowsOf = (part) => (part ? part.rows.map((r) => Object.fromEntries(part.columns.map((c, i) => [c, r[i]]))) : []);
      const base = new Map(rowsOf(d.market_baseline).map((r) => [r.symbol, r]));
      const ev = new Map(rowsOf(d.market_evidence).map((r) => [evKey(r.direction, r.z_band, r.liquidity, r.horizon_hours), r]));
      const published = d.published || {};
      if (S.data && (S.data.published.market_baseline || {}).as_of !== (published.market_baseline || {}).as_of) S.ref = null;   // a new day arrived
      S.data = { published, base, ev, at: Date.now() };
      S.loadErr = base.size ? null : 'The lakehouse hasn\'t published its tables to MEDUSA yet.';
    } catch (e) {
      if (e.message !== 'Signed out') {
        S.loadErr = e.message;
        api.log('markets', `The market data couldn't be loaded: ${e.message}`, null, 'error');
      }
    } finally {
      S.loading = null;
    }
  })();
  return S.loading;
}

// Today's move is measured from yesterday's close. The lakehouse has it after its daily run (about
// 13:30 UTC); before that its newest day is the day before, so yesterday's closes come from Binance's
// daily candles instead: one small request per coin, once a day per browser (kept in local storage).
async function ensureRef() {
  if (!S.data || S.loadErr) return;
  const day = utcDay(Date.now() - DAY);
  if ((S.ref && S.ref.day === day) || S.refBusy === day) return;
  S.refBusy = day;
  const close = new Map(), need = [];
  for (const b of S.data.base.values()) {
    if (b.status === 'not trading') continue;
    if (b.as_of_date === day) close.set(b.symbol, b.last_close);
    else need.push(b.symbol);
  }
  let src = 'lakehouse', missing = 0;
  if (need.length) {
    const cached = api.store.get(`mkt.close.${day}`, {}) || {};
    const todo = need.filter((s) => !(cached[s] > 0));
    need.forEach((s) => { if (cached[s] > 0) close.set(s, cached[s]); });
    S.refTotal = need.length; S.refDone = need.length - todo.length;
    schedule();
    const start = Date.parse(`${day}T00:00:00Z`);
    let stop = false;
    const one = async (sym) => {
      if (stop) return;
      try {
        const r = await fetch(`${REST}/klines?symbol=${sym}&interval=1d&startTime=${start}&limit=1`, { credentials: 'omit' });
        if (r.status === 418 || r.status === 429) { stop = true; return; }   // Binance asks us to slow down: stop here
        const k = r.ok ? await r.json() : null;
        if (Array.isArray(k) && k[0] && k[0][0] === start && Number(k[0][4]) > 0) { close.set(sym, Number(k[0][4])); cached[sym] = Number(k[0][4]); }
      } catch { /* this coin stays unscored */ }
      S.refDone++;
      schedule();
    };
    const queue = [...todo];
    await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()); }));
    if (todo.length) {
      try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('j.mkt.close.') && k !== `j.mkt.close.${day}`) localStorage.removeItem(k); } } catch { /* storage blocked */ }
      api.store.set(`mkt.close.${day}`, cached);
    }
    missing = need.filter((s) => !close.has(s)).length;
    src = missing === need.length ? 'none' : 'binance';
    if (missing) api.log('markets', `Yesterday's close is missing for ${missing} of ${need.length} coins`, null, 'debug');
  }
  if (S.refBusy !== day) return;   // the day changed meanwhile: a newer run takes over
  S.ref = { day, close, src, missing };
  S.refBusy = null;
  schedule();
}

/* Binance sends only the coins that changed in each message, so one snapshot of every price fills in
   the quiet coins at the start. */
async function snapshot() {
  try {
    const r = await fetch(`${REST}/ticker/price`, { credentials: 'omit' });
    if (!r.ok) return;
    for (const p of await r.json()) if (!S.live.has(p.symbol)) S.live.set(p.symbol, { price: Number(p.price), q: null, t: p.time });
    S.snapAt = Date.now();
    schedule();
  } catch { /* the stream fills them in */ }
}

function connect() {
  if (S.ws || S.stopped) return;
  S.wsState = S.everOpen ? 'reconnecting' : S.fails >= 3 ? 'refused' : 'connecting';
  let ws;
  try { ws = new WebSocket(STREAM); } catch { S.wsState = 'refused'; schedule(); return; }
  S.ws = ws;
  ws.onopen = () => { S.wsState = 'live'; S.everOpen = true; S.fails = 0; S.lastMsg = Date.now(); schedule(); };
  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!Array.isArray(d)) return;
    for (const t of d) if (t && t.s) S.live.set(t.s, { price: Number(t.c), q: Number(t.q), t: t.E });
    S.lastMsg = Date.now();
    if (S.wsState !== 'live') S.wsState = 'live';
    schedule();
  };
  ws.onclose = () => {
    if (S.ws === ws) S.ws = null;
    if (S.stopped) return;
    S.fails++;
    S.wsState = !S.everOpen && S.fails >= 3 ? 'refused' : 'reconnecting';
    if (S.fails === 3 && !S.everOpen) api.log('markets', "Binance's live stream couldn't be reached", null, 'error');
    S.retry = setTimeout(connect, [1, 2, 5, 10, 30][Math.min(S.fails - 1, 4)] * 1000);
    schedule();
  };
}

/* Every 10 seconds: restart a stream that went quiet, pick up the lakehouse's new day after its daily
   publish, and move to a new reference close at midnight UTC. */
function watch() {
  if (S.stopped) return;
  if (S.ws && S.wsState === 'live' && Date.now() - S.lastMsg > 30_000) S.ws.close();
  if (S.data && Date.now() - S.data.at > 30 * 60_000) load().then(ensureRef);
  else ensureRef();
  schedule();
}

async function start() {
  if (!S.data || S.loadErr || Date.now() - S.data.at > 30 * 60_000) { await load(); paint(); }
  if (S.stopped || !S.data || S.loadErr) return;
  connect();
  if (Date.now() - S.snapAt > 60_000) snapshot();
  ensureRef();
  if (!S.tick) S.tick = setInterval(watch, 10_000);
}

/* ---------- entry points (app.js) ---------- */

function onClick(e) {
  const el = e.target.closest('[data-mkt]');
  if (!el || !host.contains(el)) return;
  const act = el.dataset.mkt;
  if (act === 'retry') { S.loadErr = null; paint(); start(); return; }
  if (act === 'sort') { S.sort = el.dataset.v; S.limit = 50; }
  else if (act === 'more') S.limit += 50;
  else if (act === 'row') S.open = S.open === el.dataset.sym ? null : el.dataset.sym;
  paint();
}

function onInput(e) {
  if (e.target.id !== 'mkt-q') return;
  S.q = e.target.value.trim().toUpperCase();
  S.limit = 50;
  paint();
}

/** Show the page (each time it is opened). */
export function render(el, appApi) {
  api = appApi;
  if (!document.getElementById('mkt-css')) document.head.appendChild(Object.assign(document.createElement('style'), { id: 'mkt-css', textContent: CSS }));
  if (host !== el) {
    host = el;
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.stopped) schedule(); });
  }
  if (!document.getElementById('mkt-status')) shell();
  S.stopped = false;
  paint();
  start();
}

/** The page was left: close the live stream until it is opened again. */
export function stop() {
  S.stopped = true;
  clearTimeout(S.retry);
  clearInterval(S.tick);
  S.tick = 0;
  if (S.ws) { const ws = S.ws; S.ws = null; ws.close(); }
  S.wsState = 'off';
}
