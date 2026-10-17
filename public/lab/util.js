// MEDUSA Lab: small helpers shared by the Lab's modules (formatting, the API, compression).

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DAY = 86_400_000;
export const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': DAY, '3d': 3 * DAY, '1w': 7 * DAY,
};
export const MAX_CANDLES = 1_000_000;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const plural = (n, w, ws = w + 's') => `${Number(n).toLocaleString('en-US')} ${n === 1 ? w : ws}`;

/* ---------- numbers and dates (backtests are in USDT, shown as $; as ₹ when the INR switch is on) ---------- */
const val = (v) => (v === 'inf' ? Infinity : v === '-inf' ? -Infinity : v);
/** USDT → INR rate while the INR switch (top right) is on, else null. */
export const inrRate = () => (app && app.fx ? app.fx() : null);
export function money(v, dp = 2) {
  v = val(v);
  if (!isNum(v)) return '–';
  const r = inrRate();
  if (r) return (v < 0 ? '-₹' : '₹') + Math.abs(v * r).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function pct(v, dp = 1, sign = true) {
  v = val(v);
  if (!isNum(v)) return '–';
  return (sign && v > 0 ? '+' : '') + (v * 100).toFixed(dp) + '%';
}
export function num(v, dp = 2) {
  v = val(v);
  if (v === Infinity) return '∞';
  if (!isNum(v)) return '–';
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export const rr = (v, dp = 2) => (isNum(v) ? (v >= 0 ? '+' : '') + v.toFixed(dp) + 'R' : '–');
export function price(v) {
  if (!isNum(v)) return '–';
  const r = inrRate();
  if (r) v *= r;
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString(r ? 'en-IN' : 'en-US', { maximumFractionDigits: 2 });
  if (a >= 1) return String(Number(v.toFixed(4)));
  if (a === 0) return '0';
  return String(Number(v.toPrecision(5)));
}
export const tone = (v) => { v = val(v); return isNum(v) && v !== 0 ? (v > 0 ? 'pos' : 'neg') : ''; };
export function bytes(n) {
  if (!isNum(n)) return '–';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  return Number((n / 1024 ** 3).toFixed(2)) + ' GB';
}
const two = (n) => String(n).padStart(2, '0');
/** Dates in the Lab are shown in your time zone (candles open on UTC boundaries, so a daily candle opens at
 * 05:30 in India, for example). Python gets exact times in ms. */
export const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
export function dateLocal(ms, time = false) {
  if (!isNum(ms)) return '–';
  const d = new Date(ms);
  const s = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return time ? `${s} ${two(d.getHours())}:${two(d.getMinutes())}` : s;
}
/** "UTC+05:30": the viewer's time zone, for labels. */
export const zoneLabel = (ms = Date.now()) => { const o = -new Date(ms).getTimezoneOffset(); return `UTC${o >= 0 ? '+' : '-'}${two(Math.floor(Math.abs(o) / 60))}:${two(Math.abs(o) % 60)}`; };
export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
  return dateLocal(ms);
}
export const parseDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(`${s}T00:00:00`).getTime() : null);   // local midnight

/* ---------- the MEDUSA API (same session and safety header as the journal) ---------- */
let app = null;
export const setApp = (a) => { app = a; };
export const toast = (msg, kind = '') => app && app.toast(msg, kind);

export async function api(method, path, { json, body, meta, raw = false } = {}) {
  const headers = { Accept: raw ? 'application/octet-stream' : 'application/json' };
  const opts = { method, credentials: 'same-origin', headers };
  if (method !== 'GET') headers['X-Requested-With'] = 'journal';
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (body !== undefined) { headers['Content-Type'] = 'application/octet-stream'; opts.body = body; }
  if (meta !== undefined) headers['X-Lab-Meta'] = encodeURIComponent(JSON.stringify(meta));
  let r;
  const t0 = performance.now();
  try { r = await fetch(path, opts); } catch { throw new Error('Couldn’t reach MEDUSA. Check your connection.'); }
  if (app && app.log) app.log('api', `${method} ${path.split('?')[0]} → ${r.status} (${Math.round(performance.now() - t0)} ms)`, null, 'debug');
  if (r.status === 401) { if (app) app.signedOut(); throw new Error('Signed out.'); }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw Object.assign(new Error(d.error || `Request failed (${r.status}).`), { status: r.status });
  }
  return raw ? r : r.json();
}

/* ---------- gzip (built into the browser) ---------- */
async function pipe(data, stream) {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (bytesIn) => pipe(bytesIn, new CompressionStream('gzip'));
export const gunzip = (bytesIn) => pipe(bytesIn, new DecompressionStream('gzip'));
export const inflateRaw = (bytesIn) => pipe(bytesIn, new DecompressionStream('deflate-raw'));
export const gzipJSON = async (obj) => gzip(new TextEncoder().encode(JSON.stringify(obj)));
export const gunzipJSON = async (bytesIn) => JSON.parse(new TextDecoder().decode(await gunzip(bytesIn)));

/* ---------- zip files (for downloads to your computer) ---------- */
let CRC = null;
function crc32(u8, crc = 0) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
  }
  crc = ~crc;
  for (let i = 0; i < u8.length; i++) crc = CRC[(crc ^ u8[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** files: [{name, blob}] -> a .zip Blob (deflated, like Windows' "Compressed folder"). */
export async function makeZip(files) {
  const parts = [], dir = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const raw = new Uint8Array(await f.blob.arrayBuffer());
    const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(raw);
    const head = (sig, extra) => {
      const b = new DataView(new ArrayBuffer(extra ? 46 : 30));
      let p = 0;
      const u16 = (v) => { b.setUint16(p, v, true); p += 2; };
      const u32 = (v) => { b.setUint32(p, v, true); p += 4; };
      u32(sig);
      if (extra) u16(20);                                 // made by
      u16(20); u16(0x0800); u16(8); u16(dosTime); u16(dosDate); // version, UTF-8 names, deflate, time, date
      u32(crc); u32(packed.length); u32(raw.length); u16(name.length); u16(0);
      if (extra) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
      return new Uint8Array(b.buffer);
    };
    const local = head(0x04034b50, false);
    parts.push(local, name, packed);
    dir.push(head(0x02014b50, true), name);
    offset += local.length + name.length + packed.length;
  }
  const dirSize = dir.reduce((s, x) => s + x.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...dir, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* ---------- small DOM things ---------- */
export function download(name, data, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
export const ICON = {
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  down: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  up: '<path d="M12 20V9M7.5 13.5 12 9l4.5 4.5"/><path d="M5 4.5h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  code: '<path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  edit: '<path d="M4 20h4L19.5 8.5l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  save: '<path d="M5 3.5h11l3.5 3.5v13.5h-14.5z"/><path d="M8 3.5v5h7v-5M8 20.5v-6h8v6"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  db: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  chart: '<path d="M4 20h16"/><path d="M5.5 16l4-5 3 3 5.5-7.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  zoomin: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4M11 8v6M8 11h6"/>',
  zoomout: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4M8 11h6"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};
export const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;
