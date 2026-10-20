// MEDUSA Lab "Python" tab: write any Python and run it on your data files, with the backtest engine at hand.
// It runs in its own background thread (py-worker.js, like backtests), started with just the libraries the
// code imports (pandas, matplotlib, scipy, statsmodels are downloaded once, then kept by the browser) and
// with network access switched off before your code runs. What the code can call: see py/console.py.
// Full screen (its button, or Ctrl+Shift+F) gives the code and the output the whole screen, side by side or one
// above the other, with a bar between them to drag. Charts show the values under the mouse; dragging across one
// zooms in (Python draws it again at the new limits), a double-click zooms back out.
// Loaded only when the tab is opened.

import { $, esc, icon, toast, download, plural, ymd } from './util.js';
import * as data from './data.js';
import { attachEditor } from './editor.js';

const ENGINE = ['engine.py', 'strategy.py', 'indicators.py', 'stats.py', 'backtest.py', 'labrun.py', 'console.py'];
const LIBS = { pandas: 'pandas', matplotlib: 'matplotlib', mpl_toolkits: 'matplotlib', pylab: 'matplotlib', scipy: 'scipy', statsmodels: 'statsmodels' };
const SIZE = { pandas: '5 MB', matplotlib: '10 MB', scipy: '14 MB', statsmodels: '8 MB (+ scipy, pandas)' };
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
const KEYS = [
  [`${MOD}+Enter`, 'Run the code'],
  [`${MOD}+/`, 'Comment the selected lines out, or back in'],
  ['Tab, Shift+Tab', 'Indent or outdent the selected lines (Esc, then Tab: on to the next field)'],
  ['Ctrl+Space', 'Suggest names'],
  [`${MOD}+Shift+F`, 'Full screen on or off (Esc leaves it)'],
  ['Charts', 'Hover for values, drag across to zoom in, double-click to zoom out'],
];
const HINT = 'Hover for values · drag to zoom in · double-click to zoom out';
const SPLIT = 0.55;     // the code's share of the full screen, until you drag the bar between it and the output

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
const st = { attached: new Set(), local: [], out: null, running: false, status: '', full: false, split: SPLIT, below: null };
const kernel = { w: null, libs: new Set(), seq: 0, pending: new Map(), ready: null, up: false, warm: 0, gen: 0 };
let builtinFiles = null;
let editor = null;
let chartUrls = [];
let listening = false;

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
    st.split = clampSplit(Number(load('split', SPLIT)));
    st.below = load('below', null);
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('input', (ev) => { if (ev.target.id === 'lab-py-code') { save('code', ev.target.value); warmUp(); } });
    host.addEventListener('keydown', (ev) => { if (ev.target.id === 'lab-py-code' && (ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); run(); } });
    host.addEventListener('keydown', onHandleKey);
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerUp);
    host.addEventListener('pointerout', onPointerOut);
    host.addEventListener('dblclick', onDblClick);
    host.addEventListener('toggle', onToggle, true);
  }
  if (!listening) {
    listening = true;
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', closeKeysOutside, true);
    for (const evName of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(evName, () => { if (!fsElement()) setFull(false); });
  }
  const code = $('#lab-py-code', host);
  const keep = code ? { v: code.value, s: code.selectionStart, e: code.selectionEnd, top: code.scrollTop, left: code.scrollLeft, focus: document.activeElement === code } : null;
  const below = isBelow();
  host.innerHTML = `<div class="lab-py${st.full ? ' full' : ''}">
    <div class="card lab-py-main">
      <div class="card-head"><div><h2>Python</h2><p>Write any Python and run it on your data files. Your code runs in your browser with no network access.</p></div></div>
      <div class="row-btns lab-py-bar">
        <button class="btn btn-green" data-py="run" ${st.running ? 'disabled' : ''}>${icon('play')}Run <span class="faint small">${MOD}+Enter</span></button>
        <button class="btn" data-py="stop" ${st.running ? '' : 'disabled'}>${icon('stop')}Stop</button>
        <select class="input lab-py-ex" data-py="example" aria-label="Insert an example"><option value="">Examples…</option>${EXAMPLES.map(([t], k) => `<option value="${k}">${esc(t)}</option>`).join('')}</select>
        <span style="flex:1"></span>
        <label class="btn" title="Open a .py file">${icon('up')}<span class="lab-py-btxt">Open</span><input type="file" id="lab-py-open" accept=".py,text/x-python,text/plain" hidden></label>
        <button class="btn" data-py="download" title="Download as a .py file">${icon('down')}<span class="lab-py-btxt">Save as .py</span></button>
        <details class="lab-py-keys"><summary class="btn btn-icon" title="Keyboard shortcuts">${icon('keys')}<span class="sr-only">Keyboard shortcuts</span></summary>
          <div class="lab-py-keys-pop">${KEYS.map(([k, what]) => `<kbd>${esc(k)}</kbd><span>${esc(what)}</span>`).join('')}</div></details>
        <button class="btn" data-py="layout" title="Where the output goes in full screen">${layoutLabel(below)}</button>
        <button class="btn" data-py="full" aria-pressed="${st.full}" title="${fullTitle()}">${fullLabel()}</button>
      </div>
      <div class="lab-py-split${below ? ' below' : ''}" style="${splitStyle()}">
        <div class="lab-py-edit"><textarea class="input lab-code lab-py-code" id="lab-py-code" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Python code">${esc(keep ? keep.v : load('code', EXAMPLES[0][1]))}</textarea></div>
        <div class="lab-py-handle" role="separator" tabindex="0" aria-orientation="${below ? 'horizontal' : 'vertical'}" aria-valuemin="15" aria-valuemax="85" aria-valuenow="${Math.round(st.split * 100)}"
          aria-controls="lab-py-out" aria-label="Size of the code and the output" title="Drag to resize · double-click: back to the middle"></div>
        <div id="lab-py-out" class="lab-py-out" aria-live="polite"></div>
      </div>
    </div>
    <aside class="card lab-py-side">
      <h3>Data files for Python</h3>
      <p class="dim small">Tick the files your code uses: the line that loads one goes at the top of your code (<code>data = load("name")</code>; just <code>load()</code> when one is ticked). <button class="link small" data-lab="doc" data-doc="python#load">All about load()</button></p>
      <div id="lab-py-files"></div>
      <label class="btn btn-sm" style="margin-top:8px">${icon('up')}Add from this computer<input type="file" id="lab-py-local" accept=".csv,.txt,.zip" multiple hidden></label>
      <h3 style="margin-top:18px">What your code can use</h3>
      <ul class="dim small lab-py-help">
        <li><code>load()</code>, <code>files()</code>: your data (<code>.c .o .h .l .v .t</code> numpy arrays, <code>.df()</code> for pandas; <code>help(data)</code> lists it all); <code>local_time(data.t)</code>: times in your time zone</li>
        <li>The editor colours your code, marks mistakes as you type, and suggests names (type <code>data.</code>, or press Ctrl+Space). ${MOD}+/ comments lines out or back in; Tab and Shift+Tab indent them.</li>
        <li><code>backtest("turtle", data, risk_pct=1, ...)</code>: any built-in or your own strategy, on the Dashboard’s engine; <code>.report()</code>, <code>.trades</code>, <code>.equity</code>, <code>.df()</code>, <code>.save()</code></li>
        <li><code>Strategy</code>, <code>Param</code>, and <code>from indicators import ema, atr, rsi, supertrend, session_vwap …</code></li>
        <li>Libraries: numpy, pandas, matplotlib (charts show below: hover for values, drag to zoom), scipy, statsmodels and Python’s standard library. Each downloads once, the first time your code imports it (${Object.entries(SIZE).map(([k, v]) => `${k} ${v}`).join(', ')}).</li>
      </ul>
      <button class="link small" data-lab="doc" data-doc="python">Guide to the Python tab</button>
    </aside>
  </div>`;
  if (editor) editor.destroy();
  editor = attachEditor($('#lab-py-code', host), { context: editorContext, check: pythonCheck });
  if (keep) {
    const t = $('#lab-py-code', host);
    t.selectionStart = keep.s;
    t.selectionEnd = keep.e;
    t.scrollTop = keep.top;
    t.scrollLeft = keep.left;
    if (keep.focus) t.focus({ preventScroll: true });
  }
  paintFiles();
  paintOut();
}

/** Run and Stop follow the run; nothing else is redrawn, so the editor keeps your place, focus and undo. */
function paintRunning() {
  if (!host) return;
  const go = $('[data-py="run"]', host), stop = $('[data-py="stop"]', host);
  if (go) go.disabled = st.running;
  if (stop) stop.disabled = !st.running;
}

/* ---------- full screen, and the bar between the code and the output ---------- */

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fullLabel = () => (st.full ? `${icon('shrink')}<span class="lab-py-btxt">Exit full screen</span>` : `${icon('expand')}<span class="lab-py-btxt">Full screen</span>`);
const fullTitle = () => (st.full ? 'Leave full screen (Esc)' : `Full screen (${MOD}+Shift+F)`);
const layoutLabel = (below) => (below ? `${icon('cols')}<span class="lab-py-btxt">Output on the right</span>` : `${icon('rows')}<span class="lab-py-btxt">Output below</span>`);
const isBelow = () => (st.below == null ? matchMedia('(max-width: 900px)').matches : Boolean(st.below));
const clampSplit = (f) => (Number.isFinite(f) ? Math.min(0.85, Math.max(0.15, f)) : SPLIT);
const splitStyle = () => { const a = Math.round(st.split * 1000); return `--py-a: ${a}fr; --py-b: ${1000 - a}fr`; };

/** Full screen: the browser's own where it has one (like the Chart tab's), else the tab fills the window.
 *  It is asked for on the tab's own element, which stays when the tab is drawn again. Esc or the button leaves it. */
function setFull(on) {
  if (!host || on === st.full) return;
  st.full = on;
  const box = $('.lab-py', host), b = $('[data-py="full"]', host);
  if (box) box.classList.toggle('full', on);
  if (b) { b.innerHTML = fullLabel(); b.title = fullTitle(); b.setAttribute('aria-pressed', String(on)); }
  document.documentElement.classList.toggle('lab-py-locked', on);     // the page under it doesn't scroll
  if (on) {
    const req = host.requestFullscreen || host.webkitRequestFullscreen;
    if (req) { try { Promise.resolve(req.call(host, { navigationUI: 'hide' })).catch(() => {}); } catch { /* the window-filling view stays */ } }
    const t = $('#lab-py-code', host);
    if (t && !host.contains(document.activeElement)) t.focus({ preventScroll: true });
  } else if (fsElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(document)).catch(() => {});
  }
}

/** Output on the right of the code, or below it (full screen; on a narrow screen it starts below). */
function setBelow(on) {
  st.below = on;
  save('below', on);
  const box = $('.lab-py-split', host), h = $('.lab-py-handle', host), b = $('[data-py="layout"]', host);
  if (box) box.classList.toggle('below', on);
  if (h) h.setAttribute('aria-orientation', on ? 'horizontal' : 'vertical');
  if (b) b.innerHTML = layoutLabel(on);
}

/** The code's share of the space (15% to 85%); kept for next time unless keep is false (while dragging). */
function setSplit(f, keep = true) {
  st.split = clampSplit(f);
  const box = host && $('.lab-py-split', host), h = host && $('.lab-py-handle', host);
  if (box) box.setAttribute('style', splitStyle());
  if (h) h.setAttribute('aria-valuenow', String(Math.round(st.split * 100)));
  if (keep) save('split', st.split);
}

function startResize(h, ev) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const box = h.parentElement, below = box.classList.contains('below');
  h.setPointerCapture(ev.pointerId);
  h.classList.add('drag');
  const move = (e) => { const r = box.getBoundingClientRect(); setSplit(below ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width, false); };
  const up = () => {
    h.classList.remove('drag');
    h.removeEventListener('pointermove', move);
    h.removeEventListener('pointerup', up);
    h.removeEventListener('pointercancel', up);
    save('split', st.split);
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', up);
  h.addEventListener('pointercancel', up);
}

/** The bar from the keyboard: arrows move it, Home and End to the ends, Enter back to the middle. */
function onHandleKey(ev) {
  if (!ev.target.classList || !ev.target.classList.contains('lab-py-handle')) return;
  const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[ev.key];
  if (step) setSplit(st.split + step);
  else if (ev.key === 'Home' || ev.key === 'End') setSplit(ev.key === 'Home' ? 0 : 1);
  else if (ev.key === 'Enter') setSplit(SPLIT);
  else return;
  ev.preventDefault();
}

function onKey(ev) {
  if (!host || !host.isConnected || !host.getClientRects().length) return;     // the tab isn't on screen
  if (ev.key === 'Escape') {
    const open = $('details.lab-py-keys[open]', host);
    if (open) { open.open = false; return; }
    if (st.full && !ev.defaultPrevented && !fsElement()) setFull(false);      // the browser's full screen: it has Esc
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'f') { ev.preventDefault(); setFull(!st.full); }
}

/** The shortcuts list opens under its button, moved left when it would run off the window (as the Chart tab's menus). */
function onToggle(ev) {
  const d = ev.target;
  if (!d.matches || !d.matches('details.lab-py-keys') || !d.open) return;
  const pop = $('.lab-py-keys-pop', d);
  pop.style.left = '0px';
  const over = pop.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
  if (over > 0) pop.style.left = `${-Math.min(over, d.getBoundingClientRect().left - 8)}px`;
}
function closeKeysOutside(ev) {
  const d = host && $('details.lab-py-keys[open]', host);
  if (d && !d.contains(ev.target)) d.open = false;
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
    ${(o.images || []).map((b, k) => chartFigure(o, b, k)).join('')}
    ${(o.saved || []).map((s) => `<p class="small">Saved in the Results folder: <b>${esc(s.title)}</b> <button class="link small" data-lab="open-run" data-id="${esc(s.id)}">Open it</button></p>`).join('')}
    ${!o.out && !o.error && !(o.images || []).length ? '<p class="faint small">(no output: use print() to show values)</p>' : ''}`;
}

/** A chart: the picture matplotlib drew, live (values under the mouse, zoom) when Python sent the map of its axes. */
function chartFigure(o, b64, k) {
  const { w } = pngSize(b64);
  const live = Boolean(o.charts && o.charts[k] && o.charts[k].axes.some(Boolean));
  const zoomed = Boolean(o.zoomed && o.zoomed[k]);
  return `<figure class="lab-py-fig">
    <div class="lab-py-chart${live ? ' live' : ''}" data-k="${k}"><img class="lab-py-img" alt="Chart ${k + 1} from your code" width="${Math.round(w / 2)}" src="data:image/png;base64,${b64}" draggable="false"></div>
    <figcaption class="row-btns"><button class="btn btn-sm" data-py="chart-home" data-k="${k}" ${zoomed ? '' : 'hidden'}>${icon('zoomout')}Reset zoom</button><button class="btn btn-sm" data-py="chart-open" data-k="${k}" title="Open this chart full size in a new browser tab">${icon('expand')}Open in new tab</button><button class="btn btn-sm" data-py="chart-save" data-k="${k}">${icon('down')}Save PNG</button>${live ? `<span class="faint small lab-py-note">${HINT}</span>` : ''}</figcaption></figure>`;
}

/* ---------- charts: the values under the mouse, and zooming (Python draws each view: zoom() in py/console.py) ---------- */

const drag = { el: null };     // a zoom being dragged: {el, k, id, x0, y0, box, s, rect, mode}
let hoverAt = null;            // the latest pointer position over a chart, drawn at the next frame

/** A float64 array sent as base64 by py/console.py. */
function f64(b64) {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Float64Array(u.buffer);
}

/** A series' points, decoded the first time they're needed; up: x only rises (a line over time), so the nearest x
 *  is a binary search. Bars also have pv (their values) and pw (their widths across). */
function points(ser) {
  if (!ser.px) {
    ser.px = f64(ser.x);
    ser.py = f64(ser.y);
    if (ser.v) { ser.pv = f64(ser.v); ser.pw = f64(ser.w); }
    let up = ser.kind === 'line';
    for (let i = 1; up && i < ser.px.length; i++) if (!(ser.px[i] >= ser.px[i - 1])) up = false;
    ser.up = up;
  }
  return ser;
}

/** The bar under the mouse (bar charts, barh, histograms): a dot at its end, its value, and where it stands
 *  (a category's name, or a histogram bin's range). With stacked bars, the piece under the mouse. */
function barAt(a, ser, px, py) {
  const p = points(ser), h = ser.kind === 'hbars', [bx0, by1, bx1, by0] = a.box;
  const along = h ? valueAt(a.y, py, by0, by1) : valueAt(a.x, px, bx0, bx1);
  const across = h ? valueAt(a.x, px, bx0, bx1) : valueAt(a.y, py, by0, by1);
  const pos = h ? p.py : p.px, end = h ? p.px : p.py;
  let best = -1, inside = false;
  for (let i = 0; i < pos.length; i++) {
    if (!(Math.abs(along - pos[i]) <= p.pw[i] / 2)) continue;
    const base = end[i] - p.pv[i], under = across >= Math.min(base, end[i]) && across <= Math.max(base, end[i]);
    if (best < 0 || (under && !inside)) { best = i; inside = under; }
  }
  if (best < 0 || !Number.isFinite(p.pv[best])) return null;
  const at = h ? a.y : a.x, half = p.pw[best] / 2;
  const where = ser.bins ? `${shown(at, pos[best] - half, false)} to ${shown(at, pos[best] + half, false)}` : shown(at, pos[best], true);
  return { a, ser, x: p.px[best], y: p.py[best], cx: pixelOf(a.x, p.px[best], bx0, bx1), cy: pixelOf(a.y, p.py[best], by0, by1), dx: 0,
    head: where, val: shown(h ? a.x : a.y, p.pv[best], true) };
}

/* An axis (py/console.py _axis): {lim, scale} and how its values read. Its limits lie at picture pixels p0 and p1. */
const readable = (a) => a.scale === 'linear' || a.scale === 'log';
const lin = (a, v) => (a.scale === 'log' ? Math.log10(v) : v);
function valueAt(a, p, p0, p1) {
  const l0 = lin(a, a.lim[0]), l1 = lin(a, a.lim[1]), u = l0 + ((p - p0) / (p1 - p0)) * (l1 - l0);
  return a.scale === 'log' ? 10 ** u : u;
}
function pixelOf(a, v, p0, p1) {
  const l0 = lin(a, a.lim[0]), l1 = lin(a, a.lim[1]);
  return p0 + ((lin(a, v) - l0) / (l1 - l0)) * (p1 - p0);
}

const two = (n) => String(n).padStart(2, '0');
/** A value as its axis means it: a date (and time), a category's name, or a number. exact: a plotted value, shown in
 *  full; else a position under the mouse, to about a pixel's worth of digits. */
function shown(a, v, exact) {
  if (!Number.isFinite(v)) return '–';
  if (a.names) return a.names[Math.round(v)] ?? '';
  if (a.ms) {
    const d = new Date(v * a.ms[0] + a.ms[1]);
    if (!Number.isFinite(d.getTime())) return '–';
    const day = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
    const clock = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds();
    if (exact ? !clock : Math.abs(a.lim[1] - a.lim[0]) * a.ms[0] > 20 * 86_400_000) return day;
    return `${day} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${exact && d.getUTCSeconds() ? `:${two(d.getUTCSeconds())}` : ''}`;
  }
  if (exact) return Number(v.toPrecision(8)).toLocaleString('en-US', { maximumFractionDigits: 8 });
  if (a.scale === 'log') return Number(v.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 12 });
  const dp = Math.min(10, Math.max(0, Math.ceil(-Math.log10(Math.abs(a.lim[1] - a.lim[0]) / 500))));
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** The crosshair, the dots on the lines, the readout and the zoom box over a chart (made when first needed). */
function hudOf(el) {
  let hud = $('.lab-py-hud', el);
  if (!hud) {
    hud = document.createElement('div');
    hud.className = 'lab-py-hud';
    hud.hidden = true;
    hud.innerHTML = '<i class="lab-py-vl"></i><i class="lab-py-hl"></i><div class="lab-py-dots"></div><div class="lab-py-sel" hidden></div><div class="lab-py-tt"></div>';
    el.append(hud);
  }
  return hud;
}

/** Where a pointer is on a chart, in the picture's pixels (s of them per screen pixel), and the axes under it
 *  (several with twinx()). */
function locate(el, ev) {
  const o = st.out, k = Number(el.dataset.k), map = o && o.charts && o.charts[k], img = $('img', el);
  if (!map || !img || !img.naturalWidth) return null;
  const r = img.getBoundingClientRect();
  if (!r.width) return null;
  const s = img.naturalWidth / r.width, px = (ev.clientX - r.left) * s, py = (ev.clientY - r.top) * s;
  const hits = map.axes.filter((a) => a && px >= a.box[0] && px <= a.box[2] && py >= a.box[1] && py <= a.box[3]);
  return { k, s, px, py, hits };
}

/** The readout: for lines, the points nearest the mouse's x (a dot on each, their values in a box); for dots, the
 *  nearest one; elsewhere, the x and y under the mouse. */
function hover(el, ev) {
  const at = locate(el, ev), hud = hudOf(el);
  if (!at || !at.hits.length) { hud.hidden = true; return; }
  const { s, px, py, hits } = at;
  const css = (p) => `${(p / s).toFixed(1)}px`;
  const near = [];
  for (const a of hits) {
    if (!readable(a.x) || !readable(a.y)) continue;
    const [bx0, by1, bx1, by0] = a.box;                   // x: lim[0] at the left; y: lim[0] at the bottom
    const xv = valueAt(a.x, px, bx0, bx1);
    for (const ser of a.series || []) {
      if (ser.kind === 'bars' || ser.kind === 'hbars') { const b = barAt(a, ser, px, py); if (b) near.push(b); continue; }
      const p = points(ser), n = p.px.length;
      let best = -1;
      if (p.up) {
        let lo = 0, hi = n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (p.px[mid] < xv) lo = mid + 1; else hi = mid; }
        best = lo > 0 && Math.abs(p.px[lo - 1] - xv) <= Math.abs(p.px[lo] - xv) ? lo - 1 : lo;
      } else {
        let bd = (24 * s) ** 2;                             // dots: only one near the mouse
        for (let i = 0; i < n; i++) {
          const d = (pixelOf(a.x, p.px[i], bx0, bx1) - px) ** 2 + (pixelOf(a.y, p.py[i], by0, by1) - py) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best < 0 || !Number.isFinite(p.py[best])) continue;
      const cx = pixelOf(a.x, p.px[best], bx0, bx1), cy = pixelOf(a.y, p.py[best], by0, by1);
      if (cx < bx0 - 1 || cx > bx1 + 1 || Math.abs(cx - px) > 40 * s) continue;
      near.push({ a, ser, x: p.px[best], y: p.py[best], cx, cy, dx: Math.abs(cx - px) });
    }
  }
  const a0 = hits[0], snapped = near.filter((f) => f.ser.kind !== 'dots');            // a dot shows its own x and y
  const head = snapped.length ? snapped.reduce((m, f) => (f.dx < m.dx ? f : m)) : null;
  const value = (f) => f.val ?? (f.ser.kind === 'dots' ? `${shown(f.a.x, f.x, true)}, ${shown(f.a.y, f.y, true)}` : shown(f.a.y, f.y, true));
  let html = '';
  if (near.length) {
    html = `${head ? `<div class="lab-py-tt-x">${esc(head.head ?? shown(head.a.x, head.x, true))}</div>` : ''}${near.map((f) => `<div class="lab-py-tt-row"><i style="background:${f.ser.color}"></i><span>${esc(f.ser.label)}</span><b>${esc(value(f))}</b></div>`).join('')}`;
  } else if (readable(a0.x)) {
    const ys = hits.filter((a) => readable(a.y)).map((a, i, all) => `<div>y${all.length > 1 ? ` (${i ? 'right' : 'left'})` : ''} ${esc(shown(a.y, valueAt(a.y, py, a.box[3], a.box[1]), false))}</div>`);
    html = `<div class="lab-py-tt-x">x ${esc(shown(a0.x, valueAt(a0.x, px, a0.box[0], a0.box[2]), false))}</div>${ys.join('')}`;
  }
  const [vl, hl, dots, , tt] = hud.children;
  const vx = head ? head.cx : px;
  Object.assign(vl.style, { left: css(vx), top: css(a0.box[1]), height: css(a0.box[3] - a0.box[1]) });
  Object.assign(hl.style, { top: css(py), left: css(a0.box[0]), width: css(a0.box[2] - a0.box[0]) });
  dots.innerHTML = near.map((f) => `<i style="left:${css(f.cx)};top:${css(f.cy)};background:${f.ser.color}"></i>`).join('');
  tt.innerHTML = html;
  tt.hidden = !html;
  hud.hidden = false;
  if (html) {                                              // beside the mouse, inside the chart
    const w = el.clientWidth, h = el.clientHeight, tw = tt.offsetWidth, th = tt.offsetHeight;
    let left = px / s + 14, top = py / s + 14;
    if (left + tw > w) left = Math.max(0, px / s - 14 - tw);
    if (top + th > h) top = Math.max(0, py / s - 14 - th);
    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
  }
}

function onPointerDown(ev) {
  const handle = ev.target.closest('.lab-py-handle');
  if (handle) { startResize(handle, ev); return; }
  const el = ev.target.closest('.lab-py-chart.live');
  if (!el || ev.button !== 0 || el.classList.contains('busy')) return;
  if (ev.pointerType === 'touch') { hover(el, ev); return; }   // a finger reads values; zoom with the mouse
  const at = locate(el, ev);
  if (!at || !at.hits.length) return;
  ev.preventDefault();
  Object.assign(drag, { el, k: at.k, id: ev.pointerId, x0: at.px, y0: at.py, box: at.hits[0].box, s: at.s, rect: null, mode: '' });
  el.setPointerCapture(ev.pointerId);
}

function onPointerMove(ev) {
  if (drag.el) { if (ev.pointerId === drag.id) dragTo(ev); return; }
  const el = ev.target.closest && ev.target.closest('.lab-py-chart.live');
  if (!el) return;
  const first = !hoverAt;
  hoverAt = { el, clientX: ev.clientX, clientY: ev.clientY };
  if (first) requestAnimationFrame(() => { const p = hoverAt; hoverAt = null; if (p && p.el.isConnected && !drag.el) hover(p.el, p); });
}

/** The zoom box: across the chart (a flat drag) zooms x and fits y to what's left; up and down zooms y; else both. */
function dragTo(ev) {
  const at = locate(drag.el, ev);
  if (!at) return;
  const b = drag.box, x1 = Math.min(b[2], Math.max(b[0], at.px)), y1 = Math.min(b[3], Math.max(b[1], at.py));
  const dx = Math.abs(x1 - drag.x0) / drag.s, dy = Math.abs(y1 - drag.y0) / drag.s;
  if (!drag.rect && dx < 4 && dy < 4) return;              // not a drag yet: a click
  drag.mode = dy < 12 ? 'x' : dx < 12 ? 'y' : 'xy';
  const xs = [Math.min(drag.x0, x1), Math.max(drag.x0, x1)], ys = [Math.min(drag.y0, y1), Math.max(drag.y0, y1)];
  drag.rect = drag.mode === 'x' ? [xs[0], b[1], xs[1], b[3]] : drag.mode === 'y' ? [b[0], ys[0], b[2], ys[1]] : [xs[0], ys[0], xs[1], ys[1]];
  const hud = hudOf(drag.el), sel = $('.lab-py-sel', hud), r = drag.rect, css = (p) => `${(p / drag.s).toFixed(1)}px`;
  Object.assign(sel.style, { left: css(r[0]), top: css(r[1]), width: css(r[2] - r[0]), height: css(r[3] - r[1]) });
  sel.hidden = false;
  hud.classList.add('dragging');
  hud.hidden = false;
}

function onPointerUp(ev) {
  if (!drag.el || ev.pointerId !== drag.id) return;
  const { el, k, rect, mode, x0, y0, s } = drag;
  drag.el = null;
  const hud = hudOf(el);
  hud.classList.remove('dragging');
  $('.lab-py-sel', hud).hidden = true;
  if (el.isConnected && rect && (rect[2] - rect[0]) / s >= 4 && (rect[3] - rect[1]) / s >= 4) zoomChart(k, { at: [x0, y0], box: rect, mode });
}

function onPointerOut(ev) {
  const el = ev.target.closest && ev.target.closest('.lab-py-chart');
  if (!el || drag.el || (ev.relatedTarget && el.contains(ev.relatedTarget))) return;
  hoverAt = null;
  const hud = $('.lab-py-hud', el);
  if (hud) hud.hidden = true;
}

function onDblClick(ev) {
  if (ev.target.closest('.lab-py-handle')) { setSplit(SPLIT); return; }
  const el = ev.target.closest('.lab-py-chart.live'), k = el ? Number(el.dataset.k) : -1;
  if (el && st.out && st.out.zoomed && st.out.zoomed[k]) zoomChart(k, { home: true });
}

/** A line under a chart: what went wrong, or the hint again (text ''). */
function note(fig, text) {
  const n = fig && $('.lab-py-note', fig);
  if (!n) return;
  n.textContent = text || HINT;
  n.classList.toggle('warn', Boolean(text));
}

/** Zooms chart k ({home: true}: back to the view your code drew). The Python thread that drew it draws it again. */
async function zoomChart(k, req) {
  const o = st.out, el = host && $(`.lab-py-chart[data-k="${k}"]`, host);
  if (!o || !el || el.classList.contains('busy')) return;
  const fig = el.closest('.lab-py-fig');
  if (st.running) { note(fig, 'Zoom once the run has finished.'); return; }
  if (!kernel.up || o.gen !== kernel.gen) { note(fig, 'Python was stopped since this chart was drawn: run your code again to zoom.'); return; }
  el.classList.add('busy');
  hudOf(el).hidden = true;
  try {
    const z = JSON.parse((await call('zoom', { k, req })).json);
    if (st.out !== o) return;
    z.chart.axes.forEach((a, i) => { const old = o.charts[k] && o.charts[k].axes[i]; if (a && old) a.series = old.series; });
    o.images[k] = z.image;
    o.charts[k] = z.chart;
    o.zoomed[k] = !req.home;
    const img = $('img', el);
    img.width = Math.round(pngSize(z.image).w / 2);
    img.src = `data:image/png;base64,${z.image}`;
    const home = $('[data-py="chart-home"]', fig);
    if (home) home.hidden = !o.zoomed[k];
    note(fig, '');
  } catch (e) {
    if (st.out === o) note(fig, e.stopped ? 'Stopped.' : `Couldn’t zoom: ${e.message}`);
  } finally {
    el.classList.remove('busy');
  }
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
  kernel.gen++;                       // charts can be zoomed only by the thread that drew them
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
  paintRunning();
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
    o.gen = kernel.gen;
    o.zoomed = (o.images || []).map(() => false);
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
    paintRunning();
    paintOut();
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
  if (what === 'full') setFull(!st.full);
  if (what === 'layout') setBelow(!isBelow());
  if (what === 'chart-home') zoomChart(Number(el.dataset.k), { home: true });
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
