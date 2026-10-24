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
//
// Every number on the Today view is calculated by SQL: the queries in markets-metrics.js run in a
// SQLite database inside the browser (markets-sql.js, a background worker) that holds the lakehouse's
// two tables, the live prices and Binance's contract list. This file only feeds those tables, runs the
// queries about once a second and draws what they return; each number's query is shown under it,
// exactly as it runs. The rule is the lakehouse's own (intraday_events.sql), so the evidence describes
// exactly the moves flagged here. Live numbers are unchecked: the next daily run replaces them.
//
// Two views: Today (the live scan) and Patterns (every kind of move and what it did next).

import { DEFINITIONS } from './markets-metrics.js?v=1';

const RULE = { z: 3 };
const STREAM = 'wss://fstream.binance.com/market/ws/!miniTicker@arr';
const REST = 'https://fapi.binance.com/fapi/v1';
const ENGINE = '/markets-sql.js?v=1';
const DAY = 86_400_000;
const HORIZONS = [1, 4, 24];
const BANDS = ['3-4', '4-6', '6+'], LIQS = ['large', 'mid', 'small'];

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const evKey = (direction, band, liq, hours) => `${direction}|${band}|${liq}|${hours}`;
const yesterday = () => utcDay(Date.now() - DAY);

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

/* ---------- the queries: a definition plus the shared steps (models) it reads ---------- */

const DEFS = new Map(DEFINITIONS.map((d) => [d.id, d]));
const BROWSER_TABLES = {   // column -> type, for an empty value in the first row of VALUES
  live_prices: { symbol: 'STRING', price: 'DOUBLE', quote_volume_24h: 'DOUBLE' },
  binance_markets: { symbol: 'STRING', market_type: 'STRING', yesterday_close: 'DOUBLE' },
};

const noComments = (sql) => sql.replace(/--[^\n]*/g, '');
/** The tables and models a query reads (whatever follows FROM or JOIN). */
export const reads = (sql) => [...noComments(sql).matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w.]*)/gi)].map((m) => m[1].toLowerCase());

/** The models a query reads, directly or through other models, each after the ones it needs. */
function modelsOf(sql, out = []) {
  for (const t of reads(sql)) {
    const d = DEFS.get(t);
    if (d && d.kind === 'model' && !out.includes(t)) { modelsOf(d.sql, out); out.push(t); }
  }
  return out;
}

const literal = (v) => (v == null ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`);
const tidy = (s) => s.replace(/ {3,}--/g, '  --');   // each comment right after its code, so it fits a phone
const toDbx = (sql) => sql.replace(/\bmarket_baseline\b/g, 'market.gold.coin_baseline').replace(/\bmarket_evidence\b/g, 'market.gold.event_evidence');

/** One complete query: the models it reads go in front as WITH ... AS (...), so it runs as it is.
 * With `inputs` (the browser-only tables' rows) it is made to run elsewhere too: those tables are
 * written in as VALUES and the parameters are filled in. */
export function assemble(def, { inputs = null, params = {} } = {}) {
  const models = modelsOf(def.sql);
  const steps = [];
  if (inputs) {
    const used = new Set(reads([def.sql, ...models.map((m) => DEFS.get(m).sql)].join('\n')));
    for (const [t, types] of Object.entries(BROWSER_TABLES)) {
      if (!used.has(t)) continue;
      const cols = Object.keys(types);
      const rows = (inputs[t] || []).length ? inputs[t] : [['', ...cols.slice(1).map(() => null)]];   // an empty table: one row that joins nothing
      // An empty value in the first row gets its column's type, so Databricks knows the type of the column.
      const vals = rows.map((r, i) => `(${r.map((v, j) => (v == null && i === 0 ? `CAST(NULL AS ${types[cols[j]]})` : literal(v))).join(', ')})`);
      steps.push(`${t}(${cols.join(', ')}) AS (VALUES   -- ${inputs.note[t]}\n  ${vals.join(',\n  ')}\n)`);
    }
  }
  for (const m of models) steps.push(`${m} AS (   -- ${DEFS.get(m).name}\n${DEFS.get(m).sql.replace(/^/gm, '  ')}\n)`);
  const own = def.sql.trim();
  const head = `-- ${def.name}: ${def.description}\n`;
  let sql = !steps.length ? own
    : /^WITH\s/i.test(own) ? `WITH ${steps.join(',\n')},\n${own.replace(/^WITH\s+/i, '')}`
      : `WITH ${steps.join(',\n')}\n${own}`;
  if (inputs) sql = sql.replace(/:([a-z_]+)\b/g, (m, k) => (k in params ? literal(params[k]) : m));
  return tidy(head + sql);
}

const PARAM_WORDS = {
  kind: 'the type chosen at the top of the page',
  yesterday: 'yesterday (UTC), the day today\'s move is measured from',
  symbol: 'the market',
};

/* ---------- state ---------- */

let api = null, host = null;
const S = {
  data: null, loadErr: null, loading: null,          // the lakehouse's copy: {published, raw, base, ev, at}
  live: new Map(), snapAt: 0, dirty: new Set(),      // symbol -> {price, q (USDT traded in the last 24 h), t, raw, via}; changed since the last run
  ref: null, refBusy: null, refDone: 0, refTotal: 0, // yesterday's closes: {day, close: Map, binance: Map, src, missing}
  types: new Map(), typesDay: null, marketsVer: 0,   // symbol -> {group, label}; bumped when the types or Binance closes change
  ws: null, wsState: 'off', everOpen: false, fails: 0, lastMsg: 0, retry: 0, tick: 0, stopped: true,
  eng: { w: null, ready: null, ok: false, err: null, seq: 0, wait: new Map(), loadedAt: null, marketsVer: -1 },
  sent: new Map(), sentMarkets: [],                  // what the engine's live_prices and binance_markets hold now
  res: new Map(), lastRun: null, running: false, again: false, urgent: false, runErr: null,
  frozen: null,                                      // the engine's browser-only tables as of the last run, for Copy
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
const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');
const clockS = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');
const name = (sym) => esc(String(sym).replace(/USDT$/, ''));
const typeOf = (sym) => S.types.get(sym) || null;
const market = (sym) => { const t = typeOf(sym); return `${name(sym)}${t ? `<span class="mkt-kind">${esc(t.label)}</span>` : ''}`; };
const LIQ = { large: 'Large', mid: 'Mid', small: 'Small' };
const LIQ_WORDS = { large: 'large', mid: 'mid-sized', small: 'small' };
const KINDS = [['all', 'All'], ['crypto', 'Crypto'], ['stock', 'Stocks'], ['commodity', 'Commodities'], ['other', 'Other']];
const KIND_WORD = { all: '', crypto: 'crypto ', stock: 'stock ', commodity: 'commodity ', other: 'other ' };
const kindName = (dir, band, liq) => (band === 'all' ? `Every ${dir} move` : `${dir === 'up' ? 'Up' : 'Down'} ${band}σ, ${LIQ_WORDS[liq]} markets`);
const kindPhrase = (dir, band, liq) => (band === 'all' ? `every ${dir} move`
  : `${dir} moves of ${band === '6+' ? '6σ or more' : `${band.replace('-', '–')}σ`} on ${LIQ_WORDS[liq]} markets`);

/** A verdict as a query returns it ("fade 4.11%", "no pattern"), for a table cell. */
function verdictText(v, strong = true) {
  if (v == null) return '–';
  const m = /^(fade|follow) (-?[\d.]+)%$/.exec(String(v));
  if (!m) return esc(v);
  const x = Number(m[2]) / 100;
  return strong ? `<span class="mkt-ev">${m[1] === 'fade' ? 'Fade' : 'Follow'} ${pct(x)}</span>` : `<b>${m[1]} ${pct(x)}</b>`;
}

/** How each column format is shown. Values are what the query returned: percentages are already ×100. */
const FMT = {
  market: (v) => (v == null ? '–' : market(v)),
  price: (v) => price(v),
  pct: (v) => (v == null ? '–' : `<span class="${tone(v)}">${pct(v / 100)}</span>`),
  pct_plain: (v) => (v == null ? '–' : `${Math.abs(v).toFixed(2)}%`),
  share: (v) => (v == null ? '–' : `${Math.round(v)}%`),
  z: (v, row) => (row && Number(row.unusual) === 1 ? FMT.z_tag(v) : sig(v)),
  z_tag: (v) => (v == null ? '–' : `<span class="mkt-tag ${v > 0 ? 'up' : 'down'}">${sig(v)}</span>`),
  liquidity: (v) => (v == null ? '–' : LIQ[v] || esc(v)),
  times: (v) => (v == null ? '–' : `×${v >= 10 ? Math.round(v) : Number(v).toFixed(1)}`),
  int: (v) => (v == null ? '–' : Number(v).toLocaleString('en-US')),
  int_up: (v) => `<span class="pos">${FMT.int(v)}</span>`,
  int_down: (v) => `<span class="neg">${FMT.int(v)}</span>`,
  verdict: (v, row, col) => {
    const sub = col && col.sub && row && col.sub in row
      ? `<span class="mkt-ev-all">all ${row.z > 0 ? 'up' : row.z < 0 ? 'down' : ''}: ${verdictText(row[col.sub], false)}</span>` : '';
    return `<div class="mkt-evc"><span class="v">${verdictText(v)}</span>${sub}</div>`;
  },
  auto: (v) => (v == null ? '–' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 6 }) : esc(v)),
};
const LEFT = new Set(['market', 'liquidity', 'auto-text']);

/** A query's rows as objects, by column name. */
const objects = (res) => (res && res.rows ? res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]]))) : []);

/** A card's text: {column:format} filled in from the first row of its query's result. */
function fillCard(tpl, res) {
  const row = res && !res.error ? objects(res)[0] : null;
  return tpl.replace(/\{(\w+)(?::(\w+))?\}/g, (m, col, f) => (row && col in row ? (FMT[f] || FMT.auto)(row[col], row) : '–'));
}

/** A query's result as a table, each column shown by its format (columns the definition doesn't list
 * are shown as they come). `row` adds attributes to each row; `extra` adds columns kept by the page. */
function resultTable(res, def, { row = null, extra = [] } = {}) {
  const spec = new Map((def.columns || []).map((c) => [c.name, c]));
  const cols = res.columns.map((n) => spec.get(n) || { name: n, label: n, format: 'auto' }).filter((c) => c.format !== 'hidden');
  const left = (c, v) => LEFT.has(c.format) || (c.format === 'auto' && typeof v === 'string') || c.format === undefined;
  const objs = objects(res);
  const head = cols.map((c) => `<th${left(c, objs[0] && objs[0][c.name]) ? ' class="l"' : ''}${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label || c.name)}</th>`).join('')
    + extra.map((x) => `<th${x.title ? ` title="${esc(x.title)}"` : ''}>${x.label}</th>`).join('');
  const body = objs.map((o) => `<tr${row ? ` ${row(o)}` : ''}>${cols.map((c) => {
    const v = o[c.name];
    const cls = c.format === 'market' ? ' class="sym"' : left(c, v) ? ' class="l"' : '';
    return `<td${cls}>${(FMT[c.format] || FMT.auto)(v, o, c)}</td>`;
  }).join('')}${extra.map((x) => `<td>${x.cell(o)}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll-x"><table class="mkt-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const failed = (res) => `<div class="mkt-empty"><b>The query failed:</b> ${esc(res.error)}</div>`;
const pending = () => `<div class="mkt-empty">${S.eng.err ? 'The SQL engine couldn\'t start.' : 'Calculating…'}</div>`;

/* ---------- the SQL engine (markets-sql.js) ---------- */

function call(msg, ms) {
  const e = S.eng, id = ++e.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      e.wait.delete(id);
      reject(new Error('The queries took too long, so the SQL engine was restarted.'));
      restartEngine();
    }, ms);
    e.wait.set(id, { resolve, reject, timer });
    e.w.postMessage({ ...msg, id });
  });
}

function startEngine() {
  const e = S.eng;
  if (e.ready) return e.ready;
  e.err = null;
  try {
    e.w = new Worker(ENGINE);
  } catch (err) {
    e.err = err.message;
    return null;
  }
  const failAll = (why) => { for (const [, p] of e.wait) { clearTimeout(p.timer); p.reject(new Error(why)); } e.wait.clear(); };
  e.w.onmessage = ({ data }) => {
    const p = e.wait.get(data.id);
    if (!p) return;
    e.wait.delete(data.id);
    clearTimeout(p.timer);
    if (data.ok) p.resolve(data.result); else p.reject(new Error(data.error));
  };
  e.w.onerror = (ev) => { if (ev.preventDefault) ev.preventDefault(); failAll(ev.message || 'The SQL engine stopped.'); };
  e.ready = call({ op: 'init' }, 30_000).then(() => {
    e.ok = true;
    schedule();
  }, (err) => {
    e.err = err.message;
    e.ready = null;
    if (e.w) { e.w.terminate(); e.w = null; }
    api.log('markets', `The SQL engine couldn't start: ${err.message}`, null, 'error');
    draw();
  });
  return e.ready;
}

/** A fresh engine: everything is sent again on the next run. */
function restartEngine() {
  const e = S.eng;
  if (e.w) e.w.terminate();
  for (const [, p] of e.wait) clearTimeout(p.timer);
  S.eng = { w: null, ready: null, ok: false, err: null, seq: e.seq, wait: new Map(), loadedAt: null, marketsVer: -1 };
  S.sent.clear();
  for (const s of S.live.keys()) S.dirty.add(s);
  startEngine();
}

/** binance_markets: each market's type, and yesterday's close where it came from Binance. */
function marketRows() {
  const bin = (S.ref && S.ref.binance) || new Map();
  const syms = new Set([...S.types.keys(), ...bin.keys()]);
  return [...syms].map((s) => [s, (S.types.get(s) || {}).group || null, bin.get(s) ?? null]);
}

/** The queries to run now, for the view on screen. */
function jobs() {
  const params = { ':kind': S.kind, ':yesterday': yesterday() };
  const job = (id, key = id, extra = {}) => ({ id: key, sql: assemble(DEFS.get(id)), params: { ...params, ...extra } });
  const out = [job('unusual_all_types')];
  if (S.view === 'today') {
    out.push(...['breadth', 'median_move', 'unusual_count', 'bitcoin', 'unusual', 'gainers', 'losers', 'markets'].map((id) => job(id)));
    for (const sym of new Set([S.open, S.openAll])) if (sym) out.push(job('market', `market:${sym}`, { ':symbol': sym }));
  }
  return out;
}

/** Bring the engine's tables up to date (only what changed) and run the queries. */
async function run() {
  const e = S.eng;
  const msg = { op: 'run', jobs: jobs() };
  if (e.loadedAt !== S.data.at) msg.load = S.data.raw;
  if (e.marketsVer !== S.marketsVer) msg.markets = marketRows();
  msg.prices = [...S.dirty].filter((s) => S.live.has(s)).map((s) => { const l = S.live.get(s); return [s, l.price, l.q ?? null]; });
  S.dirty.clear();
  const t0 = performance.now();
  let out;
  try {
    out = await call(msg, msg.load ? 30_000 : 15_000);   // normally about 50 ms; only a stuck engine is restarted
  } catch (err) {
    if (S.eng === e) restartEngine();   // its tables may be half updated: start again from scratch
    throw err;
  }
  if (S.eng !== e) return;   // the engine was restarted meanwhile
  if (msg.load) e.loadedAt = S.data.at;
  if (msg.markets) { e.marketsVer = S.marketsVer; S.sentMarkets = msg.markets; }
  for (const [s, p, q] of msg.prices) { const old = S.sent.get(s); S.sent.set(s, [p, q ?? (old ? old[1] : null)]); }
  S.frozen = { prices: new Map(S.sent), markets: S.sentMarkets, at: S.lastMsg };
  S.lastRun = { at: Date.now(), ms: Math.round(performance.now() - t0), n: msg.jobs.length };
  S.res = new Map(Object.entries(out));
  // When this page first saw each market unusual (kept by the page, not by a query).
  const now = Date.now(), flagged = new Set(objects(S.res.get('unusual_all_types')).map((r) => r.market));
  for (const s of flagged) if (!S.seen.has(s)) S.seen.set(s, now);
  for (const s of [...S.seen.keys()]) if (!flagged.has(s)) S.seen.delete(s);
}

/* ---------- "how this is calculated": each number's query, as it runs ---------- */

const GH = 'https://github.com/shivam65-sketch/medusa/blob/main/lakehouse/dbt/models/gold/';
const ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>';
const srcBtn = (id) => `<button class="mkt-src-btn" type="button" data-mkt="src" data-id="${id}" aria-pressed="${S.src === id}" title="How this is calculated" aria-label="How this is calculated">${ICON}</button>`;
const srcBox = (id, body) => (S.src === id ? `<div class="mkt-src">${body}</div>` : '');
const sqlBlock = (title, sql) => `<div class="mkt-sql"><div class="h"><span>${title}</span><button class="btn btn-sm" type="button" data-mkt="copy">Copy</button></div><pre>${esc(sql.trim())}</pre></div>`;
const ghLink = (file) => `<a href="${GH}${file}" target="_blank" rel="noopener">${file}</a>`;
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// Copy texts are built when Copy is pressed, from the tables as they were at the last run. A panel
// registers its queries here while it is drawn, and they are kept only if the panel was redrawn.
let PENDING = [];
const SOURCES = {
  live_prices: () => `Binance's live prices, kept up to date from the stream while this page is open (last message ${clockS(S.lastMsg)}). Only in this browser.`,
  binance_markets: () => 'Each market\'s type from Binance\'s contract list (once a day), and yesterday\'s close from Binance\'s daily candle until the lakehouse publishes yesterday (about 13:30 UTC). Only in this browser.',
  market_baseline: () => `Each market's normal (last close, average daily return, σ, days of history, average volume): MEDUSA's copy of the lakehouse's <code>gold.coin_baseline</code>, built by ${ghLink('coin_baseline.sql')}. Lakehouse day ${shortDay((S.data.published.market_baseline || {}).as_of)}.`,
  market_evidence: () => `What similar moves did next: MEDUSA's copy of the lakehouse's <code>gold.event_evidence</code>, built by ${ghLink('event_evidence.sql')}. Lakehouse day ${shortDay((S.data.published.market_evidence || {}).as_of)}.`,
};

/** A query's result exactly as it came back, for the panel. */
function rawResult(res) {
  if (!res) return '<p class="faint">Not run yet.</p>';
  if (res.error) return `<p class="warn"><b>The query failed:</b> ${esc(res.error)}</p>`;
  const shown = res.rows.slice(0, 6);
  const cell = (v) => (v == null ? '<span class="faint">NULL</span>' : esc(typeof v === 'number' ? String(v) : v));
  return `<p class="now"><b>Result now</b> <span class="faint">(${res.rows.length} row${res.rows.length === 1 ? '' : 's'}, ${res.ms} ms)</span></p>
    <div class="scroll-x"><table class="mkt-legend mkt-result"><thead><tr>${res.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${shown.map((r) => `<tr>${r.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${res.columns.length}" class="faint">No rows</td></tr>`}</tbody></table></div>
    ${res.rows.length > shown.length ? `<p class="faint">… and ${res.rows.length - shown.length} more rows (download the result for all of them)</p>` : ''}`;
}

/** One number's panel: what it is, its query as it runs here, the parameters, the result now and
 * where each table comes from, with copies that run in MEDUSA's D1 or in Databricks. */
function queryPanel(id, key = id, extra = {}) {
  const def = DEFS.get(id), res = S.res.get(key);
  const params = { kind: S.kind, yesterday: yesterday(), ...extra };
  const sql = assemble(def);
  PENDING.push([key, { id, params, frozen: S.frozen }]);
  const used = [...new Set([...sql.matchAll(/:([a-z_]+)\b/g)].map((m) => m[1]))].filter((p) => p in params);
  const tables = [...new Set(reads(sql))].filter((t) => t in SOURCES);
  return `<div class="mkt-q">
    <p class="what"><b>${esc(def.name)}</b>: ${esc(def.description)}</p>
    <div class="mkt-sql"><div class="h"><span>The query, exactly as this page runs it</span><span class="b">
      <button class="btn btn-sm" type="button" data-mkt="copy" data-sql="${esc(key)}" data-db="d1">Copy for MEDUSA (D1)</button>
      <button class="btn btn-sm" type="button" data-mkt="copy" data-sql="${esc(key)}" data-db="dbx">Copy for Databricks</button></span></div>
      <pre>${esc(sql)}</pre></div>
    ${used.length ? `<p class="mkt-params"><b>Parameters</b> ${used.map((p) => `<code>:${p}</code> = <code>${esc(literal(params[p]))}</code> <span class="faint">${PARAM_WORDS[p] || ''}</span>`).join(' · ')}</p>` : ''}
    ${rawResult(res)}
    <table class="mkt-legend"><thead><tr><th>Table</th><th>What it is</th></tr></thead><tbody>${tables.map((t) => `<tr><td><code>${t}</code></td><td>${SOURCES[t]()}</td></tr>`).join('')}</tbody></table>
    <p class="faint">The steps in <code>WITH</code> are shared by every number on this view (change one and every number that reads it changes). <code>live_prices</code> and <code>binance_markets</code> exist only in this browser, so the copies write them in as <code>VALUES</code>, as they were at the last run, and fill in the parameters: they run in MEDUSA's D1 or in Databricks and return this result.</p>
    <p><button class="btn btn-sm" type="button" data-mkt="csv" data-key="${esc(key)}" data-what="result">Download the result (CSV)</button>
      <button class="btn btn-sm" type="button" data-mkt="csv" data-key="${esc(key)}" data-what="inputs">Download the inputs (CSV)</button></p>
  </div>`;
}

/** The text for Copy: the query made to run in MEDUSA's D1 or in Databricks. */
function copyText(key, db) {
  const q = S.sql.get(key), f = q && q.frozen;   // the tables as they were when the result on screen was calculated
  if (!q || !f) return null;
  const syms = q.params.symbol ? [q.params.symbol]
    : [...S.data.base.values()].filter((b) => b.status !== 'not trading').map((b) => b.symbol);
  const keep = new Set(syms);
  const inputs = {
    live_prices: syms.filter((s) => f.prices.has(s)).map((s) => [s, ...f.prices.get(s)]),
    binance_markets: f.markets.filter((r) => keep.has(r[0])),
    note: {
      live_prices: `Binance's live prices at ${clockS(f.at)}`,
      binance_markets: 'each market\'s type, and yesterday\'s close from Binance where the lakehouse hasn\'t got it yet',
    },
  };
  const sql = assemble(DEFS.get(q.id), { inputs, params: q.params });
  return db === 'dbx' ? toDbx(sql) : sql;
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
.mkt-more p.warn, .mkt-src p.warn { color: #e8c547; }
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
.mkt-more h4 { margin: 14px 0 6px; font-size: 14px; }
.mkt-q + .mkt-q { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.mkt-sql { margin: 8px 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.mkt-sql .h { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 5px 6px 5px 10px; background: #232323; color: var(--text-2); font-size: 12.5px; font-weight: 600; }
.mkt-sql .h .btn { height: 26px; padding: 0 10px; font-size: 12.5px; }
.mkt-sql .h .b { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.mkt-src p.what { color: var(--text); font-size: 14px; }
.mkt-src p.now { margin: 10px 0 4px; font-variant-numeric: tabular-nums; }
.mkt-params code { word-break: normal; }
table.mkt-legend { width: 100%; border-collapse: collapse; margin: 4px 0 10px; font-size: 13px; }
.mkt-legend th { text-align: left; font-weight: 600; color: var(--text-3); padding: 6px 8px; border-bottom: 1px solid var(--border-2); }
.mkt-legend td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.mkt-legend td:first-child { white-space: nowrap; }
table.mkt-result td, table.mkt-result th { white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
@media (max-width: 640px) { .mkt-legend td:first-child { white-space: normal; } }
.mkt-raw { margin: 6px 0 8px; }
.mkt-raw summary { cursor: pointer; color: var(--text-2); }
.mkt-raw code { display: block; margin: 6px 0; }
.mkt-sql pre { margin: 0; padding: 10px 12px; overflow-x: auto; max-height: 420px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; line-height: 1.5; color: #d4d4d8; background: #161616; }
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
      <div class="card-head"><div><h2>Unusual right now</h2><p>Markets that have moved at least ${RULE.z} of their usual daily moves today, and what similar moves did next. Tap a row for the details and how its numbers are calculated.</p></div>${srcBtn('unusual')}</div>
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
        <li><b>Every number here is calculated by SQL</b>, in a small SQLite database inside this browser that holds the lakehouse's tables and the live prices. The queries run about once a second; the <b>‹›</b> buttons show each one exactly as it runs, with its result and a copy that runs in MEDUSA's database or in Databricks.</li>
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
 * held still while the pointer is over its details or sources, so they can be read, selected and copied.
 * The queries a part's panels registered are kept for Copy only when the part was redrawn. */
function put(id, html) {
  const copies = PENDING;
  PENDING = [];
  if (S.html.get(id) === html) { for (const [k, v] of copies) S.sql.set(k, v); return; }
  const el = document.getElementById(id);
  if (!el || el.querySelector('.mkt-src:hover, .mkt-more:hover')) return;
  S.html.set(id, html);
  el.innerHTML = html;
  for (const [k, v] of copies) S.sql.set(k, v);
}

function schedule() {
  if (S.paintTimer) return;
  S.paintTimer = setTimeout(() => { S.paintTimer = 0; paint(); }, Math.max(0, 1000 - (Date.now() - S.painted)));
}

/** About once a second: bring the engine up to date, run the queries, then draw their results. */
function paint() {
  if (!host || host.hidden || document.hidden || !document.getElementById('mkt-status')) return;
  S.painted = Date.now();
  if (!S.data || S.loadErr) { draw(); return; }
  if (!S.eng.ok) { if (!S.eng.err) startEngine(); draw(); return; }
  if (S.running) { S.again = true; return; }
  S.running = true;
  S.urgent = false;
  run().then(() => { S.runErr = null; }, (e) => { S.runErr = e.message; })
    .finally(() => {
      S.running = false;
      draw();
      if (!S.again) return;
      S.again = false;
      if (S.urgent) paint(); else schedule();   // a click runs again at once; new prices wait for the next second
    });
}

/** Draw everything from the last results (no queries run here). */
function draw() {
  if (!host || !document.getElementById('mkt-status')) return;
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
  paintStatus();
  if (S.view === 'patterns') { paintPatterns(); return; }
  paintKpis();
  paintUnusual();
  paintMovers();
  paintAll();
  paintSources();
}

function paintStatus() {
  const pub = S.data.published.market_baseline || {};
  let priced = 0;
  for (const b of S.data.base.values()) if (b.status !== 'not trading' && S.live.has(b.symbol)) priced++;
  const ago = S.lastMsg ? Math.max(0, Math.round((Date.now() - S.lastMsg) / 1000)) : null;
  const live = {
    live: `<span class="mkt-dot live"></span><b>Live from Binance</b>${ago != null ? ` · updated ${ago < 2 ? 'just now' : `${ago} s ago`}` : ''}`,
    connecting: '<span class="mkt-dot warn"></span>Connecting to Binance…',
    reconnecting: '<span class="mkt-dot warn"></span>Live prices paused: reconnecting to Binance…',
    refused: '<span class="mkt-dot off"></span><b>Binance\'s live prices can\'t be reached from here</b> (Binance refuses some regions and networks). Prices below are from when they last arrived; the daily numbers are unaffected.',
    off: '<span class="mkt-dot"></span>Not connected',
  }[S.wsState] || '';
  const y = yesterday();
  const ref = !S.ref
    ? (S.refTotal ? `Getting yesterday's closes from Binance: ${S.refDone} of ${S.refTotal}…` : 'Getting yesterday\'s closes…')
    : S.ref.src === 'lakehouse' ? `Today's move is measured from yesterday's (${shortDay(y)}) close, from the lakehouse`
      : S.ref.src === 'binance' ? `Today's move is measured from yesterday's (${shortDay(y)}) close, from Binance (the lakehouse publishes ${shortDay(y)} at about 13:30 UTC)${S.ref.missing ? `; ${S.ref.missing} markets without it aren't scored` : ''}`
        : `Yesterday's closes couldn't be fetched from Binance, so ${S.ref.missing} markets aren't scored until the lakehouse publishes ${shortDay(y)} (about 13:30 UTC)`;
  const engine = S.eng.err
    ? `<span class="warn"><b>The SQL engine couldn't start:</b> ${esc(S.eng.err)}</span> <button class="btn btn-sm" data-mkt="engine">Try again</button>`
    : !S.eng.ok ? 'Starting the SQL engine…'
      : S.runErr ? `<span class="warn">${esc(S.runErr)}</span>`
        : S.lastRun ? `Numbers calculated by SQL in this browser: ${S.lastRun.n} queries at ${clockS(S.lastRun.at)} in ${S.lastRun.ms} ms` : 'Calculating…';
  put('mkt-status', `
    <div class="row"><span>${live}</span><span class="faint">${priced} markets priced</span></div>
    <div class="row faint"><span>Each market's normal: lakehouse day ${shortDay(pub.as_of)}${pub.published_at ? `, published ${clock(pub.published_at)}` : ''}</span><span>${ref}</span></div>
    <div class="row faint"><span>${engine}</span></div>
    <div class="row faint"><span>Live numbers are unchecked until the next daily run; the evidence is history, not a trading signal.</span></div>`);
}

function paintKpis() {
  const card = (src, id) => {
    const d = DEFS.get(id), res = S.res.get(id);
    const v = res && res.error ? '<span class="neg">!</span>' : fillCard(d.card.value, res);
    const s = res && res.error ? 'The query failed: see ‹›' : fillCard(d.card.sub, res);
    return `<div class="kpi"><div class="k"><span class="kt">${esc(d.name)}</span>${srcBtn(src)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  };
  put('mkt-kpis', card('kpi-breadth', 'breadth') + card('kpi-median', 'median_move') + card('kpi-unusual', 'unusual_count') + card('kpi-btc', 'bitcoin'));
}

const KEY = `<p class="mkt-key"><b>z</b> = today's move ÷ the market's usual daily move (<b>σ</b>, the spread of its daily moves over its last 30 days); ${RULE.z}σ or more is unusual. <b>Next 1 h / 4 h / 24 h</b>: what moves of the same kind (direction, size, liquidity) did next since 2020. <b>Fade</b> or <b>Follow</b> with a result means the pattern held up on years held back from the choice, after costs; otherwise the verdict. The small line is every up (or down) move together, a wider group.</p>`;

function paintUnusual() {
  const res = S.res.get('unusual');
  if (!res) { put('mkt-unusual', pending()); return; }
  if (res.error) { put('mkt-unusual', failed(res)); return; }
  if (!res.rows.length) {
    put('mkt-unusual', `<div class="mkt-empty">${S.live.size ? `No ${KIND_WORD[S.kind]}market is unusual right now: none has moved ${RULE.z} or more of its usual daily moves today.` : 'Waiting for prices…'}</div>`);
    return;
  }
  const table = resultTable(res, DEFS.get('unusual'), {
    row: (o) => `data-mkt="row" data-sym="${esc(o.market)}" aria-selected="${S.open === o.market}"`,
    extra: [{ label: 'Since', title: 'When this page first saw it unusual (kept by the page, not by the query)', cell: (o) => `<span class="faint">${clock(S.seen.get(o.market))}</span>` }],
  });
  // The chosen market's details sit under the table (not in it), so the text always fits the screen.
  const open = S.open && objects(res).some((o) => o.market === S.open) ? marketDetail(S.open) : '';
  put('mkt-unusual', `${table}${KEY}${open}`);
}

function paintMovers() {
  const part = (id) => {
    const res = S.res.get(id), d = DEFS.get(id);
    const body = !res ? pending() : res.error ? failed(res) : !res.rows.length ? `<div class="mkt-empty">${S.live.size ? 'None.' : 'Waiting for prices…'}</div>` : resultTable(res, d);
    return `<div><h3>${esc(d.name)}</h3>${body}</div>`;
  };
  put('mkt-movers', `<div class="mkt-movers">${part('gainers')}${part('losers')}</div>`);
}

/** Every market: the query returns them all; search, sorting and pages are the table's own controls. */
function paintAll() {
  const res = S.res.get('markets');
  if (!res) { put('mkt-all', pending()); return; }
  if (res.error) { put('mkt-all', failed(res)); return; }
  const col = (n) => res.columns.indexOf(n);
  const [iSym, iZ, iMove, iVol] = [col('market'), col('z'), col('today_pct'), col('volume_x')];
  let rows = res.rows;
  if (S.q && iSym >= 0) rows = rows.filter((r) => String(r[iSym]).includes(S.q) || ((typeOf(r[iSym]) || {}).label || '').toUpperCase().includes(S.q));
  const num = (v, missing) => (v == null ? missing : v);
  const key = {
    z: (r) => (iZ < 0 ? 0 : Math.abs(num(r[iZ], -1))),
    up: (r) => (iMove < 0 ? 0 : num(r[iMove], -Infinity)),
    down: (r) => (iMove < 0 ? 0 : r[iMove] == null ? -Infinity : -r[iMove]),
    vol: (r) => (iVol < 0 ? 0 : num(r[iVol], -1)),
  }[S.sort];
  rows = [...rows].sort((a, b) => key(b) - key(a) || (iSym < 0 ? 0 : String(a[iSym]).localeCompare(String(b[iSym]))));
  put('mkt-all-sub', `${rows.length} ${KIND_WORD[S.kind]}markets${S.q ? ` matching “${esc(S.q)}”` : ''}; z is today's move in the market's usual daily moves (σ); volume is the last 24 hours against its usual day`);
  if (!rows.length) { put('mkt-all', '<div class="mkt-empty">No market matches.</div>'); return; }
  const shown = { columns: res.columns, rows: rows.slice(0, S.limit) };
  const table = resultTable(shown, DEFS.get('markets'), {
    row: (o) => `data-mkt="row" data-list="all" data-sym="${esc(o.market)}" aria-selected="${S.openAll === o.market}"`,
  });
  const picked = S.openAll && objects(shown).some((o) => o.market === S.openAll) ? marketDetail(S.openAll) : '';
  const more = rows.length > S.limit ? `<button class="btn btn-sm mkt-more-btn" data-mkt="more">Show ${Math.min(50, rows.length - S.limit)} more (of ${rows.length - S.limit})</button>` : '';
  put('mkt-all', `${table}${picked}${more}`);
}

/** The "how this is calculated" panels of the summary cards and the tables. */
const PANELS = {
  'kpi-breadth': ['breadth'], 'kpi-median': ['median_move'], 'kpi-unusual': ['unusual_count'], 'kpi-btc': ['bitcoin'],
  unusual: ['unusual'], movers: ['gainers', 'losers'], every: ['markets'],
};
function paintSources() {
  const panel = (key) => `<div class="mkt-src">${PANELS[key].map((id) => queryPanel(id)).join('')}</div>`;
  put('mkt-kpi-src', S.src && S.src.startsWith('kpi-') ? panel(S.src) : '');
  for (const [slot, key] of [['mkt-unusual-src', 'unusual'], ['mkt-movers-src', 'movers'], ['mkt-every-src', 'every']]) put(slot, S.src === key ? panel(key) : '');
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

/** A verdict in a few words, from the evidence table: the side and its held-back result when it held up. */
function evShort(e) {
  if (!e) return '–';
  if (e.verdict === 'held up') return `<span class="mkt-ev">${e.side === 'fade' ? 'Fade' : 'Follow'} ${pct(e.held_back_net_after_cost)}</span>`;
  return esc(e.verdict);
}

/** A market's details: its move in words (from its query), the evidence when unusual, and its query. */
function marketDetail(sym) {
  const key = `market:${sym}`, res = S.res.get(key);
  if (!res) return '<div class="mkt-more"><p>Calculating…</p></div>';
  if (res.error) return `<div class="mkt-more">${failed(res)}<div class="mkt-src">${queryPanel('market', key, { symbol: sym })}</div></div>`;
  const r = objects(res)[0], b = S.data.base.get(sym), t = typeOf(sym), l = S.live.get(sym);
  const who = `${name(sym)}${t ? ` (${esc(t.label)})` : ''}`;
  let html;
  if (!r || r.today_pct == null) {
    html = `<p>${who}: not scored yet${l ? ', yesterday\'s close is missing' : ', no live price yet'}.</p>`;
  } else {
    html = `<p>${who} has moved ${pct(r.today_pct / 100)} since yesterday's close${r.z != null ? `: ${sig(r.z)}, ${Math.abs(r.z).toFixed(1)} times its usual daily move (${Number(r.usual_day_pct).toFixed(2)}%${b ? ` over its last ${b.history_days} days` : ''})` : ''}.${r.direction ? ` Its own group: ${kindPhrase(r.direction, r.z_band, r.liquidity)}${b ? ` (average ${Math.round((b.avg_quote_volume_30d || 0) / 1e6).toLocaleString('en-US')} million USDT a day)` : ''}.` : ''}</p>`;
    if (r.direction) {
      if (t && t.group !== 'crypto') html += `<p class="warn">${name(sym)} is a ${esc(t.label.toLowerCase())} perpetual. Almost all the history behind the evidence is crypto: the side of each pattern was chosen on 2020–2024, when Binance had almost no stock, commodity or currency perpetuals. Treat the evidence with extra care here.</p>`;
      html += HORIZONS.map((h) => evWords(S.data.ev.get(evKey(r.direction, r.z_band, r.liquidity, h)) || null, h)).join('');
      html += `<p><b>For comparison, a wider group</b>, every ${r.direction} move together (any size, any market): ${HORIZONS.map((h) => `next ${h} h ${evShort(S.data.ev.get(evKey(r.direction, 'all', 'all', h)))}`).join(' · ')}. ${name(sym)}'s own group is the closer match; the wider group has many more examples but mixes very different moves.</p>`;
    }
  }
  const raw = l ? `<details class="mkt-raw"><summary>The Binance message behind the price</summary><code>${esc(JSON.stringify(l.raw))}</code><p class="faint">${l.via === 'stream' ? `From the live stream at ${clockS(l.t)}: <code>c</code> is the last price, <code>q</code> the USDT traded in the last 24 hours.` : `From the price snapshot of ${clockS(l.t)}: it hasn't traded since this page opened.`}</p></details>` : '';
  const past = r && r.direction ? `<details class="mkt-raw"><summary>Every past move behind these verdicts (Databricks)</summary>${sqlBlock('Databricks SQL', `SELECT event_hour, symbol, z, move_so_far, fwd_return_1h, fwd_return_4h, fwd_return_24h, period\nFROM market.gold.intraday_events\nWHERE direction = '${r.direction}' AND z_band = '${r.z_band}' AND liquidity = '${r.liquidity}'\nORDER BY event_hour DESC;`)}<p class="faint">Built by ${ghLink('intraday_events.sql')}; it exists only in the lakehouse.</p></details>` : '';
  return `<div class="mkt-more">${html}<div class="mkt-src">${queryPanel('market', key, { symbol: sym })}${raw}${past}</div></div>`;
}

/* ---------- Patterns: every kind of move and what it did next ---------- */

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

function evCell(e) {
  return `<div class="mkt-evc"><span class="v">${evShort(e)}</span></div>`;
}

function paintPatterns() {
  const ev = S.data.ev;
  const evRows = [...ev.values()];
  const count = (v) => evRows.filter((e) => e.verdict === v).length;
  const total = (dir) => (ev.get(evKey(dir, 'all', 'all', 1)) || {}).events || 0;
  const flagged = objects(S.res.get('unusual_all_types'));   // live, from the query; every type
  const now = (dir, band, liq) => flagged.filter((r) => r.direction === dir && (band === 'all' || (r.z_band === band && r.liquidity === liq)));
  const pub = S.data.published.market_evidence || {};

  const held = evRows.filter((e) => e.verdict === 'held up').sort((a, b) => b.held_back_net_after_cost - a.held_back_net_after_cost);
  const heldHtml = held.length ? held.map((e) => {
    const m = now(e.direction, e.z_band, e.liquidity);
    return `<div><b>${e.side === 'fade' ? 'Fade' : 'Follow'} ${kindPhrase(e.direction, e.z_band, e.liquidity)}, over the next ${e.horizon_hours === 1 ? 'hour' : `${e.horizon_hours} hours`}:</b> <span class="mkt-ev">${pct(e.held_back_net_after_cost)}</span> a trade from 2025 after ${size(e.round_trip_cost)} costs (t ${tval(e.held_back_t)} over ${e.held_back_days} days), chosen on 2020–2024 (t ${tval(e.in_sample_t)} over ${e.in_sample_days} days). ${e.events} moves on ${e.days} days in all. Right now: ${m.length ? m.map((r) => name(r.market)).join(', ') : 'no market'}.</div>`;
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
    detail = `<div class="mkt-more"><p><b>${kindName(e.direction, e.z_band, e.liquidity)}</b>${e.z_band === 'all' ? ' (any size, any market)' : ''}.</p>${evWords(e, e.horizon_hours)}<p>Right now: ${m.length ? m.map((r) => `${name(r.market)} ${sig(r.z)}`).join(', ') : 'no market is in this group'}.</p>
      <h4>Where these numbers come from</h4><p>The lakehouse's <code>gold.event_evidence</code> (${ghLink('event_evidence.sql')}), built from <code>gold.intraday_events</code> (${ghLink('intraday_events.sql')}), copied to MEDUSA's <code>market_evidence</code>. <b>Now</b> is live, from the query below.</p>${evidenceSql(e.direction, e.z_band, e.liquidity)}</div>`;
  }

  put('mkt-patterns', `
    <section class="card">
      <div class="card-head"><div><h2>What similar moves did next</h2><p>Every time a market's move during a day reached ${RULE.z} of its usual daily moves since January 2020, the lakehouse recorded what the price did over the next 1, 4 and 24 hours: about ${(total('up') + total('down')).toLocaleString('en-US')} moves (${total('up').toLocaleString('en-US')} up, ${total('down').toLocaleString('en-US')} down), almost all of them crypto. Lakehouse day ${shortDay(pub.as_of)}.</p></div>${srcBtn('patterns')}</div>
      ${srcBox('patterns', `<p>Everything in this view comes from the lakehouse, except <b>Now</b> and <b>Right now</b>, which are live. Two dbt models build it on every daily run: ${ghLink('intraday_events.sql')} (every unusual move since 2020 and the price 1, 4 and 24 hours later) and ${ghLink('event_evidence.sql')} (the verdicts, judged by days, on 2020–2024 and then on 2025 onwards). The publish job copies the verdicts to MEDUSA's <code>market_evidence</code>${pub.published_at ? `, last at ${clock(pub.published_at)}` : ''}.</p>
        ${sqlBlock('Every verdict (Databricks SQL)', 'SELECT direction, z_band, liquidity, horizon_hours, verdict, side, events, days,\n       in_sample_days, in_sample_t, held_back_days, held_back_t, held_back_net_after_cost\nFROM market.gold.event_evidence\nORDER BY direction, z_band, liquidity, horizon_hours;')}
        ${sqlBlock('How many moves, and when (Databricks SQL)', 'SELECT direction, period, COUNT(*) AS moves, COUNT(DISTINCT event_date) AS days\nFROM market.gold.intraday_events\nGROUP BY direction, period\nORDER BY direction, period;')}
        ${queryPanel('unusual_all_types')}`)}
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
      const empty = { columns: [], rows: [] };
      S.data = { published, base, ev, at: Date.now(), raw: { market_baseline: d.market_baseline || empty, market_evidence: d.market_evidence || empty } };
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
  S.marketsVer++;
  schedule();
}

// Today's move is measured from yesterday's close. The lakehouse has it after its daily run (about
// 13:30 UTC); before that its newest day is the day before, so yesterday's closes come from Binance's
// daily candles instead: one small request per market, once a day per browser (kept in local storage).
// The queries choose between the two (market_now): these closes go into binance_markets.
async function ensureRef() {
  if (!S.data || S.loadErr) return;
  const day = yesterday();
  if ((S.ref && S.ref.day === day) || S.refBusy === day) return;
  S.refBusy = day;
  const close = new Map(), binance = new Map(), need = [];
  for (const b of S.data.base.values()) {
    if (b.status === 'not trading') continue;
    if (b.as_of_date === day) close.set(b.symbol, b.last_close);
    else need.push(b.symbol);
  }
  let src = 'lakehouse', missing = 0;
  if (need.length) {
    const cached = api.store.get(`mkt.close.${day}`, {}) || {};
    const todo = need.filter((s) => !(cached[s] > 0));
    need.forEach((s) => { if (cached[s] > 0) { close.set(s, cached[s]); binance.set(s, cached[s]); } });
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
        if (Array.isArray(k) && k[0] && k[0][0] === start && Number(k[0][4]) > 0) {
          const c = Number(k[0][4]);
          close.set(sym, c); binance.set(sym, c); cached[sym] = c;
        }
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
  S.ref = { day, close, binance, src, missing };
  S.refBusy = null;
  S.marketsVer++;
  schedule();
}

/* Binance sends only the markets that changed in each message, so one snapshot of every price fills in
   the quiet ones at the start. */
async function snapshot() {
  try {
    const r = await fetch(`${REST}/ticker/price`, { credentials: 'omit' });
    if (!r.ok) return;
    for (const p of await r.json()) {
      if (S.live.has(p.symbol)) continue;
      S.live.set(p.symbol, { price: Number(p.price), q: null, t: p.time, raw: p, via: 'snapshot' });
      S.dirty.add(p.symbol);
    }
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
    for (const t of d) {
      if (!t || !t.s) continue;
      S.live.set(t.s, { price: Number(t.c), q: Number(t.q), t: t.E, raw: t, via: 'stream' });
      S.dirty.add(t.s);
    }
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

function saveCsv(file, columns, rows) {
  const blob = new Blob([`﻿${[columns.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: file });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** A query's result, or every input behind it (each market's row of market_now), as a CSV file. */
async function downloadCsv(key, what) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const q = S.sql.get(key);
  if (what === 'result') {
    const res = S.res.get(key);
    if (!res || res.error) { api.toast('There is no result to download yet.', 'error'); return; }
    saveCsv(`medusa-markets-${key.replace(/[^\w-]/g, '-')}-${stamp}Z.csv`, res.columns, res.rows);
    api.log('markets', `Downloaded the result of ${key} (${res.rows.length} rows)`);
    return;
  }
  const one = q && q.params.symbol;
  const def = {
    name: 'The inputs', description: 'each market with its live price, yesterday\'s close and its normal',
    sql: `SELECT * FROM market_now\nWHERE :kind IN ('all', market_type)${one ? '\n  AND symbol = :symbol' : ''}`,
  };
  try {
    const out = await call({ op: 'run', jobs: [{ id: 'inputs', sql: assemble(def), params: { ':kind': S.kind, ':yesterday': yesterday(), ...(one ? { ':symbol': one } : {}) } }] }, 5_000);
    const res = out.inputs;
    if (res.error) throw new Error(res.error);
    saveCsv(`medusa-markets-inputs-${stamp}Z.csv`, res.columns, res.rows);
    api.log('markets', `Downloaded the inputs (${res.rows.length} markets)`);
  } catch (e) {
    api.toast(`The inputs couldn't be read: ${e.message}`, 'error');
  }
}

function onClick(e) {
  const el = e.target.closest('[data-mkt]');
  if (!el || !host.contains(el)) return;
  const act = el.dataset.mkt;
  if (act === 'retry') { S.loadErr = null; paint(); start(); return; }
  if (act === 'engine') { restartEngine(); draw(); return; }
  if (act === 'copy') {
    const sql = el.dataset.sql ? copyText(el.dataset.sql, el.dataset.db) : el.closest('.mkt-sql').querySelector('pre').textContent;
    if (!sql) { api.toast('Not calculated yet: try again in a second.', 'error'); return; }
    const where = el.dataset.db === 'dbx' ? ' for Databricks' : el.dataset.db === 'd1' ? ' for MEDUSA\'s D1' : '';
    navigator.clipboard.writeText(sql).then(() => api.toast(`Query copied${where}.`), () => api.toast('Copying isn\'t allowed here: select the query and copy it.', 'error'));
    return;
  }
  if (act === 'csv') { downloadCsv(el.dataset.key, el.dataset.what); return; }
  if (act === 'view') { S.view = el.dataset.v; api.store.set('mktView', S.view); }
  else if (act === 'kind') { S.kind = el.dataset.v; S.limit = 50; api.store.set('mktKind', S.kind); }
  else if (act === 'sort') { S.sort = el.dataset.v; S.limit = 50; draw(); return; }
  else if (act === 'more') { S.limit += 50; draw(); return; }
  else if (act === 'src') { S.src = S.src === el.dataset.id ? null : el.dataset.id; draw(); return; }
  else if (act === 'row' && el.dataset.list === 'all') S.openAll = S.openAll === el.dataset.sym ? null : el.dataset.sym;
  else if (act === 'row') S.open = S.open === el.dataset.sym ? null : el.dataset.sym;
  else if (act === 'pat') { S.pat = S.pat === el.dataset.k ? null : el.dataset.k; draw(); return; }
  draw();
  S.urgent = true;
  paint();   // the view, type or an opened market changes which queries run
}

function onInput(e) {
  if (e.target.id !== 'mkt-q') return;
  S.q = e.target.value.trim().toUpperCase();
  S.limit = 50;
  draw();
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

/** The page was left: close the live stream until it is opened again. The SQL engine stays, with its
 * tables, so the page is back at once. */
export function stop() {
  S.stopped = true;
  clearTimeout(S.retry);
  clearInterval(S.tick);
  S.tick = 0;
  if (S.ws) { const ws = S.ws; S.ws = null; ws.close(); }
  S.wsState = 'off';
}
