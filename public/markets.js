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
// Every number on the Today view is calculated by SQL: the queries run in a SQLite database inside the
// browser (markets-sql.js, a background worker) that holds the lakehouse's two tables, the live prices
// and Binance's contract list. The queries themselves are kept in the lakehouse
// (market.semantic.metric_definitions, every version) and published to MEDUSA with the data
// (market_metrics); markets-metrics.js is the built-in copy, used until they arrive. This file only
// feeds the tables, runs the queries about once a second and draws what they return. The rule is the
// lakehouse's own (intraday_events.sql), so the evidence describes exactly the moves flagged here. Live
// numbers are unchecked: the next daily run replaces them.
//
// Two views: Today (the live scan) and Patterns (every kind of move and what it did next). Each ‹›
// button opens one number's calculation in its own window (markets-window.html): the same code with
// its own data, engine and live prices, running only that number's queries.

import { DEFINITIONS } from './markets-metrics.js?v=2';

const RULE = { z: 3 };
const STREAM = 'wss://fstream.binance.com/market/ws/!miniTicker@arr';
const REST = 'https://fapi.binance.com/fapi/v1';
const ENGINE = '/markets-sql.js?v=2';
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

// The definitions in use: the lakehouse's published ones over the built-in copy (markets-metrics.js),
// which fills in until they arrive and for any id they don't have.
const BUILT_IN = new Map(DEFINITIONS.map((d) => [d.id, { ...d, from: 'built-in' }]));
let DEFS = BUILT_IN;

/** The published definitions (rows of market_metrics), each over the built-in one with the same id.
 * A display that isn't valid JSON, or lacks what the page needs, keeps the built-in display. */
export function definitionsFrom(rows) {
  const defs = new Map(BUILT_IN);
  for (const r of rows) {
    let display = null;
    try { display = r.display ? JSON.parse(r.display) : null; } catch { display = null; }
    const base = BUILT_IN.get(r.metric_id) || {};
    defs.set(r.metric_id, {
      id: r.metric_id, kind: r.kind, name: r.name, description: r.description || '', sql: r.sql_text,
      columns: (display && Array.isArray(display.columns) && display.columns) || base.columns,
      card: (display && display.card && display.card.value != null && display.card) || base.card,
      version: r.version, validFrom: r.valid_from, changedBy: r.changed_by, note: r.change_note, from: 'lakehouse',
    });
  }
  return defs;
}

/** The account's own versions (rows of market_user_metrics) over the shared definitions: the SQL and
 * description change, and `own` says which of the account's versions it is. */
export function ownOver(defs, rows) {
  const out = new Map(defs);
  for (const r of rows) {
    const shared = defs.get(r.metric_id);
    if (!shared) continue;
    out.set(r.metric_id, {
      ...shared, sql: r.sql_text, description: r.description || shared.description,
      own: { version: r.version, validFrom: r.valid_from, changedBy: r.changed_by, note: r.change_note, basedOn: r.based_on },
    });
  }
  return out;
}
// What the definitions are built from: the published shared rows, and the account's own rows with
// what Save does for it ({rows, canSave, saves: 'own' | 'shared', name}).
const SRC = { shared: [], mine: { rows: [], canSave: false, saves: 'own', name: '' } };
const rebuildDefs = () => { DEFS = ownOver(definitionsFrom(SRC.shared), SRC.mine.rows); };
const BROWSER_TABLES = {   // column -> type, for an empty value in the first row of VALUES
  live_prices: { symbol: 'STRING', price: 'DOUBLE', quote_volume_24h: 'DOUBLE' },
  binance_markets: { symbol: 'STRING', market_type: 'STRING', yesterday_close: 'DOUBLE' },
};

const noComments = (sql) => sql.replace(/--[^\n]*/g, '');
/** The tables and models a query reads (whatever follows FROM or JOIN). */
export const reads = (sql) => [...noComments(sql).matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w.]*)/gi)].map((m) => m[1].toLowerCase());

/** The models a query reads, directly or through other models, each after the ones it needs. `defs`
 * is the set of definitions to use (an edit being previewed replaces some). A step that reads itself,
 * directly or through others, can't run. */
function modelsOf(sql, defs = DEFS, out = [], path = []) {
  for (const t of reads(sql)) {
    const d = defs.get(t);
    if (!d || d.kind !== 'model' || out.includes(t)) continue;
    if (path.includes(t)) throw new Error(`${[...path, t].join(' reads ')}: a shared step can't read itself.`);
    modelsOf(d.sql, defs, out, [...path, t]);
    out.push(t);
  }
  return out;
}

const literal = (v) => (v == null ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`);
const tidy = (s) => s.replace(/ {3,}--/g, '  --');   // each comment right after its code, so it fits a phone
const toDbx = (sql) => sql.replace(/\bmarket_baseline\b/g, 'market.gold.coin_baseline').replace(/\bmarket_evidence\b/g, 'market.gold.event_evidence');

/** A query with the page's parameters written in as their values, so the SQL on screen (and the SQL
 * that runs) changes with the filter: the type filter `:kind IN ('all', market_type)` becomes
 * `market_type = 'crypto'` for a type, or TRUE (every row) for All. */
export function fill(sql, params) {
  return sql
    .replace(/:kind\s+IN\s*\(\s*'all'\s*,\s*([A-Za-z_][\w.]*)\s*\)/gi, (m, col) => (params.kind === 'all' ? 'TRUE' : `${col} = ${literal(params.kind)}`))
    .replace(/:([a-z_]+)\b/g, (m, k) => (k in params ? literal(params[k]) : m));
}

/** One complete query: the models it reads go in front as WITH ... AS (...), so it runs as it is.
 * With `params` the parameters are written in (fill). With `inputs` (the browser-only tables' rows)
 * it is made to run elsewhere too: those tables are written in as VALUES. `defs` replaces the
 * definitions in use (a preview). */
export function assemble(def, { inputs = null, params = null, defs = DEFS } = {}) {
  const models = modelsOf(def.sql, defs);
  const steps = [];
  if (inputs) {
    const used = new Set(reads([def.sql, ...models.map((m) => defs.get(m).sql)].join('\n')));
    for (const [t, types] of Object.entries(BROWSER_TABLES)) {
      if (!used.has(t)) continue;
      const cols = Object.keys(types);
      const rows = (inputs[t] || []).length ? inputs[t] : [['', ...cols.slice(1).map(() => null)]];   // an empty table: one row that joins nothing
      // An empty value in the first row gets its column's type, so Databricks knows the type of the column.
      const vals = rows.map((r, i) => `(${r.map((v, j) => (v == null && i === 0 ? `CAST(NULL AS ${types[cols[j]]})` : literal(v))).join(', ')})`);
      steps.push(`${t}(${cols.join(', ')}) AS (VALUES   -- ${inputs.note[t]}\n  ${vals.join(',\n  ')}\n)`);
    }
  }
  for (const m of models) steps.push(`${m} AS (   -- ${defs.get(m).name}\n${defs.get(m).sql.replace(/^/gm, '  ')}\n)`);
  const own = def.sql.trim();
  const head = `-- ${def.name}: ${def.description}\n`;
  let sql = !steps.length ? own
    : /^WITH\s/i.test(own) ? `WITH ${steps.join(',\n')},\n${own.replace(/^WITH\s+/i, '')}`
      : `WITH ${steps.join(',\n')}\n${own}`;
  if (params) sql = fill(sql, params);
  return tidy(head + sql);
}

const PARAM_WORDS = {
  kind: 'the type chosen at the top',
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
  logged: new Set(),                                 // failures already in the log ("key\nerror"): each once per page
  frozen: null,                                     // the engine's browser-only tables as of the last run, for Copy
  seen: new Map(),                                   // symbol -> when this page first saw it unusual
  view: 'today', kind: 'all', sort: 'z', q: '', limit: 50, open: null, openAll: null, pat: null,
  sql: new Map(),                                    // each calculation panel's query, for Copy
  win: null,                                         // in a ‹› window: {panel, ids, symbol}
  // A window's editor: definition id -> the text typed in its box; the ids whose box is open; the
  // edits being previewed (id -> SQL, or null); why a preview didn't start or stopped.
  edit: { text: new Map(), open: [], live: null, since: 0, note: null, hist: new Map() },
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

/** The queries to run now, for the view on screen. In a window, a preview runs each number that the
 * edits change a second time, with the edits, as `preview:<key>` (not while the tables are loading,
 * so a preview always has its own time limit). */
function jobs(preview = true) {
  const params = { kind: S.kind, yesterday: yesterday() };
  const job = (id, key = id, extra = {}, defs = DEFS) => ({ id: key, sql: assemble(defs.get(id), { defs, params: { ...params, ...extra } }) });
  if (S.win) {
    const out = [], defs = preview ? previewDefs() : null;
    for (const id of S.win.ids) {
      const key = winKey(id), extra = id === 'market' ? { symbol: S.win.symbol } : {};
      out.push(job(id, key, extra));
      if (defs && touches(id, defs)) out.push(job(id, `preview:${key}`, extra, defs));
    }
    return out;
  }
  const out = [job('unusual_all_types')];
  if (S.view === 'patterns') out.push(...['patterns_summary', 'patterns_held', 'patterns_grid'].map((id) => job(id)));
  if (S.view === 'today') {
    out.push(...['breadth', 'median_move', 'unusual_count', 'bitcoin', 'unusual', 'gainers', 'losers', 'markets'].map((id) => job(id)));
    for (const sym of new Set([S.open, S.openAll])) if (sym) out.push(job('market', `market:${sym}`, { symbol: sym }));
  }
  return out;
}

/** An error into the app's log, once per page for the same thing and message. */
function logOnce(key, error, msg, data = null) {
  const k = `${key}\n${error}`;
  if (S.logged.has(k) || S.logged.size >= 200) return;
  S.logged.add(k);
  api.log('markets', msg.slice(0, 400), data, 'error');
}

/** Bring the engine's tables up to date (only what changed) and run the queries. */
async function run() {
  const e = S.eng;
  const msg = { op: 'run' };
  if (e.loadedAt !== S.data.at) msg.load = S.data.raw;
  msg.jobs = jobs(!msg.load);
  if (e.marketsVer !== S.marketsVer) msg.markets = marketRows();
  msg.prices = [...S.dirty].filter((s) => S.live.has(s)).map((s) => { const l = S.live.get(s); return [s, l.price, l.q ?? null]; });
  S.dirty.clear();
  const t0 = performance.now();
  const previewing = msg.jobs.some((j) => j.id.startsWith('preview:'));
  let out;
  try {
    // Normally about 50 ms; only a stuck engine is restarted. An edit being previewed gets 5 seconds.
    out = await call(msg, msg.load ? 30_000 : previewing ? 5_000 : 15_000);
  } catch (err) {
    if (S.eng === e) restartEngine();   // its tables may be half updated: start again from scratch
    if (previewing) {
      stopPreview('Your version took more than 5 seconds, so the preview was stopped and the SQL engine restarted. Check for a join without a condition, or a step that reads a big table many times.');
      return;
    }
    throw err;
  }
  if (S.eng !== e) return;   // the engine was restarted meanwhile
  if (msg.load) e.loadedAt = S.data.at;
  if (msg.markets) { e.marketsVer = S.marketsVer; S.sentMarkets = msg.markets; }
  for (const [s, p, q] of msg.prices) { const old = S.sent.get(s); S.sent.set(s, [p, q ?? (old ? old[1] : null)]); }
  S.frozen = { prices: new Map(S.sent), markets: S.sentMarkets, at: S.lastMsg };
  S.lastRun = { at: Date.now(), ms: Math.round(performance.now() - t0), n: msg.jobs.length };
  S.res = new Map(Object.entries(out));
  // A query that failed goes into the log once per page (queries run every second), so the lakehouse's
  // ops.logs.app_events gets it with the daily copy. A preview's failures are the editor's to show.
  for (const [key, res] of S.res) {
    if (!res || !res.error || key.startsWith('preview:')) continue;
    const d = DEFS.get(key.split(':')[0]);
    logOnce(key, res.error, `The query ${key} failed: ${res.error}`,
      { definition: d ? d.id : key, version: d ? (d.own ? `own ${d.own.version}` : d.version || 'built-in') : null });
  }
  // When this page first saw each market unusual (kept by the page, not by a query).
  if (!S.res.has('unusual_all_types')) return;
  const now = Date.now(), flagged = new Set(objects(S.res.get('unusual_all_types')).map((r) => r.market));
  for (const s of flagged) if (!S.seen.has(s)) S.seen.set(s, now);
  for (const s of [...S.seen.keys()]) if (!flagged.has(s)) S.seen.delete(s);
}

/* ---------- "how this is calculated": each number's query, as it runs ---------- */

const GH = 'https://github.com/shivam65-sketch/medusa/blob/main/lakehouse/dbt/models/gold/';
const ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>';
const srcBtn = (panel, symbol = '') => `<button class="mkt-src-btn" type="button" data-mkt="win" data-panel="${panel}"${symbol ? ` data-sym="${esc(symbol)}"` : ''} title="How this is calculated (opens in its own window)" aria-label="How this is calculated, in its own window">${ICON}</button>`;
const sqlBlock = (title, sql) => `<div class="mkt-sql"><div class="h"><span>${title}</span><button class="btn btn-sm" type="button" data-mkt="copy">Copy</button></div><pre>${esc(sql.trim())}</pre></div>`;
const ghLink = (file) => `<a href="${GH}${file}" target="_blank" rel="noopener">${file}</a>`;
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// Copy texts are built when Copy is pressed, from the tables as they were at the last run. A panel
// registers its queries here while it is drawn, and they are kept only if the panel was redrawn.
let PENDING = [];
const SOURCES = {
  live_prices: () => `Binance's live prices, kept up to date from the stream while this ${S.win ? 'window' : 'page'} is open (last message ${clockS(S.lastMsg)}). Only in this browser.`,
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

/** A number's query as it runs here, where its definition comes from, and its parameters, with
 * copies that run in MEDUSA's D1 or in Databricks. It changes only with the definition or a parameter.
 * With `defs`, the version being previewed. */
function queryHead(id, key = id, extra = {}, defs = null) {
  const def = (defs || DEFS).get(id);
  const params = { kind: S.kind, yesterday: yesterday(), ...extra };
  const raw = assemble(def, { defs: defs || DEFS }), sql = assemble(def, { defs: defs || DEFS, params });
  PENDING.push([key, { id, params, frozen: S.frozen, defs }]);
  const used = [...new Set([...noComments(raw).matchAll(/:([a-z_]+)\b/g)].map((m) => m[1]))].filter((p) => p in params);
  const written = (p) => (p !== 'kind' ? `<code>${esc(literal(params[p]))}</code>`
    : params.kind === 'all' ? '<code>TRUE</code> (All: every type)' : `<code>market_type = ${esc(literal(params.kind))}</code>`);
  const step = (m) => { const d = DEFS.get(m); return d.own ? ` your own v${d.own.version}` : d.version ? ` v${d.version}` : ''; };
  const steps = modelsOf(def.sql).map((m) => `<code>${m}</code>${step(m)}`).join(', ');
  const own = def.own;
  const origin = defs
    ? `<b>Your version:</b> with your changes to ${[...S.edit.live.keys()].map((d) => `<code>${esc(d)}</code>`).join(', ')}, running on this screen only. Nothing is saved.`
    : own
      ? `<b>Your own version ${own.version}</b> of <code>${esc(def.id)}</code> in the lakehouse's <code>market.semantic.user_metric_definitions</code>, saved ${own.validFrom ? `${esc(own.validFrom)} UTC ` : ''}by ${esc(own.changedBy || 'you')}${own.note ? ` (“${esc(own.note)}”)` : ''}. Only your account uses it; the shared version is ${def.version || 'the built-in one'}.${S.win ? ` <button class="btn btn-sm" type="button" data-mkt="edit-giveup" data-def="${esc(def.id)}">Use the shared version again</button>` : ''}`
    : def.from === 'lakehouse'
      ? `<b>Definition:</b> version ${def.version} of <code>${esc(def.id)}</code> in the lakehouse's <code>market.semantic.metric_definitions</code>${def.validFrom ? `, in use since ${esc(def.validFrom)} UTC` : ''}${def.changedBy ? ` (${esc(def.changedBy)})` : ''}${steps ? `; its shared steps: ${steps}` : ''}.`
      : '<b>Definition:</b> the built-in copy in <code>markets-metrics.js</code>, because the lakehouse hasn\'t published this definition to MEDUSA yet.';
  return `<p class="faint">${origin}</p>
    <div class="mkt-sql"><div class="h"><span>${defs ? 'Your version, exactly as it runs on this screen' : 'The query, exactly as the Markets page runs it'}</span><span class="b">
      <button class="btn btn-sm" type="button" data-mkt="copy" data-sql="${esc(key)}" data-db="d1">Copy for MEDUSA (D1)</button>
      <button class="btn btn-sm" type="button" data-mkt="copy" data-sql="${esc(key)}" data-db="dbx">Copy for Databricks</button></span></div>
      <pre>${esc(sql)}</pre></div>
    ${used.length ? `<p class="mkt-params"><b>Filled in</b> ${used.map((p) => `<code>:${p}</code> → ${written(p)} <span class="faint">${PARAM_WORDS[p] || ''}</span>`).join(' · ')}. The definition keeps <code>:${used.join('</code>, <code>:')}</code>, so it works for every choice; the query above is written with this window's values.</p>` : ''}`;
}

/** A number's result now, exactly as the engine returned it, and where each table comes from. */
function queryLive(id, key = id) {
  const tables = [...new Set(reads(assemble(DEFS.get(id))))].filter((t) => t in SOURCES);
  return `${rawResult(S.res.get(key))}
    <table class="mkt-legend"><thead><tr><th>Table</th><th>What it is</th></tr></thead><tbody>${tables.map((t) => `<tr><td><code>${t}</code></td><td>${SOURCES[t]()}</td></tr>`).join('')}</tbody></table>
    <p class="faint">The steps in <code>WITH</code> are shared by every number on the Markets page (change one and every number that reads it changes). <code>live_prices</code> and <code>binance_markets</code> exist only in the browser, so the copies write them in as <code>VALUES</code>, as they were at the last run, and fill in the parameters: they run in MEDUSA's D1 or in Databricks and return this result.</p>
    <p><button class="btn btn-sm" type="button" data-mkt="csv" data-key="${esc(key)}" data-what="result">Download the result (CSV)</button>
      <button class="btn btn-sm" type="button" data-mkt="csv" data-key="${esc(key)}" data-what="inputs">Download the inputs (CSV)</button></p>`;
}

/** What each ‹› button opens in its own window: the numbers whose calculation it shows. */
const WINDOWS = {
  breadth: ['breadth'], median_move: ['median_move'], unusual_count: ['unusual_count'], bitcoin: ['bitcoin'],
  unusual: ['unusual'], movers: ['gainers', 'losers'], markets: ['markets'], market: ['market'],
  patterns: ['patterns_summary', 'patterns_held', 'patterns_grid', 'unusual_all_types'],
};

/** A ‹› button: the number's calculation in its own window. Pressing it again brings that window to the
 * front as it is (it isn't reloaded). */
function openWindow(panel, symbol) {
  const name = `medusa-calc-${panel}${symbol ? `-${symbol}` : ''}`;
  const url = `/markets-window?${new URLSearchParams({ panel, kind: S.kind, ...(symbol ? { symbol } : {}) })}`;
  const size = `width=${Math.min(1600, screen.availWidth - 40)},height=${Math.min(1000, screen.availHeight - 40)}`;
  const w = window.open('', name, `popup,${size}`);
  if (!w) { api.toast('The window was blocked: allow pop-ups for MEDUSA in the browser, then press ‹› again.', 'error'); return; }
  let fresh = true;
  try { fresh = w.location.href === 'about:blank'; } catch { /* that window is on another site */ }
  if (fresh) w.location.href = url;
  w.focus();
  api.log('markets', `Opened how ${panel}${symbol ? ` (${symbol})` : ''} is calculated, in its own window`, null, 'debug');
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
  const defs = q.defs || DEFS;
  const sql = assemble(defs.get(q.id), { inputs, params: q.params, defs });
  return db === 'dbx' ? toDbx(sql) : sql;
}

/* ---------- a window's editor: change a definition and preview it on this screen ---------- */

const PARAMS = ['kind', 'yesterday', 'symbol'];
const clean = (sql) => String(sql).replace(/[\s;]+$/, '');   // a ; at the end isn't needed (and isn't stored)
const winKey = (id) => (id === 'market' ? `market:${S.win.symbol}` : id);
const edited = (id) => S.edit.text.has(id) && clean(S.edit.text.get(id)) !== clean(DEFS.get(id).sql);

/** The definitions with the edits being previewed in place of their current versions, or null. */
function previewDefs() {
  if (!S.edit.live) return null;
  const defs = new Map(DEFS);
  for (const [id, sql] of S.edit.live) defs.set(id, { ...DEFS.get(id), sql });
  return defs;
}

/** Whether the edits change a number: its own query, or a shared step it reads. */
function touches(id, defs) {
  try { return S.edit.live.has(id) || modelsOf(defs.get(id).sql, defs).some((m) => S.edit.live.has(m)); } catch { return true; }
}

/** What stops a definition from running. It must be one query that only reads, with the page's
 * parameters only; the database checks the rest when it runs. The first two rules are the lakehouse's
 * own test (assert_metric_definitions_valid), which reads the text as it is, comments included. */
function sqlProblems(id, sql) {
  const name = DEFS.get(id).name, text = clean(sql).trim(), out = [];
  if (!noComments(text).trim()) return [`${name}: the query is empty.`];
  if (!/^(SELECT|WITH)[^A-Z0-9_]/i.test(text)) out.push(`${name}: a query must start with SELECT or WITH, so it can only read (a comment can go after that word, not before it).`);
  if (text.includes(';')) out.push(`${name}: only one statement, so no ; anywhere (not even in a comment).`);
  const unknown = [...new Set([...noComments(text).matchAll(/(?<![\w:]):([A-Za-z_]\w*)/g)].map((m) => m[1]))].filter((p) => !PARAMS.includes(p));
  if (unknown.length) out.push(`${name}: ${unknown.map((p) => `:${p}`).join(', ')} isn't a parameter the page fills in (it has :kind, :yesterday and :symbol).`);
  return out;
}

/** The columns a number's display needs: a card's {column} fields, or a table's columns. */
function neededColumns(id) {
  const d = DEFS.get(id);
  if (d.card) return [...new Set([...`${d.card.value} ${d.card.sub}`.matchAll(/\{(\w+)/g)].map((m) => m[1]))];
  return (d.columns || []).map((c) => c.name);
}

/** Preview: every changed definition, checked first, then run on this screen next to the current one. */
function startPreview() {
  closeSave();
  const changes = new Map();
  for (const id of S.edit.text.keys()) if (edited(id)) changes.set(id, clean(S.edit.text.get(id)));
  if (!changes.size) { stopPreview('Nothing has changed yet: edit a query, then press Preview.'); return; }
  const problems = [...changes].flatMap(([id, sql]) => sqlProblems(id, sql));
  const defs = new Map(DEFS);
  for (const [id, sql] of changes) defs.set(id, { ...DEFS.get(id), sql });
  try { for (const id of S.win.ids) modelsOf(defs.get(id).sql, defs); } catch (e) { problems.push(e.message); }
  if (problems.length) { stopPreview(problems); return; }
  S.edit.live = changes;
  S.edit.since = Date.now();
  S.edit.note = null;
  api.log('markets', `Previewing changes to ${[...changes.keys()].join(', ')}`, null, 'debug');
  draw();
  S.urgent = true;
  paint();
}

function stopPreview(note = null) {
  closeSave();
  S.edit.live = null;
  S.edit.note = note;
  for (const k of [...S.res.keys()]) if (k.startsWith('preview:')) S.res.delete(k);
  draw();
}

/** An editor box for one definition: its SQL, what it is, and who reads it. */
function editBox(id) {
  const d = DEFS.get(id);
  const readers = d.kind === 'model'
    ? [...DEFS.values()].filter((x) => x.kind === 'metric' && (() => { try { return modelsOf(x.sql).includes(id); } catch { return false; } })()).map((x) => x.name)
    : [];
  const text = S.edit.text.has(id) ? S.edit.text.get(id) : d.sql;
  const rows = Math.min(30, Math.max(6, text.split('\n').length + 1));
  return `<div class="mkt-edit-box${edited(id) ? ' changed' : ''}" data-box="${esc(id)}">
    <div class="h"><b>${esc(d.name)}</b><code>${esc(id)}</code><span class="faint">${d.kind === 'model' ? 'a shared step' : 'the number\'s own query'}${d.own ? `, your own version ${d.own.version}` : d.version ? `, version ${d.version}` : ''}</span><span class="sp"></span>
      ${SRC.mine.canSave && d.from === 'lakehouse' ? `<button class="btn btn-sm" type="button" data-mkt="edit-history" data-def="${esc(id)}">History</button>` : ''}
      <button class="btn btn-sm" type="button" data-mkt="edit-undo" data-def="${esc(id)}">Undo my changes</button>
      <button class="btn btn-sm" type="button" data-mkt="edit-close" data-def="${esc(id)}">Close</button></div>
    <p class="faint">${d.kind === 'model'
    ? `Read by name (<code>FROM ${esc(id)}</code>) by ${readers.length ? readers.map(esc).join(', ') : 'no number yet'}: changing it changes every one of them. This window previews its own numbers.`
    : `Its shared steps (whatever follows FROM or JOIN, such as <code>today</code>) are put in front of it as <code>WITH ... AS (...)</code> when it runs. Keep the parameters as they are: the page writes in their values when it runs, so <code>:kind IN ('all', market_type)</code> becomes <code>market_type = 'crypto'</code> when Crypto is chosen, or <code>TRUE</code> for All; <code>:yesterday</code> becomes yesterday's date${id === 'market' ? ' and <code>:symbol</code> the market' : ''}.`}</p>
    <textarea data-def="${esc(id)}" rows="${rows}" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="SQL of ${esc(d.name)}">${esc(text)}</textarea>
    <div class="mkt-hist" data-hist="${esc(id)}">${histHtml(id)}</div>
  </div>`;
}

/** A definition's history in its box: every version from the lakehouse, newest first, with who changed
 * it, when and why, its SQL, and a button that makes it the next version (through Preview and Save). */
function histHtml(id) {
  const h = S.edit.hist.get(id);
  if (!h) return '';
  const head = `<div class="h"><b>History</b><span class="faint">every version in the lakehouse, newest first</span><span class="sp"></span>
    <button class="btn btn-sm" type="button" data-mkt="edit-history" data-def="${esc(id)}">Read again</button>
    <button class="btn btn-sm" type="button" data-mkt="edit-hist-close" data-def="${esc(id)}">Close</button></div>`;
  if (h.state === 'loading') return `${head}<p class="faint">Reading from the lakehouse… (Databricks can take up to a minute to wake up)</p>`;
  if (h.state === 'error') return `${head}<p class="warn">${esc(h.error)}</p>`;
  const d = DEFS.get(id);
  const inUse = (v) => (v.scope === 'own' ? d.own && d.own.version === v.version : !d.own && d.version === v.version);
  const row = (v) => `<div class="mkt-hist-row${inUse(v) ? ' current' : ''}">
    <div><b>${v.scope === 'own' ? 'Your own version' : 'Shared version'} ${v.version}</b>${inUse(v) ? ' <span class="mkt-tag up">in use</span>' : v.is_current ? ' <span class="faint">(current)</span>' : ''}
      <span class="faint">${esc(v.valid_from || '')}${v.valid_to ? ` → ${esc(v.valid_to)}` : ' → now'} UTC · ${esc(v.changed_by || '')}${v.based_on ? ` · from shared version ${v.based_on}` : ''}</span></div>
    ${v.change_note ? `<div>“${esc(v.change_note)}”</div>` : ''}
    <details><summary>Its SQL</summary><pre>${esc(v.sql_text)}</pre></details>
    ${inUse(v) ? '' : `<button class="btn btn-sm" type="button" data-mkt="edit-reuse" data-def="${esc(id)}" data-scope="${v.scope}" data-v="${v.version}">Use this version again</button>`}
  </div>`;
  const shared = h.versions.filter((v) => v.scope === 'shared'), own = h.versions.filter((v) => v.scope === 'own');
  return `${head}${own.length ? `<p class="faint">Your own versions (only your account uses them):</p>${own.map(row).join('')}` : ''}
    <p class="faint">${own.length ? 'The shared versions (every account without its own uses the current one):' : 'The shared versions:'}</p>${shared.map(row).join('')}`;
}

function paintHist(id) {
  const el = [...document.querySelectorAll('[data-hist]')].find((x) => x.dataset.hist === id);
  if (el) el.innerHTML = histHtml(id);
}

async function loadHistory(id) {
  S.edit.hist.set(id, { state: 'loading' });
  paintHist(id);
  try {
    const r = await api.call('GET', `/api/market/metrics/history?id=${encodeURIComponent(id)}`);
    S.edit.hist.set(id, { state: 'ok', versions: r.versions || [] });
  } catch (e) {
    S.edit.hist.set(id, { state: 'error', error: e.message });
  }
  paintHist(id);
}

/** An old version becomes the next one: its SQL goes into the editor, is previewed, and Save opens with
 * a note saying where it came from. Saving it goes through every check, like any change. */
function reuseVersion(id, scope, version) {
  const h = S.edit.hist.get(id), v = h && h.versions && h.versions.find((x) => x.scope === scope && x.version === version);
  if (!v) return;
  S.edit.text.set(id, v.sql_text);
  if (!S.edit.open.includes(id)) S.edit.open.push(id);
  paintEditors();
  startPreview();
  if (S.edit.live && S.edit.live.has(id)) {
    openSave(new Map([[id, { note: `Back to ${scope === 'own' ? 'my own' : 'shared'} version ${version}`, description: v.description || DEFS.get(id).description }]]));
  }
}

/** The editor's boxes, drawn only when one opens or closes (so typing is never interrupted). */
function paintEditors() {
  const el = document.getElementById('mkt-edit-boxes');
  if (el) el.innerHTML = S.edit.open.map(editBox).join('');
}

/** The definitions a window can edit: its numbers' own queries, then the shared steps they read. */
function editable() {
  const out = [...S.win.ids];
  for (const id of S.win.ids) { try { for (const m of modelsOf(DEFS.get(id).sql)) if (!out.includes(m)) out.push(m); } catch { /* shown when previewed */ } }
  return out;
}

function paintEditBar() {
  const chips = editable().map((id) => {
    const d = DEFS.get(id), open = S.edit.open.includes(id);
    return `<button class="mkt-chip" type="button" data-mkt="edit-open" data-def="${esc(id)}" aria-pressed="${open}">${esc(d.kind === 'model' ? id : d.name)}${d.own ? ` <span class="faint">own v${d.own.version}</span>` : d.version ? ` <span class="faint">v${d.version}</span>` : ''}${edited(id) ? ' <span class="mkt-dirty" title="Changed">●</span>' : ''}</button>`;
  }).join('');
  put('mkt-edit-pick', `<span class="faint">Open to edit:</span>${chips}`);
  const live = S.edit.live;
  const note = S.edit.note;
  put('mkt-edit-status', live
    ? `<span class="mkt-dot live"></span>Previewing your changes to ${[...live.keys()].map((d) => `<code>${esc(d)}</code>`).join(', ')} since ${clockS(S.edit.since)}, on this screen only. Nothing is saved${SRC.mine.canSave ? ' until you press Save' : ''}.`
    : `<span class="faint">${[...S.edit.text.keys()].some(edited) ? 'Changed, not previewed yet.' : 'Your version runs on this screen only, next to the current one.'}</span>`);
  put('mkt-edit-problems', note ? `<ul class="mkt-problems">${(Array.isArray(note) ? note : [note]).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '');
  document.querySelectorAll('[data-mkt="preview-stop"]').forEach((b) => { b.hidden = !live; });
  const reload = document.querySelector('[data-mkt="defs-reload"]');
  if (reload) reload.hidden = !(SRC.mine.canSave && SRC.mine.saves === 'shared');
  const save = document.querySelector('[data-mkt="save-open"]');
  if (save) save.hidden = !(live && SRC.mine.canSave && [...live.keys()].every((id) => DEFS.get(id).from === 'lakehouse'));
  put('mkt-edit-saves', SRC.mine.canSave
    ? `After a preview, <b>Save</b> keeps it in the lakehouse ${SRC.mine.saves === 'shared' ? 'as the <b>shared</b> version, which every account uses' : 'as <b>your own</b> version, which only your account uses'}.`
    : 'Saving isn\'t set up on this MEDUSA, so changes can only be previewed.');
}

/* ---------- saving to the lakehouse (metrics.js on the server) ---------- */

// Saves and give-ups reach every MEDUSA tab and window in this browser at once.
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('medusa-markets') : null;
const tell = (msg) => { try { if (channel) channel.postMessage(msg); } catch { /* the others catch up on their next load */ } };

/** A saved version from the server becomes the definition in use here. */
function applySaved({ saves, definition: d }) {
  if (saves === 'shared') SRC.shared = [...SRC.shared.filter((r) => r.metric_id !== d.metric_id), d];
  else SRC.mine.rows = [...SRC.mine.rows.filter((r) => r.metric_id !== d.metric_id), d];
  rebuildDefs();
}
function applyGaveUp(id) {
  S.edit.hist.delete(id);
  SRC.mine.rows = SRC.mine.rows.filter((r) => r.metric_id !== id);
  rebuildDefs();
}
function definitionsChanged() {
  S.edit.painted = null;   // the editor's boxes show the new versions (unless someone is typing)
  draw();
  S.urgent = true;
  paint();
}
if (channel) {
  channel.onmessage = ({ data }) => {
    if (!data || !host) return;
    if (data.type === 'saved' && data.definition) applySaved(data);
    else if (data.type === 'gaveup') applyGaveUp(data.metric_id);
    else if (data.type === 'reloaded' && Array.isArray(data.shared)) applyReload(data);
    else return;
    definitionsChanged();
  };
}

/** The definitions read again from the lakehouse (the owner's Reload): the shared ones and the
 * account's own replace what this page had. */
function applyReload({ shared, mine }) {
  SRC.shared = shared;
  if (Array.isArray(mine)) SRC.mine.rows = mine;
  S.edit.hist.clear();
  rebuildDefs();
}

/** The browser keeps the shared answer (/api/market/scanner) for 5 minutes. After a change to the shared
 * definitions it is fetched once past that copy, which puts the new one in its place, so a window or page
 * opened next gets the new versions too (the tabs already open have them from the channel). */
const refreshShared = () => fetch('/api/market/scanner', { cache: 'reload', credentials: 'same-origin' }).catch(() => {});

async function reloadDefs() {
  const b = document.querySelector('[data-mkt="defs-reload"]');
  if (b) b.disabled = true;
  try {
    const r = await api.call('POST', '/api/market/metrics/reload');
    applyReload(r);
    refreshShared();
    tell({ type: 'reloaded', shared: r.shared, mine: r.mine });
    api.toast(`Read ${r.counts.shared} shared definitions${r.counts.own ? ` and ${r.counts.own} accounts' own versions` : ''} from the lakehouse into MEDUSA.`);
    api.log('markets', `Reloaded the definitions from the lakehouse (${r.counts.shared} shared, ${r.counts.own} own)`);
    definitionsChanged();
  } catch (e) {
    api.toast(e.message, 'error');
  } finally {
    if (b) b.disabled = false;
  }
}

/** Every number the edits change, run once with them (every type, and Bitcoin for one market's row):
 * none may fail or stop returning a column its display needs. The window previews only its own
 * numbers; this covers the whole page before anything is saved. */
async function checkEverything() {
  const defs = previewDefs();
  const params = { kind: 'all', yesterday: yesterday(), symbol: 'BTCUSDT' };
  const ids = [...DEFS.values()].filter((d) => d.kind === 'metric' && touches(d.id, defs)).map((d) => d.id);
  const out = await call({ op: 'run', jobs: ids.map((id) => ({ id, sql: assemble(defs.get(id), { defs, params }) })) }, 5_000);
  const problems = [];
  for (const id of ids) {
    const res = out[id], name = DEFS.get(id).name;
    if (res.error) { problems.push(`${name}: ${res.error}`); continue; }
    const missing = neededColumns(id).filter((c) => !res.columns.includes(c));
    if (missing.length) problems.push(`${name} would no longer return ${missing.join(', ')}, which the page needs.`);
  }
  return { ids, problems };
}

/** The save form: one note (and description) per changed definition, and what Save will do. */
function openSave(prefill = new Map()) {
  const el = document.getElementById('mkt-edit-save');
  if (!el || !S.edit.live) return;
  const shared = SRC.mine.saves === 'shared';
  el.innerHTML = `<div class="mkt-save">
    <p>${shared ? '<b>Save as the shared version.</b> Every account\'s Markets page will use it.'
    : '<b>Save as your own version.</b> Only your account\'s Markets page will use it; the shared definition stays as it is, and you can go back to it whenever you like.'}
      It is kept in the lakehouse (<code>market.semantic.${shared ? 'metric_definitions' : 'user_metric_definitions'}</code>) as a new version, with the time, your name (${esc(SRC.mine.name)}) and your note. The version before it is kept too.</p>
    ${[...S.edit.live.keys()].map((id) => `<div class="mkt-save-one">
      <div><b>${esc(DEFS.get(id).name)}</b> <code>${esc(id)}</code></div>
      <label>Why you changed it <input class="input" data-save-note="${esc(id)}" maxlength="300" placeholder="For example: count only moves bigger than 1%" value="${esc((prefill.get(id) || {}).note || '')}"></label>
      <label>What it means now <span class="faint">(optional)</span><textarea class="input" data-save-desc="${esc(id)}" rows="2" maxlength="1000">${esc((prefill.get(id) || {}).description ?? DEFS.get(id).description)}</textarea></label>
    </div>`).join('')}
    <div class="mkt-edit-bar"><button class="btn btn-green" type="button" data-mkt="save-go">Save to the lakehouse</button>
      <button class="btn" type="button" data-mkt="save-cancel">Cancel</button><span id="mkt-save-status"></span></div>
  </div>`;
  const first = el.querySelector('[data-save-note]');
  if (first) first.focus();
}
const closeSave = () => { const el = document.getElementById('mkt-edit-save'); if (el) el.innerHTML = ''; };

/** Save: check the whole page with the edits, then save each changed definition, one after another. */
async function doSave() {
  const status = (html) => { const s = document.getElementById('mkt-save-status'); if (s) s.innerHTML = html; };
  const go = document.querySelector('[data-mkt="save-go"]');
  if (!S.edit.live || (go && go.disabled)) return;
  if (go) go.disabled = true;
  const field = (attr, id) => [...host.querySelectorAll(`[${attr}]`)].find((x) => x.getAttribute(attr) === id);
  const forms = new Map([...S.edit.live.keys()].map((id) => [id, { note: field('data-save-note', id).value.trim(), description: field('data-save-desc', id).value.trim() }]));
  status('Checking every number your changes touch…');
  let check;
  try {
    check = await checkEverything();
  } catch (e) {
    check = { problems: [`The check couldn't run: ${e.message}`] };
  }
  if (check.problems.length) {
    S.edit.note = ['Nothing was saved: with your changes, these numbers would break.', ...check.problems];
    status('');
    if (go) go.disabled = false;
    paintEditBar();
    return;
  }
  const saved = [], live = new Map(S.edit.live);
  let failure = null;
  for (const [id, sql] of live) {
    const d = DEFS.get(id), form = forms.get(id);
    const base = SRC.mine.saves === 'shared' ? (d.version || 0) : (d.own ? d.own.version : 0);
    status(`Saving ${esc(d.name)} in the lakehouse… <span class="faint">(Databricks can take up to a minute to wake up)</span>`);
    try {
      const r = await api.call('POST', '/api/market/metrics/save', { metric_id: id, sql_text: sql, description: form.description, note: form.note, base });
      applySaved(r);
      tell({ type: 'saved', saves: r.saves, definition: r.definition });
      S.edit.text.delete(id);
      S.edit.hist.delete(id);
      saved.push(`${d.name}: ${r.saves === 'shared' ? 'shared' : 'your own'} version ${r.definition.version}${r.copied === false ? ' (MEDUSA\'s copy catches up with the next daily publish)' : ''}`);
      api.log('markets', `Saved ${id} as ${r.saves === 'shared' ? 'shared' : 'own'} version ${r.definition.version}`);
    } catch (e) {
      failure = `${d.name} wasn't saved: ${e.message}`;
      break;
    }
  }
  if (saved.length && SRC.mine.saves === 'shared') refreshShared();
  closeSave();
  stopPreview(failure ? [failure, ...(saved.length ? [`Saved before it: ${saved.join('; ')}.`] : [])] : null);
  if (saved.length) api.toast(`Saved in the lakehouse. ${saved.join('; ')}.`, '', 8000);
  definitionsChanged();
}

/** Back to the shared definition: the account's own version is given up (kept in the lakehouse's
 * history, no longer in use). */
async function giveUp(id) {
  const d = DEFS.get(id);
  if (!d || !d.own) return;
  if (!window.confirm(`Use the shared version of ${d.name} again? Your own version ${d.own.version} stays in the lakehouse's history but your page stops using it.`)) return;
  try {
    await api.call('POST', '/api/market/metrics/reset', { metric_id: id, base: d.own.version });
  } catch (e) {
    api.toast(e.message, 'error');
    return;
  }
  applyGaveUp(id);
  tell({ type: 'gaveup', metric_id: id });
  api.toast(`${d.name} uses the shared version again.`);
  api.log('markets', `Gave up own version ${d.own.version} of ${id}`);
  definitionsChanged();
}

/* ---------- the page ---------- */

const CSS = `
.mkt-bar { display: flex; flex-wrap: wrap; gap: 8px 14px; justify-content: space-between; align-items: center; }
.mkt-bar .toggle, .mkt-tools .toggle, .mkt-win-head .toggle { flex-wrap: wrap; gap: 6px; }
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
  .mkt-bar .toggle button, .mkt-tools .toggle button, .mkt-win-head .toggle button { height: 32px; padding: 0 10px; font-size: 13.5px; }
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
.mkt-calc { display: flex; align-items: center; gap: 10px; margin: 12px 0 6px; color: var(--text-3); }
.mkt-calc .mkt-src-btn { margin-left: 0; }
.mkt-src { margin: 0 0 14px; padding: 12px 14px 6px; border-radius: 9px; background: #1b1b1b; border: 1px dashed var(--border-2); color: var(--text-2); font-size: 13.5px; line-height: 1.55; }
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
/* a ‹› window (markets-window.html): the editor on the left, the results on the right */
.mkt-win { max-width: 1880px; margin: 0 auto; padding: 16px 16px 40px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.mkt-win-grid, .mkt-win-out { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; min-width: 0; }
@media (min-width: 1100px) {
  .mkt-win-grid { grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); }
  .mkt-edit { position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow: auto; }
}
.mkt-edit .card-head { margin-bottom: 10px; }
.mkt-edit-pick { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.mkt-chip { height: 30px; padding: 0 11px; border-radius: 99px; border: 1px solid var(--border-2); background: #1f1f1f; color: var(--text-2); font-size: 13px; font-weight: 600; }
.mkt-chip:hover { color: var(--text); }
.mkt-chip[aria-pressed="true"] { border-color: var(--green-btn); background: #1c2b21; color: var(--text); }
.mkt-dirty { color: #facc15; }
.mkt-edit-box { margin-top: 12px; border: 1px solid var(--border-2); border-radius: 8px; overflow: hidden; }
.mkt-edit-box.changed { border-color: #a16207; }
.mkt-edit-box .h { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 6px 8px 6px 12px; background: #232323; font-size: 13.5px; }
.mkt-edit-box .h code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: var(--text-3); }
.mkt-edit-box .h .sp { flex: 1; }
.mkt-edit-box .h .btn { height: 28px; padding: 0 10px; font-size: 12.5px; }
.mkt-edit-box > p { margin: 0; padding: 8px 12px; font-size: 13px; line-height: 1.5; background: #1b1b1b; border-bottom: 1px solid var(--border); }
.mkt-edit-box > p code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: var(--text-2); }
.mkt-edit-box textarea { display: block; width: 100%; min-height: 150px; resize: vertical; border: 0; outline: 0; padding: 10px 12px; background: #141414; color: #e4e4e7; font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.5; tab-size: 2; white-space: pre; overflow-wrap: normal; overflow-x: auto; }
.mkt-edit-box textarea:focus { box-shadow: inset 0 0 0 1px var(--green-btn); }
.mkt-edit-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 12px; font-size: 13.5px; color: var(--text-2); }
.mkt-edit-bar code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: var(--text); }
.mkt-problems { margin: 10px 0 0; padding-left: 20px; display: grid; gap: 4px; color: #e8c547; font-size: 13.5px; line-height: 1.5; }
.mkt-cmp { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 18px; }
.mkt-cmp.cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.mkt-cmp-yours .mkt-win-h, .mkt-yours-h { color: #facc15; }
.mkt-src.mkt-yours { border-color: #a16207; }
.mkt-save { margin-top: 12px; padding: 12px 14px; border-radius: 9px; border: 1px solid var(--green-btn); background: #18231c; display: grid; gap: 10px; font-size: 13.5px; line-height: 1.5; color: var(--text-2); }
.mkt-save b { color: var(--text); }
.mkt-save code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: var(--text); }
.mkt-save-one { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.mkt-save label { display: grid; gap: 4px; color: var(--text-2); }
.mkt-save .input { width: 100%; height: auto; min-height: 36px; padding: 7px 10px; border-radius: 7px; border: 1px solid var(--border-2); background: #141414; color: var(--text); font: inherit; resize: vertical; }
.mkt-save .mkt-edit-bar { margin-top: 2px; }
.mkt-hist:empty { display: none; }
.mkt-hist { border-top: 1px solid var(--border); background: #191919; padding-bottom: 6px; font-size: 13px; line-height: 1.5; color: var(--text-2); }
.mkt-hist > p { margin: 8px 12px 4px; }
.mkt-hist-row { margin: 6px 12px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 7px; display: grid; gap: 4px; }
.mkt-hist-row.current { border-color: var(--green-btn); }
.mkt-hist-row b { color: var(--text); }
.mkt-hist-row details summary { cursor: pointer; color: var(--text-3); }
.mkt-hist-row pre { margin: 6px 0 0; padding: 8px 10px; max-height: 260px; overflow: auto; font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #d4d4d8; background: #141414; border-radius: 6px; }
.mkt-hist-row .btn { justify-self: start; height: 28px; padding: 0 10px; font-size: 12.5px; }
.mkt-edit .card-head > .btn { flex: none; }
.mkt-win-head { display: flex; flex-wrap: wrap; gap: 10px 16px; justify-content: space-between; align-items: center; }
.mkt-win-head h1 { font-size: 22px; font-weight: 700; }
.mkt-win-head p { margin-top: 2px; font-size: 13.5px; }
.mkt-win .card-head { margin-bottom: 4px; }
.mkt-win .card-head h2 { font-size: 20px; }
.mkt-win-h { margin: 16px 0 8px; font-size: 14px; font-weight: 600; color: var(--text-2); }
.mkt-win .mkt-src { margin: 0; max-height: none; }
.kpis.mkt-win-card { grid-template-columns: minmax(0, 340px); }
.mkt-win-note { margin-top: 6px; font-size: 13px; }
.mkt-msg { margin: 6px 0 10px; padding: 10px 12px; overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; line-height: 1.5; color: #d4d4d8; background: #161616; }
@media (max-width: 640px) { .mkt-win { padding: 10px 10px 30px; gap: 10px; } .mkt-win .card { padding: 16px 14px; } }
`;

function shell() {
  if (S.win) { windowShell(); return; }
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
    <section class="card">
      <div class="card-head"><div><h2>Unusual right now</h2><p>Markets that have moved at least ${RULE.z} of their usual daily moves today, and what similar moves did next. Tap a row for the details and how its numbers are calculated.</p></div>${srcBtn('unusual')}</div>
      <div id="mkt-unusual"></div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Movers today</h2><p>The biggest moves since yesterday's close (UTC)</p></div>${srcBtn('movers')}</div>
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
          ${srcBtn('markets')}
        </div>
      </div>
      <div id="mkt-all"></div>
    </section>
    <details class="card mkt-how">
      <summary>How the scanner works</summary>
      <ul>
        <li><b>The markets</b> are every Binance USDⓈ-M perpetual futures contract quoted in USDT: crypto coins and tokens, and the TradFi perpetuals on stocks, commodities, a currency and indices. The type next to each name comes from Binance's contract list.</li>
        <li><b>Each market's normal</b> comes from MEDUSA's market data lakehouse: the average and spread (σ) of its daily moves over its last 30 days with trades, built from Binance's checked daily files and published once a day (about 13:30 UTC).</li>
        <li><b>Live prices</b> come straight from Binance to this browser, about once a second. MEDUSA's server never sees them.</li>
        <li><b>Every number here is calculated by SQL</b>, in a small SQLite database inside this browser that holds the lakehouse's tables and the live prices. The queries are kept in the lakehouse too, with every version, and published to MEDUSA with the data. They run about once a second; each <b>‹›</b> button opens one in its own window, live: the query exactly as it runs, which version it is, its result, and a copy that runs in MEDUSA's database or in Databricks.</li>
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
 * held still while the pointer is over its details, or over a window's live result, so they can be read,
 * selected and copied. The queries a part's panels registered are kept for Copy only when the part was
 * redrawn. */
function put(id, html) {
  const copies = PENDING;
  PENDING = [];
  if (S.html.get(id) === html) { for (const [k, v] of copies) S.sql.set(k, v); return; }
  const el = document.getElementById(id);
  if (!el || el.querySelector('.mkt-more:hover') || (el.classList.contains('mkt-hold') && el.matches(':hover'))) return;
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
  run().then(() => { S.runErr = null; }, (e) => { S.runErr = e.message; logOnce('run', e.message, `The queries couldn't run: ${e.message}`); })
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
  if (!S.win) {
    document.getElementById('mkt-kinds').hidden = S.view !== 'today';
    document.getElementById('mkt-today').hidden = S.view !== 'today';
    document.getElementById('mkt-patterns').hidden = S.view !== 'patterns';
  }
  if (S.loadErr || !S.data) {
    put('mkt-status', S.loadErr
      ? `<div><b>The market data couldn't be loaded.</b> ${esc(S.loadErr)} <button class="btn btn-sm" data-mkt="retry">Try again</button></div>`
      : '<div>Loading the market data…</div>');
    return;
  }
  paintStatus();
  if (S.win) { paintWindow(); return; }
  if (S.view === 'patterns') { paintPatterns(); return; }
  paintKpis();
  paintUnusual();
  paintMovers();
  paintAll();
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
        : S.lastRun ? `Numbers calculated by SQL in this browser: ${S.lastRun.n} quer${S.lastRun.n === 1 ? 'y' : 'ies'} at ${clockS(S.lastRun.at)} in ${S.lastRun.ms} ms, defined ${DEFS.get('breadth').from === 'lakehouse' ? 'in the lakehouse' : 'by the built-in copy'}${SRC.mine.rows.length ? ` (${SRC.mine.rows.length} of them your own version${SRC.mine.rows.length === 1 ? '' : 's'})` : ''}` : 'Calculating…';
  put('mkt-status', `
    <div class="row"><span>${live}</span><span class="faint">${priced} markets priced</span></div>
    <div class="row faint"><span>Each market's normal: lakehouse day ${shortDay(pub.as_of)}${pub.published_at ? `, published ${clock(pub.published_at)}` : ''}</span><span>${ref}</span></div>
    <div class="row faint"><span>${engine}</span></div>
    <div class="row faint"><span>Live numbers are unchecked until the next daily run; the evidence is history, not a trading signal.</span></div>`);
}

/** A summary card: its text filled in from its query's result. */
function kpi(id, res, btn = '') {
  const d = DEFS.get(id);
  const v = res && res.error ? '<span class="neg">!</span>' : fillCard(d.card.value, res);
  const s = res && res.error ? 'The query failed: see ‹›' : fillCard(d.card.sub, res);
  return `<div class="kpi"><div class="k"><span class="kt">${esc(d.name)}</span>${btn}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
}

function paintKpis() {
  put('mkt-kpis', ['breadth', 'median_move', 'unusual_count', 'bitcoin'].map((id) => kpi(id, S.res.get(id), srcBtn(id))).join(''));
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

/** A market's details: its move in words (from its query), the evidence when unusual, and a ‹› button
 * for how its numbers are calculated. */
function marketDetail(sym) {
  const key = `market:${sym}`, res = S.res.get(key);
  const calc = `<p class="mkt-calc">${srcBtn('market', sym)}<span>How ${name(sym)}'s numbers are calculated, in their own window</span></p>`;
  if (!res) return '<div class="mkt-more"><p>Calculating…</p></div>';
  if (res.error) return `<div class="mkt-more">${failed(res)}${calc}</div>`;
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
  return `<div class="mkt-more">${html}${calc}</div>`;
}

/** For one market's window: the Binance message behind its price, and the past moves behind its verdicts. */
function marketExtras(sym) {
  const r = objects(S.res.get(`market:${sym}`))[0], l = S.live.get(sym);
  const raw = l
    ? `<p>${l.via === 'stream' ? `From Binance's live stream at ${clockS(l.t)}: <code>c</code> is the last price, <code>q</code> the USDT traded in the last 24 hours.` : `From Binance's price snapshot of ${clockS(l.t)}: it hasn't traded since this window opened.`}</p><pre class="mkt-msg">${esc(JSON.stringify(l.raw))}</pre>`
    : '<p class="faint">No price from Binance yet.</p>';
  const past = r && r.direction
    ? `<h3 class="mkt-win-h">Every past move behind its verdicts</h3>${sqlBlock('Databricks SQL', `SELECT event_hour, symbol, z, move_so_far, fwd_return_1h, fwd_return_4h, fwd_return_24h, period\nFROM market.gold.intraday_events\nWHERE direction = '${r.direction}' AND z_band = '${r.z_band}' AND liquidity = '${r.liquidity}'\nORDER BY event_hour DESC;`)}<p class="faint">Built by ${ghLink('intraday_events.sql')}; it exists only in the lakehouse.</p>`
    : '';
  return `<h3 class="mkt-win-h">The Binance message behind the price</h3>${raw}${past}`;
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

/** The Patterns view, drawn from three queries (patterns_summary, patterns_held, patterns_grid) like
 * Today's numbers. A cell's details put that kind of move's evidence row into words. */
function paintPatterns() {
  const ev = S.data.ev;
  const pub = S.data.published.market_evidence || {};
  const sumRes = S.res.get('patterns_summary'), heldRes = S.res.get('patterns_held'), gridRes = S.res.get('patterns_grid');
  const sum = sumRes && !sumRes.error ? objects(sumRes)[0] || {} : {};
  const n = (v) => (v == null ? '–' : Number(v).toLocaleString('en-US'));
  const cost = sum.cost_pct == null ? '–' : `${Number(sum.cost_pct).toFixed(2)}%`;
  const state = (res) => (!res ? pending() : res.error ? failed(res) : null);

  // One row per held-up pattern and market in it right now (a pattern with none has one row).
  let heldHtml = state(heldRes);
  if (!heldHtml) {
    const held = [];
    for (const r of objects(heldRes)) {
      const k = evKey(r.direction, r.z_band, r.liquidity, r.horizon_hours);
      if (!held.length || held[held.length - 1].k !== k) held.push({ k, r, markets: [] });
      if (r.market) held[held.length - 1].markets.push(r.market);
    }
    heldHtml = held.length ? held.map(({ r, markets }) => `<div><b>${r.side === 'fade' ? 'Fade' : 'Follow'} ${kindPhrase(r.direction, r.z_band, r.liquidity)}, over the next ${Number(r.horizon_hours) === 1 ? 'hour' : `${r.horizon_hours} hours`}:</b> <span class="mkt-ev">${pct(r.held_back_pct / 100)}</span> a trade from 2025 after ${Number(r.cost_pct).toFixed(2)}% costs (t ${tval(r.held_back_t)} over ${r.held_back_days} days), chosen on 2020–2024 (t ${tval(r.in_sample_t)} over ${r.in_sample_days} days). ${r.events} moves on ${r.days} days in all. Right now: ${markets.length ? markets.map(name).join(', ') : 'no market'}.</div>`).join('')
      : '<div>No kind of move held up.</div>';
  }

  let gridHtml = state(gridRes);
  if (!gridHtml) {
    const rows = [];
    let dir = null;
    for (const r of objects(gridRes)) {
      if (r.direction !== dir) { dir = r.direction; rows.push(`<tr class="grp"><td colspan="5">${dir === 'up' ? 'Up moves' : 'Down moves'}</td></tr>`); }
      const cells = HORIZONS.map((h) => {
        const k = evKey(r.direction, r.z_band, r.liquidity, h);
        return `<td data-mkt="pat" data-k="${k}" aria-selected="${S.pat === k}"><div class="mkt-evc"><span class="v">${verdictText(r[`next_${h}h`])}</span></div></td>`;
      }).join('');
      rows.push(`<tr><td class="l">${kindName(r.direction, r.z_band, r.liquidity)}</td><td>${Number(r.now) || '<span class="faint">0</span>'}</td>${cells}</tr>`);
    }
    gridHtml = `<div class="scroll-x"><table class="mkt-table"><thead><tr><th>Kind of move</th><th title="Markets in this group right now">Now</th><th>Next 1 h</th><th>Next 4 h</th><th>Next 24 h</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  let detail = '';
  if (S.pat && ev.get(S.pat)) {
    const e = ev.get(S.pat);
    const flagged = objects(S.res.get('unusual_all_types'));   // live, every type
    const m = flagged.filter((r) => r.direction === e.direction && (e.z_band === 'all' || (r.z_band === e.z_band && r.liquidity === e.liquidity)));
    detail = `<div class="mkt-more"><p><b>${kindName(e.direction, e.z_band, e.liquidity)}</b>${e.z_band === 'all' ? ' (any size, any market)' : ''}.</p>${evWords(e, e.horizon_hours)}<p>Right now: ${m.length ? m.map((r) => `${name(r.market)} ${sig(r.z)}`).join(', ') : 'no market is in this group'}.</p>
      <h4>Where these numbers come from</h4><p>The lakehouse's <code>gold.event_evidence</code> (${ghLink('event_evidence.sql')}), built from <code>gold.intraday_events</code> (${ghLink('intraday_events.sql')}), copied to MEDUSA's <code>market_evidence</code>. <b>Now</b> is live; the table's queries are under ‹›.</p>${evidenceSql(e.direction, e.z_band, e.liquidity)}</div>`;
  }

  const counts = state(sumRes) || `<div class="mkt-counts"><span><b>${n(sum.held_up)}</b> held up</span><span><b>${n(sum.did_not_hold)}</b> did not hold</span><span><b>${n(sum.no_pattern)}</b> no pattern</span><span><b>${n(sum.too_few)}</b> too few</span><span>of <b>${n(sum.kinds)}</b> kinds of move and horizons</span></div>`;
  const moves = sum.moves_up == null ? '' : `: about ${n(Number(sum.moves_up) + Number(sum.moves_down))} moves (${n(sum.moves_up)} up, ${n(sum.moves_down)} down), almost all of them crypto`;
  put('mkt-patterns', `
    <section class="card">
      <div class="card-head"><div><h2>What similar moves did next</h2><p>Every time a market's move during a day reached ${RULE.z} of its usual daily moves since January 2020, the lakehouse recorded what the price did over the next 1, 4 and 24 hours${moves}. Lakehouse day ${shortDay(pub.as_of)}.</p></div>${srcBtn('patterns')}</div>
      ${counts}
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Patterns that held up</h2><p>Chosen on 2020–2024 and still profitable after costs from 2025, on years that played no part in choosing them</p></div>${srcBtn('patterns')}</div>
      <div class="mkt-held">${heldHtml}</div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Every kind of move</h2><p>By direction, size (z) and the market's liquidity; <b>Now</b> counts the markets in each group right now. Tap a cell for the details.</p></div>${srcBtn('patterns')}</div>
      ${gridHtml}
      ${detail}
    </section>
    <section class="card">
      <div class="card-head"><div><h2>How a verdict is decided</h2></div></div>
      <ul class="mkt-rules">
        <li><b>Days, not moves.</b> Markets move together: one crash day can give hundreds of moves, and they aren't hundreds of separate proofs. Each day's moves are averaged first, and the statistics are over days.</li>
        <li><b>t</b> measures how clearly the moves kept going (positive) or turned back (negative), given how much they vary from day to day; beyond ±2 is unlikely to be chance.</li>
        <li><b>The side is chosen on 2020–2024 only.</b> If moves kept going there with t ≥ 2, the side is <b>follow</b>; if they turned back with t ≤ −2, it is <b>fade</b>; otherwise there is <b>no pattern</b>.</li>
        <li><b>It is then checked on 2025 onwards</b>, which played no part in the choice. <b>Held up</b> needs the moves to behave the same way there (t ≥ 2 for follow, t ≤ −2 for fade) and a profit after ${cost} round-trip costs in both periods; otherwise it <b>did not hold</b>.</li>
        <li><b>Too few</b>: fewer than 20 days in either period.</li>
        <li>With ${n(sum.kinds)} groups tested, a few can pass by luck, which is why the held-back check matters and why the rules aren't tuned after looking at it (ADR-022). Costs are optimistic for small markets, funding isn't counted, and almost all the history is crypto. This is research, not trading advice.</li>
      </ul>
    </section>`);
}

/* ---------- a ‹› window: one number's calculation on its own (markets-window.html) ---------- */

const WIN_TITLES = { movers: 'Movers today', patterns: 'Patterns: what similar moves did next' };

/* On a wide screen the editor is on the left and the results on the right; narrower, one under the
   other. The editor's boxes are drawn only when one opens or closes, never while typing. */
function windowShell() {
  const { panel, ids } = S.win;
  const named = ids.length > 1 || panel === 'patterns';   // otherwise the window's title is the number's name
  host.innerHTML = `
  <header class="mkt-win-head">
    <div><h1 id="mkt-win-title"></h1><p class="faint">How it is calculated, live, and your own version of it: the query exactly as the Markets page runs it, on the same data and live prices.</p></div>
    ${panel === 'market' || panel === 'patterns' ? '' : `<div class="toggle" role="group" aria-label="Markets" id="mkt-kinds">
      ${KINDS.map(([v, l]) => `<button data-mkt="kind" data-v="${v}" aria-pressed="${v === S.kind}">${l}</button>`).join('')}
    </div>`}
  </header>
  <div class="banner mkt-status" id="mkt-status" aria-live="polite"></div>
  <div class="mkt-win-grid">
    <section class="card mkt-edit" aria-label="Edit and preview">
      <div class="card-head"><div><h2>Edit, preview and save</h2><p>Change the SQL, then press <b>Preview</b> (or Ctrl+Enter): your version runs on this screen only, next to the current numbers. <span id="mkt-edit-saves"></span></p></div>
        <button class="btn btn-sm" type="button" data-mkt="defs-reload" hidden title="Read the definitions in use from the lakehouse now, for a change made in Databricks itself">Reload definitions from the lakehouse</button></div>
      <div class="mkt-edit-pick" id="mkt-edit-pick"></div>
      <div id="mkt-edit-boxes"></div>
      <div class="mkt-edit-bar">
        <button class="btn btn-green" type="button" data-mkt="preview">Preview</button>
        <button class="btn" type="button" data-mkt="preview-stop" hidden>Stop preview</button>
        <button class="btn btn-green" type="button" data-mkt="save-open" hidden>Save…</button>
        <span id="mkt-edit-status"></span>
      </div>
      <div id="mkt-edit-problems"></div>
      <div id="mkt-edit-save"></div>
    </section>
    <div class="mkt-win-out">
      ${ids.map((id, i) => `
      <section class="card">
        <div class="card-head"><div>${named ? `<h2 id="mkt-win-name-${i}"></h2>` : ''}<p id="mkt-win-what-${i}"></p></div></div>
        <div id="mkt-win-shown-${i}"></div>
        <h3 class="mkt-win-h">How it is calculated</h3>
        <div class="mkt-src"><div id="mkt-win-head-${i}"></div><div id="mkt-win-live-${i}" class="mkt-hold"></div></div>
        <div id="mkt-win-prev-${i}" class="mkt-hold"></div>
      </section>`).join('')}
      ${panel === 'patterns' ? '<section class="card"><div id="mkt-win-pat"></div></section>' : ''}
      ${panel === 'market' ? '<section class="card"><div id="mkt-win-extra" class="mkt-hold"></div></section>' : ''}
    </div>
  </div>`;
  S.html.clear();
  S.edit.painted = null;
}

/** "On the page now", and beside it "Your version" while an edit that changes this number is previewed. */
function shownBoth(id, key) {
  const now = `<div><h3 class="mkt-win-h">On the page now</h3>${shownAs(id, key)}</div>`;
  const defs = previewDefs();
  if (!defs) return now;
  if (!touches(id, defs)) return `${now}<p class="faint mkt-win-note">Your changes don't change this number.</p>`;
  const pk = `preview:${key}`, res = S.res.get(pk);
  const missing = res && !res.error ? neededColumns(id).filter((c) => !res.columns.includes(c)) : [];
  return `<div class="mkt-cmp${DEFS.get(id).card ? ' cards' : ''}">${now}
    <div class="mkt-cmp-yours"><h3 class="mkt-win-h">Your version <span class="faint">(this screen only)</span></h3>${shownAs(id, pk)}
    ${missing.length ? `<p class="warn mkt-win-note">The page needs ${missing.map((c) => `<code>${esc(c)}</code>`).join(', ')}, which your version doesn't return, so it can't be saved like this.</p>` : ''}</div></div>`;
}

/** Your version's whole query as it runs here, with copies to try it in D1 or Databricks, and its result. */
function previewQuery(id, key, extra) {
  const defs = previewDefs();
  if (!defs || !touches(id, defs)) return '';
  const pk = `preview:${key}`;
  return `<h3 class="mkt-win-h mkt-yours-h">Your version, as it runs</h3>
    <div class="mkt-src mkt-yours">${queryHead(id, pk, extra, defs)}${rawResult(S.res.get(pk))}
    <p><button class="btn btn-sm" type="button" data-mkt="csv" data-key="${esc(pk)}" data-what="result">Download your version's result (CSV)</button></p></div>`;
}

/** A number as the Markets page shows it: the card, or the first rows of the table. */
function shownAs(id, key) {
  const d = DEFS.get(id), res = S.res.get(key);
  if (!res) return pending();
  if (res.error) return failed(res);
  if (d.card) return `<div class="kpis mkt-kpis mkt-win-card">${kpi(id, res)}</div>`;
  if (!res.rows.length) return `<div class="mkt-empty">${S.live.size ? 'No rows right now.' : 'Waiting for prices…'}</div>`;
  let rows = res.rows;
  const iz = res.columns.indexOf('z');
  if (id === 'markets' && iz >= 0) rows = [...rows].sort((a, b) => Math.abs(b[iz] ?? -1) - Math.abs(a[iz] ?? -1));   // the page's first order
  const n = 20;
  return resultTable({ columns: res.columns, rows: rows.slice(0, n) }, d)
    + (rows.length > n ? `<p class="faint mkt-win-note">The first ${n} of ${rows.length} rows${id === 'markets' ? ', most unusual first as on the page' : ''}; download the result below for all of them.</p>` : '');
}

/** Patterns' window: where the view's numbers come from (all but Now are the lakehouse's own tables). */
function patternSources() {
  const pub = S.data.published.market_evidence || {};
  return `<h2>Where the verdicts come from</h2><p class="dim">The Patterns view is calculated by the queries above, like Today's numbers: from MEDUSA's copy of the lakehouse's verdicts (<code>market_evidence</code>) and, for <b>Now</b> and <b>Right now</b>, the markets that are unusual this second (<code>flagged</code>, any type). The verdicts themselves are built in the lakehouse by two dbt models on every daily run: ${ghLink('intraday_events.sql')} (every unusual move since 2020 and the price 1, 4 and 24 hours later) and ${ghLink('event_evidence.sql')} (the verdicts, judged by days, on 2020–2024 and then on 2025 onwards). The publish job copies them to MEDUSA${pub.published_at ? `, last at ${clock(pub.published_at)}` : ''}. These queries read the lakehouse's own tables:</p>
    ${sqlBlock('Every verdict (Databricks SQL)', 'SELECT direction, z_band, liquidity, horizon_hours, verdict, side, events, days,\n       in_sample_days, in_sample_t, held_back_days, held_back_t, held_back_net_after_cost\nFROM market.gold.event_evidence\nORDER BY direction, z_band, liquidity, horizon_hours;')}
    ${sqlBlock('How many moves, and when (Databricks SQL)', 'SELECT direction, period, COUNT(*) AS moves, COUNT(DISTINCT event_date) AS days\nFROM market.gold.intraday_events\nGROUP BY direction, period\nORDER BY direction, period;')}`;
}

function paintWindow() {
  const { panel, ids, symbol } = S.win;
  const title = panel === 'market' ? `${String(symbol).replace(/USDT$/, '')}: one market` : WIN_TITLES[panel] || DEFS.get(ids[0]).name;
  document.title = `${title} · how it is calculated · MEDUSA`;
  put('mkt-win-title', esc(title));
  // The editor's boxes are drawn when the definitions arrive (and again if they change, unless the
  // person is typing in one).
  const typing = document.activeElement && document.activeElement.matches('#mkt-edit-boxes textarea');
  if (S.edit.painted !== S.data.at && !typing) { S.edit.painted = S.data.at; paintEditors(); }
  paintEditBar();
  if (panel === 'patterns') put('mkt-win-pat', patternSources());
  ids.forEach((id, i) => {
    const key = winKey(id), d = DEFS.get(id), extra = id === 'market' ? { symbol } : {};
    put(`mkt-win-name-${i}`, esc(d.name));
    put(`mkt-win-what-${i}`, esc(d.description));
    put(`mkt-win-shown-${i}`, shownBoth(id, key));
    put(`mkt-win-head-${i}`, queryHead(id, key, extra));
    put(`mkt-win-live-${i}`, queryLive(id, key));
    put(`mkt-win-prev-${i}`, previewQuery(id, key, extra));
  });
  if (panel === 'market') put('mkt-win-extra', marketExtras(symbol));
}

/* ---------- data: the lakehouse's copy, market types, yesterday's closes, live prices ---------- */

async function load() {
  if (S.loading) return S.loading;
  S.loading = (async () => {
    try {
      // The shared data (the same for every account) and this account's own definitions, side by side.
      const mine = api.call('GET', '/api/market/metrics/mine').catch((e) => {
        if (e.message !== 'Signed out') api.log('markets', `Your own definitions couldn't be loaded: ${e.message}`, null, 'error');
        return null;
      });
      const d = await api.call('GET', '/api/market/scanner');
      const rowsOf = (part) => (part ? part.rows.map((r) => Object.fromEntries(part.columns.map((c, i) => [c, r[i]]))) : []);
      const base = new Map(rowsOf(d.market_baseline).map((r) => [r.symbol, r]));
      const ev = new Map(rowsOf(d.market_evidence).map((r) => [evKey(r.direction, r.z_band, r.liquidity, r.horizon_hours), r]));
      const published = d.published || {};
      if (S.data && (S.data.published.market_baseline || {}).as_of !== (published.market_baseline || {}).as_of) S.ref = null;   // a new day arrived
      const empty = { columns: [], rows: [] };
      S.data = { published, base, ev, at: Date.now(), raw: { market_baseline: d.market_baseline || empty, market_evidence: d.market_evidence || empty } };
      SRC.shared = rowsOf(d.market_metrics);
      const own = await mine;
      if (own) SRC.mine = { rows: own.rows || [], canSave: Boolean(own.canSave), saves: own.saves === 'shared' ? 'shared' : 'own', name: own.name || '' };
      rebuildDefs();
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
    const params = { kind: S.kind, yesterday: yesterday(), ...(one ? { symbol: one } : {}) };
    const out = await call({ op: 'run', jobs: [{ id: 'inputs', sql: assemble(def, { params }) }] }, 5_000);
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
  if (act === 'win') { openWindow(el.dataset.panel, el.dataset.sym || null); return; }
  if (act.startsWith('edit-') || act.startsWith('preview') || act.startsWith('save-') || act === 'defs-reload') { onEdit(act, el.dataset.def, el); return; }
  if (act === 'view') { S.view = el.dataset.v; api.store.set('mktView', S.view); }
  else if (act === 'kind') { S.kind = el.dataset.v; S.limit = 50; if (!S.win) api.store.set('mktKind', S.kind); }   // a window's choice is its own
  else if (act === 'sort') { S.sort = el.dataset.v; S.limit = 50; draw(); return; }
  else if (act === 'more') { S.limit += 50; draw(); return; }
  else if (act === 'row' && el.dataset.list === 'all') S.openAll = S.openAll === el.dataset.sym ? null : el.dataset.sym;
  else if (act === 'row') S.open = S.open === el.dataset.sym ? null : el.dataset.sym;
  else if (act === 'pat') { S.pat = S.pat === el.dataset.k ? null : el.dataset.k; draw(); return; }
  draw();
  S.urgent = true;
  paint();   // the view, type or an opened market changes which queries run
}

/** The editor's buttons: open or close a definition's box, undo its changes, preview, stop, save, give
 * up an own version, history and its versions, and (the owner) reload from the lakehouse. */
function onEdit(act, id, el) {
  if (act === 'preview') { startPreview(); return; }
  if (act === 'preview-stop') { stopPreview(); return; }
  if (act === 'save-open') { openSave(); return; }
  if (act === 'save-cancel') { closeSave(); return; }
  if (act === 'save-go') { doSave(); return; }
  if (act === 'defs-reload') { reloadDefs(); return; }
  if (!DEFS.has(id)) return;
  if (act === 'edit-giveup') { giveUp(id); return; }
  if (act === 'edit-history') { loadHistory(id); return; }
  if (act === 'edit-hist-close') { S.edit.hist.delete(id); paintHist(id); return; }
  if (act === 'edit-reuse') { reuseVersion(id, el.dataset.scope, Number(el.dataset.v)); return; }
  if (act === 'edit-open' || act === 'edit-close') {
    const open = S.edit.open.includes(id);
    S.edit.open = open ? S.edit.open.filter((x) => x !== id) : [...S.edit.open, id];
    paintEditors();
    paintEditBar();
    if (!open) { const t = [...host.querySelectorAll('textarea[data-def]')].find((x) => x.dataset.def === id); if (t) t.focus(); }
    return;
  }
  if (act === 'edit-undo') {
    S.edit.text.delete(id);
    paintEditors();
    if (!S.edit.live) { paintEditBar(); return; }
    if ([...S.edit.text.keys()].some(edited)) startPreview(); else stopPreview();   // preview what's left
  }
}

function onInput(e) {
  const t = e.target;
  if (t.matches('textarea[data-def]')) {
    S.edit.text.set(t.dataset.def, t.value);
    t.closest('.mkt-edit-box').classList.toggle('changed', edited(t.dataset.def));
    paintEditBar();
    return;
  }
  if (t.id !== 'mkt-q') return;
  S.q = t.value.trim().toUpperCase();
  S.limit = 50;
  draw();
}

function onKey(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('textarea[data-def]')) { e.preventDefault(); startPreview(); }
}

const validKind = (k) => (KINDS.some(([v]) => v === k) ? k : 'all');

function attach(el) {
  if (!document.getElementById('mkt-css')) document.head.appendChild(Object.assign(document.createElement('style'), { id: 'mkt-css', textContent: CSS }));
  host = el;
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.stopped) schedule(); });
}

/** Show the page (each time it is opened). */
export function render(el, appApi) {
  api = appApi;
  if (host !== el) {
    attach(el);
    S.view = api.store.get('mktView', 'today') === 'patterns' ? 'patterns' : 'today';
    S.kind = validKind(api.store.get('mktKind', 'all'));
  }
  if (!document.getElementById('mkt-status')) shell();
  S.stopped = false;
  paint();
  start();
}

/** A ‹› window (markets-window.html): one number's calculation, with its own data, SQL engine and live
 * prices, so it keeps going while the Markets page is hidden, on another page or closed. Only that
 * number's queries run. */
export function renderWindow(el, appApi, { panel, symbol = null, kind = 'all' }) {
  api = appApi;
  const ids = WINDOWS[panel];
  if (!ids || (panel === 'market' && !/^[A-Z0-9_]{2,40}$/.test(symbol || ''))) {
    el.innerHTML = '<div class="banner"><div><b>Nothing to show here.</b> Open this window with a ‹› button on MEDUSA\'s Markets page.</div></div>';
    return;
  }
  S.win = { panel, ids, symbol: panel === 'market' ? symbol : null };
  S.kind = validKind(kind);
  S.edit.open = [...ids];   // the number's own query is ready to edit
  attach(el);
  el.addEventListener('keydown', onKey);
  // Closing the window, or reloading it, asks first while there are changes (nothing is saved).
  addEventListener('beforeunload', (e) => { if ([...S.edit.text.keys()].some(edited)) { e.preventDefault(); e.returnValue = ''; } });
  shell();
  S.stopped = false;
  api.log('markets', `Window: how ${panel}${symbol ? ` (${symbol})` : ''} is calculated`, null, 'debug');
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
