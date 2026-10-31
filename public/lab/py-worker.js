// MEDUSA Lab's Python engine. It runs in a background thread, so the page stays responsive while a
// backtest runs. Pyodide (CPython compiled to WebAssembly, served from /lab/pyodide/) and numpy load
// once, then the engine files the page sends (public/lab/py/*.py). After that this thread switches
// its own network access off: strategy code, including files you upload, can compute but can't send
// anything anywhere. The page talks to it with messages: init, strategies, check, run, and exec and
// syntax (the Python tab: your own code, and Python's check of it as you type; see py/console.py), zoom (one of its
// charts drawn again at new limits), and plots (a strategy's own lines for the Chart tab). Libraries beyond numpy (pandas, matplotlib, scipy,
// statsmodels) are loaded at init, before the network is switched off, only when asked for.
import { loadPyodide } from './pyodide/v314.0.7/pyodide.mjs';

const HOME = '/home/pyodide/lab/py';
let py = null;
let lab = null;
let printed = [];
const LIBRARIES = new Set(['pandas', 'matplotlib', 'scipy', 'statsmodels']);
const datasets = new Map(); // dataset id -> its columns (the last two used are kept)

const post = (msg) => self.postMessage(msg);

async function init(engineFiles, packages = []) {
  const t0 = performance.now(), steps = {};
  let last = t0;
  const lap = (name) => { const now = performance.now(); steps[name] = Math.round(now - last); last = now; };
  py = await loadPyodide({
    indexURL: new URL('./pyodide/v314.0.7/', import.meta.url).href,
    stdout: (line) => { if (printed.length < 400) printed.push(String(line).slice(0, 500)); },
    stderr: (line) => { if (printed.length < 400) printed.push(String(line).slice(0, 500)); },
  });
  lap('python');
  const libs = ['numpy', ...packages.filter((p) => LIBRARIES.has(p))];
  await py.loadPackage(libs, { messageCallback: () => {}, errorCallback: () => {} });
  lap('libraries');
  py.FS.mkdirTree(HOME);
  for (const [name, src] of Object.entries(engineFiles)) {
    if (/^[a-z_]+\.py$/.test(name)) py.FS.writeFile(`${HOME}/${name}`, src);
  }
  py.runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(HOME)})\nimport labrun`);
  lab = py.pyimport('labrun');
  lap('engine');
  lockDown();
  return { ms: Math.round(performance.now() - t0), steps };
}

/* No network from here on: strategy code gets a calculator, not a browser. */
function lockDown() {
  for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts', 'Worker', 'SharedWorker',
    'BroadcastChannel', 'indexedDB', 'caches', 'Notification', 'Request']) {
    try { delete self[k]; } catch { /* not deletable: overwrite below */ }
    try { if (self[k] !== undefined) Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch { /* ignore */ }
  }
}

/** The columns of m.dataset: sent with this message, or kept from an earlier one (null: send them). */
function columnsOf(m) {
  if (m.columns) {
    const cols = Object.fromEntries(Object.entries(m.columns).filter(([, v]) => v instanceof Float64Array && v.length));
    datasets.delete(m.dataset);
    datasets.set(m.dataset, cols);
    while (datasets.size > 2) datasets.delete(datasets.keys().next().value);
  }
  return datasets.get(m.dataset) || null;
}

function run(m) {
  const cols = columnsOf(m);
  if (!cols) return { need: true };
  const progress = (f, text) => post({ type: 'progress', id: m.id, f, text });
  const out = lab.run_safe(JSON.stringify(m.cfg), JSON.stringify(m.meta), cols, progress);
  return { json: out };
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  printed = [];
  try {
    let reply;
    if (m.type === 'init') reply = await init(m.engine || {}, m.packages || []);
    else if (!lab) throw new Error('The Python engine is still starting.');
    else if (m.type === 'strategies') reply = { json: lab.load_strategies(JSON.stringify(m.files || []), JSON.stringify(m.origins || [])) };
    else if (m.type === 'check') reply = { json: lab.check(String(m.source || '')) };
    else if (m.type === 'run') reply = run(m);
    else if (m.type === 'plots') { const cols = columnsOf(m); reply = cols ? { json: lab.plots(String(m.key || ''), JSON.stringify(m.params || {}), JSON.stringify(m.meta || {}), cols) } : { need: true }; }
    else if (m.type === 'warmup') reply = { n: lab.warmup(String(m.key || ''), JSON.stringify(m.params || {}), String(m.interval || '')) };
    else if (m.type === 'syntax') reply = { json: py.pyimport('console').syntax(String(m.code || '')) };
    else if (m.type === 'exec') reply = { json: py.pyimport('console').run(String(m.code || ''), JSON.stringify(m.files || []), (m.files || []).map((f) => f.cols), Number(m.tz) || 0) };
    else if (m.type === 'zoom') reply = { json: py.pyimport('console').zoom(Number(m.k) || 0, JSON.stringify(m.req || {})) };
    else throw new Error('Unknown request.');
    post({ type: 'done', id: m.id, ...reply, printed });
  } catch (e) {
    post({ type: 'error', id: m.id, message: String((e && e.message) || e), printed });
  }
};
