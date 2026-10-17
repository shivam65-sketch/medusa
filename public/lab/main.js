// MEDUSA Lab: the backtesting part of MEDUSA (the "Lab" switch at the top right). Loaded only when the
// Lab is opened, so the journal stays light.
//
//   Dashboard       run a backtest on a data file; the Results folder and the selected result
//   Get data        download from Binance into MEDUSA (Downloads folder) or to this computer, and
//                   upload a file to backtest it (Uploads folder)
//   Files           the Downloads, Uploads and Results folders on MEDUSA's server, the free storage left
//   Chart           a TradingView-style candle chart of a data file, with indicators, a candle replay and
//                   backtests drawn on it (chart.js)
//   Strategies      the built-in strategies (public/lab/strategies) and your own Python files
//   Python          run any Python code on your data files (console.js, loaded when opened)
//   Strategy guide  every strategy explained, with charts of real trades
//
// Backtests run in Python (Pyodide) in a background thread of this page: see py-worker.js.

import { $, $$, esc, isNum, pct, rr, bytes, dateLocal, ymd, parseDate, ago, plural, INTERVAL_MS, MAX_CANDLES, DAY, api, setApp, toast, gzipJSON, gunzipJSON, download, icon } from './util.js';
import * as data from './data.js';
import { renderReport, brief, resultCSV, resultCSVName } from './report.js';
import { renderLearn, DOC_FOR, GROUPS, verdictBadge } from './learn.js';
import { attachEditor, highlight } from './editor.js';

let app = null;
let root = null;
const store = {
  get(k, d) { try { const v = localStorage.getItem('j.lab.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('j.lab.' + k, JSON.stringify(v)); } catch { /* optional */ } },
};
/** The Lab's pages: the left sidebar (app.js) lists them and calls goTab(). */
export const TABS = [['dashboard', 'Dashboard'], ['data', 'Get data'], ['files', 'Files'], ['chart', 'Chart'], ['strategies', 'Strategies'], ['python', 'Python'], ['guide', 'Strategy guide']];
const FOLDER_NAME = { downloads: 'Downloads', uploads: 'Uploads', results: 'Results' };
const S = {
  tab: 'dashboard', datasets: [], runs: [], usage: null, storage: true, loaded: false,
  mine: [], catalog: { strategies: [], errors: [] }, doc: 'start', editor: null,
  form: null, up: null, downloading: null, dlDone: null,
  result: null, resultId: null, resultCandles: null, error: null, running: false, loadingResult: null,
};
/** A line in the Logs tab (kept by app.js): level "info" always, "debug" only with detailed logging on, "error". */
const log = (area, msg, data, level = 'info') => { try { if (app && app.log) app.log(area, msg, data, level); } catch { /* logging never breaks the Lab */ } };
const fail = (e) => { if (!/Signed out/.test(e.message)) { toast(e.message, 'error'); log('lab', `Error: ${e.message}`, null, 'error'); } };

/* ======================= the Python engine ======================= */

const engine = {
  w: null, ready: null, seq: 0, pending: new Map(), sent: null, state: 'off', note: '',
  status(state, note = '') {
    this.state = state;
    this.note = note;
    const el = $('#lab-engine');
    if (!el) return;
    const text = { off: 'Python engine off', loading: 'Python engine starting…', ready: 'Python engine ready', busy: 'Running…', error: 'Python engine failed' }[state];
    el.className = `lab-engine ${state}`;
    el.innerHTML = `<i></i>${text}`;
    el.title = note || (state === 'loading' ? 'The first start downloads about 16 MB (Python and numpy); after that the browser keeps it.' : '');
  },
  start() {
    if (this.ready) return this.ready;
    this.status('loading');
    this.w = new Worker('/lab/py-worker.js', { type: 'module' });
    this.w.onmessage = (e) => this.message(e.data || {});
    this.w.onerror = (e) => { e.preventDefault(); this.crash(new Error('The Python engine couldn’t start in this browser. Try a current Chrome, Edge, Firefox or Safari.')); };
    this.ready = (async () => {
      const names = ['engine.py', 'strategy.py', 'indicators.py', 'stats.py', 'backtest.py', 'labrun.py'];
      const files = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await (await fetch(`/lab/py/${n}`)).text()])));
      await this.call('init', { engine: files });
      const list = await (await fetch('/lab/strategies/index.json')).json();
      const builtin = await Promise.all(list.map(async (f) => ({ origin: 'builtin', id: f.replace(/\.py$/, ''), name: f, source: await (await fetch(`/lab/strategies/${f}`)).text() })));
      await this.load(builtin, ['builtin']);
      await this.loadMine();
      this.status('ready');
      log('lab', 'Python engine ready', null, 'debug');
    })().catch((e) => { this.crash(e); throw e; });
    return this.ready;
  },
  crash(e) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    if (this.w) this.w.terminate();
    this.w = null; this.ready = null; this.sent = null;
    this.status('error', e.message);
  },
  stop() {
    const stopped = Object.assign(new Error('Stopped.'), { stopped: true });
    for (const p of this.pending.values()) p.reject(stopped);
    this.pending.clear();
    if (this.w) this.w.terminate();
    this.w = null; this.ready = null; this.sent = null;
    this.status('off');
  },
  call(type, payload = {}, onProgress = null) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, onProgress });
      this.w.postMessage({ type, id, ...payload });
    });
  },
  message(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') { if (p.onProgress) p.onProgress(Number(m.f) || 0, String(m.text || '')); return; }
    this.pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(String(m.message || 'The Python engine stopped.')));
    else p.resolve(m);
  },
  async load(files, origins) {
    const r = await this.call('strategies', { files, origins });
    S.catalog = JSON.parse(r.json);
  },
  async loadMine() {
    const d = await api('GET', '/api/lab/strategies');
    S.mine = d.strategies;
    await this.load(S.mine.map((s) => ({ origin: 'mine', id: s.id, name: s.name, source: s.code })), ['mine']);
    paint();
  },
};

/* ======================= shell ======================= */

export function mount(host, appApi, tab) {
  app = appApi;
  setApp(appApi);
  root = host;
  S.tab = TABS.some(([t]) => t === tab) ? tab : TABS.some(([t]) => t === store.get('tab')) ? store.get('tab') : 'dashboard';
  S.doc = store.get('doc', 'start');
  S.form = Object.assign(defaultForm(), store.get('form', {}));
  root.innerHTML = `
    <div class="lab-nav" aria-label="Lab status">
      <h2 class="lab-title" id="lab-title"></h2>
      <button class="lab-storage" id="lab-storage" data-lab="tab" data-tab="files" title="Cloudflare's free storage that is still unused. Open Files to see and delete your files."></button>
      <span class="lab-engine off" id="lab-engine" role="status"></span>
    </div>
    ${TABS.map(([t]) => `<section class="lab-page" id="lab-${t}" role="region" aria-labelledby="lab-title" hidden></section>`).join('')}
    <div class="lab-pop" id="lab-pop" role="tooltip" hidden></div>`;
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKey);
  document.addEventListener('toggle', (ev) => { if (ev.target.matches && ev.target.matches('details.lab-more')) store.set('more', ev.target.open); }, true);
  if (app.onFx) app.onFx(() => paint(true));           // the INR switch: redraw amounts
  paintStorage();
  engine.status('off');
  engine.start().catch(() => paint());
  refreshFiles();
  go(S.tab);
}

/** Called by the sidebar: show one of the Lab's pages. */
export function goTab(tab) { if (root && TABS.some(([t]) => t === tab)) go(tab); }

/** Dev tools: the Python engine's state, and stopping it to free memory (whatever needs it starts it again). */
export const engineState = () => ({ state: engine.state, busy: Boolean(S.running) });
export function stopEngine() {
  if (S.running) return false;
  engine.stop();
  return true;
}

function go(tab, opts = {}) {
  S.tab = tab;
  store.set('tab', tab);
  if (opts.doc) { S.doc = opts.doc; store.set('doc', S.doc.split('#')[0]); }
  $('#lab-title', root).textContent = (TABS.find(([t]) => t === tab) || [0, ''])[1];
  if (app && app.navChanged) app.navChanged(`lab:${tab}`);
  log('nav', `Lab: ${(TABS.find(([t]) => t === tab) || [0, tab])[1]}`, null, 'debug');
  $$('.lab-page', root).forEach((p) => { p.hidden = p.id !== `lab-${tab}`; });
  paint(true);
  if (opts.top !== false) root.scrollIntoView({ block: 'start' });
}

/** Redraws the visible tab (a result on the dashboard is kept, not redrawn, unless asked). */
function paint(full = false) {
  if (!root) return;
  if (S.tab === 'dashboard') paintDashboard(full);
  if (S.tab === 'data') paintData();
  if (S.tab === 'files') paintFiles();
  if (S.tab === 'strategies') paintStrategies();
  if (S.tab === 'guide') renderLearn($('#lab-guide'), { doc: S.doc, catalog: S.catalog });
  if (S.tab === 'python') pyTab().then((c) => c.paintConsole($('#lab-python'), pyContext)).catch(fail);
  if (S.tab === 'chart') chartTab().then((c) => c.paintChart($('#lab-chart'), chartContext)).catch(fail);
}

/* The Python tab lives in console.js, loaded the first time it is opened. */
let pyModule = null;
const pyTab = () => (pyModule = pyModule || import('./console.js'));
const pyContext = {
  store,
  log,
  datasets: () => S.datasets,
  mineFiles: () => S.mine.map((m) => ({ origin: 'mine', id: m.id, name: m.name, source: m.code })),
  async saveResult(report) {
    const saved = await saveResult(report);
    refreshFiles();
    return { id: saved.id, title: report.title };
  },
};

/* The Chart tab lives in chart.js (with TradingView's Lightweight Charts), loaded the first time it is opened. */
let chartModule = null;
const chartTab = () => (chartModule = chartModule || import('./chart.js'));
const chartContext = {
  store,
  log,
  datasets: () => S.datasets,
  filesLoaded: () => Boolean(S.loaded),
  runs: () => S.runs,
  strategies: () => S.catalog.strategies,
  /** The journal's closed trades (from the journal page, already in memory). */
  myTrades: () => (app && app.trades ? app.trades() || [] : []),
  /** The stop loss and take profit of your trades on one coin: {tradeId: [stop, target, filled]}. */
  myLevels: (pair, mcur) => api('GET', `/api/levels?pair=${encodeURIComponent(pair)}&mcur=${encodeURIComponent(mcur || 'USDT')}`).then((r) => r.levels || {}),
  /** The Dashboard form's costs and money settings (a chart backtest uses them). */
  costs: () => { const f = S.form; return { fee_pct: f.fee_pct, slippage_pct: f.slippage_pct, capital: f.capital, sizing: f.sizing, risk_pct: f.risk_pct, notional_pct: f.notional_pct, max_leverage: f.max_leverage, fill: f.fill }; },
  fetchResult,
  /** A backtest of a whole data file from the chart, with the Dashboard's costs: {R, id} or throws. */
  async runBacktest({ dataset, strategy, params, save }, progress) {
    if (S.running) throw new Error('A backtest is already running.');
    const row = findDs(dataset);
    if (!row) throw new Error('That data file isn’t in MEDUSA any more.');
    const f = Object.assign(defaultForm(), S.form, { dataset, strategy, start: '', end: '', split: '', save, params: { ...S.form.params, [strategy]: params } });
    const ok = await runTest({ row, f, withDates: false, save, progress });
    if (S.resultId) refreshFiles();
    if (S.tab === 'dashboard') paintOutput();
    if (!ok) throw new Error(S.error ? S.error.message : 'The backtest stopped.');
    return { R: S.result, id: S.resultId };
  },
  /** The strategy's own lines for a result: {start, n, plots: [{name, kind, values: Float32Array}]} or {error}. */
  async plots(R) {
    const row = findDs(R.meta.dataset);
    if (!row) return { error: 'The data file of this result isn’t in MEDUSA any more.' };
    await engine.start();
    const d = await data.loadDataset(row.id);
    const meta = { from: R.meta.slice_from ?? R.meta.from, to: R.meta.to, interval: R.meta.interval, symbol: R.meta.symbol, market: R.meta.market };
    const columns = () => ({ ...d.cols, ...(d.funding ? { ft: d.funding.ft || d.funding.cols.ft, fr: d.funding.fr || d.funding.cols.fr } : {}) });
    const send = (withData) => engine.call('plots', { dataset: row.id, key: R.config.strategy, params: R.meta.params, meta, columns: withData ? columns() : undefined });
    let r = await send(engine.sent !== row.id);
    if (r.need) r = await send(true);
    engine.sent = row.id;
    const out = JSON.parse(r.json);
    if (out.plots) for (const p of out.plots) { const b = atob(p.b64); const u8 = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i); p.values = new Float32Array(u8.buffer); delete p.b64; }
    return out;
  },
  /** The full report of a result, on the Dashboard. */
  openReport(R, id) {
    Object.assign(S, { result: R, resultId: id || null, resultCandles: null, error: null });
    go('dashboard');
  },
};
/** Shows one of the journal's trades on the Chart tab (the trade window's "Show on chart"). */
export function showMyTrade(id) {
  chartTab().then((c) => { c.showMine(id); go('chart'); }).catch(fail);
}
/** Shows a backtest result on the Chart tab. */
function openOnChart(R, id) {
  chartTab().then((c) => { c.showResult(R, id || null); go('chart'); }).catch(fail);
}

async function refreshFiles() {
  try {
    const d = await api('GET', '/api/lab/files');
    Object.assign(S, { datasets: d.datasets, runs: d.runs, usage: d.usage, storage: d.storage, loaded: true });
  } catch (e) { fail(e); S.loaded = true; }
  paintStorage();
  if (S.tab === 'dashboard') { paintForm(); paintResultsList(); showLatest(); }
  if (S.tab === 'files') paintFiles();
  if (S.tab === 'data') { paintFreeNote(); }
  if (S.tab === 'python' && pyModule) pyModule.then((c) => c.paintFiles());
  if (chartModule) chartModule.then((c) => c.paintFiles());
}

/* Cloudflare's free storage left (Workers KV, 1 GB for the whole MEDUSA app). */
const mb = (n) => `${(n / 1048576).toLocaleString('en-US', { maximumFractionDigits: n < 10 * 1048576 ? 2 : 1 })} MB`;
function freeLine(u) {
  return u ? `${mb(u.free)} free of ${bytes(u.limit)}` : '…';
}
function paintStorage() {
  const el = $('#lab-storage');
  if (!el) return;
  const u = S.usage;
  const used = u ? Math.min(100, (u.total / u.limit) * 100) : 0;
  el.innerHTML = `${icon('db')}<span><b>${u ? mb(u.free) : '…'}</b> free storage</span><i class="lab-mini"><i style="width:${used.toFixed(1)}%"></i></i>`;
}
function paintFreeNote() { $$('[data-free]').forEach((x) => { x.textContent = freeLine(S.usage); }); }

const findDs = (id) => S.datasets.find((d) => d.id === id);
const findStrat = (key) => S.catalog.strategies.find((s) => s.key === key);
const findRun = (id) => S.runs.find((r) => r.id === id);

/** Two taps to delete: the first changes the button, the second does it. */
function confirmThen(btn, fn, text = 'Tap again to delete') {
  if (btn.dataset.armed) { fn(); return; }
  btn.dataset.armed = '1';
  const old = btn.innerHTML;
  btn.innerHTML = text;
  btn.classList.add('btn-red');
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.innerHTML = old; btn.classList.remove('btn-red'); } }, 3500);
}

function setProgress(sel, fr, text) {
  const box = $(sel);
  if (!box) return;
  box.hidden = false;
  $('i', box).style.width = `${Math.round(Math.max(0.02, Math.min(1, fr)) * 100)}%`;
  $('span', box).textContent = text;
}

/* ======================= the backtest settings (shared by the dashboard and the upload form) ======================= */

function defaultForm() {
  return { dataset: '', start: '', end: '', strategy: 'turtle', params: {}, fee_pct: 0.05, slippage_pct: 0.05, funding: true, capital: 1000,
    sizing: 'risk', risk_pct: 1, notional_pct: 100, max_leverage: 3, compounding: true, fill: 'next_open', split: '', save: true, dropAfter: false };
}

/* ---------- lengths in candles, or in time ---------- */
const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 };
const UNITS = ['candles', 'minutes', 'hours', 'days', 'weeks'];
const clampP = (p, n) => Math.min(isNum(p.max) ? p.max : Infinity, Math.max(isNum(p.min) ? p.min : 1, n));
/** Candles for a length setting: entered as a number of candles, or as {v, u} (a time such as 35 days). */
function candlesOf(p, val, interval) {
  if (val && typeof val === 'object') return clampP(p, Math.max(1, Math.round((val.v * UNIT_MS[val.u]) / (INTERVAL_MS[interval] || 3_600_000))));
  return val;
}
/** "5.8 days", "36 hours", "2 weeks": how long n candles are. */
function spanText(ms) {
  const m = ms / 60_000;
  if (m < 120) return `${+m.toFixed(1)} minutes`;
  if (m < 2880) return `${+(m / 60).toFixed(1)} hours`;
  if (m < 60 * 24 * 70) return `${+(m / 1440).toFixed(1)} days`;
  return `${+(m / 10080).toFixed(1)} weeks`;
}
/** Suggested lengths for this timeframe: common indicator periods and round times, as candles. */
function lengthSuggestions(p, interval, unit) {
  const iv = INTERVAL_MS[interval] || 3_600_000;
  if (unit !== 'candles') {
    const pick = { minutes: [5, 15, 30, 60, 120, 240], hours: [1, 4, 8, 12, 24, 48, 72, 168], days: [1, 2, 3, 5, 7, 14, 20, 30, 50, 90, 100, 200], weeks: [1, 2, 4, 8, 13, 26, 52] }[unit];
    return pick.filter((v) => (v * UNIT_MS[unit]) / iv >= 1).map((v) => [v, `${v} ${unit} = ${Math.round((v * UNIT_MS[unit]) / iv).toLocaleString('en-US')} candles`]);
  }
  const times = [[3_600_000, '1 hour'], [4 * 3_600_000, '4 hours'], [86_400_000, '1 day'], [3 * 86_400_000, '3 days'], [7 * 86_400_000, '1 week'],
    [14 * 86_400_000, '2 weeks'], [30 * 86_400_000, '1 month'], [90 * 86_400_000, '3 months'], [200 * 86_400_000, '200 days']];
  const out = new Map();
  for (const n of [9, 10, 14, 20, 21, 26, 50, 100, 200]) out.set(n, `${n} candles = ${spanText(n * iv)}`);
  for (const [ms, label] of times) { const n = Math.round(ms / iv); if (n >= 2) out.set(n, `${n} candles = ${label}`); }
  return [...out].filter(([n]) => (!isNum(p.min) || n >= p.min) && (!isNum(p.max) || n <= p.max)).sort((a, b) => a[0] - b[0]);
}
/** The hint under a length / UTC-hour setting. */
function unitHint(p, val, interval) {
  if (p.unit === 'utc_hour') {
    const h = Number(val);
    if (!isNum(h)) return '';
    const d = new Date(Date.UTC(2026, 0, 5, Math.floor(h), Math.round((h % 1) * 60)));
    return `= ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} your time`;
  }
  if (p.unit !== 'candles' || !interval) return '';
  const iv = INTERVAL_MS[interval];
  const n = candlesOf(p, val, interval);
  if (!isNum(n)) return '';
  const want = val && typeof val === 'object' ? Math.round((val.v * UNIT_MS[val.u]) / iv) : n;
  const cut = want !== n ? ` (asked ${want.toLocaleString('en-US')}, the limit is ${n.toLocaleString('en-US')})` : '';
  return val && typeof val === 'object' ? `= ${n.toLocaleString('en-US')} candles of ${interval}${cut}` : `= ${spanText(n * iv)} of ${interval} candles`;
}

function paramField(p, value, pfx, interval = '') {
  const id = `lab-p-${pfx}-${p.key}`;
  const help = p.help ? `<span class="hint">${esc(p.help)}</span>` : '';
  if (p.unit === 'candles' || p.unit === 'utc_hour') {
    const unit = value && typeof value === 'object' ? value.u : 'candles';
    const num = value && typeof value === 'object' ? value.v : value;
    const attrs = unit === 'candles' ? [isNum(p.min) ? `min="${p.min}"` : '', isNum(p.max) ? `max="${p.max}"` : '', `step="${isNum(p.step) ? p.step : 1}"`].join(' ') : 'min="0" step="any"';
    const list = p.unit === 'candles' && interval ? `<datalist id="${id}-dl">${lengthSuggestions(p, interval, unit).map(([v, l]) => `<option value="${v}" label="${esc(l)}">${esc(l)}</option>`).join('')}</datalist>` : '';
    return `<label for="${id}"><span class="label">${esc(p.label)}</span>
      <span class="lab-unit"><input class="input" type="number" inputmode="decimal" id="${id}" data-param="${esc(p.key)}" value="${esc(num)}" ${attrs} ${list ? `list="${id}-dl"` : ''}>${
        p.unit === 'candles' ? `<select class="input" data-unit="${esc(p.key)}" data-prev="${unit}" aria-label="Unit">${UNITS.map((u) => `<option value="${u}" ${u === unit ? 'selected' : ''}>${u}</option>`).join('')}</select>` : ''}</span>
      ${list}<span class="hint" data-hint="${esc(p.key)}">${esc(unitHint(p, value, interval))}</span>${help}</label>`;
  }
  if (p.kind === 'bool') return `<label class="check lab-pcheck"><input type="checkbox" data-param="${esc(p.key)}" ${value ? 'checked' : ''}><span>${esc(p.label)}</span></label>`;
  if (p.kind === 'choice') {
    return `<label for="${id}"><span class="label">${esc(p.label)}</span><select class="input" id="${id}" data-param="${esc(p.key)}">${
      (p.choices || []).map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${help}</label>`;
  }
  const attrs = [isNum(p.min) ? `min="${p.min}"` : '', isNum(p.max) ? `max="${p.max}"` : '', `step="${isNum(p.step) ? p.step : p.kind === 'int' ? 1 : 'any'}"`].join(' ');
  return `<label for="${id}"><span class="label">${esc(p.label)}</span><input class="input" type="number" inputmode="decimal" id="${id}" data-param="${esc(p.key)}" value="${esc(value)}" ${attrs}>${help}</label>`;
}

/** The built-in strategies as [group title, strategies] in the Strategy guide's order (unknown groups last). */
function builtinGroups() {
  const builtin = S.catalog.strategies.filter((s) => s.origin === 'builtin');
  const known = new Set(GROUPS.map((g) => g[0]));
  return [...GROUPS.map(([g, title]) => [title, builtin.filter((s) => s.group === g)]),
    ['Other built-in', builtin.filter((s) => !known.has(s.group))]].filter(([, list]) => list.length);
}

/** Strategy picker + its settings. */
function strategyBlock(f, pfx, interval = '') {
  if (!S.catalog.strategies.length) {
    return engine.state === 'error' ? `<div class="err">${esc(engine.note)}</div>` : '<p class="dim small"><span class="spin"></span> Loading the strategies…</p>';
  }
  if (!findStrat(f.strategy)) f.strategy = (findStrat('turtle') || S.catalog.strategies[0]).key;
  const st = findStrat(f.strategy);
  const vals = { ...Object.fromEntries(st.params.map((p) => [p.key, p.default])), ...(f.params[f.strategy] || {}) };
  const opt = (s) => `<option value="${esc(s.key)}" ${s.key === f.strategy ? 'selected' : ''}>${esc(s.label)}</option>`;
  const mine = S.catalog.strategies.filter((s) => s.origin === 'mine');
  return `<label><span class="label">Strategy</span><select class="input" data-f="strategy">${builtinGroups().map(([title, list]) => `<optgroup label="${esc(title)}">${list.map(opt).join('')}</optgroup>`).join('')}${
      mine.length ? `<optgroup label="My strategies">${mine.map(opt).join('')}</optgroup>` : ''}</select></label>
    <p class="dim small lab-desc">${esc(st.description)} <button class="link small" type="button" data-lab="doc" data-doc="${esc(DOC_FOR(st))}">How it works</button> · <button class="link small" type="button" data-lab="tab" data-tab="strategies">Add your own</button></p>
    <div class="lab-params" data-strategy="${esc(st.key)}">${st.params.map((p) => paramField(p, vals[p.key], pfx, interval)).join('')}</div>
    ${st.params.some((p) => p.unit === 'candles') ? '<p class="dim small">Lengths can be typed in candles or in time (pick the unit next to each); the list on each shows common choices for this timeframe.</p>' : ''}
    <p class="hint lab-warm" data-warm="${pfx}"></p>`;
}

/** Costs, money and checks (folded away by default). */
function settingsBlock(f, fundingOk, title) {
  return `<details class="lab-more" ${store.get('more', false) ? 'open' : ''}>
      <summary>${title} <span class="faint small">fee ${f.fee_pct}% · ${f.sizing === 'risk' ? `risk ${f.risk_pct}%` : `${f.notional_pct}% of account`} · up to ${f.max_leverage}x · $${f.capital}</span></summary>
      <div class="lab-grid2">
        <label><span class="label">Fee per fill (%)</span><input class="input" type="number" step="0.001" min="0" max="2" data-f="fee_pct" value="${f.fee_pct}"><span class="hint">0.05 = Binance futures taker</span></label>
        <label><span class="label">Slippage per fill (%)</span><input class="input" type="number" step="0.001" min="0" max="5" data-f="slippage_pct" value="${f.slippage_pct}"><span class="hint">price moving against you</span></label>
      </div>
      <label class="check"><input type="checkbox" data-f="funding" ${f.funding && fundingOk ? 'checked' : ''} ${fundingOk ? '' : 'disabled'}><span>Pay and receive funding (futures)${fundingOk ? '' : ': this data has no funding rates'}</span></label>
      <div class="lab-grid2">
        <label><span class="label">Starting money ($)</span><input class="input" type="number" min="1" step="any" data-f="capital" value="${f.capital}"></label>
        <label><span class="label">Position size</span><select class="input" data-f="sizing"><option value="risk" ${f.sizing === 'risk' ? 'selected' : ''}>Risk a % per trade</option><option value="notional" ${f.sizing === 'notional' ? 'selected' : ''}>A % of the account</option></select></label>
        ${f.sizing === 'risk'
          ? `<label><span class="label">Risk per trade (%)</span><input class="input" type="number" min="0.01" max="100" step="0.1" data-f="risk_pct" value="${f.risk_pct}"><span class="hint">lost if the stop is hit</span></label>`
          : `<label><span class="label">Position (% of account)</span><input class="input" type="number" min="1" max="10000" step="1" data-f="notional_pct" value="${f.notional_pct}"></label>`}
        <label><span class="label">Max leverage (x)</span><input class="input" type="number" min="0.1" max="125" step="0.1" data-f="max_leverage" value="${f.max_leverage}"><span class="hint">spot is always 1x</span></label>
      </div>
      <label class="check"><input type="checkbox" data-f="compounding" ${f.compounding ? 'checked' : ''}><span>Compounding (size from the current balance)</span></label>
      <div class="lab-grid2">
        <label><span class="label">Market orders fill at</span><select class="input" data-f="fill"><option value="next_open" ${f.fill === 'next_open' ? 'selected' : ''}>Next candle’s open</option><option value="close" ${f.fill === 'close' ? 'selected' : ''}>Signal candle’s close</option></select></label>
        <label><span class="label">Held-back date (optional)</span><input class="input" type="date" data-f="split" value="${esc(f.split)}"><span class="hint">report splits results here</span></label>
      </div>
    </details>`;
}

/** Reads a form's settings into f. The settings box belongs to the strategy it was drawn for. */
function readForm(form, f) {
  if (!form) return f;
  const box = $('.lab-params', form);
  const st = box && findStrat(box.dataset.strategy);
  if (st) {
    const p = {};
    for (const el of $$('[data-param]', box)) {
      const def = st.params.find((x) => x.key === el.dataset.param);
      if (!def) continue;
      const unit = def.unit === 'candles' ? ($(`[data-unit="${def.key}"]`, box) || {}).value || 'candles' : 'candles';
      const x = parseFloat(el.value);
      p[def.key] = def.kind === 'bool' ? el.checked : def.kind === 'choice' ? el.value : !isNum(x) ? def.default : unit === 'candles' ? x : { v: x, u: unit };
    }
    f.params[st.key] = p;
  }
  for (const el of $$('[data-f]', form)) {
    const k = el.dataset.f;
    if (el.type === 'checkbox') { if (!el.disabled) f[k] = el.checked; } else if (el.type === 'number') { const x = parseFloat(el.value); if (isNum(x)) f[k] = x; } else f[k] = el.value;
  }
  return f;
}
const readDash = () => { readForm($('#lab-form'), S.form); store.set('form', S.form); return S.form; };
const readUp = () => { if (S.up && S.up.form) { readForm($('#lab-upform'), S.up.form); store.set('upform', S.up.form); } return S.up && S.up.form; };

/** A strategy's settings for Python: lengths given as a time become candles of this timeframe. */
function paramsFor(f, interval) {
  const st = findStrat(f.strategy);
  const raw = f.params[f.strategy] || {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => {
    const p = st && st.params.find((x) => x.key === k);
    return [k, p && p.unit === 'candles' ? candlesOf(p, v, interval) : v];
  }));
}
const localMidnight = (ymdText) => (ymdText ? new Date(`${ymdText}T00:00:00`).getTime() : null);

/** What Python gets: dates as local-midnight times (your time zone), lengths in candles, and the units you typed. */
const cfgOf = (f, row, withDates) => {
  const raw = f.params[f.strategy] || {};
  const units = Object.fromEntries(Object.entries(raw).filter(([, v]) => v && typeof v === 'object'));
  return {
    strategy: f.strategy, params: paramsFor(f, row.interval), param_units: units, fee_pct: f.fee_pct, slippage_pct: f.slippage_pct,
    funding: Boolean(f.funding && row.funding > 0), capital: f.capital, sizing: f.sizing, risk_pct: f.risk_pct, notional_pct: f.notional_pct,
    max_leverage: f.max_leverage, compounding: f.compounding, fill: f.fill,
    start: withDates ? f.start : '', end: withDates ? f.end : '', split: f.split,
    start_ms: withDates ? localMidnight(f.start) : null, end_ms: withDates ? localMidnight(f.end) : null, split_ms: localMidnight(f.split),
    tz_offset_min: -new Date().getTimezoneOffset(),
  };
};

/** The warm-up line under a form's settings: how much history these indicator settings need, and whether the file has it. */
let warmSeq = 0;
async function paintWarm(pfx, f, row) {
  const el = $(`[data-warm="${pfx}"]`);
  if (!el || !row || !engine.w) return;
  const seq = ++warmSeq;
  let n;
  try { n = (await engine.call('warmup', { key: f.strategy, params: paramsFor(f, row.interval), interval: row.interval })).n; } catch { return; }
  if (seq !== warmSeq || !isNum(n)) return;
  const iv = INTERVAL_MS[row.interval];
  if (!n) { el.textContent = 'Warm-up: none needed (no indicator history), so trading can start on the first candle.'; return; }
  const span = spanText(n * iv);
  const start = localMidnight(f.start);
  let where;
  if (start && start > row.start_ts) {
    const before = Math.floor((start - row.start_ts) / iv);
    where = before >= n ? `taken from before your start date (the file has ${before.toLocaleString('en-US')} candles there).`
      : `but the file has only ${before.toLocaleString('en-US')} candles before your start date, so the test will start ${spanText((n - before) * iv)} later.`;
  } else where = `so the test starts ${span} after the file’s first candle.`;
  el.textContent = `Warm-up: these settings need ${n.toLocaleString('en-US')} candles (${span}) of history before the first trade, ${where}`;
}

/**
 * One backtest of a stored data file (row from the Downloads or Uploads folder). The result becomes
 * the dashboard's result and, if `save`, is saved in the Results folder.
 */
async function runTest({ row, f, withDates, save, progress, candles = null }) {
  S.running = true;
  S.error = null;
  engine.status('busy');
  try {
    progress(0.01, 'Starting the Python engine');
    await engine.start();
    engine.status('busy');
    progress(0.02, 'Loading the candles');
    const d = candles || await data.loadDataset(row.id);
    const meta = { symbol: row.symbol, market: row.market, source: row.source, interval: row.interval, id: row.id, name: row.name };
    const columns = () => ({ ...d.cols, ...(d.funding ? { ft: d.funding.ft || d.funding.cols.ft, fr: d.funding.fr || d.funding.cols.fr } : {}) });
    const send = (withData) => engine.call('run', { dataset: row.id, cfg: cfgOf(f, row, withDates), meta, columns: withData ? columns() : undefined }, (x, text) => progress(0.05 + 0.9 * x, text));
    let r = await send(engine.sent !== row.id);
    if (r.need) r = await send(true);
    engine.sent = row.id;
    const out = JSON.parse(r.json);
    if (out.error) {
      Object.assign(S, { error: { message: out.error, trace: out.trace, printed: r.printed }, result: null, resultId: null });
      log('lab', `Backtest failed: ${f.strategy} on ${row.symbol} ${row.interval}: ${out.error}`, { trace: (out.trace || '').slice(-600) }, 'error');
      return false;
    }
    out.printed = r.printed || [];
    const sm = out.summary;
    log('lab', `Backtest: ${out.title}: ${(sm.trades.n || 0).toLocaleString('en-US')} trades, ${(sm.return * 100).toFixed(1)}%, ${out.meta.seconds}s`,
      { from: out.meta.from, to: out.meta.to, warmup: out.meta.warmup, params: out.meta.params, settings: out.settings });
    Object.assign(S, { result: out, resultId: null, resultCandles: d });
    if (save) {
      progress(0.97, 'Saving the result in the Results folder');
      try {
        const saved = await saveResult(out);
        if (saved.existing) toast('The same result was already in the Results folder: it is shown, not saved twice');
        S.resultId = saved.id;
      } catch (e) {
        toast(`The result isn’t saved: ${e.message}`, 'error');
      }
    }
    return true;
  } catch (e) {
    if (e.stopped) toast('Backtest stopped');
    else S.error = { message: e.message };
    return false;
  } finally {
    S.running = false;
    if (engine.w) engine.status('ready');
  }
}

/* ======================= Dashboard ======================= */

function paintDashboard(full) {
  const host = $('#lab-dashboard');
  if (!host.firstElementChild) {
    host.innerHTML = `<div class="lab-bt"><form class="card lab-form" id="lab-form" novalidate></form>
      <div class="lab-right"><div class="card lab-rcard" id="lab-rlist"></div><div class="lab-out" id="lab-out"></div></div></div>`;
    full = true;
  }
  paintForm();
  paintResultsList();
  if (full || !$('#lab-out').firstElementChild) paintOutput();
  showLatest();
}

const dsLabel = (d) => `${d.symbol} ${d.interval} · ${d.market} · ${ymd(d.start_ts)} → ${ymd(d.end_ts)}`;

function paintForm() {
  const form = $('#lab-form');
  if (!form) return;
  const f = S.form;
  if (!findDs(f.dataset) && S.datasets.length) f.dataset = S.datasets[0].id;
  const ds = findDs(f.dataset);
  const group = (folder) => {
    const rows = S.datasets.filter((d) => d.folder === folder);
    return rows.length ? `<optgroup label="${FOLDER_NAME[folder]} folder">${rows.map((d) => `<option value="${d.id}" ${d.id === f.dataset ? 'selected' : ''}>${esc(dsLabel(d))}</option>`).join('')}</optgroup>` : '';
  };
  form.innerHTML = `
    <div class="lab-form-head"><h2>Backtest</h2><p class="dim small">Runs in your browser with Python. The result opens in the report and is saved in Results.</p></div>
    <fieldset><legend>1 · Data file</legend>
      ${S.datasets.length ? `<label><span class="label">File on MEDUSA</span><select class="input" data-f="dataset">${group('downloads')}${group('uploads')}</select></label>
      <div class="lab-grid2"><label><span class="label">From (optional)</span><input class="input" type="date" data-f="start" value="${esc(f.start)}"></label>
      <label><span class="label">To (optional)</span><input class="input" type="date" data-f="end" value="${esc(f.end)}"></label></div>
      ${ds ? `<span class="hint">${ds.candles.toLocaleString('en-US')} candles of ${ds.interval}${ds.funding ? ' · with funding rates' : ''}. Leave the dates empty to test all of it.</span>` : ''}`
      : `<div class="lab-note">${S.loaded ? 'No data files yet.' : '<span class="spin"></span> Loading your files…'} <button class="link" type="button" data-lab="tab" data-tab="data">Download from Binance</button> or <button class="link" type="button" data-lab="go-upload">upload a file</button>.</div>`}
    </fieldset>
    <fieldset><legend>2 · Strategy</legend>${strategyBlock(f, 'd', ds ? ds.interval : '')}</fieldset>
    ${settingsBlock(f, ds && ds.market === 'futures' && ds.funding > 0, '3 · Costs, money and checks')}
    <label class="check"><input type="checkbox" data-f="save" ${f.save ? 'checked' : ''}><span>Save the result in the Results folder</span></label>
    <div class="lab-run">
      <button class="btn btn-green" type="submit" ${S.running || !ds || !S.catalog.strategies.length ? 'disabled' : ''}>${S.running ? '<span class="spin"></span>Running…' : `${icon('play')}Run backtest`}</button>
      ${S.running ? '<button class="btn" type="button" data-lab="stop">Stop</button>' : ''}
    </div>
    <div class="lab-progress" id="lab-progress" hidden><div class="lab-meter"><i></i></div><span class="faint small"></span></div>`;
  paintWarm('d', f, ds);
}

function runRow(r, full) {
  const b = r.brief || {};
  const tone = b.return > 0 ? 'pos' : b.return < 0 ? 'neg' : '';
  return `<tr data-lab="open-run" data-id="${r.id}" tabindex="0" class="${r.id === S.resultId ? 'on' : ''}">
    <td class="l"><b>${esc(r.title)}</b><br><span class="faint small">${b.from ? `${ymd(b.from)} → ${ymd(b.to)} · ` : ''}${ago(r.created_at)}</span></td>
    <td class="${tone}">${pct(b.return)}</td><td>${isNum(b.max_dd) ? (-b.max_dd * 100).toFixed(1) + '%' : '–'}</td><td>${b.trades ?? '–'}</td>
    ${full ? `<td>${isNum(b.win_rate) ? (b.win_rate * 100).toFixed(1) + '%' : '–'}</td><td>${rr(b.r_avg, 3)}</td><td>${pct(b.bh_return)}</td><td>${bytes(r.bytes)}</td>` : ''}
    <td class="lab-acts">${b.dataset && findDs(b.dataset) ? `<button class="btn btn-sm" data-lab="chart-run" data-id="${r.id}" title="Show the trades on the Chart tab">${icon('chart')}<span class="sr-only">Show on chart</span></button>` : ''}<button class="btn btn-sm" data-lab="csv-run" data-id="${r.id}" title="Export CSV">${icon('down')}<span class="sr-only">Export CSV</span></button><button class="btn btn-sm" data-lab="del-run" data-id="${r.id}" title="Delete">${icon('trash')}<span class="sr-only">Delete</span></button></td></tr>`;
}

function paintResultsList() {
  const box = $('#lab-rlist');
  if (!box) return;
  box.innerHTML = `<div class="lab-rhead2"><div><h2>Results</h2><p class="dim small">Every backtest is saved here (the Results folder on MEDUSA). Click one to show it below.</p></div>
      <button class="btn btn-sm" data-lab="tab" data-tab="files">${icon('db')}Manage files</button></div>
    ${S.runs.length ? `<div class="lab-scroll lab-rscroll"><table class="lab-table lab-list"><thead><tr><th>Test</th><th>Return</th><th>Drawdown</th><th>Trades</th><th></th></tr></thead><tbody>${S.runs.map((r) => runRow(r, false)).join('')}</tbody></table></div>`
      : `<p class="dim small">${S.loaded ? 'No results yet. Run a backtest and it appears here.' : '<span class="spin"></span> Loading…'}</p>`}`;
}

/** On opening the dashboard with nothing shown, show the newest saved result. */
function showLatest() {
  if (S.tab !== 'dashboard' || S.result || S.error || S.running || S.loadingResult || !S.runs.length) return;
  openResult(S.runs[0].id);
}

async function fetchResult(id) {
  const r = await api('GET', `/api/lab/runs/${id}`, { raw: true });
  return gunzipJSON(new Uint8Array(await r.arrayBuffer()));
}

async function openResult(id) {
  S.loadingResult = id;
  paintOutput();
  try {
    const R = await fetchResult(id);
    if (S.loadingResult !== id) return;
    Object.assign(S, { result: R, resultId: id, resultCandles: null, error: null });
  } catch (e) {
    fail(e);
  } finally {
    if (S.loadingResult === id) S.loadingResult = null;
    paintResultsList();
    paintOutput();
  }
}

/** Saves a result in the Results folder. Saving the same result again returns the copy already there. */
async function saveResult(R) {
  const { made, seconds, ...stable } = R.meta;            // when and how fast it ran don't make a different result
  const hash = await data.sha256(JSON.stringify({ ...R, meta: stable, printed: undefined }));
  const saved = await api('POST', '/api/lab/runs', { body: await gzipJSON(R), meta: { title: R.title, brief: brief(R), hash } });
  log('lab', saved.existing ? `Result already in Results: ${R.title}` : `Result saved: ${R.title}`, { id: saved.id }, saved.existing ? 'info' : 'debug');
  return saved;
}

/** "Python code": the whole backtest as one standalone .py file (standalone.js), shown in a window. */
async function showCode(R) {
  const mod = await import('./standalone.js');
  const names = [...mod.ENGINE_FILES, 'export_runner.py'];
  const files = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await (await fetch(`/lab/py/${n}`)).text()])));
  const key = String(R.config.strategy || '');
  let source = null, note = '';
  if (key.startsWith('mine:')) {
    const m = S.mine.find((x) => x.id === key.split(':')[1]);
    source = m ? m.code : null;
    if (!m) note = 'the strategy file used for this result has been deleted from MEDUSA.';
  } else if (!key.startsWith('console:')) {
    const r = await fetch(`/lab/strategies/${key}.py`);
    source = r.ok ? await r.text() : null;
  }
  const code = mod.standaloneScript({ report: R, files, strategySource: source, strategyNote: note });
  const name = mod.scriptName(R);
  log('lab', `Python code shown for ${R.title}`, { file: name, bytes: code.length });
  app.showModal(`
    <div class="modal-head"><h2 id="modal-title">The Python code of this backtest</h2><span style="flex:1"></span><button class="btn btn-icon" data-action="close" aria-label="Close">✕</button></div>
    <div class="modal-body lab-editor">
      <p class="dim small">Everything that ran, in one file: the settings, MEDUSA’s engine files exactly as they ran in your browser, the strategy, and a runner that downloads the same candles from Binance (or reads your CSV/ZIP file with <code>--csv</code>) and prints the same report, checking it against this result. Needs Python 3.9+ and numpy (<code>pip install numpy</code>); run it with <code>python ${esc(name)}</code>.</p>
      <pre class="lab-code lab-code-view" id="lab-code-view" tabindex="0" aria-label="Python code">${highlight(code)}</pre>
    </div>
    <div class="modal-foot"><span class="faint small">${esc(name)} · ${(code.length / 1024).toFixed(0)} KB</span><span style="flex:1"></span>
      <button class="btn" data-lab="code-copy">${icon('copy')}Copy</button><button class="btn btn-green" data-lab="code-download">${icon('down')}Download .py</button></div>`, 'lab-wide');
  S.code = { code, name };
}

function paintOutput() {
  const out = $('#lab-out');
  if (!out) return;
  if (S.loadingResult) { out.innerHTML = '<div class="card"><p class="dim"><span class="spin"></span> Opening the result…</p></div>'; return; }
  if (S.result) {
    const R = S.result;
    const id = S.resultId;
    renderReport(out, R, {
      candles: S.resultCandles && S.resultCandles.n ? S.resultCandles : null,
      loadCandles: () => data.loadDataset(R.meta.dataset),
      saved: Boolean(id),
      onSave: async (btn) => {
        btn.disabled = true;
        try {
          const saved = await saveResult(R);
          S.resultId = saved.id;
          toast('Saved in the Results folder');
          await refreshFiles();
          paintOutput();
        } catch (e) { btn.disabled = false; fail(e); }
      },
      onExport: () => download(resultCSVName(R), resultCSV(R)),
      onCode: () => showCode(R).catch(fail),
      onChart: findDs(R.meta.dataset) ? () => openOnChart(R, id) : null,
      onReuse: findDs(R.meta.dataset) ? () => {
        S.form = Object.assign(defaultForm(), R.config, { dataset: R.meta.dataset, save: S.form.save,
          params: { ...S.form.params, [R.config.strategy]: { ...(R.config.params || {}), ...(R.config.param_units || {}) } } });
        if (!R.config.start) S.form.start = '';
        store.set('form', S.form);
        paintForm();
        $('#lab-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('Settings loaded into the form');
      } : null,
      onDelete: id ? (btn) => confirmThen(btn, () => deleteRun(id)) : null,
    });
    return;
  }
  if (S.error) {
    out.innerHTML = `<div class="card lab-error"><h3>The backtest stopped</h3><pre class="lab-pre">${esc(S.error.message)}</pre>
      ${S.error.trace ? `<details><summary class="small">Full Python error</summary><pre class="lab-pre">${esc(S.error.trace)}</pre></details>` : ''}
      ${S.error.printed && S.error.printed.length ? `<details open><summary class="small">Printed by the strategy</summary><pre class="lab-pre">${esc(S.error.printed.join('\n'))}</pre></details>` : ''}</div>`;
    return;
  }
  out.innerHTML = `<div class="card lab-intro">
    <h2>Test a trading idea on past prices</h2>
    <p class="dim">A backtest replays history candle by candle and trades it with fixed rules, so you can see how they would have done, with fees, before risking money.</p>
    <ol class="steps">
      <li><b>Get data</b> in <button class="link" type="button" data-lab="tab" data-tab="data">Get data</button>, one of two ways: download a coin from Binance <b>straight into MEDUSA</b>, or download it <b>to this computer</b> and upload the file to backtest it.</li>
      <li><b>Pick the data file and a strategy</b> on the left. Every strategy is explained in the <button class="link" type="button" data-lab="tab" data-tab="guide">Strategy guide</button>; you can add your own in Python under <button class="link" type="button" data-lab="tab" data-tab="strategies">Strategies</button>.</li>
      <li><b>Run it.</b> The result appears here and is saved in the Results folder. Export it as CSV, or delete it any time.</li>
    </ol>
    <p class="faint small">New to this? Start with <button class="link small" type="button" data-lab="doc" data-doc="start">What is backtesting</button> and <button class="link small" type="button" data-lab="doc" data-doc="report">Reading the report</button>.</p>
  </div>`;
}

async function runDashboard() {
  if (S.running) return;
  const f = readDash();
  const row = findDs(f.dataset), st = findStrat(f.strategy);
  if (!row || !st) return;
  for (const [k, label] of [['start', 'From'], ['end', 'To'], ['split', 'Held-back date']]) {
    if (f[k] && !parseDate(f[k])) { toast(`${label}: pick a full date.`, 'error'); return; }
  }
  S.running = true;
  paintForm();
  await runTest({ row, f, withDates: true, save: f.save, progress: (x, t) => setProgress('#lab-progress', x, t) });
  if (S.resultId) await refreshFiles();
  paintForm();
  paintResultsList();
  paintOutput();
  $('#lab-out').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteRun(id) {
  try {
    await api('DELETE', `/api/lab/runs/${id}`);
    log('lab', 'Result deleted', { id });
    if (S.resultId === id) Object.assign(S, { result: null, resultId: null, resultCandles: null });
    toast('Result deleted');
    await refreshFiles();
    if (S.tab === 'dashboard') paintOutput();
  } catch (e) { fail(e); }
}

async function exportRun(id, btn) {
  btn.disabled = true;
  try {
    const R = id === S.resultId && S.result ? S.result : await fetchResult(id);
    download(resultCSVName(R), resultCSV(R));
  } catch (e) { fail(e); }
  btn.disabled = false;
}

/* ======================= Get data ======================= */

function dlState() {
  return Object.assign({ market: 'futures', symbol: 'BTCUSDT', interval: '4h', period: '5y', from: '', to: '', funding: true, format: 'zip' }, store.get('dl', {}));
}
function readDl() {
  const d = dlState();
  for (const el of $$('[data-d]', $('#lab-dl') || document.createElement('div'))) d[el.dataset.d] = el.type === 'checkbox' ? el.checked : el.value.trim();
  d.symbol = normSymbol(d.symbol);
  store.set('dl', d);
  return d;
}
/** "btc", "BTC/USDT" or "btcusdt" -> "BTCUSDT". */
function normSymbol(s) {
  const x = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return x && !/(USDT|USDC|FDUSD|BTC|ETH|BNB|TRY|EUR)$/.test(x) ? x + 'USDT' : x;
}

const listedCache = new Map();
function paintData() {
  const host = $('#lab-data');
  const d = dlState();
  const busy = Boolean(S.downloading);
  host.innerHTML = `
  ${S.storage ? '' : '<div class="banner"><div><b>MEDUSA storage isn’t set up yet.</b> Downloads to this computer work; saving in MEDUSA and uploading need the LAB storage (Workers KV). The README’s “MEDUSA Lab” section has the two commands.</div></div>'}
  <div class="lab-data">
    <form class="card lab-dl" id="lab-dl" novalidate>
      <div class="card-head"><div><h2>Download crypto data from Binance</h2><p>Pick a coin, a timeframe and how far back. Save it in MEDUSA to backtest right away, or as a file on this computer.</p></div></div>
      <div><span class="label">Market</span><div class="toggle" role="group">${['futures', 'spot'].map((m) => `<button type="button" data-lab="dl-market" data-v="${m}" aria-pressed="${d.market === m}">${m === 'futures' ? 'Futures (USD-M perpetual)' : 'Spot'}</button>`).join('')}</div></div>
      <div><span class="label">Coin</span>
        <div class="lab-chips">${data.POPULAR.map((c) => `<button type="button" class="lab-chip" data-lab="coin" data-v="${c}USDT" aria-pressed="${d.symbol === c + 'USDT'}">${c}</button>`).join('')}</div>
        <input class="input" data-d="symbol" list="lab-coins" autocomplete="off" spellcheck="false" value="${esc(d.symbol)}" placeholder="or type any Binance coin, e.g. PEPEUSDT" aria-label="Coin"><datalist id="lab-coins"></datalist>
        <span class="hint" id="lab-coin-note"></span></div>
      <div class="lab-grid2">
        <label><span class="label">Timeframe (one candle =)</span><select class="input" data-d="interval">${data.BINANCE_INTERVALS.map((x) => `<option value="${x}" ${x === d.interval ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label><span class="label">How far back</span><select class="input" data-d="period">${data.PERIODS.map(([k, l]) => `<option value="${k}" ${k === d.period ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      ${d.period === 'custom' ? `<div class="lab-grid2"><label><span class="label">From</span><input class="input" type="date" data-d="from" value="${esc(d.from)}"></label><label><span class="label">To (empty = today)</span><input class="input" type="date" data-d="to" value="${esc(d.to)}"></label></div>` : ''}
      ${d.market === 'futures' ? `<label class="check"><input type="checkbox" data-d="funding" ${d.funding ? 'checked' : ''}><span>Include funding rates (backtests then pay and receive funding)</span></label>` : ''}
      <div class="lab-estimate" id="lab-estimate"></div>
      <div class="lab-dest">
        <div class="lab-destbox">
          <button class="btn btn-green" type="button" data-lab="dl-medusa" ${busy || !S.storage ? 'disabled' : ''}>${icon('db')}Download to MEDUSA</button>
          <span class="hint">Into the <b>Downloads</b> folder · <span data-free>${freeLine(S.usage)}</span></span>
        </div>
        <div class="lab-destbox">
          <div class="lab-split"><button class="btn" type="button" data-lab="dl-local" ${busy ? 'disabled' : ''}>${icon('down')}Download to this computer</button>
            <select class="input lab-fmt" data-d="format" aria-label="File type"><option value="zip" ${d.format === 'zip' ? 'selected' : ''}>ZIP</option><option value="csv" ${d.format === 'csv' ? 'selected' : ''}>CSV</option></select></div>
          <span class="hint">ZIP: smaller, keeps funding rates · CSV: opens in Excel. Upload it later to backtest.</span>
        </div>
      </div>
      ${busy ? '<div class="lab-run"><button class="btn" type="button" data-lab="stop-dl">Stop</button></div>' : ''}
      <div class="lab-progress" id="lab-dl-progress" ${busy ? '' : 'hidden'}><div class="lab-meter"><i></i></div><span class="faint small"></span></div>
      <div id="lab-dl-done">${S.dlDone || ''}</div>
    </form>
    <div class="card lab-upload" id="lab-upload">
      <div class="card-head"><div><h2>Upload a file and backtest it</h2><p>A file you downloaded to this computer, or any CSV of candles (time, open, high, low, close). It is saved in MEDUSA’s <b>Uploads</b> folder; delete it any time in Files.</p></div></div>
      <label class="lab-drop" id="lab-drop"><input type="file" id="lab-file" accept=".csv,.txt,.zip" multiple hidden>${icon('up')}<span><b>Choose a file</b> or drop it here<br><span class="faint small">CSV or ZIP · several files of one coin are joined</span></span></label>
      <div id="lab-upload-form"></div>
    </div>
  </div>`;
  estimate();
  paintUpload();
  data.binanceSymbols(d.market).then((list) => {
    const dl = $('#lab-coins');
    if (dl) dl.innerHTML = list.map((s) => `<option value="${esc(s)}">`).join('');
    coinNote(list);
  });
  if (S.downloading) setProgress('#lab-dl-progress', S.downloading.f, S.downloading.text);
}

function coinNote(list) {
  const el = $('#lab-coin-note');
  if (!el) return;
  const d = dlState();
  el.textContent = list && list.length && d.symbol && !list.includes(d.symbol) ? `Binance doesn’t list ${d.symbol} on ${d.market} right now (it may be delisted or spelled differently).` : '';
  el.classList.toggle('lab-bad', Boolean(el.textContent));
}

/** Candle count and file sizes before downloading. */
function estimate() {
  const el = $('#lab-estimate');
  if (!el) return;
  const d = dlState();
  const step = INTERVAL_MS[d.interval];
  let { start, end } = data.periodRange(d.period, d.from, d.to);
  const key = `${d.market}:${d.symbol}`;
  const listed = listedCache.get(key);
  if (listed === undefined && d.symbol) {
    listedCache.set(key, null);
    data.binanceListed(d.market, d.symbol).then((t) => { listedCache.set(key, t); estimate(); }).catch(() => { listedCache.set(key, 0); estimate(); });
  }
  if (listed) start = Math.max(start || listed, listed);
  end = Math.min(end || Date.now(), Date.now());
  const medusaBtn = $('[data-lab="dl-medusa"]'), localBtn = $('[data-lab="dl-local"]');
  if (!start) {
    el.innerHTML = `<span class="faint">${listed === 0 ? 'Binance has no candles for this coin and market.' : '<span class="spin"></span> Checking when Binance listed it…'}</span>`;
    return;
  }
  const n = Math.max(0, Math.round((end - start) / step));
  const small = step <= 900_000;                      // bytes per candle, measured on real downloads
  const perCandle = small ? 12 : 18, perZip = small ? 22 : 30;
  const tooBigMedusa = n > MAX_CANDLES, tooBigLocal = n > data.LOCAL_MAX;
  el.innerHTML = `<b>${n.toLocaleString('en-US')} candles</b> from ${dateLocal(start)}${listed && start === listed ? ' (listing)' : ''} to ${d.period === 'custom' && d.to ? dateLocal(end - DAY) : 'today'}.
    <span class="faint">In MEDUSA about ${bytes(n * perCandle)} · on this computer about ${bytes(n * 85)} as CSV, ${bytes(n * perZip)} as ZIP.</span>
    ${tooBigLocal ? `<br><span class="lab-bad">Too many candles: the limit is ${data.LOCAL_MAX.toLocaleString('en-US')} per download. Pick a shorter period or a bigger timeframe.</span>`
      : tooBigMedusa ? `<br><span class="lab-bad">Too many for MEDUSA and backtests (limit ${MAX_CANDLES.toLocaleString('en-US')}): download it to this computer, then upload the part you want to test.</span>` : ''}`;
  if (medusaBtn && !S.downloading) medusaBtn.disabled = tooBigMedusa || !S.storage;
  if (localBtn && !S.downloading) localBtn.disabled = tooBigLocal;
}

async function runDownload(dest) {
  if (S.downloading) return;
  const d = readDl();
  if (!d.symbol) { toast('Pick a coin.', 'error'); return; }
  if (d.period === 'custom' && !parseDate(d.from)) { toast('Pick the From date.', 'error'); return; }
  const { start, end } = data.periodRange(d.period, d.from, d.to);
  const ctl = new AbortController();
  S.downloading = { ctl, f: 0, text: 'Starting' };
  S.dlDone = null;
  paintData();
  const say = (f, text) => { if (S.downloading) Object.assign(S.downloading, { f, text }); setProgress('#lab-dl-progress', f, text); };
  try {
    const ds = await data.fromBinance({ market: d.market, symbol: d.symbol, interval: d.interval, start, end, funding: d.funding, max: dest === 'medusa' ? MAX_CANDLES : data.LOCAL_MAX }, say, ctl.signal);
    const what = `${d.symbol} ${d.interval} ${d.market}, ${ds.n.toLocaleString('en-US')} candles (${ymd(ds.cols.t[0])} → ${ymd(ds.cols.t[ds.n - 1])})${ds.funding ? ` + ${ds.funding.n.toLocaleString('en-US')} funding rates` : ''}`;
    if (dest === 'medusa') {
      say(0.98, 'Saving in MEDUSA’s Downloads folder');
      const saved = await data.saveDataset(ds, `${d.symbol} ${d.interval} · Binance ${d.market}`);
      S.form.dataset = saved.id;
      store.set('form', S.form);
      log('lab', saved.existing ? `Download already in Downloads (no copy made): ${what}` : `Downloaded to MEDUSA: ${what}`, { bytes: saved.bytes, id: saved.id });
      S.dlDone = `<div class="lab-done">${icon('check')}<div><b>${saved.existing ? 'Already in the Downloads folder' : 'Saved in the Downloads folder'}</b> (${bytes(saved.bytes)}${saved.existing ? ', the same file, so no second copy was made' : ''}): ${esc(what)}.
        <div class="row-btns"><button class="btn btn-sm btn-green" type="button" data-lab="use-ds" data-id="${saved.id}">${icon('play')}Backtest it</button><button class="btn btn-sm" type="button" data-lab="tab" data-tab="files">Open Files</button></div></div></div>`;
      await refreshFiles();
    } else {
      say(0.98, 'Making the file');
      const file = await data.localFile(ds, d.format);
      download(file.name, file.blob);
      log('lab', `Downloaded to this computer: ${file.name}`, { bytes: file.blob.size });
      S.dlDone = `<div class="lab-done">${icon('check')}<div><b>Saved to this computer</b> as <code>${esc(file.name)}</code> (${bytes(file.blob.size)}): ${esc(what)}.
        Look in your Downloads folder. To backtest it, upload it on the right.</div></div>`;
    }
  } catch (e) {
    if (data.isCancel(e)) { toast('Download stopped'); log('lab', 'Download stopped'); } else fail(e);
  } finally {
    S.downloading = null;
    if (S.tab === 'data') paintData();
  }
}

/* ---------- upload and backtest ---------- */

async function readUpload(files) {
  if (!files.length) return;
  S.up = { busy: true, files: [...files] };
  paintUpload();
  try {
    const ds = await data.fromFiles(S.up.files, (x, t) => { const el = $('#lab-up-reading'); if (el) el.textContent = t; });
    const g = ds.guess;
    const interval = ds.interval || (INTERVAL_MS[g.interval] ? g.interval : '');
    const n = ds.n;
    // A file bigger than one backtest can take starts at the first whole day of its last 1,000,000 candles.
    const from = n > MAX_CANDLES ? ymd(Math.ceil(ds.cols.t[n - MAX_CANDLES] / DAY) * DAY) : ymd(ds.cols.t[0]);
    S.up = {
      files: S.up.files, ds,
      answers: { symbol: g.symbol, market: g.market || 'futures', interval, from, to: ymd(ds.cols.t[n - 1]) },
      form: Object.assign(defaultForm(), store.get('upform', {})),
    };
  } catch (e) {
    S.up = { error: e.message };
  }
  paintUpload();
}

function upCount(u) {
  const lo = parseDate(u.answers.from), hi = parseDate(u.answers.to);
  if (!lo || !hi) return 0;
  const t = u.ds.cols.t;
  let a = 0, b = u.ds.n;
  while (a < b && t[a] < lo) a++;
  while (b > a && t[b - 1] >= hi + DAY) b--;
  return b - a;
}

function paintUpload() {
  const box = $('#lab-upload-form');
  if (!box) return;
  const u = S.up;
  if (!u) { box.innerHTML = ''; return; }
  if (u.busy) { box.innerHTML = '<p class="dim"><span class="spin"></span> <span id="lab-up-reading">Reading the file…</span></p>'; return; }
  if (u.error) { box.innerHTML = `<div class="err">${esc(u.error)}</div>`; return; }
  const ds = u.ds, a = u.answers;
  const detected = ds.interval;
  const count = upCount(u);
  const fundingOk = a.market === 'futures' && Boolean(ds.funding);
  box.innerHTML = `<form class="lab-upform" id="lab-upform" novalidate>
    <div class="lab-upsum">${icon('check')}<div><b>${esc(u.files.map((f) => f.name).join(', '))}</b><br>
      <span class="small dim">${ds.n.toLocaleString('en-US')} candles from ${dateLocal(ds.cols.t[0], true)} to ${dateLocal(ds.cols.t[ds.n - 1], true)} (your time)${ds.funding ? ` · ${ds.funding.n.toLocaleString('en-US')} funding rates` : ''}${ds.skipped ? ` · ${plural(ds.skipped, 'line')} skipped (not numbers)` : ''}</span></div></div>
    <fieldset><legend>1 · What is this data?</legend>
      <div class="lab-grid2">
        <label><span class="label">Coin</span><input class="input" data-u="symbol" value="${esc(a.symbol)}" placeholder="BTCUSDT" spellcheck="false"></label>
        <label><span class="label">Market</span><select class="input" data-u="market"><option value="futures" ${a.market === 'futures' ? 'selected' : ''}>Futures (long and short)</option><option value="spot" ${a.market === 'spot' ? 'selected' : ''}>Spot (long only, no leverage)</option></select></label>
        <label><span class="label">Timeframe of each candle</span><select class="input" data-u="interval"><option value="">Choose</option>${Object.keys(INTERVAL_MS).map((x) => `<option ${x === a.interval ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <span class="hint ${detected && a.interval && a.interval !== detected ? 'lab-bad' : ''}">${detected ? (a.interval && a.interval !== detected ? `The candles are ${detected} apart, not ${a.interval}.` : `Detected from the file: ${detected}`) : `Couldn’t detect it (candles are usually ${Math.round(ds.typicalGap / 60000)} minutes apart)`}</span></label>
      </div>
    </fieldset>
    <fieldset><legend>2 · Which dates?</legend>
      <div class="lab-grid2">
        <label><span class="label">From</span><input class="input" type="date" data-u="from" value="${esc(a.from)}" min="${ymd(ds.cols.t[0])}" max="${ymd(ds.cols.t[ds.n - 1])}"></label>
        <label><span class="label">To</span><input class="input" type="date" data-u="to" value="${esc(a.to)}" min="${ymd(ds.cols.t[0])}" max="${ymd(ds.cols.t[ds.n - 1])}"></label>
      </div>
      <span class="hint ${count > MAX_CANDLES || count < 2 ? 'lab-bad' : ''}" id="lab-up-count">${upCountText(count)}</span>
    </fieldset>
    <fieldset><legend>3 · Which strategy?</legend>${strategyBlock(u.form, 'u', a.interval || '')}</fieldset>
    ${settingsBlock(u.form, fundingOk, '4 · Costs, money and checks')}
    <label class="check"><input type="checkbox" data-f="save" ${u.form.save ? 'checked' : ''}><span>Save the result in the Results folder</span></label>
    <label class="check"><input type="checkbox" data-f="dropAfter" ${u.form.dropAfter ? 'checked' : ''}><span>Delete the file from MEDUSA after the backtest (keep only the result)</span></label>
    <div class="lab-run"><button class="btn btn-green" type="submit" ${S.running || !S.storage ? 'disabled' : ''}>${S.running ? '<span class="spin"></span>Working…' : `${icon('up')}Upload and backtest`}</button><button class="btn" type="button" data-lab="cancel-upload">Cancel</button></div>
    <div class="lab-progress" id="lab-up-progress" hidden><div class="lab-meter"><i></i></div><span class="faint small"></span></div>
  </form>`;
  if (a.interval) setTimeout(() => paintWarm('u', { ...u.form, start: a.from }, { interval: a.interval, start_ts: ds.cols.t[0] }), 0);
}

const upCountText = (n) => (n > MAX_CANDLES ? `${n.toLocaleString('en-US')} candles: more than the ${MAX_CANDLES.toLocaleString('en-US')} a backtest can take. Move From later.`
  : n < 2 ? 'No candles between these dates.' : `${n.toLocaleString('en-US')} candles will be saved in the Uploads folder and tested.`);

function readAnswers() {
  const u = S.up;
  if (!u || !u.answers) return null;
  for (const el of $$('[data-u]', $('#lab-upform') || document.createElement('div'))) u.answers[el.dataset.u] = el.value.trim();
  return u.answers;
}

async function runUpload() {
  const u = S.up;
  if (!u || !u.ds || S.running) return;
  const a = readAnswers();
  const f = readUp();
  const symbol = a.symbol.toUpperCase().replace(/[^A-Z0-9._-]/g, '');
  if (!symbol) { toast('Type the coin’s name, for example BTCUSDT.', 'error'); return; }
  if (!INTERVAL_MS[a.interval]) { toast('Choose the timeframe of each candle.', 'error'); return; }
  const lo = parseDate(a.from), hi = parseDate(a.to);
  if (!lo || !hi || hi < lo) { toast('Pick the From and To dates.', 'error'); return; }
  if (!findStrat(f.strategy)) { toast('Pick a strategy.', 'error'); return; }
  const part = data.slice(u.ds, lo, hi + DAY);
  if (part.n < 2) { toast('No candles between these dates.', 'error'); return; }
  if (part.n > MAX_CANDLES) { toast(upCountText(part.n), 'error'); return; }
  if (a.market === 'spot') part.funding = null;
  part.meta = { symbol, market: a.market, source: 'upload', interval: a.interval };
  S.running = true;
  paintUpload();
  const progress = (x, t) => setProgress('#lab-up-progress', x, t);
  try {
    progress(0.01, 'Saving the file in MEDUSA’s Uploads folder');
    const saved = await data.saveDataset(part, `${symbol} ${a.interval} · uploaded ${a.market}`);
    log('lab', saved.existing ? `Upload already in Uploads (no copy made): ${symbol} ${a.interval}` : `Uploaded: ${symbol} ${a.interval}, ${part.n.toLocaleString('en-US')} candles`, { id: saved.id });
    if (saved.existing) toast('This file was already in the Uploads folder, so no second copy was made');
    await refreshFiles();
    const row = findDs(saved.id);
    const candles = await data.loadDataset(saved.id);
    const ok = await runTest({ row, f, withDates: false, save: f.save, progress, candles });
    if (f.dropAfter) {
      await api('DELETE', `/api/lab/datasets/${saved.id}`).catch(fail);
      data.forget(saved.id);
      if (engine.sent === saved.id) engine.sent = null;
    }
    await refreshFiles();
    if (ok) { S.up = null; toast(f.dropAfter ? 'Backtest done; the file was deleted from MEDUSA' : 'Backtest done'); }
    go('dashboard');
  } catch (e) {
    fail(e);
  } finally {
    S.running = false;
    if (S.tab === 'data') paintUpload();
  }
}

/* ======================= Files ======================= */

function paintFiles() {
  const host = $('#lab-files');
  const u = S.usage;
  const sum = (rows) => rows.reduce((s, r) => s + (r.bytes || 0), 0);
  const folder = (key) => {
    const rows = S.datasets.filter((d) => d.folder === key);
    const intro = key === 'downloads' ? 'Candles downloaded from Binance straight into MEDUSA.' : 'Files you uploaded from your computer to backtest.';
    return `<div class="card lab-folder">
      <div class="card-head"><div><h2>${icon('db')}${FOLDER_NAME[key]}</h2><p>${intro} ${plural(rows.length, 'file')} · ${bytes(sum(rows))}</p></div>
        ${key === 'downloads' ? meterBox(u) : ''}
        ${rows.length ? `<button class="btn btn-sm lab-delall" data-lab="del-folder" data-folder="${key}">${icon('trash')}Delete all ${FOLDER_NAME[key].toLowerCase()}</button>` : ''}</div>
      ${rows.length ? `<div class="lab-scroll"><table class="lab-table lab-list"><thead><tr><th>File</th><th>From</th><th>To</th><th>Candles</th><th>Size</th><th></th></tr></thead><tbody>
        ${rows.map((d) => `<tr><td class="l"><b>${esc(d.name)}</b><br><span class="faint small">${d.market} · ${d.interval}${d.funding ? ` · ${d.funding.toLocaleString('en-US')} funding rates` : ''} · added ${ago(d.created_at)}</span></td>
          <td>${ymd(d.start_ts)}</td><td>${ymd(d.end_ts)}</td><td>${d.candles.toLocaleString('en-US')}</td><td>${bytes(d.bytes)}</td>
          <td class="lab-acts"><button class="btn btn-sm" data-lab="use-ds" data-id="${d.id}">${icon('play')}Backtest</button><button class="btn btn-sm" data-lab="chart-ds" data-id="${d.id}" title="Open in the Chart tab">${icon('chart')}Chart</button><button class="btn btn-sm" data-lab="get-ds" data-id="${d.id}" data-fmt="${d.funding ? 'zip' : 'csv'}" title="Download to this computer">${icon('down')}${d.funding ? 'ZIP' : 'CSV'}</button><button class="btn btn-sm" data-lab="del-ds" data-id="${d.id}" title="Delete from MEDUSA">${icon('trash')}<span class="sr-only">Delete</span></button></td></tr>`).join('')}
        </tbody></table></div>`
        : `<p class="dim small">Empty. ${key === 'downloads' ? '<button class="link small" data-lab="tab" data-tab="data">Download from Binance</button>' : '<button class="link small" data-lab="go-upload">Upload a file</button>'}.</p>`}
    </div>`;
  };
  host.innerHTML = `
  ${S.storage ? '' : '<div class="banner"><div><b>MEDUSA storage isn’t set up yet.</b> The README’s “MEDUSA Lab” section has the two commands.</div></div>'}
  ${folder('downloads')}
  ${folder('uploads')}
  <div class="card lab-folder">
    <div class="card-head"><div><h2>${icon('chart')}Results</h2><p>Every backtest’s full report, saved automatically. ${plural(S.runs.length, 'result')} · ${bytes(sum(S.runs))}</p></div>
      ${S.runs.length ? `<button class="btn btn-sm lab-delall" data-lab="del-folder" data-folder="results">${icon('trash')}Delete all results</button>` : ''}</div>
    ${S.runs.length ? `<div class="lab-scroll"><table class="lab-table lab-list"><thead><tr><th>Test</th><th>Return</th><th>Drawdown</th><th>Trades</th><th>Win rate</th><th>Average trade</th><th>Buy &amp; hold</th><th>Size</th><th></th></tr></thead><tbody>${S.runs.map((r) => runRow(r, true)).join('')}</tbody></table></div>`
      : '<p class="dim small">Empty. Run a backtest on the Dashboard.</p>'}
  </div>
  <p class="faint small">All three folders live in Cloudflare’s free storage (Workers KV, 1 GB for the whole MEDUSA app). Deleting a file frees its space at once. Deleting a data file keeps the results made from it; only their price chart needs the data.</p>`;
}

function meterBox(u) {
  if (!u) return '<div class="lab-meterbox"><span class="faint small">Checking storage…</span></div>';
  const pctUsed = Math.min(100, (u.total / u.limit) * 100);
  return `<div class="lab-meterbox" title="Cloudflare's free Workers KV storage, shared by everything MEDUSA stores">
    <div class="small"><b>${mb(u.free)}</b> of Cloudflare’s free ${bytes(u.limit)} left</div>
    <div class="lab-usage"><i style="width:${pctUsed.toFixed(1)}%"></i></div>
    <div class="faint small">Your files ${bytes(u.used)} · up to ${bytes(u.quota)} per account</div></div>`;
}

async function deleteDataset(id) {
  try {
    await api('DELETE', `/api/lab/datasets/${id}`);
    log('lab', 'Data file deleted', { id });
    data.forget(id);
    if (engine.sent === id) engine.sent = null;
    toast('Deleted from MEDUSA');
    await refreshFiles();
  } catch (e) { fail(e); }
}

async function deleteFolder(folder) {
  try {
    const r = folder === 'results' ? await api('DELETE', '/api/lab/runs') : await api('DELETE', `/api/lab/datasets?folder=${folder}`);
    log('lab', `${FOLDER_NAME[folder]} folder emptied: ${plural(r.deleted, 'file')}`);
    if (folder === 'results') Object.assign(S, { result: null, resultId: null, resultCandles: null });
    else { data.forget(); engine.sent = null; }
    toast(`${FOLDER_NAME[folder]} folder emptied (${plural(r.deleted, 'file')})`);
    await refreshFiles();
  } catch (e) { fail(e); }
}

async function datasetToComputer(id, fmt, btn) {
  const row = findDs(id);
  btn.disabled = true;
  try {
    const d = await data.loadDataset(id);
    const ds = { ...d, meta: { symbol: row.symbol, market: row.market, interval: row.interval }, funding: d.funding ? { ft: d.funding.ft, fr: d.funding.fr } : null };
    const file = await data.localFile(ds, fmt);
    download(file.name, file.blob);
  } catch (e) { fail(e); }
  btn.disabled = false;
}

/* ======================= Strategies ======================= */

function paintStrategies() {
  const host = $('#lab-strategies');
  const groups = builtinGroups();
  const loaded = engine.state === 'ready' || S.catalog.strategies.length;
  const byFile = (id) => S.catalog.strategies.filter((s) => s.origin === 'mine' && s.id === id);
  const errOf = (id) => S.catalog.errors.find((e) => e.origin === 'mine' && e.id === id);
  host.innerHTML = `
  <div class="card">
    <div class="card-head"><div><h2>My strategies</h2><p>Your own trading logic in Python. Saved on MEDUSA’s server with your account; it runs only in your browser.</p></div>
      <div class="row-btns"><button class="btn btn-green" data-lab="new-strategy">${icon('plus')}Write a new strategy</button>
      <label class="btn">${icon('up')}Upload a .py file<input type="file" id="lab-pyfile" accept=".py,text/x-python,text/plain" hidden></label></div></div>
    ${S.mine.length ? `<div class="lab-scroll"><table class="lab-table lab-list"><thead><tr><th>File</th><th>Strategies in it</th><th>Changed</th><th></th></tr></thead><tbody>
      ${S.mine.map((m) => { const ss = byFile(m.id), er = errOf(m.id); return `<tr><td class="l"><b>${esc(m.name)}</b><br><span class="faint small">${bytes(new Blob([m.code]).size)}</span></td>
        <td class="l">${er ? `<span class="neg small">Doesn’t load: ${esc(er.error)}</span>` : ss.length ? ss.map((s) => esc(s.label)).join('<br>') : `<span class="faint small">${loaded ? '–' : 'loading…'}</span>`}</td>
        <td>${ago(m.updated_at)}</td>
        <td class="lab-acts">${ss.length ? `<button class="btn btn-sm" data-lab="use-strategy" data-key="${esc(ss[0].key)}">${icon('play')}Backtest</button><button class="btn btn-sm" data-lab="doc" data-doc="${esc(DOC_FOR(ss[0]))}">${icon('book')}Guide</button>` : ''}<button class="btn btn-sm" data-lab="edit-strategy" data-id="${m.id}">${icon('edit')}Edit</button>
          <button class="btn btn-sm" data-lab="dl-strategy" data-id="${m.id}" title="Download">${icon('down')}<span class="sr-only">Download</span></button><button class="btn btn-sm" data-lab="del-strategy" data-id="${m.id}" title="Delete">${icon('trash')}<span class="sr-only">Delete</span></button></td></tr>`; }).join('')}
      </tbody></table></div>`
      : `<p class="dim">None yet. <b>Write a new strategy</b> opens a commented template; <b>Copy</b> on a built-in strategy below gives you its code to change. The <button class="link" data-lab="doc" data-doc="write">guide to writing a strategy</button> explains every part.</p>`}
  </div>
  <div class="card">
    <div class="card-head"><div><h2>Built-in strategies</h2><p>Explained step by step, with real trades, in the Strategy guide. The label on each is how its published settings did in our test on 7 coins after costs.</p></div></div>
    ${groups.length ? groups.map(([title, list]) => `<h3 class="lab-sgroup">${esc(title)}</h3><div class="lab-cards">${list.map((s) => `<div class="lab-scard"><h3>${esc(s.label)}</h3>${verdictBadge(s.key)}<p class="dim small">${esc(s.description)}</p>
      <div class="row-btns"><button class="btn btn-sm btn-green" data-lab="use-strategy" data-key="${esc(s.key)}">${icon('play')}Backtest</button><button class="btn btn-sm" data-lab="doc" data-doc="${esc(DOC_FOR(s))}">${icon('book')}Guide</button>
      <button class="btn btn-sm" data-lab="view-builtin" data-id="${esc(s.id)}">${icon('code')}Code</button><button class="btn btn-sm" data-lab="copy-builtin" data-id="${esc(s.id)}">${icon('copy')}Copy</button></div></div>`).join('')}</div>`).join('')
      : `<p class="dim"><span class="spin"></span> ${engine.state === 'error' ? esc(engine.note) : 'Loading the Python engine…'}</p>`}
  </div>`;
}

const sourceOf = async (origin, id) => (origin === 'mine' ? (S.mine.find((m) => m.id === id) || {}).code || '' : (await fetch(`/lab/strategies/${id}.py`)).text());

/* The editor: a plain code box with Check (runs the file on test candles, including the look-ahead check) and Save. */
function openEditor({ id = null, name = 'my_strategy.py', code = '', readOnly = false, builtinId = null }) {
  const draft = store.get('draft');
  const hasDraft = !readOnly && draft && draft.id === id && draft.code !== code;
  app.showModal(`
    <div class="modal-head"><h2 id="modal-title">${readOnly ? `${esc(name)} <span class="faint small">(built in, read-only)</span>` : id ? 'Edit strategy' : 'New strategy'}</h2><span style="flex:1"></span><button class="btn btn-icon" data-action="close" aria-label="Close">✕</button></div>
    <div class="modal-body lab-editor">
      ${hasDraft ? `<div class="banner"><div>You have unsaved changes from ${ago(draft.at)}.</div><button class="btn btn-sm" data-lab="restore-draft">Restore them</button></div>` : ''}
      ${readOnly ? '' : `<label><span class="label">File name</span><input class="input" id="lab-ed-name" value="${esc(name)}" maxlength="60" spellcheck="false"></label>`}
      <textarea class="input lab-code" id="lab-ed-code" spellcheck="false" autocapitalize="off" autocomplete="off" ${readOnly ? 'readonly' : ''} aria-label="Python code">${esc(code)}</textarea>
      <div id="lab-ed-out" class="lab-check" aria-live="polite">${readOnly ? '<p class="faint small">To change it, press <b>Copy to my strategies</b>: you get your own copy to edit, and this one stays as it is.</p>' : '<p class="faint small">Tab indents. <b>Check</b> runs the file on test candles and makes sure it doesn’t look into the future. <b>Save</b> keeps it on MEDUSA’s server (Ctrl+S).</p>'}</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-lab="ed-download">${icon('down')}Download</button><button class="btn" data-lab="doc" data-doc="write">${icon('book')}How to write one</button><span style="flex:1"></span>
      ${readOnly ? `<button class="btn btn-green" data-lab="copy-builtin" data-id="${esc(builtinId)}">${icon('copy')}Copy to my strategies</button>`
        : `<button class="btn" data-lab="ed-check">${icon('check')}Check</button><button class="btn btn-green" data-lab="ed-save">${icon('save')}Save</button>`}
    </div>`, 'lab-wide');
  S.editor = { id, readOnly };
  attachEditor($('#lab-ed-code'));
  if (!readOnly) setTimeout(() => $('#lab-ed-code').focus(), 50);
}

function editorValues() {
  return { name: ($('#lab-ed-name') || {}).value || 'strategy.py', code: $('#lab-ed-code').value };
}

async function checkCode(code) {
  const out = $('#lab-ed-out');
  out.innerHTML = '<p class="dim small"><span class="spin"></span> Checking…</p>';
  try {
    await engine.start();
    const r = await engine.call('check', { source: code });
    const c = JSON.parse(r.json);
    log('lab', `Strategy check: ${c.ok ? 'passed' : 'failed'}${c.error ? ` (${c.error.split(/\r?\n/)[0].slice(0, 120)})` : ''}`, null, c.ok ? 'info' : 'error');
    const printed = (r.printed || []).length ? `<details><summary class="small">Printed</summary><pre class="lab-pre">${esc(r.printed.join('\n'))}</pre></details>` : '';
    if (c.error && !c.strategies.length) { out.innerHTML = `<div class="err"><pre class="lab-pre plain">${esc(c.error)}</pre></div>${printed}`; return c; }
    out.innerHTML = `${c.ok ? `<div class="lab-ok">${icon('check')} Works, and doesn’t look ahead.</div>` : ''}${c.error ? `<div class="err"><pre class="lab-pre plain">${esc(c.error)}</pre></div>` : ''}
      ${c.notes.map((n) => `<div class="${/LOOKS AHEAD/.test(n) ? 'err' : 'lab-note'}">${esc(n)}</div>`).join('')}
      <ul class="small dim">${c.strategies.map((s) => `<li><b>${esc(s.label)}</b> (key <code>${esc(s.key)}</code>): ${s.error ? 'error' : `${(s.params || []).length} settings, ${plural(s.trades || 0, 'trade')} on 1,600 test candles in ${s.seconds}s`}</li>`).join('')}</ul>${printed}`;
    return c;
  } catch (e) {
    out.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    return null;
  }
}

async function saveCode(btn) {
  const { name, code } = editorValues();
  const ed = S.editor;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Saving…';
  try {
    const file = /\.py$/i.test(name) ? name : name + '.py';
    const r = ed.id ? await api('PUT', `/api/lab/strategies/${ed.id}`, { json: { name: file, code } }) : await api('POST', '/api/lab/strategies', { json: { name: file, code } });
    ed.id = r.id;
    log('lab', r.existing ? `Strategy file unchanged (already saved): ${file}` : `Strategy file saved: ${file}`);
    store.set('draft', null);
    btn.innerHTML = `${icon('save')}Save`;
    btn.disabled = false;
    toast('Saved on MEDUSA');
    await engine.start();
    await engine.loadMine();
    const er = S.catalog.errors.find((x) => x.origin === 'mine' && x.id === r.id);
    if (er) $('#lab-ed-out').innerHTML = `<div class="err">Saved, but it doesn’t load yet: ${esc(er.error)}</div>`;
    else await checkCode(code);
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = `${icon('save')}Save`;
    fail(e);
  }
}

async function uploadPy(file) {
  if (!file) return;
  if (file.size > 100 * 1024) { toast('Strategy files can be up to 100 KB.', 'error'); return; }
  const code = await file.text();
  openEditor({ id: null, name: file.name.replace(/[^\w .()-]/g, '_').slice(0, 60), code });
  setTimeout(() => checkCode(code), 100);
}

async function deleteStrategy(id) {
  try {
    await api('DELETE', `/api/lab/strategies/${id}`);
    log('lab', 'Strategy file deleted', { id });
    toast('Strategy deleted');
    await engine.start();
    await engine.loadMine();
  } catch (e) { fail(e); }
}

/* ======================= events ======================= */

function showPop(btn) {
  const pop = $('#lab-pop');
  pop.textContent = btn.dataset.text;
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left - 120, innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = (r.bottom + 8) + 'px';
}

function inLab(el) { return el && (root.contains(el) || el.closest('#modal')); }

function useStrategy(key) {
  if (findStrat(key)) { S.form.strategy = key; store.set('form', S.form); }
  go('dashboard');
}

function onClick(ev) {
  const pop = $('#lab-pop');
  if (pop && !pop.hidden && !ev.target.closest('[data-lab="explain"]')) pop.hidden = true;
  const el = ev.target.closest('[data-lab]');
  if (!el || !inLab(el) || el.disabled) return;
  const id = el.dataset.id;
  switch (el.dataset.lab) {
    case 'tab': go(el.dataset.tab); break;
    case 'doc': app.closeModal(); go('guide', { doc: el.dataset.doc }); break;
    case 'try': useStrategy(el.dataset.strategy); break;
    case 'explain': showPop(el); break;
    case 'stop': engine.stop(); engine.start().catch(() => {}); break;
    case 'go-upload': go('data'); setTimeout(() => { const u = $('#lab-upload'); if (u) u.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50); break;
    /* results */
    case 'open-run': if (!ev.target.closest('.lab-acts')) { if (S.tab !== 'dashboard') go('dashboard'); openResult(id); } break;
    case 'csv-run': exportRun(id, el); break;
    case 'del-run': confirmThen(el, () => deleteRun(id)); break;
    /* get data */
    case 'dl-market': { const d = readDl(); d.market = el.dataset.v; store.set('dl', d); paintData(); break; }
    case 'coin': { const d = readDl(); d.symbol = el.dataset.v; store.set('dl', d); paintData(); break; }
    case 'dl-medusa': runDownload('medusa'); break;
    case 'dl-local': runDownload('local'); break;
    case 'stop-dl': if (S.downloading) S.downloading.ctl.abort(); break;
    case 'cancel-upload': S.up = null; paintUpload(); break;
    /* files */
    case 'use-ds': S.form.dataset = id; store.set('form', S.form); go('dashboard'); break;
    case 'chart-ds': chartTab().then((c) => { c.show(id); go('chart'); }).catch(fail); break;
    case 'chart-run': el.disabled = true; (id === S.resultId && S.result ? Promise.resolve(S.result) : fetchResult(id)).then((R) => openOnChart(R, id)).catch(fail).finally(() => { el.disabled = false; }); break;
    case 'get-ds': datasetToComputer(id, el.dataset.fmt, el); break;
    case 'del-ds': confirmThen(el, () => deleteDataset(id)); break;
    case 'del-folder': confirmThen(el, () => deleteFolder(el.dataset.folder), 'Tap again to delete them all'); break;
    /* strategies */
    case 'use-strategy': useStrategy(el.dataset.key); break;
    case 'new-strategy': fetch('/lab/template.py').then((r) => r.text()).then((code) => openEditor({ name: 'my_strategy.py', code })).catch(fail); break;
    case 'edit-strategy': { const m = S.mine.find((x) => x.id === id); if (m) openEditor({ id, name: m.name, code: m.code }); break; }
    case 'dl-strategy': { const m = S.mine.find((x) => x.id === id); if (m) download(m.name, m.code, 'text/x-python'); break; }
    case 'del-strategy': confirmThen(el, () => deleteStrategy(id)); break;
    case 'view-builtin': sourceOf('builtin', id).then((code) => openEditor({ name: `${id}.py`, code, readOnly: true, builtinId: id })).catch(fail); break;
    case 'copy-builtin': sourceOf('builtin', id).then((code) => openEditor({ name: `${id}_copy.py`, code })).catch(fail); break;
    case 'restore-draft': { const d = store.get('draft'); if (d) { $('#lab-ed-code').value = d.code; $('#lab-ed-code').dispatchEvent(new Event('input', { bubbles: true })); if ($('#lab-ed-name')) $('#lab-ed-name').value = d.name; el.closest('.banner').remove(); } break; }
    case 'ed-check': checkCode(editorValues().code); break;
    case 'ed-save': saveCode(el); break;
    case 'code-copy': navigator.clipboard.writeText(S.code ? S.code.code : '').then(() => toast('Code copied'), () => toast('Couldn’t copy: select the text and copy it instead', 'error')); break;
    case 'code-download': if (S.code) { download(S.code.name, S.code.code, 'text/x-python'); log('lab', `Python code downloaded: ${S.code.name}`); } break;
    case 'ed-download': { const v = editorValues(); download(/\.py$/.test(v.name) ? v.name : v.name + '.py', v.code, 'text/x-python'); break; }
    default: break;
  }
}

/** The form, the timeframe and the file a settings field belongs to (dashboard or upload form). */
function formCtx(el) {
  if (el.closest('#lab-form')) { const ds = findDs(S.form.dataset); return { pfx: 'd', f: S.form, row: ds, interval: ds && ds.interval }; }
  if (el.closest('#lab-upform') && S.up && S.up.ds) {
    const a = S.up.answers || {};
    return { pfx: 'u', f: { ...S.up.form, start: a.from }, row: { interval: a.interval, start_ts: S.up.ds.cols.t[0] }, interval: a.interval };
  }
  return null;
}
let warmTimer = null;
/** After a length / hour setting changed: its hint, and (soon) the warm-up line. */
function settingTouched(el) {
  const c = formCtx(el);
  if (!c) return;
  if (el.closest('#lab-form')) readDash(); else { readAnswers(); readUp(); }
  const box = el.closest('.lab-params');
  const st = box && findStrat(box.dataset.strategy);
  const key = el.dataset.param || el.dataset.unit;
  const p = st && st.params.find((x) => x.key === key);
  const hint = box && $(`[data-hint="${key}"]`, box);
  const f = el.closest('#lab-form') ? S.form : S.up.form;
  if (p && hint) hint.textContent = unitHint(p, (f.params[st.key] || {})[key], c.interval);
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => { const c2 = formCtx(el); if (c2 && c2.row && c2.interval) paintWarm(c2.pfx, c2.f, c2.row); }, 250);
}

function onChange(ev) {
  const t = ev.target;
  if (!inLab(t)) return;
  if (t.dataset.unit) {                                   // a length's unit changed: keep the same length, in the new unit
    const c = formCtx(t);
    const input = t.closest('.lab-unit') && $('input', t.closest('.lab-unit'));
    const iv = c && INTERVAL_MS[c.interval];
    const prev = t.dataset.prev || 'candles', next = t.value;
    const x = input ? parseFloat(input.value) : NaN;
    if (input && iv && isNum(x)) {
      const ms = prev === 'candles' ? x * iv : x * UNIT_MS[prev];
      const v = next === 'candles' ? Math.max(1, Math.round(ms / iv)) : +(ms / UNIT_MS[next]).toFixed(2);
      input.value = String(v);
      if (next === 'candles') { input.step = '1'; } else { input.step = 'any'; input.removeAttribute('max'); input.min = '0'; }
    }
    t.dataset.prev = next;
    settingTouched(t);
    if (t.closest('#lab-form')) paintForm(); else paintUpload();   // new suggestions for the unit
    return;
  }
  if (t.closest('#lab-form')) {
    readDash();
    if (['strategy', 'dataset', 'sizing'].includes(t.dataset.f)) paintForm();
    return;
  }
  if (t.closest('#lab-upform')) {
    readAnswers();
    readUp();
    if (['strategy', 'sizing'].includes(t.dataset.f) || ['market', 'interval'].includes(t.dataset.u)) paintUpload();
    if (t.dataset.u === 'from' || t.dataset.u === 'to') upCountRefresh();
    return;
  }
  if (t.closest('#lab-dl')) {
    readDl();
    if (t.dataset.d === 'period') paintData();
    else if (t.dataset.d === 'symbol') { paintData(); }
    else estimate();
    return;
  }
  if (t.id === 'lab-file') { readUpload(t.files); t.value = ''; return; }
  if (t.id === 'lab-pyfile') { uploadPy(t.files[0]); t.value = ''; }
}

function upCountRefresh() {
  const el = $('#lab-up-count');
  if (!el || !S.up || !S.up.ds) return;
  const n = upCount(S.up);
  el.textContent = upCountText(n);
  el.classList.toggle('lab-bad', n > MAX_CANDLES || n < 2);
}

function onInput(ev) {
  const t = ev.target;
  if (t.id === 'lab-ed-code' || t.id === 'lab-ed-name') store.set('draft', { id: S.editor ? S.editor.id : null, at: Date.now(), ...editorValues() });
  if (!t.closest) return;
  if (t.closest('#lab-form')) readDash();
  if (t.closest('#lab-upform')) { readAnswers(); readUp(); if (t.dataset.u === 'from' || t.dataset.u === 'to') upCountRefresh(); }
  if (t.closest('#lab-dl') && (t.dataset.d === 'from' || t.dataset.d === 'to')) { readDl(); estimate(); }
  if (t.dataset.param || t.dataset.f === 'start') settingTouched(t);
}

function onSubmit(ev) {
  const t = ev.target;
  if (t.id === 'lab-form') { ev.preventDefault(); runDashboard(); }
  if (t.id === 'lab-upform') { ev.preventDefault(); runUpload(); }
  if (t.id === 'lab-dl') ev.preventDefault();
}

function onKey(ev) {
  const t = ev.target;
  if ((t.id === 'lab-ed-code' || t.id === 'lab-py-code') && !t.readOnly) {
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      const s = t.selectionStart, e = t.selectionEnd, v = t.value;
      if (ev.shiftKey) {
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        const cut = v.slice(ls, ls + 4).match(/^ {0,4}/)[0].length;
        t.value = v.slice(0, ls) + v.slice(ls + cut);
        t.selectionStart = t.selectionEnd = Math.max(ls, s - cut);
      } else {
        t.value = v.slice(0, s) + '    ' + v.slice(e);
        t.selectionStart = t.selectionEnd = s + 4;
      }
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      // keep the indentation of the line above (and indent after a colon)
      const s = t.selectionStart, v = t.value;
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const line = v.slice(ls, s);
      const ind = line.match(/^ */)[0] + (/:\s*$/.test(line) ? '    ' : '');
      if (ind) {
        ev.preventDefault();
        t.value = v.slice(0, s) + '\n' + ind + v.slice(t.selectionEnd);
        t.selectionStart = t.selectionEnd = s + 1 + ind.length;
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's' && $('#lab-ed-code') && !$('#lab-ed-code').readOnly) {
    ev.preventDefault();
    const b = $('[data-lab="ed-save"]');
    if (b && !b.disabled) saveCode(b);
  }
  if (ev.key === 'Enter' && t.matches && t.matches('tr[data-lab="open-run"]')) { if (S.tab !== 'dashboard') go('dashboard'); openResult(t.dataset.id); }
}

/* drag and drop for uploads */
document.addEventListener('dragover', (ev) => { const d = ev.target.closest && ev.target.closest('#lab-drop'); if (d) { ev.preventDefault(); d.classList.add('over'); } });
document.addEventListener('dragleave', (ev) => { const d = ev.target.closest && ev.target.closest('#lab-drop'); if (d) d.classList.remove('over'); });
document.addEventListener('drop', (ev) => {
  const d = ev.target.closest && ev.target.closest('#lab-drop');
  if (!d) return;
  ev.preventDefault();
  d.classList.remove('over');
  readUpload(ev.dataTransfer.files);
});
