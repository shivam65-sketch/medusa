// MEDUSA Markets: one number's calculation in its own window, opened by a ‹› button on the Markets page
// (/markets-window?panel=breadth&kind=all, or panel=market&symbol=BTCUSDT; the file is markets-window.html,
// served without its extension).
//
// The window runs the Markets page's own code (markets.js) with its own copy of the data, its own SQL
// engine and its own live prices, but only the queries of the number it shows. So it stays live while
// the Markets page is hidden, on another page or closed. It needs no more than the page does: the
// signed-in session (the same cookie) and the app's local storage.

import { renderWindow } from './markets.js?v=10';

const root = document.getElementById('mkt-win');

/** The app's local storage, with the same keys as app.js. */
const store = {
  get(k, d) { try { const v = localStorage.getItem('j.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('j.' + k, JSON.stringify(v)); } catch { /* optional */ } },
};

/* Log lines go to the Logs like the app's own, in small batches. */
const LOG = { buf: [], timer: 0, verbose: store.get('logVerbose', false) };
const lineId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => (b % 36).toString(36)).join('');
function log(area, msg, data = null, level = 'info') {
  if (level === 'debug' && !LOG.verbose) return;
  LOG.buf.push({ cid: lineId(), at: Date.now(), level, area: String(area).slice(0, 20), msg: String(msg).slice(0, 400), data: null });
  clearTimeout(LOG.timer);
  LOG.timer = setTimeout(() => flush(), 4000);
}
async function flush(keepalive = false) {
  if (!LOG.buf.length) return;
  const batch = LOG.buf.splice(0, 100);
  try {
    await fetch('/api/logs', {
      method: 'POST', keepalive, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'journal' },
      body: JSON.stringify({ entries: batch, tz: -new Date().getTimezoneOffset() }),
    });
  } catch { /* the lines are lost; the window still works */ }
}
addEventListener('pagehide', () => flush(true));
addEventListener('error', (e) => { if (e.message) log('error', e.message, null, 'error'); });

function signedOut() {
  root.innerHTML = '<div class="banner"><div><b>You\'re signed out.</b> Sign in on MEDUSA\'s page, then press ‹› on the Markets page again.</div></div>';
}

/** MEDUSA's API, as app.js calls it. */
async function call(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['X-Requested-With'] = 'journal';
    if (body !== undefined) opts.body = JSON.stringify(body);
  }
  let r;
  try { r = await fetch(path, opts); } catch { throw new Error('Couldn\'t reach MEDUSA. Check your connection.'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { signedOut(); throw new Error('Signed out'); }
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status}).`), { status: r.status, data });
  return data;
}

let toastTimer = 0;
function toast(msg, tone = '', ms = 0) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.dataset.tone = tone;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms || (tone === 'error' ? 6000 : 2800));
}

const q = new URLSearchParams(location.search);
renderWindow(root, { call, log, store, toast }, { panel: q.get('panel'), symbol: q.get('symbol'), kind: q.get('kind') || store.get('mktKind', 'all') });
