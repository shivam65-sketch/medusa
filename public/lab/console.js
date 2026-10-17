// MEDUSA Lab "Python" tab: write any Python and run it on your data files, with the backtest engine at hand.
// It runs in its own background thread (py-worker.js, like backtests), started with just the libraries the
// code imports (pandas, matplotlib, scipy, statsmodels are downloaded once, then kept by the browser) and
// with network access switched off before your code runs. What the code can call: see py/console.py.
// Loaded only when the tab is opened.

import { $, esc, icon, toast, download, plural, ymd } from './util.js';
import * as data from './data.js';
import { attachEditor } from './editor.js';

const ENGINE = ['engine.py', 'strategy.py', 'indicators.py', 'stats.py', 'backtest.py', 'labrun.py', 'console.py'];
const LIBS = { pandas: 'pandas', matplotlib: 'matplotlib', mpl_toolkits: 'matplotlib', pylab: 'matplotlib', scipy: 'scipy', statsmodels: 'statsmodels' };
const SIZE = { pandas: '5 MB', matplotlib: '10 MB', scipy: '14 MB', statsmodels: '8 MB (+ scipy, pandas)' };

const EXAMPLES = [
  ['Look at a data file', `# Attach a file on the right, then run (Ctrl+Enter).
data = load()                      # the attached file (with several attached: load("name"))
print(data)
c = data.c                         # closes as a numpy array; also data.o .h .l .v and data.t (ms since 1970, UTC)
ret = c[1:] / c[:-1] - 1
print(f"{len(ret):,} candles: average move {ret.mean() * 100:+.4f}%, typical size {ret.std() * 100:.3f}%")
print(f"Best {ret.max() * 100:+.2f}%, worst {ret.min() * 100:+.2f}%, up candles {(ret > 0).mean() * 100:.1f}%")

import matplotlib.pyplot as plt
plt.figure(figsize=(9, 3.5))
plt.plot(local_time(data.t), c, lw=1)    # local_time(): ms -> your time zone
plt.title(f"{data.symbol} {data.interval}")
plt.show()
`],
  ['Backtest a built-in strategy', `data = load()
r = backtest("turtle", data, risk_pct=1, fee_pct=0.05, slippage_pct=0.05)   # any built-in key, or your own class
r.report()
r.save()                           # also keep it in the Results folder (remove this line if not)

import matplotlib.pyplot as plt
plt.figure(figsize=(9, 3.5))
plt.plot(local_time(r.equity_t), r.equity, lw=1)
plt.title(r.title + " · account value")
plt.show()
`],
  ['Test your own idea', `# A strategy is a class with prepare() (indicators, once) and on_bar() (decisions at each close).
from indicators import ema, atr

class PullbackInTrend(Strategy):
    key = "pullback"
    label = "Pullback in a trend"
    params = [Param("trend", "Trend EMA", 100, 10, 500, 1)]

    def prepare(self, d):
        self.c = d.c
        self.trend = ema(d.c, self.p.trend)
        self.fast = ema(d.c, 10)
        self.atr = atr(d.h, d.l, d.c, 14)

    def on_bar(self, i, pos, orders):
        if i < self.p.trend or pos is not None:
            return
        # in an uptrend, buy when the close dips under the 10 EMA; stop 2 ATR, target 2x the risk
        if self.c[i] > self.trend[i] and self.c[i] < self.fast[i] and self.c[i - 1] >= self.fast[i - 1]:
            orders.buy(stop_dist=2 * self.atr[i], target_r=2, max_bars=48, tag="Dip in an uptrend")

r = backtest(PullbackInTrend, load(), trend=100)
r.report()
`],
  ['Compare settings (and the trap)', `# Trying many settings and keeping the best one is how backtests lie. Choose on the first part
# of the data only ("split"), then look at the held-back part once.
data = load()
rows = []
for entry in (10, 20, 40, 55):
    for exit_ in (5, 10, 20):
        r = backtest("turtle", data, entry_len=entry, exit_len=exit_, split="2024-07-01")
        b, a = r.report_json["split"]["before"], r.report_json["split"]["after"]
        rows.append((entry, exit_, b["return"], a["return"] if a else float("nan")))
rows.sort(key=lambda x: -x[2])
print("entry exit   first part   held back")
for e, x, b, a in rows:
    print(f"{e:5d} {x:4d}   {b * 100:+9.1f}%   {a * 100:+8.1f}%")
print("\\nThe best first-part row is the one you would have picked; its held-back number is the honest one.")
`],
  ['pandas: returns by weekday and hour', `import pandas as pd
df = load().df()                   # a DataFrame indexed by time (your time zone)
ret = df["close"].pct_change()
print("Average move by weekday (%):")
print((ret.groupby(df.index.dayofweek).mean() * 100).round(4).rename(index=dict(enumerate("Mon Tue Wed Thu Fri Sat Sun".split()))))
if df.index.to_series().diff().median() < pd.Timedelta("1D"):
    print("\\nAverage move by hour of your day (%):")
    print((ret.groupby(df.index.hour).mean() * 100).round(4).to_string())
`],
];

let ctx = null;
let host = null;
const st = { attached: new Set(), local: [], out: null, running: false, status: '' };
const kernel = { w: null, libs: new Set(), seq: 0, pending: new Map(), ready: null, up: false, warm: 0 };
let builtinFiles = null;
let editor = null;
let chartUrls = [];

const save = (k, v) => ctx.store.set('py.' + k, v);
const load = (k, d) => ctx.store.get('py.' + k, d);

/** The Python name of a MEDUSA data file (unique within the list). */
function pyNames() {
  const names = new Map(), used = new Map();
  const add = (key, base) => { const n = (used.get(base) || 0) + 1; used.set(base, n); names.set(key, n > 1 ? `${base}-${n}` : base); };
  for (const d of ctx.datasets()) add(d.id, `${d.symbol}-${d.market}-${d.interval}`);
  st.local.forEach((f, k) => add(`local:${k}`, f.base));
  return names;
}

export function paintConsole(el, context) {
  ctx = context;
  host = el;
  if (!host.dataset.ready) {
    host.dataset.ready = '1';
    st.attached = new Set(load('files', []));
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('input', (ev) => { if (ev.target.id === 'lab-py-code') { save('code', ev.target.value); warmUp(); } });
    host.addEventListener('keydown', (ev) => { if (ev.target.id === 'lab-py-code' && (ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); run(); } });
  }
  const code = $('#lab-py-code', host);
  const keep = code ? { v: code.value, s: code.selectionStart, e: code.selectionEnd } : null;
  host.innerHTML = `<div class="lab-py">
    <div class="card lab-py-main">
      <div class="card-head"><div><h2>Python</h2><p>Write any Python and run it on your data files. Your code runs in your browser with no network access.</p></div></div>
      <div class="row-btns lab-py-bar">
        <button class="btn btn-green" data-py="run" ${st.running ? 'disabled' : ''}>${icon('play')}Run <span class="faint small">Ctrl+Enter</span></button>
        <button class="btn" data-py="stop" ${st.running ? '' : 'disabled'}>${icon('stop')}Stop</button>
        <select class="input lab-py-ex" data-py="example" aria-label="Insert an example"><option value="">Examples…</option>${EXAMPLES.map(([t], k) => `<option value="${k}">${esc(t)}</option>`).join('')}</select>
        <span style="flex:1"></span>
        <label class="btn" title="Open a .py file">${icon('up')}Open<input type="file" id="lab-py-open" accept=".py,text/x-python,text/plain" hidden></label>
        <button class="btn" data-py="download" title="Download as a .py file">${icon('down')}Save as .py</button>
      </div>
      <textarea class="input lab-code lab-py-code" id="lab-py-code" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Python code">${esc(keep ? keep.v : load('code', EXAMPLES[0][1]))}</textarea>
      <div id="lab-py-out" class="lab-py-out" aria-live="polite"></div>
    </div>
    <aside class="card lab-py-side">
      <h3>Data files for Python</h3>
      <p class="dim small">Tick the files your code uses: the line that loads one goes at the top of your code (<code>data = load("name")</code>; just <code>load()</code> when one is ticked). <button class="link small" data-lab="doc" data-doc="python#load">All about load()</button></p>
      <div id="lab-py-files"></div>
      <label class="btn btn-sm" style="margin-top:8px">${icon('up')}Add from this computer<input type="file" id="lab-py-local" accept=".csv,.txt,.zip" multiple hidden></label>
      <h3 style="margin-top:18px">What your code can use</h3>
      <ul class="dim small lab-py-help">
        <li><code>load()</code>, <code>files()</code>: your data (<code>.c .o .h .l .v .t</code> numpy arrays, <code>.df()</code> for pandas; <code>help(data)</code> lists it all); <code>local_time(data.t)</code>: times in your time zone</li>
        <li>The editor colours your code, marks mistakes as you type, and suggests names (type <code>data.</code>, or press Ctrl+Space).</li>
        <li><code>backtest("turtle", data, risk_pct=1, ...)</code>: any built-in or your own strategy, on the Dashboard’s engine; <code>.report()</code>, <code>.trades</code>, <code>.equity</code>, <code>.df()</code>, <code>.save()</code></li>
        <li><code>Strategy</code>, <code>Param</code>, and <code>from indicators import ema, atr, rsi, supertrend, session_vwap …</code></li>
        <li>Libraries: numpy, pandas, matplotlib (charts show below), scipy, statsmodels and Python’s standard library. Each downloads once, the first time your code imports it (${Object.entries(SIZE).map(([k, v]) => `${k} ${v}`).join(', ')}).</li>
      </ul>
      <button class="link small" data-lab="doc" data-doc="python">Guide to the Python tab</button>
    </aside>
  </div>`;
  if (editor) editor.destroy();
  editor = attachEditor($('#lab-py-code', host), { context: editorContext, check: pythonCheck });
  if (keep) { const t = $('#lab-py-code', host); t.selectionStart = keep.s; t.selectionEnd = keep.e; }
  paintFiles();
  paintOut();
}

/** For the editor's checks: the names of the ticked files, and of all files. */
function editorContext() {
  const names = pyNames();
  return { attached: [...st.attached].map((id) => names.get(id)).filter(Boolean), available: [...names.values()] };
}

/** Python's own syntax check, when Python is up and not running your code. */
function pythonCheck(code) {
  if (!kernel.up || st.running) return null;
  return call('syntax', { code }).then((r) => JSON.parse(r.json));
}

/** Once you start typing, Python starts in the background (with the libraries the code imports): the
 *  editor's check becomes Python's own, and Run starts at once. */
function warmUp() {
  clearTimeout(kernel.warm);
  if (kernel.ready || st.running) return;
  kernel.warm = setTimeout(() => {
    if (kernel.ready || st.running) return;
    startKernel(librariesIn($('#lab-py-code', host).value)).then(() => editor && editor.refresh()).catch(() => {});
  }, 1500);
}

/** The lines a ticked file puts at the top of the code. */
function boilerplate(id, code) {
  const names = pyNames();
  const name = names.get(id);
  let about = '';
  if (id.startsWith('local:')) {
    const f = st.local[Number(id.slice(6))];
    if (f) about = `${f.meta.symbol || 'a file'} ${f.meta.market} ${f.ds.interval || '(timeframe unknown)'} · ${plural(f.ds.n, 'candle')} · from this computer`;
  } else {
    const d = ctx.datasets().find((x) => x.id === id);
    if (d) about = `${d.symbol} ${d.market} ${d.interval} · ${plural(d.candles, 'candle')} · ${ymd(d.start_ts)} → ${ymd(d.end_ts)}`;
  }
  const taken = new Set([...code.matchAll(/^\s*([A-Za-z_]\w*)\s*=/gm)].map((m) => m[1]));
  let v = 'data';
  if (taken.has(v)) {
    const base = name.replace(/-(futures|spot)-/, '_').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
    v = base;
    for (let k = 2; taken.has(v); k++) v = `${base}_${k}`;
  }
  return `# ── ${name}: ${about}\n${v} = load(${JSON.stringify(name)})    # .t .o .h .l .c .v numpy arrays, .df() pandas; help(${v}) lists everything\n`;
}
const BOILER_HEAD = /^# ── (\S+): .*\n[A-Za-z_]\w* = load\("([^"]*)"\).*(?:\n|$)/;

/** A ticked file: its load() line goes at the top of the code (after the ones already there), unless the code loads it already. */
function addBoilerplate(id) {
  const t = $('#lab-py-code', host);
  const name = pyNames().get(id);
  if (!t || !name) return;
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = t.value.search(new RegExp(`load\\(\\s*["']${quoted}["']\\s*\\)`));
  if (at >= 0) { t.focus(); t.setSelectionRange(at, at); return; }
  let pos = 0, m;
  while ((m = BOILER_HEAD.exec(t.value.slice(pos)))) pos += m[0].length;
  const text = boilerplate(id, t.value) + (pos === 0 && t.value.trim() ? '\n' : '');
  t.setRangeText(text, pos, pos, 'end');
  t.scrollTop = 0;
  t.dispatchEvent(new Event('input', { bubbles: true }));
}

/** An unticked file: its load() lines go, if they're still as they were put there. */
function removeBoilerplate(id) {
  const t = $('#lab-py-code', host);
  const name = pyNames().get(id);
  if (!t || !name) return;
  let pos = 0, m;
  while ((m = BOILER_HEAD.exec(t.value.slice(pos)))) {
    if (m[1] === name && m[2] === name) {
      let end = pos + m[0].length;
      if (!BOILER_HEAD.test(t.value.slice(end)) && t.value[end] === '\n' && pos === 0) end++;   // the blank line under the last one
      t.setRangeText('', pos, end, 'start');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    pos += m[0].length;
  }
}

export function paintFiles() {
  const box = host && $('#lab-py-files', host);
  if (!box) return;
  const names = pyNames();
  const rows = ctx.datasets();
  for (const id of [...st.attached]) if (!rows.some((d) => d.id === id) && !id.startsWith('local:')) st.attached.delete(id);
  box.innerHTML = rows.length || st.local.length
    ? `<div class="lab-py-files">${rows.map((d) => fileRow(d.id, names.get(d.id), `${d.folder === 'uploads' ? 'Uploads' : 'Downloads'} · ${ymd(d.start_ts)} → ${ymd(d.end_ts)} · ${plural(d.candles, 'candle')}`)).join('')}
       ${st.local.map((f, k) => fileRow(`local:${k}`, names.get(`local:${k}`), `this computer · ${plural(f.ds.n, 'candle')} (not stored)`)).join('')}</div>`
    : `<p class="dim small">No data files yet. <button class="link small" data-lab="tab" data-tab="data">Download one</button> or add one from this computer.</p>`;
  if (editor) editor.refresh();
}

const fileRow = (id, name, note) => `<label class="lab-py-file"><input type="checkbox" data-py-file="${esc(id)}" ${st.attached.has(id) ? 'checked' : ''}>
  <span><code>${esc(name)}</code><br><span class="faint small">${esc(note)}</span></span>
  <button class="btn btn-sm" type="button" data-py="insert" data-id="${esc(id)}" title="Tick it and put data = load(&quot;${esc(name)}&quot;) at the top of the code">Insert</button></label>`;

/** A PNG's size from its header (the image is drawn at twice the size it's shown at). */
function pngSize(b64) {
  const b = atob(b64.slice(0, 32));
  const u = (k) => ((b.charCodeAt(k) << 24) | (b.charCodeAt(k + 1) << 16) | (b.charCodeAt(k + 2) << 8) | b.charCodeAt(k + 3)) >>> 0;
  return { w: u(16), h: u(20) };
}

/** A chart, full size, in a new browser tab. */
function openChart(k) {
  const b64 = st.out && (st.out.images || [])[k];
  if (!b64) return;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chart ${k + 1} · MEDUSA Python</title>
    <style>html,body{margin:0;background:#1a1a1a;min-height:100%}body{display:grid;place-items:center;padding:16px;box-sizing:border-box}img{max-width:100%;height:auto;background:#fff;border-radius:8px}</style></head>
    <body><img alt="Chart ${k + 1} from your Python code" src="data:image/png;base64,${b64}"></body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  chartUrls.push(url);
  const w = window.open(url, '_blank');
  if (!w) toast('The browser blocked the new tab. Allow pop-ups for MEDUSA, or right-click the chart to open it.', 'error');
}

function paintOut() {
  const box = host && $('#lab-py-out', host);
  if (!box) return;
  const o = st.out;
  if (st.running) { box.innerHTML = `<p class="dim small"><span class="spin"></span> ${esc(st.status)}</p>`; return; }
  if (!o) { box.innerHTML = '<p class="faint small">Output, errors and charts appear here.</p>'; return; }
  box.innerHTML = `<p class="faint small">${o.error ? 'Stopped with an error' : 'Done'} in ${o.seconds}s${o.libs.length ? ` · loaded ${esc(o.libs.join(', '))}` : ''}</p>
    ${o.out ? `<pre class="lab-py-text">${esc(o.out)}</pre>` : ''}
    ${o.error ? `<pre class="lab-py-text err">${esc(o.error)}</pre>` : ''}
    ${(o.images || []).map((b, k) => { const { w } = pngSize(b); return `<figure class="lab-py-fig"><img class="lab-py-img" alt="Chart ${k + 1} from your code" width="${Math.round(w / 2)}" src="data:image/png;base64,${b}">
      <figcaption class="row-btns"><button class="btn btn-sm" data-py="chart-open" data-k="${k}" title="Open this chart full size in a new browser tab">${icon('expand')}Open in new tab</button><button class="btn btn-sm" data-py="chart-save" data-k="${k}">${icon('down')}Save PNG</button></figcaption></figure>`; }).join('')}
    ${(o.saved || []).map((s) => `<p class="small">Saved in the Results folder: <b>${esc(s.title)}</b> <button class="link small" data-lab="open-run" data-id="${esc(s.id)}">Open it</button></p>`).join('')}
    ${!o.out && !o.error && !(o.images || []).length ? '<p class="faint small">(no output: use print() to show values)</p>' : ''}`;
}

/* ---------- the Python thread ---------- */

function call(type, payload = {}) {
  const id = ++kernel.seq;
  return new Promise((resolve, reject) => {
    kernel.pending.set(id, { resolve, reject });
    kernel.w.postMessage({ type, id, ...payload });
  });
}

function stopKernel() {
  if (kernel.w) kernel.w.terminate();
  for (const p of kernel.pending.values()) p.reject(Object.assign(new Error('Stopped.'), { stopped: true }));
  kernel.pending.clear();
  Object.assign(kernel, { w: null, libs: new Set(), ready: null, up: false });
}

/** A thread with numpy and these libraries; restarted when the code needs one it doesn't have. */
async function startKernel(libs) {
  if (kernel.ready && [...libs].every((l) => kernel.libs.has(l))) return kernel.ready;
  const all = new Set([...kernel.libs, ...libs]);
  stopKernel();
  kernel.libs = all;
  kernel.w = new Worker('/lab/py-worker.js', { type: 'module' });
  kernel.w.onmessage = (e) => {
    const m = e.data || {};
    const p = kernel.pending.get(m.id);
    if (!p || m.type === 'progress') return;
    kernel.pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
  };
  kernel.w.onerror = (e) => { e.preventDefault(); for (const p of kernel.pending.values()) p.reject(new Error('Python couldn’t start in this browser.')); kernel.pending.clear(); };
  // A start can be overtaken by a newer one (the background start, then Run needing more libraries):
  // the older one then stops quietly instead of talking to, or stopping, the newer thread.
  const stale = () => { if (kernel.ready !== ready) throw Object.assign(new Error('Stopped.'), { stopped: true }); };
  const ready = (async () => {
    const engine = Object.fromEntries(await Promise.all(ENGINE.map(async (n) => [n, await (await fetch(`/lab/py/${n}`)).text()])));
    stale();
    await call('init', { engine, packages: [...all] });
    if (!builtinFiles) {
      const list = await (await fetch('/lab/strategies/index.json')).json();
      builtinFiles = await Promise.all(list.map(async (f) => ({ origin: 'builtin', id: f.replace(/\.py$/, ''), name: f, source: await (await fetch(`/lab/strategies/${f}`)).text() })));
    }
    stale();
    await call('strategies', { files: [...builtinFiles, ...ctx.mineFiles()], origins: ['builtin', 'mine'] });
    stale();
    kernel.up = true;
  })();
  kernel.ready = ready;
  ready.catch(() => { if (kernel.ready === ready) stopKernel(); });
  return ready;
}

/** The libraries a piece of code imports (only the ones MEDUSA has). */
function librariesIn(code) {
  const out = new Set();
  for (const m of code.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*)/gm)) if (LIBS[m[1]]) out.add(LIBS[m[1]]);
  for (const m of code.matchAll(/^\s*import\s+([^\n#]+)/gm)) for (const part of m[1].split(',')) { const k = part.trim().split(/[.\s]/)[0]; if (LIBS[k]) out.add(LIBS[k]); }
  if (/\.df\(\)/.test(code)) out.add('pandas');
  return out;
}

async function run() {
  if (st.running) return;
  const code = $('#lab-py-code', host).value;
  save('code', code);
  const libs = librariesIn(code);
  clearTimeout(kernel.warm);
  for (const u of chartUrls.splice(0)) URL.revokeObjectURL(u);
  st.running = true;
  const t0 = performance.now();
  const say = (s) => { st.status = s; paintOut(); };
  paintConsole(host, ctx);
  try {
    const fresh = !(kernel.ready && [...libs].every((l) => kernel.libs.has(l)));
    say(fresh ? `Starting Python${libs.size ? ` with ${[...libs].join(', ')} (the first time downloads them)` : ''}…` : 'Running…');
    await startKernel(libs);
    const names = pyNames();
    const files = [];
    for (const id of st.attached) {
      say(`Loading ${names.get(id) || 'a file'}…`);
      if (id.startsWith('local:')) {
        const f = st.local[Number(id.slice(6))];
        if (f) files.push({ name: names.get(id), meta: f.meta, cols: colsOf(f.ds) });
        continue;
      }
      const row = ctx.datasets().find((d) => d.id === id);
      if (!row) continue;
      const d = await data.loadDataset(id);
      files.push({ name: names.get(id), meta: { symbol: row.symbol, market: row.market, interval: row.interval }, cols: colsOf(d) });
    }
    say('Running…');
    const r = await call('exec', { code, files, tz: -new Date().getTimezoneOffset() });
    const o = JSON.parse(r.json);
    o.libs = [...libs];
    o.seconds = ((performance.now() - t0) / 1000).toFixed(1);
    o.saved = [];
    for (const rep of o.results || []) {
      try { o.saved.push(await ctx.saveResult(rep)); } catch (e) { toast(`A result wasn’t saved: ${e.message}`, 'error'); }
    }
    st.out = o;
    ctx.log('python', `Python run ${o.error ? 'stopped with an error' : 'done'} in ${o.seconds}s${o.libs.length ? ` (${o.libs.join(', ')})` : ''}${o.saved.length ? `, ${o.saved.length} result(s) saved` : ''}`,
      { files: files.map((x) => x.name), error: o.error ? o.error.slice(0, 400) : undefined, lines: code.split(String.fromCharCode(10)).length }, o.error ? 'error' : 'info');
  } catch (e) {
    ctx.log('python', e.stopped ? 'Python run stopped' : `Python run failed: ${e.message}`, null, e.stopped ? 'info' : 'error');
    st.out = e.stopped ? { out: '', error: 'Stopped.', seconds: ((performance.now() - t0) / 1000).toFixed(1), libs: [] }
      : { out: '', error: e.message, seconds: ((performance.now() - t0) / 1000).toFixed(1), libs: [] };
  } finally {
    st.running = false;
    paintConsole(host, ctx);
  }
}

function colsOf(d) {
  const f = d.funding;
  return { ...d.cols, ...(f ? { ft: f.ft || (f.cols && f.cols.ft), fr: f.fr || (f.cols && f.cols.fr) } : {}) };
}

/* ---------- clicks and files ---------- */

function onClick(ev) {
  const el = ev.target.closest('[data-py]');
  if (!el) return;
  const what = el.dataset.py;
  if (what === 'run') run();
  if (what === 'stop') { stopKernel(); }
  if (what === 'download') download('medusa_python.py', $('#lab-py-code', host).value, 'text/x-python');
  if (what === 'insert') {
    ev.preventDefault();
    const id = el.dataset.id;
    if (!st.attached.has(id)) { st.attached.add(id); saveFiles(); paintFiles(); }
    addBoilerplate(id);
  }
  if (what === 'chart-open') openChart(Number(el.dataset.k));
  if (what === 'chart-save') {
    const b64 = st.out && (st.out.images || [])[Number(el.dataset.k)];
    if (b64) download(`medusa_chart_${Number(el.dataset.k) + 1}.png`, new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: 'image/png' }));
  }
}

const saveFiles = () => save('files', [...st.attached].filter((x) => !x.startsWith('local:')));

/** Code put in the editor from elsewhere (an example, a file): coloured and checked like typed code. */
function setCode(text) {
  const t = $('#lab-py-code', host);
  t.value = text;
  t.scrollTop = 0;
  t.dispatchEvent(new Event('input', { bubbles: true }));
}

async function onChange(ev) {
  const t = ev.target;
  if (t.dataset.pyFile) {
    const id = t.dataset.pyFile;
    if (t.checked) st.attached.add(id); else st.attached.delete(id);
    saveFiles();
    if (t.checked) addBoilerplate(id); else removeBoilerplate(id);
    if (editor) editor.refresh();
  }
  if (t.dataset.py === 'example' && t.value !== '') {
    const code = $('#lab-py-code', host);
    if (code.value.trim() && !confirm('Replace the code in the editor with this example?')) { t.value = ''; return; }
    setCode(EXAMPLES[Number(t.value)][1]);
    t.value = '';
  }
  if (t.id === 'lab-py-open' && t.files[0]) {
    setCode(await t.files[0].text());
    t.value = '';
  }
  if (t.id === 'lab-py-local' && t.files.length) {
    try {
      const ds = await data.fromFiles([...t.files]);
      const g = ds.guess || {};
      const base = (`${g.symbol || 'FILE'}-${g.market || 'futures'}-${ds.interval || 'custom'}`).replace(/[^A-Za-z0-9_-]/g, '');
      st.local.push({ ds, base, meta: { symbol: g.symbol || '', market: g.market || 'futures', interval: ds.interval || '1h' } });
      st.attached.add(`local:${st.local.length - 1}`);
      addBoilerplate(`local:${st.local.length - 1}`);
      if (!ds.interval) toast('Couldn’t tell the timeframe from the gaps between candles; it is treated as 1h in backtests.');
      paintFiles();
    } catch (e) {
      toast(e.message, 'error');
    }
    t.value = '';
  }
}
