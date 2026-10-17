// The Logs tab's server side: short lines about what happened in the app (more with detailed logging on).
// One D1 table, app_logs, created on first use. The Logs "folder" shows one file per day (your local day);
// you can read, download or delete a day, or delete everything. Each line carries an id made in the browser,
// so a batch sent twice (a retry) is stored once. Nothing secret is ever logged (the browser removes it).

import { json, fail, readBody } from './http.js';

const MAX_ROWS = 20000;          // per account: the oldest lines go first
const MAX_BATCH = 100;
const LEVELS = new Set(['info', 'debug', 'error']);

let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, cid TEXT NOT NULL,
      day TEXT NOT NULL, at INTEGER NOT NULL, level TEXT NOT NULL, area TEXT NOT NULL, msg TEXT NOT NULL, data TEXT, UNIQUE (user_id, cid))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS app_logs_day ON app_logs (user_id, day, at)'),
  ]);
  ready = true;
}

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, max) : '');
const goodDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

function dayOf(at, tzMin) {
  const d = new Date(at + tzMin * 60_000);
  return d.toISOString().slice(0, 10);
}

async function addLines(req, env, uid) {
  const b = await readBody(req);
  const tz = Number.isInteger(b.tz) && Math.abs(b.tz) <= 14 * 60 ? b.tz : 0;
  const rows = (Array.isArray(b.entries) ? b.entries : []).slice(0, MAX_BATCH).map((e) => ({
    cid: /^[A-Za-z0-9]{8,32}$/.test(e.cid || '') ? e.cid : null,
    at: Number.isSafeInteger(e.at) && e.at > 1.5e12 && e.at < Date.now() + 86_400_000 ? e.at : Date.now(),
    level: LEVELS.has(e.level) ? e.level : 'info',
    area: text(e.area, 20) || 'app',
    msg: text(e.msg, 400),
    data: e.data && typeof e.data === 'object' ? JSON.stringify(e.data).slice(0, 2000) : null,
  })).filter((r) => r.cid && r.msg);
  if (!rows.length) return json({ ok: true, added: 0 });
  await env.DB.batch(rows.map((r) => env.DB.prepare('INSERT OR IGNORE INTO app_logs (user_id, cid, day, at, level, area, msg, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(uid, r.cid, dayOf(r.at, tz), r.at, r.level, r.area, r.msg, r.data)));
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM app_logs WHERE user_id = ?').bind(uid).first()).n;
  if (n > MAX_ROWS) {
    await env.DB.prepare('DELETE FROM app_logs WHERE id IN (SELECT id FROM app_logs WHERE user_id = ? ORDER BY at, id LIMIT ?)').bind(uid, n - MAX_ROWS).run();
  }
  return json({ ok: true, added: rows.length });
}

export async function logsRoute(req, env, url, uid) {
  await ensure(env);
  const method = req.method;
  const day = url.searchParams.get('day');
  if (method === 'POST') return addLines(req, env, uid);
  if (method === 'GET' && !day) {
    const r = await env.DB.prepare(`SELECT day, COUNT(*) AS n, SUM(level = 'error') AS errors, SUM(level = 'debug') AS debug, MIN(at) AS first, MAX(at) AS last
      FROM app_logs WHERE user_id = ? GROUP BY day ORDER BY day DESC`).bind(uid).all();
    return json({ days: r.results, max: MAX_ROWS });
  }
  if (method === 'GET') {
    if (!goodDay(day)) return fail(400, 'Unknown day.');
    const r = await env.DB.prepare('SELECT at, level, area, msg, data FROM app_logs WHERE user_id = ? AND day = ? ORDER BY at, id LIMIT 5000').bind(uid, day).all();
    return json({ day, lines: r.results.map((x) => ({ ...x, data: x.data ? JSON.parse(x.data) : null })) });
  }
  if (method === 'DELETE') {
    if (day && !goodDay(day)) return fail(400, 'Unknown day.');
    const r = day ? await env.DB.prepare('DELETE FROM app_logs WHERE user_id = ? AND day = ?').bind(uid, day).run()
      : await env.DB.prepare('DELETE FROM app_logs WHERE user_id = ?').bind(uid).run();
    return json({ ok: true, deleted: r.meta.changes });
  }
  return fail(404, 'Not found.');
}

/** Account deletion: the statement that removes this account's logs. */
export async function deleteLogs(env, uid) {
  await ensure(env);
  return env.DB.prepare('DELETE FROM app_logs WHERE user_id = ?').bind(uid);
}
