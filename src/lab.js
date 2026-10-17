// MEDUSA Lab on the server: three folders of files plus your strategy code, nothing else.
//
//   downloads/<account>/<id>   candles downloaded from Binance straight into MEDUSA
//   uploads/<account>/<id>     candle files you uploaded from your computer
//   results/<account>/<id>     backtest results (saved automatically after each backtest)
//
// The folders are in Workers KV (binding LAB; Cloudflare's free plan gives 1 GB, files up to 25 MB) and
// stay until you delete them in the Lab's Files tab. Their lists, and your strategy files, are in the
// D1 tables lab_datasets, lab_runs and lab_strategies. Downloading from Binance, compressing and
// backtesting all happen in the browser, so every request here stays far under the free plan's 10 ms
// of CPU: files are passed through, never parsed.
//
// Saving is safe to repeat: the browser sends a fingerprint (SHA-256) of each file and result, so saving
// the same thing twice (a double click, a retry, the same backtest run again) returns the copy already
// there instead of storing a second one. The same goes for a strategy file with the same name and code.

import { json, fail, SECURITY, readBody } from './http.js';

const MB = 1024 * 1024;
const KV_FREE = 1024 * MB;                       // Cloudflare's free Workers KV storage (1 GB)
const MAX = { dataset: 24 * MB, run: 8 * MB, code: 100 * 1024, datasets: 200, runs: 300, strategies: 60 };
const INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w']);
const FOLDER = { binance: 'downloads', upload: 'uploads' };   // a dataset's source decides its folder

/** Biggest request body each Lab route accepts (others keep the app's 64 KB). */
export function bodyLimit(path, method) {
  if (method === 'POST' && path === '/api/lab/datasets') return MAX.dataset + 64 * 1024;
  if (method === 'POST' && path === '/api/lab/runs') return MAX.run + 64 * 1024;
  if (path.startsWith('/api/lab/strategies')) return 4 * MAX.code;
  return null;
}

let tablesReady = false;
async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS lab_datasets (user_id INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
      market TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, candles INTEGER NOT NULL,
      funding INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS lab_runs (user_id INTEGER NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
      bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS lab_strategies (user_id INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id))`),
  ]);
  // Fingerprints (added later: existing tables get the column once).
  for (const t of ['lab_datasets', 'lab_runs']) {
    try { await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN hash TEXT`).run(); } catch { /* already there */ }
  }
  tablesReady = true;
}

const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
const goodId = (id) => /^[0-9a-f]{16}$/.test(id);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const int = (v, lo, hi) => (Number.isSafeInteger(v) && v >= lo && v <= hi ? v : null);
const noStorage = () => fail(503, 'Lab storage isn’t set up yet: the LAB storage (Workers KV) is missing. The README has the two commands.');
const goodHash = (h) => (/^[0-9a-f]{64}$/.test(h || '') ? h : null);
const isGzip = (buf) => buf.byteLength > 18 && new Uint8Array(buf, 0, 2).every((b, i) => b === [0x1f, 0x8b][i]);
const dsKey = (uid, row) => `${FOLDER[row.source] || 'uploads'}/${uid}/${row.id}`;
const runKey = (uid, id) => `results/${uid}/${id}`;
const quota = (env) => Math.max(1, Number(env.LAB_QUOTA_MB) || 300) * MB;
const totalCap = (env) => Math.min(KV_FREE, Math.max(1, Number(env.LAB_TOTAL_MB) || 950) * MB);

/** Storage in use: this account's files, all accounts' files, and what is left of the free 1 GB. */
async function usage(env, uid) {
  const [mine, all] = await env.DB.batch([
    env.DB.prepare('SELECT (SELECT COALESCE(SUM(bytes), 0) FROM lab_datasets WHERE user_id = ?1) + (SELECT COALESCE(SUM(bytes), 0) FROM lab_runs WHERE user_id = ?1) AS b').bind(uid),
    env.DB.prepare('SELECT (SELECT COALESCE(SUM(bytes), 0) FROM lab_datasets) + (SELECT COALESCE(SUM(bytes), 0) FROM lab_runs) AS b'),
  ]);
  const used = mine.results[0].b, total = all.results[0].b;
  return { used, quota: quota(env), total, free: Math.max(0, KV_FREE - total), limit: KV_FREE };
}

/** Reads a binary body, refusing anything over `max` even when no length was announced. */
async function readFile(req, max) {
  const buf = await req.arrayBuffer();
  if (buf.byteLength > max) return { error: fail(413, `That file is over ${Math.round(max / MB)} MB. Pick a shorter period or a bigger timeframe.`) };
  if (!isGzip(buf)) return { error: fail(400, 'That isn’t a MEDUSA Lab file.') };
  return { buf };
}

async function roomFor(env, uid, bytes) {
  const u = await usage(env, uid);
  if (u.used + bytes > u.quota) {
    return fail(413, `Your Lab storage is full (${(u.used / MB).toFixed(1)} of ${Math.round(u.quota / MB)} MB). Delete some files in the Files tab first.`);
  }
  if (u.total + bytes > totalCap(env)) return fail(507, 'The free Cloudflare storage is almost full. Delete some files in the Files tab first.');
  return null;
}

function meta(req) {
  try {
    return JSON.parse(decodeURIComponent(req.headers.get('x-lab-meta') || '')) || {};
  } catch {
    return {};
  }
}

/* ---------- everything in the three folders, in one call ---------- */

async function listFiles(env, uid) {
  const [ds, rs] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, source, market, symbol, interval, start_ts, end_ts, candles, funding, bytes, created_at FROM lab_datasets WHERE user_id = ? ORDER BY created_at DESC').bind(uid),
    env.DB.prepare('SELECT id, title, brief, bytes, created_at FROM lab_runs WHERE user_id = ? ORDER BY created_at DESC').bind(uid),
  ]);
  return json({
    datasets: ds.results.map((d) => ({ ...d, folder: FOLDER[d.source] || 'uploads' })),
    runs: rs.results.map((r) => ({ ...r, brief: JSON.parse(r.brief || '{}') })),
    usage: await usage(env, uid),
    storage: Boolean(env.LAB),
  });
}

/* ---------- Downloads and Uploads ---------- */

async function saveDataset(req, env, uid) {
  if (!env.LAB) return noStorage();
  const m = meta(req);
  const d = {
    name: text(m.name, 80), source: FOLDER[m.source] ? m.source : null, market: m.market === 'spot' ? 'spot' : m.market === 'futures' ? 'futures' : null,
    symbol: /^[A-Za-z0-9._-]{1,40}$/.test(m.symbol || '') ? m.symbol : null, interval: INTERVALS.has(m.interval) ? m.interval : null,
    start: int(m.start, 0, 9e15), end: int(m.end, 0, 9e15), candles: int(m.candles, 2, 5_000_000), funding: int(m.funding ?? 0, 0, 1_000_000),
    hash: goodHash(m.hash),
  };
  if (!d.name || !d.source || !d.market || !d.symbol || !d.interval || d.start === null || d.end === null || d.end < d.start || !d.candles || d.funding === null) {
    return fail(400, 'The file’s details are incomplete.');
  }
  if (d.hash) {                                     // the same file is already here: keep one copy
    const same = await env.DB.prepare('SELECT id, source FROM lab_datasets WHERE user_id = ? AND hash = ? AND source = ?').bind(uid, d.hash, d.source).first();
    if (same) return json({ ok: true, id: same.id, folder: FOLDER[same.source], existing: true });
  }
  const { buf, error } = await readFile(req, MAX.dataset);
  if (error) return error;
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM lab_datasets WHERE user_id = ?').bind(uid).first();
  if (count.n >= MAX.datasets) return fail(400, `You can keep up to ${MAX.datasets} data files. Delete some in the Files tab first.`);
  const full = await roomFor(env, uid, buf.byteLength);
  if (full) return full;
  const row = { id: newId(), source: d.source };
  await env.LAB.put(dsKey(uid, row), buf);
  try {
    await env.DB.prepare('INSERT INTO lab_datasets (user_id, id, name, source, market, symbol, interval, start_ts, end_ts, candles, funding, bytes, created_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid, row.id, d.name, d.source, d.market, d.symbol, d.interval, d.start, d.end, d.candles, d.funding, buf.byteLength, Date.now(), d.hash).run();
  } catch (e) {
    await env.LAB.delete(dsKey(uid, row)).catch(() => {});
    throw e;
  }
  return json({ ok: true, id: row.id, folder: FOLDER[d.source] });
}

async function blob(env, key) {
  if (!env.LAB) return noStorage();
  const body = await env.LAB.get(key, { type: 'stream' });
  if (!body) return fail(404, 'That file is no longer in your Lab.');
  return new Response(body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...SECURITY } });
}

async function renameDataset(req, env, uid, id) {
  const name = text((await readBody(req)).name, 80);
  if (!name) return fail(400, 'Type a name.');
  const r = await env.DB.prepare('UPDATE lab_datasets SET name = ? WHERE user_id = ? AND id = ?').bind(name, uid, id).run();
  return r.meta.changes ? json({ ok: true, name }) : fail(404, 'That file is no longer in your Lab.');
}

/** Deletes the given rows' files from KV, then the rows. */
async function removeDatasets(env, uid, rows) {
  if (env.LAB) for (let i = 0; i < rows.length; i += 50) await Promise.all(rows.slice(i, i + 50).map((r) => env.LAB.delete(dsKey(uid, r)).catch(() => {})));
  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(rows.slice(i, i + 50).map((r) => env.DB.prepare('DELETE FROM lab_datasets WHERE user_id = ? AND id = ?').bind(uid, r.id)));
  }
}
async function removeRuns(env, uid, ids) {
  if (env.LAB) for (let i = 0; i < ids.length; i += 50) await Promise.all(ids.slice(i, i + 50).map((id) => env.LAB.delete(runKey(uid, id)).catch(() => {})));
  for (let i = 0; i < ids.length; i += 50) {
    await env.DB.batch(ids.slice(i, i + 50).map((id) => env.DB.prepare('DELETE FROM lab_runs WHERE user_id = ? AND id = ?').bind(uid, id)));
  }
}

/* ---------- Results ---------- */

async function saveRun(req, env, uid) {
  if (!env.LAB) return noStorage();
  const m = meta(req);
  const title = text(m.title, 160);
  const brief = JSON.stringify(m.brief && typeof m.brief === 'object' ? m.brief : {});
  if (!title || brief.length > 4000) return fail(400, 'The result’s details are incomplete.');
  const hash = goodHash(m.hash);
  if (hash) {                                       // the same result is already saved (same data, strategy and settings)
    const same = await env.DB.prepare('SELECT id FROM lab_runs WHERE user_id = ? AND hash = ?').bind(uid, hash).first();
    if (same) return json({ ok: true, id: same.id, existing: true });
  }
  const { buf, error } = await readFile(req, MAX.run);
  if (error) return error;
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM lab_runs WHERE user_id = ?').bind(uid).first();
  if (count.n >= MAX.runs) return fail(400, `The Results folder holds up to ${MAX.runs} results. Delete some in the Files tab first.`);
  const full = await roomFor(env, uid, buf.byteLength);
  if (full) return full;
  const id = newId();
  await env.LAB.put(runKey(uid, id), buf);
  try {
    await env.DB.prepare('INSERT INTO lab_runs (user_id, id, title, brief, bytes, created_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(uid, id, title, brief, buf.byteLength, Date.now(), hash).run();
  } catch (e) {
    await env.LAB.delete(runKey(uid, id)).catch(() => {});
    throw e;
  }
  return json({ ok: true, id });
}

/* ---------- your strategy files ---------- */

function cleanCode(b) {
  const name = text(b.name, 60).replace(/[^\w .()-]/g, '').trim();
  const code = typeof b.code === 'string' ? b.code.replace(/\r\n?/g, '\n') : '';
  if (!name) return { error: 'Give the file a name.' };
  if (!code.trim()) return { error: 'The file is empty.' };
  if (new TextEncoder().encode(code).length > MAX.code) return { error: `Strategy files can be up to ${MAX.code / 1024} KB.` };
  return { name, code };
}

async function listStrategies(env, uid) {
  const r = await env.DB.prepare('SELECT id, name, code, created_at, updated_at FROM lab_strategies WHERE user_id = ? ORDER BY created_at').bind(uid).all();
  return json({ strategies: r.results });
}

async function saveStrategy(req, env, uid, id) {
  const c = cleanCode(await readBody(req));
  if (c.error) return fail(400, c.error);
  const now = Date.now();
  if (id) {
    const r = await env.DB.prepare('UPDATE lab_strategies SET name = ?, code = ?, updated_at = ? WHERE user_id = ? AND id = ?').bind(c.name, c.code, now, uid, id).run();
    return r.meta.changes ? json({ ok: true, id }) : fail(404, 'That strategy is no longer in your Lab.');
  }
  const same = await env.DB.prepare('SELECT id FROM lab_strategies WHERE user_id = ? AND name = ? AND code = ?').bind(uid, c.name, c.code).first();
  if (same) return json({ ok: true, id: same.id, existing: true });
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM lab_strategies WHERE user_id = ?').bind(uid).first();
  if (count.n >= MAX.strategies) return fail(400, `You can keep up to ${MAX.strategies} strategy files. Delete some first.`);
  const nid = newId();
  await env.DB.prepare('INSERT INTO lab_strategies (user_id, id, name, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(uid, nid, c.name, c.code, now, now).run();
  return json({ ok: true, id: nid });
}

/* ---------- router (signed-in only; called from worker.js) ---------- */

export async function labRoute(req, env, url, uid) {
  const path = url.pathname, method = req.method;
  await ensureTables(env);
  if (path === '/api/lab/files' && method === 'GET') return listFiles(env, uid);
  if (path === '/api/lab/datasets') {
    if (method === 'POST') return saveDataset(req, env, uid);
    if (method === 'DELETE') {                       // a whole folder: ?folder=downloads|uploads
      const folder = url.searchParams.get('folder');
      const source = Object.keys(FOLDER).find((s) => FOLDER[s] === folder);
      if (!source) return fail(400, 'Unknown folder.');
      const rows = (await env.DB.prepare('SELECT id, source FROM lab_datasets WHERE user_id = ? AND source = ?').bind(uid, source).all()).results;
      await removeDatasets(env, uid, rows);
      return json({ ok: true, deleted: rows.length });
    }
  }
  if (path === '/api/lab/runs') {
    if (method === 'POST') return saveRun(req, env, uid);
    if (method === 'DELETE') {                       // the whole Results folder
      const ids = (await env.DB.prepare('SELECT id FROM lab_runs WHERE user_id = ?').bind(uid).all()).results.map((r) => r.id);
      await removeRuns(env, uid, ids);
      return json({ ok: true, deleted: ids.length });
    }
  }
  if (path === '/api/lab/strategies') {
    if (method === 'GET') return listStrategies(env, uid);
    if (method === 'POST') return saveStrategy(req, env, uid, null);
  }
  const m = path.match(/^\/api\/lab\/(datasets|runs|strategies)\/([^/]+)$/);
  if (m && goodId(m[2])) {
    const [, kind, id] = m;
    if (kind === 'datasets') {
      const row = await env.DB.prepare('SELECT id, source FROM lab_datasets WHERE user_id = ? AND id = ?').bind(uid, id).first();
      if (method === 'GET') return row ? blob(env, dsKey(uid, row)) : fail(404, 'That file is no longer in your Lab.');
      if (method === 'PATCH') return renameDataset(req, env, uid, id);
      if (method === 'DELETE') {
        if (row) await removeDatasets(env, uid, [row]);
        return json({ ok: true });
      }
    }
    if (kind === 'runs') {
      const row = await env.DB.prepare('SELECT 1 AS x FROM lab_runs WHERE user_id = ? AND id = ?').bind(uid, id).first();
      if (method === 'GET') return row ? blob(env, runKey(uid, id)) : fail(404, 'That result is no longer in your Lab.');
      if (method === 'DELETE') {
        if (row) await removeRuns(env, uid, [id]);
        return json({ ok: true });
      }
    }
    if (kind === 'strategies') {
      if (method === 'PUT') return saveStrategy(req, env, uid, id);
      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM lab_strategies WHERE user_id = ? AND id = ?').bind(uid, id).run();
        return json({ ok: true });
      }
    }
  }
  return fail(404, 'Not found.');
}

/** Account deletion: every Lab file in KV, then the statements that delete the lists. */
export async function deleteLabData(env, uid) {
  await ensureTables(env);
  if (env.LAB) {
    const [ds, rs] = await env.DB.batch([
      env.DB.prepare('SELECT id, source FROM lab_datasets WHERE user_id = ?').bind(uid),
      env.DB.prepare('SELECT id FROM lab_runs WHERE user_id = ?').bind(uid),
    ]);
    const keys = [...ds.results.map((r) => dsKey(uid, r)), ...rs.results.map((r) => runKey(uid, r.id))];
    for (let i = 0; i < keys.length; i += 50) await Promise.all(keys.slice(i, i + 50).map((k) => env.LAB.delete(k).catch(() => {})));
  }
  return ['lab_datasets', 'lab_runs', 'lab_strategies'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(uid));
}
