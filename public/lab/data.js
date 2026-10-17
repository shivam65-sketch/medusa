// MEDUSA Lab data: downloading candles from Binance (straight from the browser), building the files
// you download to your computer (CSV, or ZIP with funding rates), reading files you upload, and the
// compact format candles are stored in on MEDUSA's server (Downloads and Uploads folders).
//
// Stored file = gzip( "MLD1" | header length | header JSON | one block per column ). Prices are kept
// exactly: each column is turned into whole numbers with its own number of decimals (from the
// exchange's text), stored as differences from the previous candle in a variable number of bytes.
// A column that can't be stored that way exactly is kept as plain 8-byte numbers instead.
// Typical size: 8-15 bytes per candle, about a fifth of a CSV file.

import { INTERVAL_MS, MAX_CANDLES, sleep, gzip, gunzip, inflateRaw, api, ymd, parseDate, makeZip } from './util.js';

/** Most candles one download to your computer may hold (a stored/backtested dataset holds MAX_CANDLES). */
export const LOCAL_MAX = 2_000_000;
/** Most lines an uploaded file may have before it is cut to MAX_CANDLES for the backtest. */
const UPLOAD_MAX = 5_000_000;

/* ---------- decimals and the column builder ---------- */

/** Decimals a number was written with: "43521.10" -> 1, "0.00001234" -> 8, "1.5e-7" -> 8, 12 -> 0. */
export function decimalsOf(s) {
  if (typeof s === 'number') s = String(s);
  let e = 0;
  const k = s.search(/[eE]/);
  if (k >= 0) { e = parseInt(s.slice(k + 1), 10) || 0; s = s.slice(0, k); }
  const dot = s.indexOf('.');
  let d = 0;
  if (dot >= 0) {
    let j = s.length - 1;
    while (j > dot && s.charCodeAt(j) === 48) j--;
    d = j - dot;
  }
  return Math.max(0, d - e);
}

const KEYS = ['t', 'o', 'h', 'l', 'c', 'v', 'tbv'];

/** Collects rows column by column, tracking each column's decimals. The first column is the time. */
class Cols {
  constructor(keys = KEYS) {
    this.keys = keys;
    this.a = Object.fromEntries(keys.map((k) => [k, []]));
    this.d = Object.fromEntries(keys.map((k) => [k, 0]));
    this.bad = 0;
  }
  /** vals: one value per key (text or number); returns false (and counts it) if any is not a number. */
  push(vals) {
    const n = this.keys.length;
    const xs = new Array(n);
    for (let j = 0; j < n; j++) {
      const s = vals[j];
      const x = typeof s === 'number' ? s : s === '' || s == null ? NaN : Number(s);
      if (!Number.isFinite(x)) { this.bad++; return false; }
      xs[j] = x;
    }
    for (let j = 0; j < n; j++) {
      const k = this.keys[j];
      this.a[k].push(xs[j]);
      if (j) { const dd = decimalsOf(vals[j]); if (dd > this.d[k]) this.d[k] = dd; }
    }
    return true;
  }
  append(other) {
    for (const k of this.keys) {
      const src = other.a[k];
      const dst = this.a[k];
      for (let i = 0; i < src.length; i++) dst.push(src[i]);
      if (other.d[k] > this.d[k]) this.d[k] = other.d[k];
    }
    this.bad += other.bad;
  }
  get length() { return this.a[this.keys[0]].length; }
  /** Sorted by time, duplicates dropped, only [lo, hi) and only finished candles. */
  finish(lo = -Infinity, hi = Infinity, stepMs = 0) {
    const t = this.a[this.keys[0]];
    let idx = [...t.keys()];
    let sorted = true;
    for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) { sorted = false; break; }
    if (!sorted) idx.sort((x, y) => t[x] - t[y]);
    const now = Date.now();
    idx = idx.filter((i, k) => t[i] >= lo && t[i] < hi && (!stepMs || t[i] + stepMs <= now) && (k === 0 || t[i] !== t[idx[k - 1]]));
    const cols = {};
    for (const key of this.keys) {
      const src = this.a[key];
      cols[key] = Float64Array.from(idx, (i) => src[i]);
    }
    return { n: idx.length, cols, decs: { ...this.d } };
  }
}

/* ---------- the stored file format ---------- */

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 16); this.n = 0; this.dv = new DataView(this.buf.buffer); }
  need(k) {
    if (this.n + k <= this.buf.length) return;
    let c = this.buf.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Uint8Array(c);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  bytes(a) { this.need(a.length); this.buf.set(a, this.n); this.n += a.length; }
  u32(v) { this.need(4); this.dv.setUint32(this.n, v, true); this.n += 4; }
  f64(v) { this.need(8); this.dv.setFloat64(this.n, v, true); this.n += 8; }
  varint(v) {
    this.need(8);
    while (v >= 128) { this.buf[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.buf[this.n++] = v;
  }
  done() { return this.buf.subarray(0, this.n); }
}

/** How a column can be stored exactly: whole numbers with d decimals ('i'), or plain numbers ('f'). */
function plan(arr, d) {
  if (!Number.isInteger(d) || d > 12) return { m: 'f' };
  const s = 10 ** d;
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (!(Math.abs(x) * s < 2 ** 51)) return { m: 'f' };
    if (Math.round(x * s) / s !== x) return { m: 'f' };
  }
  return { m: 'i', d };
}

function writeCol(w, arr, p) {
  if (p.m === 'f') { for (let i = 0; i < arr.length; i++) w.f64(arr[i]); return; }
  const s = 10 ** p.d;
  let prev = 0;
  for (let i = 0; i < arr.length; i++) {
    const k = Math.round(arr[i] * s);
    const dl = k - prev;
    w.varint(dl >= 0 ? dl * 2 : -dl * 2 - 1);
    prev = k;
  }
}

function readCol(u8, pos, n, p) {
  const out = new Float64Array(n);
  if (p.m === 'f') {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 0; i < n; i++) { out[i] = dv.getFloat64(pos, true); pos += 8; }
    return [out, pos];
  }
  const s = 10 ** p.d;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let v = 0, mul = 1, b;
    do { b = u8[pos++]; v += (b & 127) * mul; mul *= 128; } while (b & 128);
    prev += v % 2 === 0 ? v / 2 : -(v + 1) / 2;
    out[i] = prev / s;
  }
  return [out, pos];
}

/** ds = {meta, n, cols, decs, funding: {n, cols: {ft, fr}, decs} | null} -> compressed bytes. */
export async function encode(ds) {
  const keys = Object.keys(ds.cols).filter((k) => ds.cols[k] && ds.cols[k].length === ds.n);
  const plans = keys.map((k) => ({ k, ...plan(ds.cols[k], k === 't' ? 0 : ds.decs[k]) }));
  const f = ds.funding && ds.funding.n ? ds.funding : null;
  const fplans = f ? ['ft', 'fr'].map((k) => ({ k, ...plan(f.cols[k], k === 'ft' ? 0 : f.decs[k]) })) : [];
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, n: ds.n, meta: ds.meta, cols: plans, fn: f ? f.n : 0, fcols: fplans }));
  const w = new Writer();
  w.bytes([0x4d, 0x4c, 0x44, 0x31]);
  w.u32(header.length);
  w.bytes(header);
  for (const p of plans) writeCol(w, ds.cols[p.k], p);
  for (const p of fplans) writeCol(w, f.cols[p.k], p);
  return gzip(w.done());
}

/** Compressed bytes -> {meta, n, cols: {t, o, h, l, c, v, [tbv]}, funding: {ft, fr} | null}. */
export async function decode(bytesIn) {
  const u8 = await gunzip(bytesIn);
  if (u8[0] !== 0x4d || u8[1] !== 0x4c || u8[2] !== 0x44 || u8[3] !== 0x31) throw new Error('That isn’t a MEDUSA Lab data file.');
  const hl = new DataView(u8.buffer, u8.byteOffset).getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  let pos = 8 + hl;
  const cols = {};
  for (const p of h.cols) [cols[p.k], pos] = readCol(u8, pos, h.n, p);
  let funding = null;
  if (h.fn) {
    funding = {};
    for (const p of h.fcols) [funding[p.k], pos] = readCol(u8, pos, h.fn, p);
  }
  return { meta: h.meta, n: h.n, cols, funding };
}

/* ---------- zip files (Binance's archive, uploads) ---------- */

/** The files inside a zip: [{name, method, data}] (data still compressed). */
function zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('That zip file is damaged.');
  const count = dv.getUint16(e + 10, true);
  let cd = dv.getUint32(e + 16, true);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) throw new Error('That zip file is damaged.');
    const method = dv.getUint16(cd + 10, true), size = dv.getUint32(cd + 20, true);
    const nl = dv.getUint16(cd + 28, true), xl = dv.getUint16(cd + 30, true), cl = dv.getUint16(cd + 32, true);
    const name = new TextDecoder().decode(u8.subarray(cd + 46, cd + 46 + nl));
    const lh = dv.getUint32(cd + 42, true);
    const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
    if (!name.endsWith('/')) {
      if (method !== 0 && method !== 8) throw new Error('That zip file uses a compression this page can’t read.');
      out.push({ name, method, data: u8.subarray(start, start + size) });
    }
    cd += 46 + nl + xl + cl;
  }
  return out;
}

/** Text of every file inside a (small) zip. */
async function unzip(u8) {
  return Promise.all(zipEntries(u8).map(async (x) => ({ name: x.name, text: new TextDecoder().decode(x.method === 8 ? await inflateRaw(x.data) : x.data) })));
}

/* ---------- Binance ---------- */

const BINANCE = {
  futures: { api: 'https://fapi.binance.com/fapi/v1', limit: 1500, archive: 'https://data.binance.vision/data/futures/um' },
  spot: { api: 'https://api.binance.com/api/v3', limit: 1000, archive: 'https://data.binance.vision/data/spot' },
};
export const BINANCE_INTERVALS = Object.keys(INTERVAL_MS);
/** Coins offered as one-click choices (they trade on both Binance futures and spot). */
export const POPULAR = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'TRX', 'DOT', 'SUI', 'NEAR'];
/** How far back a download goes. */
export const PERIODS = [['1y', '1 year', 1], ['2y', '2 years', 2], ['3y', '3 years', 3], ['5y', '5 years', 5], ['all', 'All time', 0], ['custom', 'Custom dates', 0]];

/** [start, end) in ms for a period choice (start null = since the coin was listed, end null = now). */
/** Download range in ms: dates are days in your time zone (From's midnight to the end of To). */
export function periodRange(period, from, to) {
  if (period === 'custom') {
    const s = parseDate(from), e = parseDate(to);
    const next = e === null ? null : new Date(e).setDate(new Date(e).getDate() + 1);
    return { start: s, end: next };
  }
  const p = PERIODS.find((x) => x[0] === period);
  if (!p || !p[2]) return { start: null, end: null };
  const d = new Date();
  return { start: new Date(d.getFullYear() - p[2], d.getMonth(), d.getDate()).getTime(), end: null };
}

class Cancelled extends Error {}
export const isCancel = (e) => e instanceof Cancelled || (e && e.name === 'AbortError');

async function getJSON(url, signal) {
  for (let attempt = 0; ; attempt++) {
    if (signal && signal.aborted) throw new Cancelled('Stopped.');
    let r;
    try {
      r = await fetch(url, { signal, credentials: 'omit' });
    } catch (e) {
      if (signal && signal.aborted) throw new Cancelled('Stopped.');
      if (attempt >= 4) throw new Error('Couldn’t reach Binance. Check the internet connection and try again.');
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (r.ok) return r.json();
    if (r.status === 400 || r.status === 404) throw Object.assign(new Error(`Binance answered ${r.status}.`), { status: r.status });
    if (attempt >= 4) throw new Error(`Binance answered ${r.status}. Try again in a minute.`);
    await sleep((r.status === 418 || r.status === 429 ? 5000 : 1000) * (attempt + 1));
  }
}

/** Every USDT coin Binance trades on a market (for the coin picker), cached for 12 hours. */
const symbolCache = new Map();
export async function binanceSymbols(market) {
  if (symbolCache.has(market)) return symbolCache.get(market);
  let list = [];
  try {
    const saved = JSON.parse(localStorage.getItem('j.lab.coins.' + market) || 'null');
    if (saved && Date.now() - saved.at < 12 * 3600_000) list = saved.list;
  } catch { /* no saved list */ }
  if (!list.length) {
    try {
      const d = await getJSON(`${BINANCE[market].api}/ticker/price`);
      list = d.map((x) => x.symbol).filter((s) => /^[A-Z0-9]+USDT$/.test(s)).sort();
      try { localStorage.setItem('j.lab.coins.' + market, JSON.stringify({ at: Date.now(), list })); } catch { /* optional */ }
    } catch { list = []; }
  }
  symbolCache.set(market, list);
  return list;
}

function monthsBetween(start, end) {
  const out = [];
  const d = new Date(start);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  while (Date.UTC(y, m, 1) < end) {
    out.push({ ym: `${y}-${String(m + 1).padStart(2, '0')}`, from: Date.UTC(y, m, 1), to: Date.UTC(y, m + 1, 1) });
    m++;
    if (m === 12) { m = 0; y++; }
  }
  return out;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function klineCSV(text, cols) {
  for (const line of text.split('\n')) {
    const c0 = line.charCodeAt(0);
    if (!(c0 >= 48 && c0 <= 57)) continue;                 // header or empty line
    const f = line.split(',');
    if (f.length < 6) continue;
    let t = Number(f[0]);
    if (t > 1e14) t = Math.floor(t / 1000);               // spot files use microseconds from 2025
    cols.push([t, f[1], f[2], f[3], f[4], f[5], f.length > 9 ? f[9] : '0']);
  }
}

async function binanceRest(market, symbol, interval, start, end, signal, cols) {
  const { api: base, limit } = BINANCE[market];
  const step = INTERVAL_MS[interval];
  let t = start;
  while (t < end) {
    const batch = await getJSON(`${base}/klines?symbol=${symbol}&interval=${interval}&startTime=${t}&endTime=${end - 1}&limit=${limit}`, signal);
    if (!batch.length) break;
    for (const r of batch) cols.push([r[0], r[1], r[2], r[3], r[4], r[5], r[9]]);
    const nxt = batch[batch.length - 1][0] + step;
    if (nxt <= t || batch.length < limit) break;
    t = nxt;
  }
}

/** First candle Binance has for a symbol (its listing). */
export async function binanceListed(market, symbol, signal) {
  let rows;
  try {
    rows = await getJSON(`${BINANCE[market].api}/klines?symbol=${symbol}&interval=1d&startTime=0&limit=1`, signal);
  } catch (e) {
    if (e.status === 400) throw new Error(`Binance doesn’t have ${symbol} on ${market}. Check the name (for example BTCUSDT).`);
    throw e;
  }
  if (!rows.length) throw new Error(`Binance has no candles for ${symbol}.`);
  return rows[0][0] > 1e14 ? Math.floor(rows[0][0] / 1000) : rows[0][0];
}

async function binanceFunding(symbol, start, end, signal, say) {
  const f = new Cols(['ft', 'fr']);
  const months = monthsBetween(start, end);
  const now = Date.now();
  let done = 0;
  const parts = await pool(months, 4, async (mo) => {
    const part = new Cols(['ft', 'fr']);
    let got = false;
    if (mo.to <= now - 3_600_000) {
      try {
        const r = await fetch(`${BINANCE.futures.archive}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${mo.ym}.zip`, { signal, credentials: 'omit' });
        if (r.ok) {
          for (const { text } of await unzip(new Uint8Array(await r.arrayBuffer()))) {
            for (const line of text.split('\n')) {
              if (!/^\d/.test(line)) continue;
              const x = line.split(',');
              part.push([Math.round(Number(x[0]) / 60_000) * 60_000, x[2]]);
            }
          }
          got = true;
        }
      } catch (e) { if (isCancel(e)) throw e; }
    }
    if (!got) {
      let t = mo.from;
      const stop = Math.min(mo.to, now);
      while (t < stop) {
        let batch = [];
        try { batch = await getJSON(`${BINANCE.futures.api}/fundingRate?symbol=${symbol}&startTime=${t}&endTime=${stop - 1}&limit=1000`, signal); } catch (e) { if (isCancel(e)) throw e; }
        if (!batch.length) break;
        for (const b of batch) part.push([Math.round(Number(b.fundingTime) / 60_000) * 60_000, b.fundingRate]);
        t = Number(batch[batch.length - 1].fundingTime) + 1;
        if (batch.length < 1000) break;
      }
    }
    say(++done / months.length);
    return part;
  });
  for (const p of parts) f.append(p);
  const out = f.finish(start - 8 * 3_600_000, end + 8 * 3_600_000);
  return { n: out.n, cols: out.cols, decs: out.decs };
}

/** Candles (and funding rates) from Binance for [start, end); say(fraction, text) reports progress. */
export async function fromBinance({ market, symbol, interval, start, end, funding, max = MAX_CANDLES }, say, signal) {
  const step = INTERVAL_MS[interval];
  say(0, 'Finding when Binance listed ' + symbol);
  const listed = await binanceListed(market, symbol, signal);
  const now = Date.now();
  const lo = Math.max(start || listed, listed);
  const hi = Math.min(end || now, now);
  if (hi - lo < 2 * step) throw new Error('That period is empty, or before Binance listed the coin.');
  if ((hi - lo) / step > max) throw new Error(tooMany(lo, hi, step, max));
  const months = monthsBetween(lo, hi);
  let done = 0;
  const parts = await pool(months, 4, async (mo) => {
    const part = new Cols();
    let got = false;
    if (mo.to <= now - 3_600_000) {
      try {
        const r = await fetch(`${BINANCE[market].archive}/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${mo.ym}.zip`, { signal, credentials: 'omit' });
        if (r.ok) {
          for (const { text } of await unzip(new Uint8Array(await r.arrayBuffer()))) klineCSV(text, part);
          got = part.length > 0;
        }
      } catch (e) { if (isCancel(e)) throw e; }
    }
    if (!got) await binanceRest(market, symbol, interval, Math.max(mo.from, lo), Math.min(mo.to, hi), signal, part);
    done++;
    say((funding ? 0.85 : 0.97) * done / months.length, `Candles: ${done} of ${months.length} months`);
    return part;
  });
  const all = new Cols();
  for (const p of parts) all.append(p);
  const ds = all.finish(lo, hi, step);
  if (ds.n < 2) throw new Error('Binance returned no candles for that period.');
  let f = null;
  if (funding && market === 'futures') {
    f = await binanceFunding(symbol, ds.cols.t[0], ds.cols.t[ds.n - 1] + step, signal, (x) => say(0.85 + 0.12 * x, 'Funding rates'));
  }
  return { ...ds, funding: f, meta: { symbol, market, source: 'binance', interval } };
}

export const tooMany = (lo, hi, step, max = MAX_CANDLES) =>
  `That is about ${Math.round((hi - lo) / step).toLocaleString('en-US')} candles; the limit here is ${max.toLocaleString('en-US')}. Pick a shorter period or a bigger timeframe.`;

/* ---------- files for your computer ---------- */

/** "BTCUSDT-futures-1h-2021-10-04-to-2026-10-04": the name tells the upload what the file holds. */
export const fileBase = (ds) => `${ds.meta.symbol}-${ds.meta.market}-${ds.meta.interval}-${ymd(ds.cols.t[0])}-to-${ymd(ds.cols.t[ds.n - 1])}`;

export function candlesCSV(d) {
  const keys = ['o', 'h', 'l', 'c', 'v', 'tbv'].filter((k) => d.cols[k]);
  const names = { o: 'open', h: 'high', l: 'low', c: 'close', v: 'volume', tbv: 'taker_buy_volume' };
  const parts = ['open_time_utc,open_time_ms,' + keys.map((k) => names[k]).join(',') + '\n'];
  let chunk = '';
  for (let i = 0; i < d.n; i++) {
    chunk += new Date(d.cols.t[i]).toISOString().slice(0, 19).replace('T', ' ') + ',' + d.cols.t[i];
    for (const k of keys) chunk += ',' + d.cols[k][i];
    chunk += '\n';
    if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return new Blob(parts, { type: 'text/csv' });
}

function fundingCSV(f) {
  let out = 'funding_time_utc,funding_time_ms,funding_rate\n';
  for (let i = 0; i < f.ft.length; i++) out += `${new Date(f.ft[i]).toISOString().slice(0, 19).replace('T', ' ')},${f.ft[i]},${f.fr[i]}\n`;
  return new Blob([out], { type: 'text/csv' });
}

/** The file a download to your computer saves: CSV (candles only) or ZIP (candles + funding rates). */
export async function localFile(ds, format) {
  const base = fileBase(ds);
  const candles = candlesCSV(ds);
  if (format === 'csv') return { name: `${base}.csv`, blob: candles };
  const files = [{ name: `${base}.csv`, blob: candles }];
  const f = ds.funding && (ds.funding.cols ? ds.funding.cols : ds.funding);
  if (f && f.ft && f.ft.length) files.push({ name: `${ds.meta.symbol}-${ds.meta.market}-funding-${ymd(ds.cols.t[0])}-to-${ymd(ds.cols.t[ds.n - 1])}.csv`, blob: fundingCSV(f) });
  return { name: `${base}.zip`, blob: await makeZip(files) };
}

/* ---------- uploaded files ---------- */

const NAMES = {
  t: ['open_time', 'opentime', 'open time', 'open_time_ms', 'time', 'timestamp', 'date', 'datetime', 'date_time', 'unix', 'ts', 'open_time_utc', 'time_utc'],
  o: ['open', 'o'], h: ['high', 'h'], l: ['low', 'l'], c: ['close', 'c', 'price'],
  v: ['volume', 'vol', 'v', 'base_volume', 'volume_base'],
  tbv: ['taker_buy_volume', 'taker_buy_base_asset_volume', 'taker buy base asset volume', 'taker_buy_base_volume'],
};
const FUNDING_TIME = ['funding_time_ms', 'funding_time', 'fundingtime', 'calc_time', 'funding_time_utc', 'time'];
const FUNDING_RATE = ['funding_rate', 'fundingrate', 'last_funding_rate', 'rate'];

function toMs(s) {
  const x = Number(s);
  if (s !== '' && Number.isFinite(x)) return x > 1e14 ? Math.floor(x / 1000) : x > 1e11 ? x : x * 1000;
  let text = String(s).trim().replace(/^"|"$/g, '');
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(text)) text = text.replace(' ', 'T') + (text.length === 10 ? 'T00:00:00Z' : 'Z');
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : NaN;
}

/** Feeds a text stream to fn one line at a time (never holds a whole big file as one string). */
async function eachLine(stream, fn) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (rest + value).split('\n');
    rest = lines.pop();
    for (const l of lines) fn(l);
  }
  if (rest) fn(rest);
}

/** A CSV reader that works out the layout from the first line: candles (with or without a header) or funding rates. */
function csvReader(cols, fund) {
  let delim = null, map = null, kind = null, rows = 0;
  const unq = (x) => x.trim().replace(/^"|"$/g, '');
  return {
    get kind() { return kind; },
    get rows() { return rows; },
    line(raw) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) return;
      if (delim === null) {
        delim = [',', ';', '\t'].map((d) => [d, line.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
        const head = line.split(delim).map((x) => unq(x).toLowerCase());
        const header = head.filter((x) => x !== '' && !Number.isFinite(Number(x))).length >= 2 && !/^\d{4}-\d{2}-\d{2}/.test(head[0]);
        if (header && head.some((h) => FUNDING_RATE.includes(h))) {
          kind = 'funding';
          map = { t: head.findIndex((h) => FUNDING_TIME.includes(h)), r: head.findIndex((h) => FUNDING_RATE.includes(h)) };
          if (map.t < 0) throw new Error('A funding-rate file needs a time column.');
          return;
        }
        kind = 'candles';
        if (header) {
          map = {};
          for (const [k, names] of Object.entries(NAMES)) {
            // prefer the millisecond column when a file has both a readable time and milliseconds
            const order = k === 't' ? ['open_time_ms', ...names] : names;
            const i = order.map((nm) => head.indexOf(nm)).find((x) => x >= 0);
            if (i !== undefined) map[k] = i;
          }
          if (map.t === undefined || map.c === undefined) throw new Error('Couldn’t find the time and close columns in the file’s header line.');
          for (const k of ['o', 'h', 'l']) if (map[k] === undefined) map[k] = map.c;
          return;
        }
        const width = head.length;
        if (width < 5) throw new Error('Each line needs at least time, open, high, low and close.');
        map = { t: 0, o: 1, h: 2, l: 3, c: 4 };
        if (width >= 6) map.v = 5;
        if (width >= 10) map.tbv = 9;                        // Binance's kline layout
      }
      const f = line.split(delim);
      if (kind === 'funding') {
        if (fund.push([Math.round(toMs(unq(f[map.t])) / 60_000) * 60_000, unq(f[map.r] || '')])) rows++;
        return;
      }
      const g = (k) => (map[k] !== undefined ? unq(f[map[k]] || '') : '0');
      if (cols.push([toMs(unq(f[map.t] || '')), g('o'), g('h'), g('l'), g('c'), g('v'), g('tbv')])) rows++;
      if (cols.length > UPLOAD_MAX) throw new Error(`That file has more than ${UPLOAD_MAX.toLocaleString('en-US')} lines, more than a browser can handle. Split it into smaller files.`);
    },
  };
}

/** What a file name says about its contents (our downloads and Binance's archive files are named that way). */
export function guessFromName(name) {
  const n = name.replace(/\.(csv|txt|zip)$/i, '');
  let m = n.match(/^([A-Z0-9]{2,30})-(futures|spot)-(\d+[mhdw])-/i);
  if (m) return { symbol: m[1].toUpperCase(), market: m[2].toLowerCase(), interval: m[3].toLowerCase() };
  m = n.match(/^([A-Z0-9]{2,30})-(\d+[mhdw])-\d{4}/i);
  if (m) return { symbol: m[1].toUpperCase(), market: '', interval: m[2].toLowerCase() };
  m = n.toUpperCase().match(/^([A-Z0-9]{2,30}?)(?:[-_ .](?:\d+[MHDW]|SPOT|PERP|FUTURES)|[-_ ]\d{4})/);
  return { symbol: m ? m[1] : '', market: /spot/i.test(n) ? 'spot' : /futures|perp/i.test(n) ? 'futures' : '', interval: '' };
}

/** Reads uploaded CSV / ZIP files (candles, and funding-rate files if included) into one dataset. */
export async function fromFiles(files, say = () => {}) {
  const cols = new Cols();
  const fund = new Cols(['ft', 'fr']);
  for (const [k, file] of files.entries()) {
    say(k / files.length, `Reading ${file.name}`);
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const streams = [];
    if (head[0] === 0x50 && head[1] === 0x4b) {
      for (const e of zipEntries(new Uint8Array(await file.arrayBuffer()))) {
        if (!/\.(csv|txt)$/i.test(e.name)) continue;
        const s = new Blob([e.data]).stream();
        streams.push({ name: e.name, stream: e.method === 8 ? s.pipeThrough(new DecompressionStream('deflate-raw')) : s });
      }
      if (!streams.length) throw new Error(`${file.name} has no CSV file inside.`);
    } else streams.push({ name: file.name, stream: file.stream() });
    for (const { name, stream } of streams) {
      const r = csvReader(cols, fund);
      await eachLine(stream, (l) => r.line(l));
      if (!r.rows) throw new Error(`No ${r.kind === 'funding' ? 'funding rates' : 'candles'} found in ${name}.`);
    }
  }
  say(1, 'Sorting');
  const ds = cols.finish();
  if (ds.n < 2) throw new Error('The files hold fewer than 2 candles.');
  if (!ds.cols.tbv.some((x) => x !== 0)) delete ds.cols.tbv;
  const f = fund.length ? fund.finish() : null;
  const gaps = [];
  for (let i = 1; i < ds.n; i += Math.max(1, Math.floor(ds.n / 2000))) gaps.push(ds.cols.t[i] - ds.cols.t[i - 1]);
  gaps.sort((a, b) => a - b);
  const typical = gaps[Math.floor(gaps.length / 2)];
  const interval = Object.keys(INTERVAL_MS).find((x) => INTERVAL_MS[x] === typical) || null;
  return { ...ds, funding: f && f.n ? f : null, interval, typicalGap: typical, skipped: cols.bad, guess: guessFromName(files[0].name) };
}

/** The part of a dataset from lo to hi (ms, hi exclusive), funding rates included. */
export function slice(ds, lo, hi) {
  const t = ds.cols.t;
  let a = 0, b = ds.n;
  while (a < b && t[a] < lo) a++;
  while (b > a && t[b - 1] >= hi) b--;
  const cols = Object.fromEntries(Object.entries(ds.cols).map(([k, v]) => [k, v.slice(a, b)]));
  let funding = ds.funding;
  if (funding && funding.n) {
    const ft = funding.cols.ft;
    const keep = [];
    for (let i = 0; i < ft.length; i++) if (ft[i] >= lo - 8 * 3_600_000 && ft[i] < hi + 8 * 3_600_000) keep.push(i);
    funding = { ...funding, n: keep.length, cols: { ft: Float64Array.from(keep, (i) => ft[i]), fr: Float64Array.from(keep, (i) => funding.cols.fr[i]) } };
  }
  return { ...ds, n: b - a, cols, funding };
}

/* ---------- the Downloads and Uploads folders on MEDUSA, with a small memory cache ---------- */

const cache = new Map();
export async function loadDataset(id) {
  if (cache.has(id)) return cache.get(id);
  const r = await api('GET', `/api/lab/datasets/${id}`, { raw: true });
  const d = await decode(new Uint8Array(await r.arrayBuffer()));
  cache.set(id, d);
  while (cache.size > 4) cache.delete(cache.keys().next().value);
  return d;
}
export const forget = (id) => (id ? cache.delete(id) : cache.clear());

/** Hex SHA-256 of bytes or text: the fingerprint that keeps repeated saves from making copies. */
export async function sha256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Saves a dataset in MEDUSA (source "binance" → Downloads folder, "upload" → Uploads folder). */
export async function saveDataset(ds, name) {
  const file = await encode(ds);
  const meta = {
    name, source: ds.meta.source, market: ds.meta.market, symbol: ds.meta.symbol, interval: ds.meta.interval,
    start: ds.cols.t[0], end: ds.cols.t[ds.n - 1], candles: ds.n, funding: ds.funding ? ds.funding.n : 0,
    hash: await sha256(file),                   // the same file twice is kept once (the server returns the copy it has)
  };
  const r = await api('POST', '/api/lab/datasets', { body: file, meta });
  cache.set(r.id, await decode(file));
  while (cache.size > 4) cache.delete(cache.keys().next().value);
  return { id: r.id, bytes: file.length, existing: Boolean(r.existing) };
}
