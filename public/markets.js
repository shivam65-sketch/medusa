// MEDUSA Markets: the live scanner, downloaded only when the page is opened (app.js).
//
// Every row is a Binance USDⓈ-M perpetual futures contract quoted in USDT (a "market"): crypto coins
// and tokens, and the TradFi perpetuals on stocks, commodities, a currency and indices.
//
// Two layers meet here (a Lambda-style design):
//   batch  each market's normal and the evidence, from the market data lakehouse's daily copy
//          (GET /api/market/scanner: market_baseline and market_evidence; ADR-024, ADR-025)
//   live   prices straight from Binance to this browser: one stream with every market that changed,
//          about once a second. MEDUSA's server never sees them.
// The rule is the lakehouse's own (lakehouse/dbt/models/gold/intraday_events.sql), so the evidence
// describes exactly the moves flagged here:
//   move today = price now / yesterday's close - 1
//   z          = (move today - the market's average daily return) / the spread of its daily returns (σ),
//                over its last 30 days with trades (scored from 20 of them)
//   unusual    = |z| >= 3; size bands 3-4, 4-6, 6+; liquidity by average daily volume in USDT
// Live numbers are unchecked: the next day's batch run replaces them with checked ones.
//
// Two views: Today (the live scan) and Patterns (every kind of move and what it did next).

const RULE = { z: 3, bands: [4, 6], large: 1e8, mid: 1e7, minDays: 20 };
const STREAM = 'wss://fstream.binance.com/market/ws/!miniTicker@arr';
const REST = 'https://fapi.binance.com/fapi/v1';
const DAY = 86_400_000;
const HORIZONS = [1, 4, 24];
const BANDS = ['3-4', '4-6', '6+'], LIQS = ['large', 'mid', 'small'];

/* ---------- the rule (no page code: testable on its own) ---------- */

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const zBand = (z) => (Math.abs(z) < RULE.bands[0] ? '3-4' : Math.abs(z) < RULE.bands[1] ? '4-6' : '6+');
export const liquidity = (usdtPerDay) => (usdtPerDay >= RULE.large ? 'large' : usdtPerDay >= RULE.mid ? 'mid' : 'small');
export const evKey = (direction, band, liq, hours) => `${direction}|${band}|${liq}|${hours}`;

/** A market's move today and its z, or null without a price and a reference close. z is null when the
 * market has too little history to have a normal. */
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

/** What a market is, from Binance's contract list: its group for the filter and a short label. */
const TYPES = {
  COIN: ['crypto', 'Crypto'], INDEX: ['other', 'Index'], FX: ['other', 'Currency'], PREMARKET: ['other', 'Pre-IPO'],
  EQUITY: ['stock', 'US stock'], HK_EQUITY: ['stock', 'HK stock'], KR_EQUITY: ['stock', 'Korean stock'], CN_EQUITY: ['stock', 'Chinese stock'],
  COMMODITY: ['commodity', 'Commodity'],
};
export function marketType(underlyingType, subTypes) {
  const [group, label] = TYPES[underlyingType] || ['other', underlyingType ? underlyingType.toLowerCase() : 'Other'];
  const sector = group === 'crypto' ? (subTypes || []).filter((s) => s !== 'Crypto').sort((a, b) => (a === 'Alpha') - (b === 'Alpha'))[0] : null;
  return { group, label: sector ? `${label} · ${sector}` : label };
}

/* ---------- state ---------- */

let api = null, host = null;
const S = {
  data: null, loadErr: null, loading: null,          // the lakehouse's copy: {published, base, ev, at}
  live: new Map(), snapAt: 0,                        // symbol -> {price, q (USDT traded in the last 24 h), t, raw, via}
  ref: null, refBusy: null, refDone: 0, refTotal: 0, // yesterday's closes: {day, close: Map, src}
  types: new Map(), typesDay: null,                  // symbol -> {group, label}
  ws: null, wsState: 'off', everOpen: false, fails: 0, lastMsg: 0, retry: 0, tick: 0, stopped: true,
  seen: new Map(),                                   // symbol -> when this page first saw it unusual
  view: 'today', kind: 'all', sort: 'z', q: '', limit: 50, open: null, openAll: null, pat: null,
  src: null, sql: new Map(),                         // the open "how this is calculated" panel; its queries for Copy
  painted: 0, paintTimer: 0, html: new Map(),
};

/* ---------- formatting ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = (x) => (x > 0 ? '+' : x < 0 ? '−' : '');
const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '–' : `${sign(x)}${Math.abs(x * 100).toFixed(d)}%`);
const size = (x) => (x == null || !Number.isFinite(x) ? '–' : `${Math.abs(x * 100).toFixed(2)}%`);   // no sign: a spread or a cost
const sig = (z) => (z == null || !Number.isFinite(z) ? '–' : `${sign(z)}${Math.abs(z).toFixed(1)}σ`);
const tval = (x) => (x == null ? '–' : `${sign(Math.round(x * 10))}${Math.abs(x).toFixed(1)}`);
const tone = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
function price(p) {
  if (!(p > 0)) return '–';
  if (p >= 1) return p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 2 : 4 });
  return p.toFixed(Math.min(8, 3 - Math.floor(Math.log10(p))));
}
const shortDay = (ymd) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '–');
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const name = (sym) => esc(sym.replace(/USDT$/, ''));
const typeOf = (sym) => S.types.get(sym) || null;
const market = (sym) => { const t = typeOf(sym); return `${name(sym)}${t ? `<span class="mkt-kind">${esc(t.label)}</span>` : ''}`; };
const volx = (x) => (x == null ? '–' : `×${x >= 10 ? x.toFixed(0) : x.toFixed(1)}`);
const LIQ = { large: 'Large', mid: 'Mid', small: 'Small' };
const LIQ_WORDS = { large: 'large', mid: 'mid-sized', small: 'small' };
const KINDS = [['all', 'All'], ['crypto', 'Crypto'], ['stock', 'Stocks'], ['commodity', 'Commodities'], ['other', 'Other']];
const KIND_WORD = { all: '', crypto: 'crypto ', stock: 'stock ', commodity: 'commodity ', other: 'other ' };
const kindName = (dir, band, liq) => (band === 'all' ? `Every ${dir} move` : `${dir === 'up' ? 'Up' : 'Down'} ${band}σ, ${LIQ_WORDS[liq]} markets`);
const kindPhrase = (dir, band, liq) => (band === 'all' ? `every ${dir} move`
  : `${dir} moves of ${band === '6+' ? '6σ or more' : `${band.replace('-', '–')}σ`} on ${LIQ_WORDS[liq]} markets`);
const Z_TIP = "Today's move ÷ the market's usual daily move (σ). 3σ or more is unusual.";
const LIQ_TIP = 'Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below';
const clockS = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* ---------- where each number comes from (lineage) ---------- */
// Every number on Today is shown as one SQL query that produces it, over three inputs:
//   live_prices      Binance's live prices, as on screen now (written out as VALUES, so the query runs as it is)
//   market_baseline  each market's normal: MEDUSA's daily copy of the lakehouse's gold.coin_baseline
//   market_evidence  what similar moves did next: MEDUSA's copy of gold.event_evidence
// The same query runs in MEDUSA's D1 and, with the lakehouse's table names, in Databricks.

const GH = 'https://github.com/shivam65-sketch/medusa/blob/main/lakehouse/dbt/models/gold/';
const ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>';
const srcBtn = (id) => `<button class="mkt-src-btn" type="button" data-mkt="src" data-id="${id}" aria-pressed="${S.src === id}" title="How this is calculated" aria-label="How this is calculated">${ICON}</button>`;
const srcBox = (id, body) => (S.src === id ? `<div class="mkt-src">${body}</div>` : '');
const sqlBlock = (title, sql) => `<div class="mkt-sql"><div class="h"><span>${title}</span><button class="btn btn-sm" type="button" data-mkt="copy">Copy</button></div><pre>${esc(sql.trim())}</pre></div>`;
const ghLink = (file) => `<a href="${GH}${file}" target="_blank" rel="noopener">${file}</a>`;
const csvBtn = (scope) => `<p><button class="btn btn-sm" type="button" data-mkt="csv" data-scope="${scope}">Download the inputs (CSV)</button> <span class="faint">every market behind this number, exactly as used now</span></p>`;
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const num = (x) => (Number.isFinite(x) ? String(x) : 'NULL');
const toDbx = (sql) => sql.replace(/\bmarket_baseline\b/g, 'market.gold.coin_baseline').replace(/\bmarket_evidence\b/g, 'market.gold.event_evidence');
const closeFromBinance = (r) => !!(S.ref && S.ref.close.has(r.sym) && r.b.as_of_date !== S.ref.day);

/** A query panel: the SQL as shown, with Copy buttons for MEDUSA's D1 and for Databricks (the full text). */
function queryBlock(id, title, sql, shown = sql, dbx = toDbx(sql)) {
  const tidy = (s) => s.replace(/ {3,}--/g, '  --');   // each comment right after its code, so it fits a phone
  [sql, shown, dbx] = [sql, shown, dbx].map(tidy);
  S.sql.set(id, { d1: sql, dbx });
  return `<div class="mkt-sql"><div class="h"><span>${title}</span><span class="b">
    <button class="btn btn-sm" type="button" data-mkt="copy" data-sql="${id}" data-db="d1">Copy for MEDUSA (D1)</button>
    <button class="btn btn-sm" type="button" data-mkt="copy" data-sql="${id}" data-db="dbx">Copy for Databricks</button></span></div>
    <pre>${esc(shown.trim())}</pre></div>`;
}

/** live_prices as VALUES: the markets behind a number with their prices on screen now. Yesterday's close
 * joins them when it came from Binance (before the lakehouse publishes yesterday), and the last 24 hours'
 * volume when the query needs it. Long lists show their first rows; Copy has them all. */
function livePrices(rows, { volume = false, show = 3 } = {}) {
  const bc = rows.some(closeFromBinance);
  const cols = ['symbol', 'price', ...(bc ? ['yesterday_close'] : []), ...(volume ? ['quote_volume_24h'] : [])];
  const vals = rows.map((r) => {
    const l = S.live.get(r.sym);
    return `('${r.sym}', ${num(l && l.price)}${bc ? `, ${num(S.ref.close.get(r.sym))}` : ''}${volume ? `, ${num(l && l.q)}` : ''})`;
  });
  const kind = S.kind === 'all' ? '' : `; ${KIND_WORD[S.kind].trim()} markets only`;
  const head = `WITH live_prices(${cols.join(', ')}) AS (VALUES   -- Binance's live prices at ${S.lastMsg ? clockS(S.lastMsg) : 'now'}${kind}`;
  const full = `${head}\n  ${vals.join(',\n  ')}\n)`;
  const shown = vals.length > show ? `${head}\n  ${vals.slice(0, show).join(',\n  ')},\n  -- ... ${vals.length - show} more markets (Copy has them all)\n)` : full;
  return { full, shown, bc };
}

/** The step every query shares: each market's move today, its z and its liquidity. */
function todaySql(bc, extra = false) {
  const c = bc ? 'p.yesterday_close' : 'b.last_close';
  return `today AS (
  SELECT b.symbol,
         p.price,
         p.price / ${c} - 1 AS move,                         -- Today: the move since yesterday's close
         CASE WHEN b.history_days >= 20 AND b.sd_return_30d > 0
              THEN (p.price / ${c} - 1 - b.avg_return_30d) / b.sd_return_30d
         END AS z,                                           -- z: the move in usual daily moves (σ)
         CASE WHEN b.avg_quote_volume_30d >= 100000000 THEN 'large'
              WHEN b.avg_quote_volume_30d >= 10000000 THEN 'mid'
              ELSE 'small' END AS liquidity${extra ? `,                    -- Liquidity: average USDT a day
         b.sd_return_30d,                                    -- Usual day: σ
         p.quote_volume_24h / b.avg_quote_volume_30d AS volume_x   -- Volume: last 24 h ÷ a usual day` : '                        -- Liquidity: average USDT a day'}
  FROM market_baseline b                                     -- each market's normal (lakehouse)
  JOIN live_prices p ON p.symbol = b.symbol                  -- its live price (Binance)
)`;
}

const FLAGGED = `flagged AS (
  SELECT *,
         CASE WHEN z > 0 THEN 'up' ELSE 'down' END AS direction,
         CASE WHEN ABS(z) < 4 THEN '3-4' WHEN ABS(z) < 6 THEN '4-6' ELSE '6+' END AS z_band
  FROM today
  WHERE ABS(z) >= 3                                          -- unusual: 3 or more usual daily moves
)`;
const verdict = (h) => `CASE WHEN e${h}.verdict = 'held up'
            THEN e${h}.side || ' ' || ROUND(100 * e${h}.held_back_net_after_cost, 2) || '%'
            ELSE e${h}.verdict END AS next_${h}h`;
const EVIDENCE_JOINS = HORIZONS.map((h) => `LEFT JOIN market_evidence e${h} ON e${h}.direction = f.direction AND e${h}.z_band = f.z_band
                          AND e${h}.liquidity = f.liquidity AND e${h}.horizon_hours = ${h}`).join('\n');

/** What each table in a query is, where it comes from, and when it was last updated. */
function sourcesTable({ bc = false, evidence = false, volume = false } = {}) {
  const pub = S.data.published;
  const rows = [
    ['live_prices', `Binance's live prices, streamed to this browser${volume ? ', with the USDT traded in the last 24 hours' : ''}`, `every second · last ${S.lastMsg ? clockS(S.lastMsg) : '–'}`],
    ...(bc ? [['live_prices.yesterday_close', 'Yesterday\'s close from Binance\'s daily candle, until the lakehouse publishes yesterday (about 13:30 UTC)', 'once a day']] : []),
    ['market_baseline', `Each market's normal (last close, average daily return, σ, days of history, average volume): MEDUSA's copy of the lakehouse's <code>gold.coin_baseline</code>, built by ${ghLink('coin_baseline.sql')}`, `daily · day ${shortDay((pub.market_baseline || {}).as_of)}`],
    ...(evidence ? [['market_evidence', `What similar moves did next: MEDUSA's copy of the lakehouse's <code>gold.event_evidence</code>, built by ${ghLink('event_evidence.sql')}`, `daily · day ${shortDay((pub.market_evidence || {}).as_of)}`]] : []),
  ];
  return `<table class="mkt-legend"><thead><tr><th>In the query</th><th>What it is</th><th>Updated</th></tr></thead><tbody>${rows.map(([a, b, c]) => `<tr><td><code>${a}</code></td><td>${b}</td><td>${c}</td></tr>`).join('')}</tbody></table>`;
}

/** One panel: what the number is, the query that makes it, its result now, and its sources. */
const panelHtml = ({ what, id, title, sql, shown, dbx, now, sources, csv }) => `<p class="what">${what}</p>
  ${queryBlock(id, title, sql, shown, dbx)}${now ? `<p class="now"><b>On screen now:</b> ${now}</p>` : ''}${sources}${csv ? csvBtn(csv) : ''}`;

/** One market's row as a query, with its real price written in, so it runs and gives the same numbers. */
function marketPanel(r) {
  const base = name(r.sym), l = S.live.get(r.sym);
  if (!l || r.move == null) return `<p class="what">${base} has no ${!l ? 'live price' : 'close for yesterday'} yet, so there is nothing to calculate.</p>`;
  const live = livePrices([r], { volume: true, show: 1 });
  const cols = `SELECT f.symbol AS market,
       f.price,
       ROUND(100 * f.move, 2) AS today_pct,
       ROUND(f.z, 1) AS z,
       ROUND(100 * f.sd_return_30d, 2) AS usual_day_pct,
       ROUND(f.volume_x, 1) AS volume_x,
       f.liquidity`;
  const sql = r.unusual
    ? `-- ${base}: every number in its row\n${live.full},\n${todaySql(live.bc, true)},\n${FLAGGED}\n${cols},\n       ${HORIZONS.map(verdict).join(',\n       ')}\nFROM flagged f\n${EVIDENCE_JOINS};`
    : `-- ${base}: every number in its row\n${live.full},\n${todaySql(live.bc, true)}\n${cols}\nFROM today f;`;
  const ev = r.unusual ? evidenceFor(S.data.ev, r.z, r.liq) : [];
  const now = `today_pct ${(100 * r.move).toFixed(2)} · z ${r.z == null ? 'NULL' : r.z.toFixed(1)} · usual_day_pct ${(100 * r.b.sd_return_30d).toFixed(2)} · volume_x ${r.volx == null ? 'NULL' : r.volx.toFixed(1)} · liquidity ${r.liq}${ev.map((e, i) => ` · next_${HORIZONS[i]}h ${e ? (e.verdict === 'held up' ? `${e.side} ${(100 * e.held_back_net_after_cost).toFixed(2)}%` : e.verdict) : 'NULL'}`).join('')}`;
  return `${panelHtml({ what: `How ${base}'s numbers are calculated. Run the query in MEDUSA's D1 or in Databricks and it gives the same numbers.`, id: `m-${r.sym}`, title: 'The query (SQL)', sql, now, sources: sourcesTable({ bc: live.bc, evidence: r.unusual, volume: true }) })}
    <details class="mkt-raw"><summary>The Binance message behind the price</summary><code>${esc(JSON.stringify(l.raw))}</code><p class="faint">${l.via === 'stream' ? `From the live stream at ${clockS(l.t)}: <code>c</code> is the last price, <code>q</code> the USDT traded in the last 24 hours.` : `From the price snapshot of ${clockS(l.t)}: it hasn't traded since this page opened.`}</p></details>
    ${r.unusual ? `<details class="mkt-raw"><summary>Every past move behind these verdicts (Databricks)</summary>${sqlBlock('Databricks SQL', `SELECT event_hour, symbol, z, move_so_far, fwd_return_1h, fwd_return_4h, fwd_return_24h, period\nFROM market.gold.intraday_events\nWHERE direction = '${r.z > 0 ? 'up' : 'down'}' AND z_band = '${zBand(r.z)}' AND liquidity = '${r.liq}'\nORDER BY event_hour DESC;`)}<p class="faint">Built by ${ghLink('intraday_events.sql')}; it exists only in the lakehouse.</p></details>` : ''}`;
}

/** The verdicts and past moves of one kind of move, for Patterns. */
function evidenceSql(dir, band, liq) {
  const moves = band === 'all' ? `direction = '${dir}'` : `direction = '${dir}' AND z_band = '${band}' AND liquidity = '${liq}'`;
  const verdicts = band === 'all' ? `direction = '${dir}' AND z_band = 'all' AND liquidity = 'all'` : moves;
  return sqlBlock('The verdicts (Databricks SQL; in MEDUSA\'s D1 the table is market_evidence)', `SELECT horizon_hours, verdict, side, events, days, avg_continuation, in_sample_t, held_back_t, held_back_net_after_cost
FROM market.gold.event_evidence
WHERE ${verdicts}
ORDER BY horizon_hours;`)
    + sqlBlock('Every past move behind them (Databricks SQL)', `SELECT event_hour, symbol, z, move_so_far, fwd_return_1h, fwd_return_4h, fwd_return_24h, period
FROM market.gold.intraday_events
WHERE ${moves}
ORDER BY event_hour DESC;`);
}

/* ---------- the page ---------- */

const CSS = `
.mkt-bar { display: flex; flex-wrap: wrap; gap: 8px 14px; justify-content: space-between; align-items: center; }
.mkt-bar .toggle, .mkt-tools .toggle { flex-wrap: wrap; gap: 6px; }
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
.mkt-table th[title] { text-decoration: underline dotted var(--text-3); text-underline-offset: 3px; cursor: help; }
.mkt-table td { text-align: right; padding: 10px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; font-variant-numeric: tabular-nums; }
.mkt-table th:first-child, .mkt-table td:first-child, .mkt-table .l { text-align: left; }
.mkt-table tr:last-child td { border-bottom: 0; }
.mkt-table tr[data-mkt="row"], .mkt-table td[data-mkt="pat"] { cursor: pointer; }
.mkt-table tr[data-mkt="row"]:hover td, .mkt-table td[data-mkt="pat"]:hover { background: #2b2b2b; }
.mkt-table tr[aria-selected="true"] td, .mkt-table td[aria-selected="true"] { background: #2b2b2b; }
.mkt-table td.sym { font-weight: 700; }
.mkt-table tr.grp td { font-weight: 700; color: var(--text); background: #222; }
.mkt-kind { margin-left: 7px; font-size: 12px; font-weight: 500; color: var(--text-3); }
.mkt-evc { display: inline-grid; justify-items: end; gap: 1px; line-height: 1.3; }
.mkt-evc .v { color: var(--text-2); }
.mkt-ev { font-weight: 700; color: var(--green); }
.mkt-ev-all { font-size: 12px; color: var(--text-3); }
.mkt-ev-all b { color: var(--green); font-weight: 600; }
.mkt-tag { display: inline-block; padding: 1px 7px; border-radius: 5px; font-size: 12px; font-weight: 700; background: #2f2f2f; color: var(--text-2); }
.mkt-tag.up { background: rgba(34, 197, 94, 0.15); color: var(--green); }
.mkt-tag.down { background: rgba(240, 75, 75, 0.15); color: var(--red); }
.mkt-key { margin: 10px 2px 0; color: var(--text-3); font-size: 13px; line-height: 1.5; }
.mkt-key b { color: var(--text-2); }
.mkt-more { margin-top: 12px; padding: 12px 14px 8px; border-radius: 9px; background: #202020; color: var(--text-2); font-size: 13.5px; line-height: 1.55; }
.mkt-more p { margin: 0 0 6px; }
.mkt-more b { color: var(--text); }
.mkt-more p.warn { color: #e8c547; }
.mkt-movers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.mkt-movers h3 { font-size: 15px; margin: 0 0 6px; color: var(--text-2); }
@media (max-width: 760px) { .mkt-movers { grid-template-columns: minmax(0, 1fr); } }
.mkt-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; max-width: 100%; }
.mkt-tools .input { width: 170px; height: 38px; }
@media (max-width: 640px) {
  .mkt-tools .input { width: 100%; }
  .mkt-bar .toggle button, .mkt-tools .toggle button { height: 32px; padding: 0 10px; font-size: 13.5px; }
}
.mkt-empty { padding: 18px 2px; color: var(--text-2); }
.mkt-more-btn { margin-top: 12px; }
.mkt-how summary { cursor: pointer; font-size: 17px; font-weight: 700; }
.mkt-how ul, .mkt-rules { margin: 12px 0 0; padding-left: 20px; display: grid; gap: 8px; color: var(--text-2); font-size: 14px; line-height: 1.55; }
.mkt-rules { margin-top: 0; }
.mkt-counts { display: flex; flex-wrap: wrap; gap: 8px; }
.mkt-counts span { padding: 4px 10px; border-radius: 99px; border: 1px solid var(--border-2); color: var(--text-2); font-size: 13.5px; }
.mkt-counts b { color: var(--text); }
.mkt-held { display: grid; gap: 10px; }
.mkt-held > div { padding: 12px 14px; border-radius: 9px; background: #202020; border: 1px solid var(--border); color: var(--text-2); font-size: 14px; line-height: 1.55; }
.mkt-held b { color: var(--text); }
.mkt-src-btn { display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; margin-left: auto; padding: 0; border-radius: 7px; border: 1px solid var(--border-2); background: #1f1f1f; color: var(--text-3); cursor: pointer; }
.mkt-src-btn .ic { width: 15px; height: 15px; }
.mkt-src-btn:hover, .mkt-src-btn[aria-pressed="true"] { color: var(--text); border-color: var(--text-3); }
.mkt-src-btn[aria-pressed="true"] { background: #2b2b2b; }
.card-head .mkt-src-btn { margin-left: 0; }
.mkt-kpis .kpi .k { display: flex; align-items: center; gap: 6px; }
.mkt-src { margin: 0 0 14px; padding: 12px 14px 6px; border-radius: 9px; background: #1b1b1b; border: 1px dashed var(--border-2); color: var(--text-2); font-size: 13.5px; line-height: 1.55; }
#mkt-kpi-src:empty, .mkt-src-slot:empty { display: none; }
#mkt-kpi-src .mkt-src { margin: 0; }
.mkt-src p { margin: 0 0 8px; }
.mkt-src b, .mkt-more h4 { color: var(--text); }
.mkt-src code, .mkt-more code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: var(--text); word-break: break-all; }
.mkt-src a, .mkt-more a { color: #86efac; }
.mkt-src-list { margin: 0 0 8px; padding-left: 18px; display: grid; gap: 4px; }
.mkt-more h4 { margin: 14px 0 6px; font-size: 14px; }
.mkt-calc { display: grid; gap: 4px; margin: 0 0 8px; }
.mkt-calc > div { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.mkt-calc span { min-width: 92px; color: var(--text-3); }
.mkt-sql { margin: 8px 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.mkt-sql .h { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 5px 6px 5px 10px; background: #232323; color: var(--text-2); font-size: 12.5px; font-weight: 600; }
.mkt-sql .h .btn { height: 26px; padding: 0 10px; font-size: 12.5px; }
.mkt-sql .h .b { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.mkt-src p.what { color: var(--text); font-size: 14px; }
.mkt-src p.now { margin: 6px 0 10px; font-variant-numeric: tabular-nums; }
table.mkt-legend { width: 100%; border-collapse: collapse; margin: 4px 0 10px; font-size: 13px; }
.mkt-legend th { text-align: left; font-weight: 600; color: var(--text-3); padding: 6px 8px; border-bottom: 1px solid var(--border-2); }
.mkt-legend td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.mkt-legend td:first-child, .mkt-legend td:last-child { white-space: nowrap; }
.mkt-legend td:last-child { color: var(--text-3); }
@media (max-width: 640px) { .mkt-legend td:first-child, .mkt-legend td:last-child { white-space: normal; } }
.mkt-raw { margin: 6px 0 8px; }
.mkt-raw summary { cursor: pointer; color: var(--text-2); }
.mkt-raw code { display: block; margin: 6px 0; }
.mkt-sql pre { margin: 0; padding: 10px 12px; overflow-x: auto; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; line-height: 1.5; color: #d4d4d8; background: #161616; }
`;

function shell() {
  host.innerHTML = `
  <div class="mkt-bar">
    <div class="toggle" role="group" aria-label="View">
      <button data-mkt="view" data-v="today" aria-pressed="true">Today</button>
      <button data-mkt="view" data-v="patterns" aria-pressed="false">Patterns</button>
    </div>
    <div class="toggle" role="group" aria-label="Markets" id="mkt-kinds">
      ${KINDS.map(([v, l]) => `<button data-mkt="kind" data-v="${v}" aria-pressed="${v === 'all'}">${l}</button>`).join('')}
    </div>
  </div>
  <div class="banner mkt-status" id="mkt-status" aria-live="polite"></div>
  <div id="mkt-today" class="view">
    <section class="kpis mkt-kpis" id="mkt-kpis" aria-label="The markets today"></section>
    <div id="mkt-kpi-src"></div>
    <section class="card">
      <div class="card-head"><div><h2>Unusual right now</h2><p>Markets that have moved at least ${RULE.z} of their usual daily moves today, and what similar moves did next. Tap a row for the details and where its numbers come from.</p></div>${srcBtn('unusual')}</div>
      <div class="mkt-src-slot" id="mkt-unusual-src"></div>
      <div id="mkt-unusual"></div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Movers today</h2><p>The biggest moves since yesterday's close (UTC)</p></div>${srcBtn('movers')}</div>
      <div class="mkt-src-slot" id="mkt-movers-src"></div>
      <div id="mkt-movers"></div>
    </section>
    <section class="card">
      <div class="card-head">
        <div><h2>Every market</h2><p id="mkt-all-sub">Today against each market's normal</p></div>
        <div class="mkt-tools">
          <input class="input" type="search" id="mkt-q" placeholder="Find a market or type" aria-label="Find a market or type" autocomplete="off" spellcheck="false">
          <div class="toggle" role="group" aria-label="Sort">
            <button data-mkt="sort" data-v="z" aria-pressed="true">Most unusual</button>
            <button data-mkt="sort" data-v="up" aria-pressed="false">Gainers</button>
            <button data-mkt="sort" data-v="down" aria-pressed="false">Losers</button>
            <button data-mkt="sort" data-v="vol" aria-pressed="false">Volume</button>
          </div>
          ${srcBtn('every')}
        </div>
      </div>
      <div class="mkt-src-slot" id="mkt-every-src"></div>
      <div id="mkt-all"></div>
    </section>
    <details class="card mkt-how">
      <summary>How the scanner works</summary>
      <ul>
        <li><b>The markets</b> are every Binance USDⓈ-M perpetual futures contract quoted in USDT: crypto coins and tokens, and the TradFi perpetuals on stocks, commodities, a currency and indices. The type next to each name comes from Binance's contract list.</li>
        <li><b>Each market's normal</b> comes from MEDUSA's market data lakehouse: the average and spread (σ) of its daily moves over its last 30 days with trades, built from Binance's checked daily files and published once a day (about 13:30 UTC).</li>
        <li><b>Live prices</b> come straight from Binance to this browser, about once a second. MEDUSA's server never sees them.</li>
        <li><b>Today's move</b> is measured from yesterday's close (UTC). z is that move in the market's usual daily moves; ${RULE.z} or more (|z| ≥ ${RULE.z}) is flagged as unusual: the same rule the lakehouse applies to every hour since 2020.</li>
        <li><b>The evidence</b> shows what similar moves (same direction, size and liquidity) did over the next 1, 4 and 24 hours since 2020. Each side (follow the move or fade it) was chosen on 2020–2024 and checked on 2025 onwards, which played no part in choosing it, after 0.10% trading costs. Most kinds of move show no pattern that held; the Patterns view lists them all. Almost all of that history is crypto.</li>
        <li><b>Live numbers are unchecked</b> until the next day's batch run. History is no promise: costs differ by market and funding isn't counted. This is research, not trading advice.</li>
      </ul>
    </details>
  </div>
  <div id="mkt-patterns" class="view" hidden></div>`;
  S.html.clear();
}

/** Replace a part of the page only when it changed (keeps focus, hover and text selection). A part is
 * held still while the pointer is over its details or sources, so they can be read, selected and copied. */
function put(id, html) {
  if (S.html.get(id) === html) return;
  const el = document.getElementById(id);
  if (!el || el.querySelector('.mkt-src:hover, .mkt-more:hover')) return;
  S.html.set(id, html);
  el.innerHTML = html;
}

function schedule() {
  if (S.paintTimer) return;
  S.paintTimer = setTimeout(() => { S.paintTimer = 0; paint(); }, Math.max(0, 1000 - (Date.now() - S.painted)));
}

function paint() {
  if (!host || host.hidden || document.hidden || !document.getElementById('mkt-status')) return;
  S.painted = Date.now();
  host.querySelectorAll('[data-mkt="view"], [data-mkt="kind"], [data-mkt="sort"]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === S[b.dataset.mkt]));
  });
  host.querySelectorAll('[data-mkt="src"]').forEach((b) => b.setAttribute('aria-pressed', String(S.src === b.dataset.id)));
  document.getElementById('mkt-kinds').hidden = S.view !== 'today';
  document.getElementById('mkt-today').hidden = S.view !== 'today';
  document.getElementById('mkt-patterns').hidden = S.view !== 'patterns';
  if (S.loadErr || !S.data) {
    put('mkt-status', S.loadErr
      ? `<div><b>The market data couldn't be loaded.</b> ${esc(S.loadErr)} <button class="btn btn-sm" data-mkt="retry">Try again</button></div>`
      : '<div>Loading the market data…</div>');
    return;
  }
  const all = compute();
  paintStatus(all);
  if (S.view === 'patterns') { paintPatterns(all); return; }
  const rows = S.kind === 'all' ? all : all.filter((r) => r.type && r.type.group === S.kind);
  paintKpis(rows, all);
  paintUnusual(rows);
  paintMovers(rows);
  paintAll(rows);
  paintSources(rows, all);
}

/** The "how this is calculated" panels of the summary cards and the tables. */
function paintSources(rows, all) {
  const moved = rows.filter((r) => r.move != null);
  const only = S.kind === 'all' ? '' : ` (${KIND_WORD[S.kind].trim()} markets only)`;
  const none = '<p class="what">No market has a live price and yesterday\'s close yet.</p>';
  // The query's first two steps, for every panel below: the live prices, then each market's move and z.
  const start = (list, extra = false) => {
    const live = livePrices(list, { volume: extra });
    return { live, full: `${live.full},\n${todaySql(live.bc, extra)}`, shown: `${live.shown},\n${todaySql(live.bc, extra)}` };
  };
  const panel = (id, what, q, tail, now, csv, { dbxTail = tail, evidence = false, volume = false } = {}) => panelHtml({
    what, id, title: 'The query (SQL)', sql: `${q.full}\n${tail}`, shown: `${q.shown}\n${tail}`, dbx: toDbx(`${q.full}\n${dbxTail}`),
    now, sources: sourcesTable({ bc: q.live.bc, evidence, volume }), csv,
  });

  let kpi = '';
  if (S.src === 'kpi-btc') {
    const btc = all.find((r) => r.sym === 'BTCUSDT');
    kpi = btc ? `<p class="what"><b>Bitcoin</b> is the BTCUSDT perpetual (on TradingView: BINANCE:BTCUSDT.P), not the spot market.</p>${marketPanel(btc)}` : '<p class="what">No Bitcoin price yet.</p>';
  } else if (S.src && S.src.startsWith('kpi-')) {
    if (!moved.length) kpi = none;
    else {
      const q = start(moved);
      const up = moved.filter((r) => r.move > 0).length, down = moved.filter((r) => r.move < 0).length;
      const sorted = moved.map((r) => r.move).sort((a, b) => a - b);
      const median = (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
      if (S.src === 'kpi-breadth') {
        kpi = panel('kpi-breadth', `<b>Breadth</b> is the share of markets that are up today${only}.`, q, `SELECT SUM(CASE WHEN move > 0 THEN 1 ELSE 0 END) AS up,
       SUM(CASE WHEN move < 0 THEN 1 ELSE 0 END) AS down,
       COUNT(*) AS markets,
       ROUND(100.0 * SUM(CASE WHEN move > 0 THEN 1 ELSE 0 END) / COUNT(*)) AS breadth_pct
FROM today;`, `up ${up} · down ${down} · markets ${moved.length} · breadth_pct ${Math.round((100 * up) / moved.length)}`, 'kpi');
      } else if (S.src === 'kpi-median') {
        kpi = panel('kpi-median', `<b>Median move</b> is the middle of today's moves${only}: half of the markets moved less, half more.`, q, `SELECT ROUND(100 * AVG(move), 2) AS median_pct     -- the middle move (or the average of the two middle ones)
FROM (SELECT move FROM today ORDER BY move
      LIMIT 2 - (SELECT COUNT(*) FROM today) % 2
      OFFSET (SELECT (COUNT(*) - 1) / 2 FROM today)) middle;`, `median_pct ${(100 * median).toFixed(2)}`, 'kpi', {
          dbxTail: 'SELECT ROUND(100 * percentile(move, 0.5), 2) AS median_pct   -- the middle move\nFROM today;',
        });
      } else if (S.src === 'kpi-unusual') {
        const uUp = moved.filter((r) => r.unusual && r.z > 0).length, uDown = moved.filter((r) => r.unusual && r.z < 0).length;
        kpi = panel('kpi-unusual', `<b>Unusual now</b> counts the markets that have moved ${RULE.z} or more of their usual daily moves today${only}.`, q, `SELECT SUM(CASE WHEN z >= 3 THEN 1 ELSE 0 END) AS unusual_up,
       SUM(CASE WHEN z <= -3 THEN 1 ELSE 0 END) AS unusual_down
FROM today;`, `unusual_up ${uUp} · unusual_down ${uDown}`, 'kpi');
      }
    }
  }
  put('mkt-kpi-src', kpi ? `<div class="mkt-src">${kpi}</div>` : '');

  const flagged = moved.filter((r) => r.unusual);
  put('mkt-unusual-src', srcBox('unusual', !moved.length ? none : (() => {
    const q = start(moved);
    return panel('unusual', `<b>Unusual right now</b>: every column of the table as one query. It keeps the markets whose z is ${RULE.z} or more either way, then looks up what moves of the same kind (direction, size band, liquidity) did next. The small line under each verdict is the same lookup with <code>z_band = 'all'</code> and <code>liquidity = 'all'</code>; <b>Since</b> is when this page first saw the market unusual.`,
      { ...q, full: `${q.full},\n${FLAGGED}`, shown: `${q.shown},\n${FLAGGED}` }, `SELECT f.symbol AS market,
       f.price,
       ROUND(100 * f.move, 2) AS today_pct,
       ROUND(f.z, 1) AS z,
       f.liquidity,
       ${HORIZONS.map(verdict).join(',\n       ')}
FROM flagged f
${EVIDENCE_JOINS}
ORDER BY ABS(f.z) DESC;`, `${flagged.length} markets`, 'unusual', { evidence: true });
  })()));

  put('mkt-movers-src', srcBox('movers', !moved.length ? none : panel('movers', `<b>Movers today</b>: the eight biggest gains and the eight biggest losses since yesterday's close${only}.`, start(moved), `SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z
FROM today
ORDER BY move DESC          -- Up the most (Down the most: ORDER BY move ASC)
LIMIT 8;`, '', 'moved')));

  const sorted = { z: 'ABS(z) DESC          -- Most unusual', up: 'move DESC            -- Gainers', down: 'move ASC             -- Losers', vol: 'volume_x DESC        -- Volume' }[S.sort];
  const shown = S.q ? moved.filter((r) => r.sym.includes(S.q) || (r.type && r.type.label.toUpperCase().includes(S.q))) : moved;
  put('mkt-every-src', srcBox('every', !shown.length ? none : panel('every', `<b>Every market</b>: every column of the table as one query${only}${S.q ? `, for the markets matching “${esc(S.q)}”` : ''}.`, start(shown, true), `SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z,
       ROUND(100 * sd_return_30d, 2) AS usual_day_pct,
       ROUND(volume_x, 1) AS volume_x,
       liquidity
FROM today
ORDER BY ${sorted};`, '', 'every', { volume: true })));
}

/** A market's details: its move in words, the evidence when unusual, and how every number is calculated. */
function marketDetail(r) {
  const t = r.type, b = r.b, dir = r.z > 0 ? 'up' : 'down';
  const who = `${name(r.sym)}${t ? ` (${esc(t.label)})` : ''}`;
  let html = r.move == null
    ? `<p>${who}: not scored yet${S.live.get(r.sym) ? ', yesterday\'s close is missing' : ', no live price yet'}.</p>`
    : `<p>${who} has moved ${pct(r.move)} since yesterday's close${r.z != null ? `: ${sig(r.z)}, ${Math.abs(r.z).toFixed(1)} times its usual daily move (${size(b.sd_return_30d)} over its last ${b.history_days} days)` : ''}.${r.unusual ? ` Its own group: ${kindPhrase(dir, zBand(r.z), r.liq)} (average ${Math.round((b.avg_quote_volume_30d || 0) / 1e6).toLocaleString('en-US')} million USDT a day).` : ''}</p>`;
  if (r.unusual) {
    if (t && t.group !== 'crypto') html += `<p class="warn">${name(r.sym)} is a ${esc(t.label.toLowerCase())} perpetual. Almost all the history behind the evidence is crypto: the side of each pattern was chosen on 2020–2024, when Binance had almost no stock, commodity or currency perpetuals. Treat the evidence with extra care here.</p>`;
    html += evidenceFor(S.data.ev, r.z, r.liq).map((e, i) => evWords(e, HORIZONS[i])).join('');
    html += `<p><b>For comparison, a wider group</b>, every ${dir} move together (any size, any market): ${HORIZONS.map((h) => `next ${h} h ${evShort(S.data.ev.get(evKey(dir, 'all', 'all', h)))}`).join(' · ')}. ${name(r.sym)}'s own group is the closer match; the wider group has many more examples but mixes very different moves.</p>`;
  }
  return `<div class="mkt-more">${html}<div class="mkt-src">${marketPanel(r)}</div></div>`;
}

/** Every trading market with its live price, move today, z, liquidity, type and volume against normal. */
function compute() {
  const out = [], now = Date.now();
  for (const b of S.data.base.values()) {
    if (b.status === 'not trading') continue;
    const l = S.live.get(b.symbol);
    const s = l && S.ref ? score(b, l.price, S.ref.close.get(b.symbol)) : null;
    const avgVol = b.avg_quote_volume_30d || 0;
    const r = {
      b, sym: b.symbol, type: typeOf(b.symbol), price: l ? l.price : null, move: s ? s.move : null, z: s ? s.z : null,
      unusual: !!(s && s.unusual), liq: liquidity(avgVol), volx: l && l.q > 0 && avgVol > 0 ? l.q / avgVol : null,
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
      : S.ref.src === 'binance' ? `Today's move is measured from yesterday's (${shortDay(y)}) close, from Binance (the lakehouse publishes ${shortDay(y)} at about 13:30 UTC)${S.ref.missing ? `; ${S.ref.missing} markets without it aren't scored` : ''}`
        : `Yesterday's closes couldn't be fetched from Binance, so ${S.ref.missing} markets aren't scored until the lakehouse publishes ${shortDay(y)} (about 13:30 UTC)`;
  put('mkt-status', `
    <div class="row"><span>${live}</span><span class="faint">${priced} markets priced</span></div>
    <div class="row faint"><span>Each market's normal: lakehouse day ${shortDay(pub.as_of)}${pub.published_at ? `, published ${clock(pub.published_at)}` : ''}</span><span>${ref}</span></div>
    <div class="row faint"><span>Live numbers are unchecked until the next daily run; the evidence is history, not a trading signal.</span></div>`);
}

function paintKpis(rows, all) {
  const moved = rows.filter((r) => r.move != null);
  const up = moved.filter((r) => r.move > 0).length, down = moved.filter((r) => r.move < 0).length;
  const sorted = moved.map((r) => r.move).sort((a, b) => a - b);
  const median = sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : null;
  const uUp = rows.filter((r) => r.unusual && r.z > 0).length, uDown = rows.filter((r) => r.unusual && r.z < 0).length;
  const btc = all.find((r) => r.sym === 'BTCUSDT');
  const kpi = (id, k, v, s) => `<div class="kpi"><div class="k"><span class="kt">${k}</span>${srcBtn(id)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  put('mkt-kpis', [
    kpi('kpi-breadth', 'Breadth', moved.length ? `${Math.round((up / moved.length) * 100)}% up` : '–', `${up} up · ${down} down`),
    kpi('kpi-median', 'Median move', `<span class="${tone(median)}">${pct(median)}</span>`, `of ${moved.length} ${KIND_WORD[S.kind]}markets`),
    kpi('kpi-unusual', 'Unusual now', `${uUp + uDown}`, `<span class="pos">${uUp} up</span> · <span class="neg">${uDown} down</span>`),
    kpi('kpi-btc', 'Bitcoin', btc && btc.price ? price(btc.price) : '–', btc ? `<span class="${tone(btc.move)}">${pct(btc.move)}</span> · ${sig(btc.z)}` : '–'),
  ].join(''));
}

/** A verdict in a few words: the side and its held-back result when the pattern held up. */
function evShort(e, strong = true) {
  if (!e) return '–';
  if (e.verdict === 'held up') return strong ? `<span class="mkt-ev">${e.side === 'fade' ? 'Fade' : 'Follow'} ${pct(e.held_back_net_after_cost)}</span>` : `<b>${e.side} ${pct(e.held_back_net_after_cost)}</b>`;
  return esc(e.verdict);
}

/** One evidence cell: this kind of move's verdict, and below it every move in that direction together. */
function evCell(e, wide, dir) {
  return `<div class="mkt-evc"><span class="v">${evShort(e)}</span>${wide !== undefined ? `<span class="mkt-ev-all">all ${dir}: ${evShort(wide, false)}</span>` : ''}</div>`;
}

/** The evidence in words, for the details. */
function evWords(e, h) {
  const span = h === 1 ? 'the next hour' : `the next ${h} hours`;
  if (!e) return `<p><b>${span[0].toUpperCase() + span.slice(1)}:</b> no evidence for this kind of move.</p>`;
  const went = e.avg_continuation == null ? '' : e.avg_continuation >= 0 ? `Over all those years it kept going on average (${pct(e.avg_continuation)})` : `Over all those years it turned back on average (${pct(e.avg_continuation)})`;
  const head = `<b>Over ${span}:</b> ${e.events ?? 0} similar moves on ${e.days ?? 0} days since 2020. ${went}${e.hit_rate != null ? `, and kept going ${Math.round(e.hit_rate * 100)}% of the time` : ''}.`;
  const side = e.side === 'fade' ? 'fade the move, betting it turns back' : 'follow the move';
  const verdict = {
    'held up': `2020–2024 chose to ${side} (t ${tval(e.in_sample_t)}). From 2025 it still worked: ${pct(e.held_back_net_after_cost)} a trade after ${size(e.round_trip_cost)} costs (t ${tval(e.held_back_t)} over ${e.held_back_days} days). <b>Held up.</b>`,
    'did not hold': `2020–2024 pointed to ${side} (t ${tval(e.in_sample_t)}), but from 2025 it didn't pay after ${size(e.round_trip_cost)} costs (${pct(e.held_back_net_after_cost)}, t ${tval(e.held_back_t)}). <b>Did not hold.</b>`,
    'no pattern': `In 2020–2024 alone, where the side is chosen, there was no clear pattern (t ${tval(e.in_sample_t)}), so there is no side to take. <b>No pattern.</b>`,
    'too few': `Too few days to judge (${e.in_sample_days ?? 0} in 2020–2024, ${e.held_back_days ?? 0} from 2025; 20 needed in each). <b>Too few.</b>`,
  }[e.verdict] || esc(e.verdict);
  return `<p>${head} ${verdict}</p>`;
}

const KEY = `<p class="mkt-key"><b>z</b> = today's move ÷ the market's usual daily move (<b>σ</b>, the spread of its daily moves over its last 30 days); ${RULE.z}σ or more is unusual. <b>Next 1 h / 4 h / 24 h</b>: what moves of the same kind (direction, size, liquidity) did next since 2020. <b>Fade</b> or <b>Follow</b> with a result means the pattern held up on years held back from the choice, after costs; otherwise the verdict. The small line is every up (or down) move together, a wider group.</p>`;

function paintUnusual(rows) {
  const list = rows.filter((r) => r.unusual).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  if (!list.length) {
    put('mkt-unusual', `<div class="mkt-empty">${S.ref && S.live.size ? `No ${KIND_WORD[S.kind]}market is unusual right now: none has moved ${RULE.z} or more of its usual daily moves today.` : 'Waiting for prices…'}</div>`);
    return;
  }
  const ev = S.data.ev;
  const body = list.map((r) => {
    const dir = r.z > 0 ? 'up' : 'down';
    return `<tr data-mkt="row" data-sym="${esc(r.sym)}" aria-selected="${S.open === r.sym}">
      <td class="sym">${market(r.sym)}</td><td>${price(r.price)}</td><td class="${tone(r.move)}">${pct(r.move)}</td>
      <td><span class="mkt-tag ${dir}">${sig(r.z)}</span></td><td class="l">${LIQ[r.liq]}</td>
      ${evidenceFor(ev, r.z, r.liq).map((e, i) => `<td>${evCell(e, ev.get(evKey(dir, 'all', 'all', HORIZONS[i])) || null, dir)}</td>`).join('')}
      <td class="faint">${clock(S.seen.get(r.sym))}</td></tr>`;
  }).join('');
  // The chosen market's details sit under the table (not in it), so the text always fits the screen.
  const r = list.find((x) => x.sym === S.open);
  const more = r ? marketDetail(r) : '';
  put('mkt-unusual', `<div class="scroll-x"><table class="mkt-table"><thead><tr><th>Market</th><th>Price</th><th>Today</th><th title="${Z_TIP}">z (σ)</th><th class="l" title="${LIQ_TIP}">Liquidity</th><th>Next 1 h</th><th>Next 4 h</th><th>Next 24 h</th><th title="When this page first saw it unusual">Since</th></tr></thead><tbody>${body}</tbody></table></div>${KEY}${more}`);
}

function paintMovers(rows) {
  const moved = rows.filter((r) => r.move != null);
  const table = (list) => (list.length
    ? `<div class="scroll-x"><table class="mkt-table"><thead><tr><th>Market</th><th>Price</th><th>Today</th><th title="${Z_TIP}">z (σ)</th></tr></thead><tbody>${list.map((r) => `<tr><td class="sym">${market(r.sym)}</td><td>${price(r.price)}</td><td class="${tone(r.move)}">${pct(r.move)}</td><td>${sig(r.z)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="mkt-empty">Waiting for prices…</div>');
  const gain = [...moved].sort((a, b) => b.move - a.move).slice(0, 8).filter((r) => r.move > 0);
  const lose = [...moved].sort((a, b) => a.move - b.move).slice(0, 8).filter((r) => r.move < 0);
  put('mkt-movers', `<div class="mkt-movers"><div><h3>Up the most</h3>${table(gain)}</div><div><h3>Down the most</h3>${table(lose)}</div></div>`);
}

function paintAll(rows) {
  let list = S.q ? rows.filter((r) => r.sym.includes(S.q) || (r.type && r.type.label.toUpperCase().includes(S.q))) : rows;
  const key = { z: (r) => (r.z == null ? -1 : Math.abs(r.z)), up: (r) => (r.move == null ? -Infinity : r.move), down: (r) => (r.move == null ? -Infinity : -r.move), vol: (r) => (r.volx == null ? -1 : r.volx) }[S.sort];
  list = [...list].sort((a, b) => key(b) - key(a) || a.sym.localeCompare(b.sym));
  put('mkt-all-sub', `${list.length} ${KIND_WORD[S.kind]}markets${S.q ? ` matching “${esc(S.q)}”` : ''}; z is today's move in the market's usual daily moves (σ); volume is the last 24 hours against its usual day`);
  if (!list.length) { put('mkt-all', '<div class="mkt-empty">No market matches.</div>'); return; }
  const shown = list.slice(0, S.limit);
  const body = shown.map((r) => `<tr data-mkt="row" data-list="all" data-sym="${esc(r.sym)}" aria-selected="${S.openAll === r.sym}"><td class="sym">${market(r.sym)}</td><td>${price(r.price)}</td><td class="${tone(r.move)}">${pct(r.move)}</td>
    <td>${r.unusual ? `<span class="mkt-tag ${r.z > 0 ? 'up' : 'down'}">${sig(r.z)}</span>` : sig(r.z)}</td>
    <td>${size(r.b.sd_return_30d)}</td><td>${volx(r.volx)}</td><td class="l">${LIQ[r.liq]}</td></tr>`).join('');
  const picked = shown.find((r) => r.sym === S.openAll);
  const more = list.length > S.limit ? `<button class="btn btn-sm mkt-more-btn" data-mkt="more">Show ${Math.min(50, list.length - S.limit)} more (of ${list.length - S.limit})</button>` : '';
  put('mkt-all', `<div class="scroll-x"><table class="mkt-table"><thead><tr><th>Market</th><th>Price</th><th>Today</th><th title="${Z_TIP}">z (σ)</th><th title="The market's usual daily move (σ) over its last 30 days">Usual day</th><th title="USDT traded in the last 24 hours ÷ its usual day">Volume</th><th class="l" title="${LIQ_TIP}">Liquidity</th></tr></thead><tbody>${body}</tbody></table></div>${picked ? marketDetail(picked) : ''}${more}`);
}

/* ---------- Patterns: every kind of move and what it did next ---------- */

function paintPatterns(rows) {
  const ev = S.data.ev;
  const evRows = [...ev.values()];
  const count = (v) => evRows.filter((e) => e.verdict === v).length;
  const total = (dir) => (ev.get(evKey(dir, 'all', 'all', 1)) || {}).events || 0;
  const now = (dir, band, liq) => rows.filter((r) => r.unusual && (r.z > 0 ? 'up' : 'down') === dir && (band === 'all' || (zBand(r.z) === band && r.liq === liq)));
  const pub = S.data.published.market_evidence || {};

  const held = evRows.filter((e) => e.verdict === 'held up').sort((a, b) => b.held_back_net_after_cost - a.held_back_net_after_cost);
  const heldHtml = held.length ? held.map((e) => {
    const m = now(e.direction, e.z_band, e.liquidity);
    return `<div><b>${e.side === 'fade' ? 'Fade' : 'Follow'} ${kindPhrase(e.direction, e.z_band, e.liquidity)}, over the next ${e.horizon_hours === 1 ? 'hour' : `${e.horizon_hours} hours`}:</b> <span class="mkt-ev">${pct(e.held_back_net_after_cost)}</span> a trade from 2025 after ${size(e.round_trip_cost)} costs (t ${tval(e.held_back_t)} over ${e.held_back_days} days), chosen on 2020–2024 (t ${tval(e.in_sample_t)} over ${e.in_sample_days} days). ${e.events} moves on ${e.days} days in all. Right now: ${m.length ? m.map((r) => name(r.sym)).join(', ') : 'no market'}.</div>`;
  }).join('') : '<div>No kind of move held up.</div>';

  const groups = [];
  for (const dir of ['up', 'down']) {
    groups.push(`<tr class="grp"><td colspan="5">${dir === 'up' ? 'Up moves' : 'Down moves'}</td></tr>`);
    for (const [band, liq] of [...BANDS.flatMap((b) => LIQS.map((l) => [b, l])), ['all', 'all']]) {
      const n = now(dir, band, liq).length;
      const cells = HORIZONS.map((h) => {
        const k = evKey(dir, band, liq, h);
        return `<td data-mkt="pat" data-k="${k}" aria-selected="${S.pat === k}">${evCell(ev.get(k) || null)}</td>`;
      }).join('');
      groups.push(`<tr><td class="l">${kindName(dir, band, liq)}</td><td>${n || '<span class="faint">0</span>'}</td>${cells}</tr>`);
    }
  }
  let detail = '';
  if (S.pat && ev.get(S.pat)) {
    const e = ev.get(S.pat);
    const m = now(e.direction, e.z_band, e.liquidity);
    detail = `<div class="mkt-more"><p><b>${kindName(e.direction, e.z_band, e.liquidity)}</b>${e.z_band === 'all' ? ' (any size, any market)' : ''}.</p>${evWords(e, e.horizon_hours)}<p>Right now: ${m.length ? m.map((r) => `${name(r.sym)} ${sig(r.z)}`).join(', ') : 'no market is in this group'}.</p>
      <h4>Where these numbers come from</h4><p>The lakehouse's <code>gold.event_evidence</code> (${ghLink('event_evidence.sql')}), built from <code>gold.intraday_events</code> (${ghLink('intraday_events.sql')}), copied to MEDUSA's <code>market_evidence</code>. <b>Now</b> is live, as on Today.</p>${evidenceSql(e.direction, e.z_band, e.liquidity)}</div>`;
  }

  put('mkt-patterns', `
    <section class="card">
      <div class="card-head"><div><h2>What similar moves did next</h2><p>Every time a market's move during a day reached ${RULE.z} of its usual daily moves since January 2020, the lakehouse recorded what the price did over the next 1, 4 and 24 hours: about ${(total('up') + total('down')).toLocaleString('en-US')} moves (${total('up').toLocaleString('en-US')} up, ${total('down').toLocaleString('en-US')} down), almost all of them crypto. Lakehouse day ${shortDay(pub.as_of)}.</p></div>${srcBtn('patterns')}</div>
      ${srcBox('patterns', `<p>Everything in this view comes from the lakehouse, except <b>Now</b> and <b>Right now</b>, which are live, as on Today. Two dbt models build it on every daily run: ${ghLink('intraday_events.sql')} (every unusual move since 2020 and the price 1, 4 and 24 hours later) and ${ghLink('event_evidence.sql')} (the verdicts, judged by days, on 2020–2024 and then on 2025 onwards). The publish job copies the verdicts to MEDUSA's <code>market_evidence</code>${pub.published_at ? `, last at ${clock(pub.published_at)}` : ''}.</p>
        ${sqlBlock('Every verdict (Databricks SQL)', 'SELECT direction, z_band, liquidity, horizon_hours, verdict, side, events, days,\n       in_sample_days, in_sample_t, held_back_days, held_back_t, held_back_net_after_cost\nFROM market.gold.event_evidence\nORDER BY direction, z_band, liquidity, horizon_hours;')}
        ${sqlBlock('How many moves, and when (Databricks SQL)', 'SELECT direction, period, COUNT(*) AS moves, COUNT(DISTINCT event_date) AS days\nFROM market.gold.intraday_events\nGROUP BY direction, period\nORDER BY direction, period;')}
        ${sqlBlock("The same verdicts, in MEDUSA's copy (D1)", 'SELECT *\nFROM market_evidence\nORDER BY direction, z_band, liquidity, horizon_hours;')}`)}
      <div class="mkt-counts"><span><b>${count('held up')}</b> held up</span><span><b>${count('did not hold')}</b> did not hold</span><span><b>${count('no pattern')}</b> no pattern</span><span><b>${count('too few')}</b> too few</span><span>of <b>${evRows.length}</b> kinds of move and horizons</span></div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Patterns that held up</h2><p>Chosen on 2020–2024 and still profitable after costs from 2025, on years that played no part in choosing them</p></div></div>
      <div class="mkt-held">${heldHtml}</div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Every kind of move</h2><p>By direction, size (z) and the market's liquidity; <b>Now</b> counts the markets in each group right now. Tap a cell for the details.</p></div></div>
      <div class="scroll-x"><table class="mkt-table"><thead><tr><th>Kind of move</th><th title="Markets in this group right now">Now</th><th>Next 1 h</th><th>Next 4 h</th><th>Next 24 h</th></tr></thead><tbody>${groups.join('')}</tbody></table></div>
      ${detail}
    </section>
    <section class="card">
      <div class="card-head"><div><h2>How a verdict is decided</h2></div></div>
      <ul class="mkt-rules">
        <li><b>Days, not moves.</b> Markets move together: one crash day can give hundreds of moves, and they aren't hundreds of separate proofs. Each day's moves are averaged first, and the statistics are over days.</li>
        <li><b>t</b> measures how clearly the moves kept going (positive) or turned back (negative), given how much they vary from day to day; beyond ±2 is unlikely to be chance.</li>
        <li><b>The side is chosen on 2020–2024 only.</b> If moves kept going there with t ≥ 2, the side is <b>follow</b>; if they turned back with t ≤ −2, it is <b>fade</b>; otherwise there is <b>no pattern</b>.</li>
        <li><b>It is then checked on 2025 onwards</b>, which played no part in the choice. <b>Held up</b> needs the moves to behave the same way there (t ≥ 2 for follow, t ≤ −2 for fade) and a profit after ${size((evRows[0] || {}).round_trip_cost)} round-trip costs in both periods; otherwise it <b>did not hold</b>.</li>
        <li><b>Too few</b>: fewer than 20 days in either period.</li>
        <li>With ${evRows.length} groups tested, a few can pass by luck, which is why the held-back check matters and why the rules aren't tuned after looking at it (ADR-022). Costs are optimistic for small markets, funding isn't counted, and almost all the history is crypto. This is research, not trading advice.</li>
      </ul>
    </section>`);
}

/* ---------- data: the lakehouse's copy, market types, yesterday's closes, live prices ---------- */

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

/* What each market is (crypto, stock, commodity...), from Binance's contract list (about 1 MB), once a
   day per browser; only a short type per market is kept in local storage. */
async function loadTypes() {
  const day = utcDay(Date.now());
  if (S.typesDay === day) return;
  S.typesDay = day;
  let kept = api.store.get('mkt.types', null);
  if (!kept || kept.day !== day || !kept.map) {
    try {
      const r = await fetch(`${REST}/exchangeInfo`, { credentials: 'omit' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const map = {};
      for (const s of (await r.json()).symbols || []) if (s.quoteAsset === 'USDT') map[s.symbol] = [s.underlyingType || '', s.underlyingSubType || []];
      kept = { day, map };
      api.store.set('mkt.types', kept);
    } catch (e) {
      api.log('markets', `Binance's contract list couldn't be loaded: ${e.message}`, null, 'debug');
      if (!kept || !kept.map) { S.typesDay = null; return; }   // try again on the next check; an older list is better than none
    }
  }
  S.types = new Map(Object.entries(kept.map).map(([sym, [u, sub]]) => [sym, marketType(u, sub)]));
  schedule();
}

// Today's move is measured from yesterday's close. The lakehouse has it after its daily run (about
// 13:30 UTC); before that its newest day is the day before, so yesterday's closes come from Binance's
// daily candles instead: one small request per market, once a day per browser (kept in local storage).
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
      } catch { /* this market stays unscored */ }
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
    if (missing) api.log('markets', `Yesterday's close is missing for ${missing} of ${need.length} markets`, null, 'debug');
  }
  if (S.refBusy !== day) return;   // the day changed meanwhile: a newer run takes over
  S.ref = { day, close, src, missing };
  S.refBusy = null;
  schedule();
}

/* Binance sends only the markets that changed in each message, so one snapshot of every price fills in
   the quiet ones at the start. */
async function snapshot() {
  try {
    const r = await fetch(`${REST}/ticker/price`, { credentials: 'omit' });
    if (!r.ok) return;
    for (const p of await r.json()) if (!S.live.has(p.symbol)) S.live.set(p.symbol, { price: Number(p.price), q: null, t: p.time, raw: p, via: 'snapshot' });
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
    for (const t of d) if (t && t.s) S.live.set(t.s, { price: Number(t.c), q: Number(t.q), t: t.E, raw: t, via: 'stream' });
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
   publish, and move to a new reference close (and contract list) at midnight UTC. */
function watch() {
  if (S.stopped) return;
  if (S.ws && S.wsState === 'live' && Date.now() - S.lastMsg > 30_000) S.ws.close();
  if (S.data && Date.now() - S.data.at > 30 * 60_000) load().then(ensureRef);
  else ensureRef();
  loadTypes();
  schedule();
}

async function start() {
  if (!S.data || S.loadErr || Date.now() - S.data.at > 30 * 60_000) { await load(); paint(); }
  if (S.stopped || !S.data || S.loadErr) return;
  connect();
  if (Date.now() - S.snapAt > 60_000) snapshot();
  loadTypes();
  ensureRef();
  if (!S.tick) S.tick = setInterval(watch, 10_000);
}

/* ---------- entry points (app.js) ---------- */

/** Every market behind a number, with each input exactly as used now and where it came from. */
function downloadCsv(scope) {
  const all = compute();
  let rows = S.kind === 'all' ? all : all.filter((r) => r.type && r.type.group === S.kind);
  if (scope === 'unusual') rows = rows.filter((r) => r.unusual);
  else if (scope === 'moved') rows = rows.filter((r) => r.move != null);
  else if (scope === 'every' && S.q) rows = rows.filter((r) => r.sym.includes(S.q) || (r.type && r.type.label.toUpperCase().includes(S.q)));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
  const head = ['market', 'type', 'price', 'price_time_utc', 'price_source', 'yesterday_close', 'close_source', 'move_today', 'avg_return_30d',
    'sd_return_30d', 'history_days', 'z', 'unusual', 'avg_quote_volume_30d', 'liquidity', 'quote_volume_24h', 'lakehouse_day'];
  const lines = rows.map((r) => {
    const l = S.live.get(r.sym), close = S.ref ? S.ref.close.get(r.sym) : null;
    return [r.sym, r.type ? r.type.label : '', l ? l.price : '', l ? iso(l.t) : '', l ? `binance ${l.via}` : '', close,
      close == null ? '' : r.b.as_of_date === S.ref.day ? 'lakehouse market_baseline' : 'binance daily candle', r.move, r.b.avg_return_30d,
      r.b.sd_return_30d, r.b.history_days, r.z, r.unusual, r.b.avg_quote_volume_30d, r.liq, l && l.q ? l.q : '', r.b.as_of_date].map(csvCell).join(',');
  });
  const blob = new Blob([`﻿${[head.join(','), ...lines].join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `medusa-markets-${scope}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}Z.csv`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  api.log('markets', `Downloaded the inputs (${scope}, ${rows.length} markets)`);
}

function onClick(e) {
  const el = e.target.closest('[data-mkt]');
  if (!el || !host.contains(el)) return;
  const act = el.dataset.mkt;
  if (act === 'retry') { S.loadErr = null; paint(); start(); return; }
  if (act === 'copy') {
    const q = el.dataset.sql ? S.sql.get(el.dataset.sql) : null;
    const sql = q ? q[el.dataset.db] : el.closest('.mkt-sql').querySelector('pre').textContent;
    const where = el.dataset.db === 'dbx' ? ' for Databricks' : el.dataset.db === 'd1' ? ' for MEDUSA\'s D1' : '';
    navigator.clipboard.writeText(sql).then(() => api.toast(`Query copied${where}.`), () => api.toast('Copying isn\'t allowed here: select the query and copy it.', 'error'));
    return;
  }
  if (act === 'csv') { downloadCsv(el.dataset.scope); return; }
  if (act === 'view') { S.view = el.dataset.v; api.store.set('mktView', S.view); }
  else if (act === 'kind') { S.kind = el.dataset.v; S.limit = 50; api.store.set('mktKind', S.kind); }
  else if (act === 'sort') { S.sort = el.dataset.v; S.limit = 50; }
  else if (act === 'more') S.limit += 50;
  else if (act === 'src') S.src = S.src === el.dataset.id ? null : el.dataset.id;
  else if (act === 'row' && el.dataset.list === 'all') S.openAll = S.openAll === el.dataset.sym ? null : el.dataset.sym;
  else if (act === 'row') S.open = S.open === el.dataset.sym ? null : el.dataset.sym;
  else if (act === 'pat') S.pat = S.pat === el.dataset.k ? null : el.dataset.k;
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
    S.view = api.store.get('mktView', 'today') === 'patterns' ? 'patterns' : 'today';
    S.kind = KINDS.some(([v]) => v === api.store.get('mktKind', 'all')) ? api.store.get('mktKind', 'all') : 'all';
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
