// Operations (lakehouse step 31): MEDUSA's own failures, and the daily copy of them to the lakehouse.
//
// server_events: one D1 table, created on first use, of the errors the server hit: answers of 500 and
// above, refused ingests (a wrong token), failed scheduled imports. It never says which account. The
// same error is stored once a minute at most (once in 6 hours for imports), and only the newest
// 2,000 rows are kept: the lakehouse has its own copy.
//
// GET /api/ops/events: the lakehouse's daily run reads, with its own read-only token
//   Authorization: Bearer <OPS_EXPORT_TOKEN>
// the error lines MEDUSA's pages reported (app_logs, level error: logs.js) and the server events, each
// after the highest id the lakehouse already has (?browser_after=&server_after=), oldest first, 500 of
// each at a time. No account is sent, and anything that looks like an email address is replaced. The
// token opens nothing else.

import { json, fail, hasBearer } from './http.js';

const KEEP = 2000;
const PAGE = 500;
const EMAIL = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[A-Za-z]{2,}/g;

let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS server_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL, area TEXT NOT NULL, msg TEXT NOT NULL, data TEXT)`).run();
  ready = true;
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(EMAIL, '[email]').slice(0, max);

/** Which part of MEDUSA an address belongs to. */
export function areaOf(path) {
  if (path.startsWith('/api/market/ingest')) return 'ingest';
  if (path.startsWith('/api/market/metrics')) return 'metrics';
  if (path.startsWith('/api/market')) return 'markets';
  return (path.split('/')[2] || 'server').slice(0, 20);
}

/** Store one server error. Never throws: failing to log must not change the answer. */
export async function recordServerEvent(env, area, msg, data = null, sameWithin = 60_000) {
  try {
    await ensure(env);
    const at = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO server_events (at, area, msg, data) SELECT ?1, ?2, ?3, ?4
        WHERE NOT EXISTS (SELECT 1 FROM server_events WHERE area = ?2 AND msg = ?3 AND at > ?1 - ?5)`)
        .bind(at, clean(area, 20) || 'server', clean(msg, 400) || 'Error', data ? clean(JSON.stringify(data), 2000) : null, sameWithin),
      env.DB.prepare('DELETE FROM server_events WHERE id <= (SELECT MAX(id) FROM server_events) - ?').bind(KEEP),
    ]);
  } catch (e) {
    console.error('server event not stored:', e && e.message);
  }
}

/** An API answer worth keeping (worker.js decides which): its error message, address and status. */
export async function noteAnswer(env, req, url, res) {
  let msg = `Answered ${res.status}`;
  try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
  await recordServerEvent(env, areaOf(url.pathname), msg, { method: req.method, path: url.pathname, status: res.status });
}

/** GET /api/ops/events: error lines and server events after the ids given, oldest first. */
export async function opsEvents(req, env, url) {
  if (!env.OPS_EXPORT_TOKEN) return fail(503, 'The ops export is not set up: the OPS_EXPORT_TOKEN secret is missing.');
  if (!(await hasBearer(req, env.OPS_EXPORT_TOKEN))) return fail(401, 'Wrong or missing token.');
  const after = (k) => { const v = Number(url.searchParams.get(k)); return Number.isSafeInteger(v) && v > 0 ? v : 0; };
  await ensure(env);
  const read = async (sql, from) => {
    try {
      return (await env.DB.prepare(sql).bind(from, PAGE).all()).results;
    } catch (e) {
      if (/no such table/i.test((e && e.message) || '')) return [];   // no page has logged anything yet
      throw e;
    }
  };
  const shape = (r) => ({ id: r.id, at: r.at, area: clean(r.area, 20), msg: clean(r.msg, 400), data: r.data ? clean(r.data, 4000) : null });
  const browser = (await read("SELECT id, at, area, msg, data FROM app_logs WHERE level = 'error' AND id > ? ORDER BY id LIMIT ?", after('browser_after'))).map(shape);
  const server = (await read('SELECT id, at, area, msg, data FROM server_events WHERE id > ? ORDER BY id LIMIT ?', after('server_after'))).map(shape);
  // The highest ids there are, so the reader can tell if they ever went back (a table made again).
  const last = async (table) => ((await read(`SELECT MAX(id) AS id FROM ${table} WHERE id > ? LIMIT ?`, 0))[0] || {}).id || 0;
  return json({ browser, server, more: browser.length === PAGE || server.length === PAGE,
    last: { browser: await last('app_logs'), server: await last('server_events') } });
}
