// MEDUSA Dev tools: checks and clean-up for this browser, loaded only when the page is opened (app.js).
// It measures (version, speed, storage), clears what this browser keeps for MEDUSA, and offers a few
// speed-ups. Nothing here changes your account's data on the server (trades, notes, Lab files, results).
//
// What this browser keeps for MEDUSA (local storage, keys starting with "j."), in three kinds:
//   temporary   rebuilt by itself: Binance coin lists (j.lab.coins.*), yesterday's closes for Markets
//               (j.mkt.close.*), the greeting's cached name
//   settings    layouts, filters, forms, chart settings, the menu, the INR switch, replay speed...
//   your own    chart drawings (j.lab.chart.draw.*), the Python tab's code, the strategy editor's draft
// plus the browser's cache of MEDUSA's files (the page, the Lab, the Python engine) and what is in memory.

let api = null, host = null;
const S = { ping: null, pinging: false, newest: null, checking: false, armed: null, armTimer: 0, py: null, pyBusy: null, persisted: null, engine: null };
const PY_SIZE = { engine: 'about 16 MB', libs: 'about 37 MB' };   // README: the engine, and the Python tab's libraries
let meter = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
const ms = (v) => (Number.isFinite(v) && v > 0 ? `${Math.round(v)} ms` : '–');
const dateText = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

/* ---------- what this browser keeps ---------- */

function kindOf(k) {
  if (/^j\.lab\.coins\./.test(k) || /^j\.mkt\.close\./.test(k) || k === 'j.name') return 'temp';
  if (/^j\.lab\.chart\.draw\./.test(k) || k === 'j.lab.py.code' || k === 'j.lab.draft') return 'mine';
  return 'settings';
}
function stored() {
  const out = { temp: { n: 0, b: 0, keys: [] }, settings: { n: 0, b: 0, keys: [] }, mine: { n: 0, b: 0, keys: [] }, drawings: 0 };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('j.')) continue;
      const kind = out[kindOf(k)];
      kind.n++;
      kind.b += (k.length + (localStorage.getItem(k) || '').length) * 2;   // the browser keeps text as UTF-16
      kind.keys.push(k);
      if (/^j\.lab\.chart\.draw\./.test(k)) { try { out.drawings += (JSON.parse(localStorage.getItem(k)) || []).length; } catch { /* unreadable */ } }
    }
  } catch { /* storage blocked */ }
  return out;
}
const removeKeys = (keys) => { for (const k of keys) { try { localStorage.removeItem(k); } catch { /* blocked */ } } };

/* ---------- the page ---------- */

const CSS = `
.dev-grid { display: grid; gap: 16px; }
.dev-rows { display: grid; }
.dev-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; padding: 12px 0; border-top: 1px solid var(--border); }
.dev-row:first-child { border-top: 0; padding-top: 2px; }
.dev-row > div:first-child { flex: 1 1 320px; min-width: 0; }
.dev-row > div:first-child > b { color: var(--text); font-size: 14.5px; }
.dev-row p { margin: 3px 0 0; color: var(--text-2); font-size: 13.5px; line-height: 1.5; }
.dev-row .check { flex: 1 1 100%; }
.dev-acts { display: flex; flex-wrap: wrap; gap: 6px; }
.dev-acts .btn[data-armed] { border-color: var(--red); color: #fff; background: #5b2b2d; }
.dev-acts .btn-danger { color: var(--red); border-color: #5b2b2d; }
.dev-bar { height: 6px; margin-top: 8px; border-radius: 3px; background: #2a2a2a; overflow: hidden; }
.dev-bar i { display: block; height: 100%; background: var(--green-btn); transition: width 0.2s; }
.dev-err { display: block; margin-top: 4px; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: #fca5a5; white-space: pre-wrap; word-break: break-word; }
.dev-meter { position: fixed; right: 10px; bottom: max(10px, env(safe-area-inset-bottom)); z-index: 300; padding: 4px 9px; border-radius: 6px; background: rgba(0, 0, 0, 0.78); color: #86efac; font: 12px ui-monospace, Consolas, monospace; pointer-events: none; }
`;

export function render(el, appApi) {
  api = appApi;
  if (!document.getElementById('dev-css')) document.head.appendChild(Object.assign(document.createElement('style'), { id: 'dev-css', textContent: CSS }));
  if (host !== el) {
    host = el;
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
  }
  paint();
  if (S.persisted == null && navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { S.persisted = p; paint(); }).catch(() => {});
  if (!S.newest && !S.checking) checkVersion();
  if (!S.py) checkPython();
  readEngine();
}

function paint() {
  if (!host || host.hidden) return;
  const rel = api.release() || {};
  const st = stored();
  const nav = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource');
  const sent = res.reduce((a, r) => a + (r.transferSize || 0), 0) + (nav ? nav.transferSize || 0 : 0);
  const fromCache = res.filter((r) => r.transferSize === 0 && r.decodedBodySize > 0).length;
  const mem = performance.memory ? performance.memory.usedJSHeapSize : null;
  const conn = navigator.connection;
  const newer = S.newest && rel.version && S.newest.version !== rel.version;
  const auto = api.store.get('autoUpdate', true), pre = api.store.get('preloadLab', false);
  const btn = (act, label, extra = '') => `<button class="btn btn-sm ${extra}" data-dev="${act}" ${S.armed === act ? 'data-armed="1"' : ''}>${S.armed === act ? 'Tap again to confirm' : label}</button>`;
  const row = (title, text, acts = '') => `<div class="dev-row"><div><b>${title}</b><p>${text}</p></div>${acts ? `<div class="dev-acts">${acts}</div>` : ''}</div>`;
  const py = S.py;
  const pyLine = (g) => (!py ? 'Checking…' : py.error ? esc(py.error) : py[g].have === py[g].files.length ? `Downloaded (${PY_SIZE[g]})` : `${py[g].have} of ${py[g].files.length} files downloaded (${PY_SIZE[g]} in all)`);
  const pyBar = (g) => (S.pyBusy && S.pyBusy.g === g ? `<div class="dev-bar" role="progressbar" aria-valuenow="${Math.round(S.pyBusy.f * 100)}"><i style="width:${Math.round(S.pyBusy.f * 100)}%"></i></div><p class="faint small">${esc(S.pyBusy.text)}</p>` : '');
  const errs = api.errors();
  host.innerHTML = `<div class="dev-grid">
    <section class="card">
      <div class="card-head"><div><h2>App version</h2><p>The version of MEDUSA in this browser, and the newest one on the server.</p></div></div>
      <div class="dev-rows">
        ${row(`This page: ${rel.version ? `version ${esc(rel.version)}` : 'unknown'}`, rel.date ? `Released ${esc(dateText(rel.date))}.` : '',
          `<button class="btn btn-sm" data-dev="about">What’s new and security</button>`)}
        ${row('Newest on the server', S.checking ? 'Checking…' : !S.newest ? 'Couldn’t check (offline?).' : newer ? `<b class="pos">Version ${esc(S.newest.version)} is ready</b> (released ${esc(dateText(S.newest.date))}). Reload to use it.` : 'You have the newest version.',
          `${newer ? btn('update', 'Reload to update', 'btn-green') : ''}<button class="btn btn-sm" data-dev="check" ${S.checking ? 'disabled' : ''}>Check now</button>`)}
        <div class="dev-row"><label class="check"><input type="checkbox" data-dev-opt="autoUpdate" ${auto ? 'checked' : ''}><span>Look for new versions by itself (every 30 minutes, and when you come back to MEDUSA) and offer to reload</span></label></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div><h2>Speed</h2><p>How quickly MEDUSA reaches its server and loads in this browser.</p></div></div>
      <div class="dev-rows">
        ${row('Server', S.pinging ? 'Measuring…' : S.ping ? (S.ping.error ? esc(S.ping.error) : `<b>${ms(S.ping.median)}</b> there and back (the middle of ${S.ping.n} tries; fastest ${ms(S.ping.min)})${S.ping.colo ? `, answered by Cloudflare’s <b>${esc(S.ping.colo)}</b> data centre` : ''}.`) : 'Measure the time to MEDUSA’s server and back.',
          `<button class="btn btn-sm" data-dev="ping" ${S.pinging ? 'disabled' : ''}>Measure</button>`)}
        ${row('This visit', nav ? `First reply from the server ${ms(nav.responseStart)} · page ready ${ms(nav.domContentLoadedEventEnd)} · fully loaded ${ms(nav.loadEventEnd)}. Downloaded <b>${kb(sent)}</b> so far; ${fromCache} file${fromCache === 1 ? '' : 's'} came from the browser’s cache.` : 'Not available in this browser.')}
        ${row('Memory', mem != null ? `This page uses about <b>${kb(mem)}</b> of memory for its scripts${S.engine && S.engine.state !== 'off' ? ' (the Python engine runs in its own thread, on top of this)' : ''}.` : 'This browser doesn’t say how much memory the page uses (Chrome and Edge do).',
          S.engine && ['ready', 'loading', 'busy'].includes(S.engine.state) ? btn('engine', 'Stop the Python engine') : '')}
        ${conn ? row('Your connection', `About ${conn.effectiveType ? esc(conn.effectiveType.toUpperCase()) : '?'}${conn.downlink ? `, ${conn.downlink} Mbps` : ''}${conn.rtt ? `, ${conn.rtt} ms` : ''}, as the browser estimates it.${conn.saveData ? ' <b>Data saver is on</b>: keep the speed-ups below off.' : ''}`) : ''}
        <div class="dev-row"><label class="check"><input type="checkbox" data-dev-opt="meter" ${meter ? 'checked' : ''}><span>Show a live speed meter in the corner (frames a second, the slowest frame and memory), for example while a replay plays. Until you reload.</span></label></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div><h2>Speed-ups</h2><p>Optional. They use more data once, so everything later opens at once.</p></div></div>
      <div class="dev-rows">
        <div class="dev-row"><label class="check"><input type="checkbox" data-dev-opt="preloadLab" ${pre ? 'checked' : ''}><span>Get the Lab ready in the background: once the journal has loaded and the browser is idle, the Lab’s and the Chart’s code (about 600 KB) is fetched, so they open at once.</span></label></div>
        ${row('Python engine', `Python and numpy, for backtests (the Lab starts it by itself). ${pyLine('engine')}.${pyBar('engine')}`, py && !py.error && py.engine.have < py.engine.files.length ? `<button class="btn btn-sm" data-dev="py-engine" ${S.pyBusy ? 'disabled' : ''}>Download now</button>` : '')}
        ${row('Python libraries', `pandas, matplotlib, scipy and statsmodels, for the Python tab. Each downloads the first time your code imports it; get them now (on Wi-Fi) so it starts at once. ${pyLine('libs')}.${pyBar('libs')}`, py && !py.error && py.libs.have < py.libs.files.length ? `<button class="btn btn-sm" data-dev="py-libs" ${S.pyBusy ? 'disabled' : ''}>Download now</button>` : '')}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div><h2>Storage on this device</h2><p>What this browser keeps for MEDUSA. Your trades, notes, Lab files and results are on MEDUSA’s server, not here.</p></div></div>
      <div class="dev-rows">
        ${row('Temporary data', `${st.temp.n} item${st.temp.n === 1 ? '' : 's'}, ${kb(st.temp.b)}: coin lists and the like, rebuilt by themselves. Plus what is in memory (open data files, results, the Python engine).`)}
        ${row('Settings', `${st.settings.n} item${st.settings.n === 1 ? '' : 's'}, ${kb(st.settings.b)}: layouts, filters, chart settings, forms, the menu.`)}
        ${row('Your own work', `${st.mine.n} item${st.mine.n === 1 ? '' : 's'}, ${kb(st.mine.b)}: ${st.drawings} chart drawing${st.drawings === 1 ? '' : 's'}, the Python tab’s code and the strategy editor’s draft. These are only in this browser.`)}
        ${navigator.storage && navigator.storage.persist ? row('Keep it on this device', S.persisted ? 'Kept: the browser won’t remove MEDUSA’s data on its own.' : 'When it runs short of space, the browser may remove what it keeps for MEDUSA (your drawings and Python code included). Ask it to keep it.', S.persisted ? '' : `<button class="btn btn-sm" data-dev="persist">Keep it</button>`) : ''}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div><h2>Clean up</h2><p>Each one clears this browser only, then reloads the page. You stay signed in, and nothing in your account is touched.</p></div></div>
      <div class="dev-rows">
        ${row('Clear the cache', 'Removes the copies of MEDUSA’s files this browser keeps (the page, the Lab, the 16 MB Python engine) and loads everything fresh from the server. Use it when something looks out of date. The Python engine downloads again the next time the Lab opens.', btn('cache', 'Clear the cache'))}
        ${row('Clear temporary data', 'Coin lists and other temporary data, and everything held in memory: open data files, results and the Python engine. Settings, drawings and your Python code stay.', btn('temp', 'Clear temporary data'))}
        ${row('Reset settings', 'Layouts, filters, chart settings, forms and the menu go back to how they were at first. Drawings, your Python code and everything in your account stay.', btn('settings', 'Reset settings'))}
        ${row('Delete chart drawings', `${st.drawings} drawing${st.drawings === 1 ? '' : 's'} on all coins.`, st.drawings ? btn('drawings', 'Delete drawings') : '')}
        ${row('Clear everything on this device', 'All of the above, plus your Python code and the strategy editor’s draft. Your account (trades, notes, Lab files, results, your strategies) stays on the server.', btn('all', 'Clear everything', 'btn-danger'))}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div><h2>Diagnostics</h2><p>For finding a problem: errors in this visit, and a report to send with a bug. The report has no email, trades, notes or keys.</p></div></div>
      <div class="dev-rows">
        ${row('Errors in this visit', errs.length ? `<span class="dev-err">${errs.slice(-8).map((e) => `${new Date(e.at).toLocaleTimeString('en-GB')}  ${esc(e.msg)}${e.where ? `  (${esc(e.where)})` : ''}`).join('\n')}</span>` : 'None.',
          `<button class="btn btn-sm" data-dev="logs">Open Logs</button>`)}
        ${row('Report', 'Version, browser, screen, storage, speed and errors as plain text.', `<button class="btn btn-sm" data-dev="copy">Copy</button><button class="btn btn-sm" data-dev="download">Download</button>`)}
      </div>
    </section>
  </div>`;
}

/* ---------- version ---------- */

function checkVersion() {
  S.checking = true;
  paint();
  api.checkVersion().then((v) => { S.newest = v; }).finally(() => { S.checking = false; paint(); });
}

/* ---------- speed ---------- */

async function ping() {
  S.pinging = true;
  paint();
  const times = [];
  let colo = null;
  try {
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await api.call('GET', '/api/ping');
      times.push(performance.now() - t0);
      colo = r.colo || colo;
    }
    times.sort((a, b) => a - b);
    S.ping = { median: times[times.length >> 1], min: times[0], n: times.length, colo };
  } catch (e) { S.ping = { error: e.message }; }
  S.pinging = false;
  paint();
}
function setMeter(on) {
  if (on && !meter) {
    const el = document.createElement('div');
    el.className = 'dev-meter';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    let frames = 0, worst = 0, last = performance.now(), prev = last, raf = 0;
    const tick = (t) => {
      frames++;
      worst = Math.max(worst, t - prev);
      prev = t;
      if (t - last >= 1000) {
        const mem = performance.memory ? ` · ${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB` : '';
        el.textContent = `${Math.round((frames * 1000) / (t - last))} fps · slowest ${Math.round(worst)} ms${mem}`;
        frames = 0; worst = 0; last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    meter = { stop: () => { cancelAnimationFrame(raf); el.remove(); } };
  } else if (!on && meter) { meter.stop(); meter = null; }
}
function readEngine() {
  const lab = api.lab();
  if (!lab) { S.engine = null; return; }
  lab.then((m) => { S.engine = m && m.engineState ? m.engineState() : null; paint(); }).catch(() => {});
}

/* ---------- the Python files (Pyodide): what this browser has, and getting them now ---------- */

async function pyFiles() {
  const worker = await (await fetch('/lab/py-worker.js')).text();
  const ver = (worker.match(/pyodide\/(v[\w.]+)\//) || [])[1];
  if (!ver) throw new Error('Couldn’t find the Python engine’s files.');
  const base = `/lab/pyodide/${ver}/`;
  const lock = await (await fetch(`${base}pyodide-lock.json`)).json();
  const pk = lock.packages || {};
  const closure = (names) => {
    const seen = new Set(), out = [];
    const add = (n) => { const k = String(n).toLowerCase(); if (seen.has(k) || !pk[k]) return; seen.add(k); for (const d of pk[k].depends || []) add(d); out.push(pk[k].file_name); };
    names.forEach(add);
    return out;
  };
  const core = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', ...closure(['numpy'])];
  const libs = closure(['pandas', 'matplotlib', 'scipy', 'statsmodels']).filter((f) => !core.includes(f));
  return { base, engine: core, libs };
}
/** Whether the browser already has a file (asks its cache only; nothing is downloaded). */
async function cached(url) {
  try {
    const r = await fetch(url, { cache: 'only-if-cached', mode: 'same-origin' });
    if (r.body) r.body.cancel().catch(() => {});
    return r.ok ? Number(r.headers.get('content-length')) || 0 : -1;
  } catch { return -1; }
}
async function checkPython() {
  try {
    const f = await pyFiles();
    const group = async (files) => {
      const sizes = await Promise.all(files.map((n) => cached(f.base + n)));
      return { files, have: sizes.filter((s) => s >= 0).length };
    };
    S.py = { base: f.base, engine: await group(f.engine), libs: await group(f.libs) };
  } catch (e) { S.py = { error: e.message }; }
  paint();
}
async function getPython(g) {
  if (!S.py || S.pyBusy) return;
  const { base } = S.py, files = S.py[g].files;
  let got = 0;
  S.pyBusy = { g, f: 0, text: 'Starting…' };
  paint();
  try {
    for (let i = 0; i < files.length; i++) {
      if ((await cached(base + files[i])) >= 0) continue;   // already here
      const r = await fetch(base + files[i]);                // kept by the browser for a year (the version is in the path)
      if (!r.ok) throw new Error(`${files[i]}: ${r.status}`);
      const size = Number(r.headers.get('content-length')) || 0, reader = r.body.getReader();
      let part = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        part += value.length;
        got += value.length;
        S.pyBusy = { g, f: Math.min(1, (i + (size ? part / size : 0.5)) / files.length), text: `File ${i + 1} of ${files.length}: ${files[i]} · ${kb(got)} so far` };
        paintBusy();
      }
    }
    api.log('devtools', `Downloaded the Python ${g === 'engine' ? 'engine' : 'libraries'} ahead of time`);
    api.toast(g === 'engine' ? 'The Python engine is downloaded.' : 'The Python libraries are downloaded.');
  } catch (e) { api.toast(`The download stopped: ${e.message}`, 'error'); }
  S.pyBusy = null;
  await checkPython();
}
let busyFrame = 0;
const paintBusy = () => { if (!busyFrame) busyFrame = requestAnimationFrame(() => { busyFrame = 0; paint(); }); };

/* ---------- clean-up ---------- */

async function clearSiteData(types) {
  try { await api.call('POST', '/api/clear-site-data', { types }); } catch { /* the steps below still run */ }
}
async function clearCaches() {
  try { if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k); } catch { /* none */ }
}
async function clearIdb() {
  try { if (indexedDB.databases) for (const d of await indexedDB.databases()) if (d.name) indexedDB.deleteDatabase(d.name); } catch { /* none */ }
}
async function reloadAfter(msg) {
  api.log('devtools', msg);
  await api.flushLogs();
  api.toast(`${msg}. Reloading…`);
  setTimeout(() => location.reload(), 600);
}
async function act(what) {
  const st = stored();
  if (what === 'cache') { await clearSiteData(['cache']); await clearCaches(); return reloadAfter('Cleared the cache'); }
  if (what === 'temp') {
    removeKeys(st.temp.keys);
    try { sessionStorage.clear(); } catch { /* blocked */ }
    await clearCaches();
    await clearIdb();
    return reloadAfter('Cleared temporary data');
  }
  if (what === 'settings') { removeKeys(st.settings.keys.filter((k) => k !== 'j.menuHint')); return reloadAfter('Reset the settings'); }
  if (what === 'drawings') {
    removeKeys(st.mine.keys.filter((k) => /^j\.lab\.chart\.draw\./.test(k)));
    api.log('devtools', `Deleted ${st.drawings} chart drawings`);
    api.toast(`Deleted ${st.drawings} drawing${st.drawings === 1 ? '' : 's'}. Open charts show them until they reload.`);
    return paint();
  }
  if (what === 'all') {
    await clearSiteData(['cache', 'storage']);
    removeKeys([...st.temp.keys, ...st.settings.keys, ...st.mine.keys]);
    try { sessionStorage.clear(); } catch { /* blocked */ }
    await clearCaches();
    await clearIdb();
    return reloadAfter('Cleared everything MEDUSA kept on this device');
  }
  if (what === 'engine') {
    const m = await api.lab();
    if (m && m.stopEngine && m.stopEngine()) { api.toast('The Python engine is stopped. It starts again when something needs it.'); readEngine(); }
    else api.toast('A backtest is running: the engine stops when it has finished.');
    return null;
  }
  if (what === 'update') { await clearCaches(); location.reload(); }
  return null;
}
/** Actions that remove something ask for a second tap within 4 seconds. */
const ARMED = new Set(['temp', 'settings', 'drawings', 'all']);

/* ---------- the report ---------- */

function report() {
  const rel = api.release() || {};
  const st = stored();
  const nav = performance.getEntriesByType('navigation')[0];
  const conn = navigator.connection;
  const lines = [
    `MEDUSA diagnostic report · ${new Date().toISOString()}`,
    `Version: ${rel.version || '?'} (released ${rel.date || '?'})${S.newest ? ` · newest on the server: ${S.newest.version}` : ''}`,
    `Browser: ${navigator.userAgent}`,
    `Language: ${navigator.language} · time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} · online: ${navigator.onLine}`,
    `Screen: ${screen.width}x${screen.height} at ${devicePixelRatio}x · window: ${innerWidth}x${innerHeight} · touch: ${navigator.maxTouchPoints > 0}`,
    conn ? `Connection: ${conn.effectiveType || '?'} · ${conn.downlink || '?'} Mbps · ${conn.rtt || '?'} ms · data saver: ${Boolean(conn.saveData)}` : 'Connection: not reported',
    nav ? `This visit: first byte ${Math.round(nav.responseStart)} ms · ready ${Math.round(nav.domContentLoadedEventEnd)} ms · loaded ${Math.round(nav.loadEventEnd)} ms` : 'This visit: not reported',
    S.ping && !S.ping.error ? `Server: ${Math.round(S.ping.median)} ms (middle of ${S.ping.n}) · Cloudflare ${S.ping.colo || '?'}` : 'Server: not measured',
    performance.memory ? `Memory: ${Math.round(performance.memory.usedJSHeapSize / 1048576)} MB used of ${Math.round(performance.memory.jsHeapSizeLimit / 1048576)} MB` : 'Memory: not reported',
    `Python engine: ${S.engine ? S.engine.state : 'Lab not opened'}`,
    `Stored here: temporary ${kb(st.temp.b)} (${st.temp.n}) · settings ${kb(st.settings.b)} (${st.settings.n}) · your own ${kb(st.mine.b)} (${st.mine.n}, ${st.drawings} drawings)`,
    `Kept on purpose (persistent storage): ${Boolean(S.persisted)}`,
    S.py && !S.py.error ? `Python files in the cache: engine ${S.py.engine.have}/${S.py.engine.files.length} · libraries ${S.py.libs.have}/${S.py.libs.files.length}` : '',
    `Errors in this visit: ${api.errors().length}`,
    ...api.errors().map((e) => `  ${new Date(e.at).toISOString()}  ${e.msg}${e.where ? `  (${e.where})` : ''}`),
  ];
  return lines.filter(Boolean).join('\n') + '\n';
}

/* ---------- events ---------- */

async function onClick(ev) {
  const el = ev.target.closest('[data-dev]');
  if (!el || el.disabled) return;
  const what = el.dataset.dev;
  if (ARMED.has(what) || what === 'cache') {
    if (S.armed !== what) {
      S.armed = what;
      clearTimeout(S.armTimer);
      S.armTimer = setTimeout(() => { S.armed = null; paint(); }, 4000);
      paint();
      return;
    }
    S.armed = null;
    clearTimeout(S.armTimer);
  }
  switch (what) {
    case 'check': checkVersion(); break;
    case 'about': api.openAbout(); break;
    case 'ping': ping(); break;
    case 'persist': navigator.storage.persist().then((ok) => { S.persisted = ok; if (!ok) api.toast('The browser said no. It usually agrees for sites you use often, bookmark or install.'); paint(); }).catch(() => {}); break;
    case 'py-engine': getPython('engine'); break;
    case 'py-libs': getPython('libs'); break;
    case 'logs': api.go('logs'); break;
    case 'copy': navigator.clipboard.writeText(report()).then(() => api.toast('The report is copied.')).catch(() => api.toast('Copying isn’t allowed here; use Download.', 'error')); break;
    case 'download': {
      const url = URL.createObjectURL(new Blob([report()], { type: 'text/plain' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `medusa-report-${new Date().toISOString().slice(0, 10)}.txt` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      break;
    }
    default: await act(what);
  }
}
function onChange(ev) {
  const t = ev.target;
  const opt = t.dataset && t.dataset.devOpt;
  if (!opt) return;
  if (opt === 'meter') { setMeter(t.checked); return; }
  api.store.set(opt, t.checked);
  api.log('devtools', `${opt}: ${t.checked ? 'on' : 'off'}`);
  if (opt === 'preloadLab' && t.checked) api.preloadLab();
}
