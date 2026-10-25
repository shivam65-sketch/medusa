// Saving the Markets page's definitions to the lakehouse (lakehouse step 28).
//
// The master copy of every definition is in Databricks (market.semantic): the shared versions every
// account uses (metric_definitions) and each account's own versions (user_metric_definitions). The page
// edits and previews a definition on its own screen; Save comes here, and this file:
//   1. checks the SQL with the same rules as the page and the lakehouse's dbt tests,
//   2. signs in to Databricks as the service principal medusa-markets-writer (OAuth client credentials,
//      scope sql), which may only use the SQL warehouse and read and change those two tables,
//   3. runs one MERGE that closes the current version and adds the next, with the SQL and every other
//      value sent as parameters: stored as data, never run by Databricks,
//   4. copies the new current version into D1 (market_user_metrics; or for a shared version
//      market_metrics and the scanner's ready-made answer), so the page uses it at once.
// The owner's account (MARKET_OWNER_ID) saves the shared version; every other account its own.
//
// Secrets: DATABRICKS_HOST, DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET, MARKET_OWNER_ID, and
// optionally DATABRICKS_WAREHOUSE_ID (otherwise the warehouse is found by its name). Without the first
// three, saving is off and the page only previews.

import { json, fail, readBody } from './http.js';
import { rebuildAnswer } from './market.js';

const WAREHOUSE_NAME = 'Serverless Starter Warehouse';
const SHARED_TABLE = 'market.semantic.metric_definitions';
const OWN_TABLE = 'market.semantic.user_metric_definitions';
const PARAMS = ['kind', 'yesterday', 'symbol'];
const DAY = 86_400_000;
const LIMITS = { account: 20, all: 300 };   // saves a day, per account and in all: each one wakes the warehouse

export const canSave = (env) => Boolean(env.DATABRICKS_HOST && env.DATABRICKS_CLIENT_ID && env.DATABRICKS_CLIENT_SECRET);
const isOwner = (env, uid) => env.MARKET_OWNER_ID != null && String(env.MARKET_OWNER_ID).trim() === String(uid);
const noTable = (e) => /no such table/i.test(String(e && e.message));

/** What stops SQL from being saved: the page's own rules (markets.js sqlProblems), which are the
 * lakehouse's dbt tests (assert_*metric_definitions_valid): one read-only statement, with the page's
 * parameters only. */
function sqlProblem(sql) {
  if (!sql.replace(/--[^\n]*/g, '').trim()) return 'The query is empty.';
  if (sql.length > 20000) return 'The query is longer than 20,000 characters.';
  if (!/^(SELECT|WITH)[^A-Z0-9_]/i.test(sql.trim())) return 'A query must start with SELECT or WITH, so it can only read (a comment can go after that word, not before it).';
  if (sql.includes(';')) return 'Only one statement, so no ; anywhere.';
  const unknown = [...new Set([...sql.replace(/--[^\n]*/g, '').matchAll(/(?<![\w:]):([A-Za-z_]\w*)/g)].map((m) => m[1]))].filter((p) => !PARAMS.includes(p));
  if (unknown.length) return `${unknown.map((p) => `:${p}`).join(', ')} isn't a parameter the page fills in (it has :kind, :yesterday and :symbol).`;
  return null;
}

/* ---------- Databricks: sign in, and run one statement ---------- */

class DbxError extends Error {}
// Always https, except a stand-in server on this computer for local tests.
const host = (env) => {
  const h = String(env.DATABRICKS_HOST).trim().replace(/\/+$/, '');
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(h) ? h : `https://${h.replace(/^https?:\/\//, '')}`;
};

async function call(env, token, path, body) {
  const init = { headers: { authorization: `Bearer ${token}` } };
  if (body) Object.assign(init, { method: 'POST', body: JSON.stringify(body), headers: { ...init.headers, 'content-type': 'application/json' } });
  let r;
  try { r = await fetch(`${host(env)}${path}`, init); } catch { throw new DbxError('Databricks couldn\'t be reached.'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new DbxError(`Databricks answered ${r.status} (${d.message || d.error_code || 'no reason given'}).`);
  return d;
}

/** A one-hour token for the service principal, and the warehouse it may use. */
async function connect(env) {
  let r;
  try {
    r = await fetch(`${host(env)}/oidc/v1/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${env.DATABRICKS_CLIENT_ID}:${env.DATABRICKS_CLIENT_SECRET}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=sql',
    });
  } catch {
    throw new DbxError('Databricks couldn\'t be reached.');
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new DbxError(`Databricks refused MEDUSA's sign-in (${d.error_description || d.error || r.status}).`);
  const conn = { token: d.access_token, wh: env.DATABRICKS_WAREHOUSE_ID || null };
  if (!conn.wh) {
    const w = ((await call(env, conn.token, '/api/2.0/sql/warehouses')).warehouses || []).find((x) => x.name === WAREHOUSE_NAME);
    if (!w) throw new DbxError(`MEDUSA's Databricks login can't use the ${WAREHOUSE_NAME} (it needs Can use on it).`);
    conn.wh = w.id;
  }
  return conn;
}

/** Run one statement with named parameters ({name: [type, value]}; a null value is NULL) and return its
 * rows as objects (every value as text). Waits while the warehouse wakes up: about a minute and a half. */
async function run(env, conn, statement, params) {
  const parameters = Object.entries(params).map(([name, [type, value]]) => (value == null ? { name, type } : { name, type, value: String(value) }));
  let r = await call(env, conn.token, '/api/2.0/sql/statements', {
    warehouse_id: conn.wh, statement, parameters, wait_timeout: '50s', on_wait_timeout: 'CONTINUE', format: 'JSON_ARRAY', disposition: 'INLINE',
  });
  for (let i = 0; i < 15 && ['PENDING', 'RUNNING'].includes(r.status && r.status.state); i++) {
    await new Promise((done) => setTimeout(done, 3000));
    r = await call(env, conn.token, `/api/2.0/sql/statements/${r.statement_id}`);
  }
  const state = r.status && r.status.state;
  if (state === 'PENDING' || state === 'RUNNING') throw new DbxError('Databricks took too long to answer.');
  if (state !== 'SUCCEEDED') throw new DbxError(`Databricks couldn't run it (${(r.status && r.status.error && r.status.error.message) || state}).`);
  const cols = r.manifest.schema.columns.map((c) => c.name);
  return ((r.result && r.result.data_array) || []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

/* ---------- the statements (every value is a parameter) ---------- */

// The account's current version is closed and the next one added in one MERGE, so the two can't half
// happen. :base is the version the page edited (0: the account had none in use); if the account's
// current version is no longer that one, the source is empty and nothing changes.
const SAVE_OWN = `MERGE INTO ${OWN_TABLE} AS t
USING (
  WITH cur AS (
    SELECT coalesce(max(version), 0) AS last_v,
           coalesce(max(CASE WHEN is_current THEN version END), 0) AS current_v
    FROM ${OWN_TABLE}
    WHERE account_id = :account_id AND metric_id = :metric_id
  )
  SELECT :account_id AS account_id, :metric_id AS metric_id, current_v AS version, 'close' AS step FROM cur
  WHERE current_v > 0 AND current_v = :base
  UNION ALL
  SELECT :account_id, :metric_id, last_v + 1, 'add' FROM cur
  WHERE current_v = :base
) AS s
ON t.account_id = s.account_id AND t.metric_id = s.metric_id AND t.version = s.version AND s.step = 'close'
WHEN MATCHED THEN UPDATE SET valid_to = current_timestamp(), is_current = false
WHEN NOT MATCHED AND s.step = 'add' THEN INSERT
  (account_id, metric_id, version, sql_text, description, based_on, valid_from, valid_to, is_current, changed_by, change_note)
  VALUES (s.account_id, s.metric_id, s.version, :sql_text, :description, :based_on, current_timestamp(), NULL, true, :changed_by, :change_note)`;

// The same for a shared definition: its kind, name and display carry over from the version in use.
const SAVE_SHARED = `MERGE INTO ${SHARED_TABLE} AS t
USING (
  WITH cur AS (
    SELECT max(version) AS last_v,
           coalesce(max(CASE WHEN is_current THEN version END), 0) AS current_v,
           max_by(kind, version) AS kind, max_by(name, version) AS name, max_by(display, version) AS display
    FROM ${SHARED_TABLE}
    WHERE metric_id = :metric_id
  )
  SELECT :metric_id AS metric_id, current_v AS version, 'close' AS step, kind, name, display FROM cur
  WHERE current_v > 0 AND current_v = :base
  UNION ALL
  SELECT :metric_id, last_v + 1, 'add', kind, name, display FROM cur
  WHERE current_v = :base AND last_v IS NOT NULL
) AS s
ON t.metric_id = s.metric_id AND t.version = s.version AND s.step = 'close'
WHEN MATCHED THEN UPDATE SET valid_to = current_timestamp(), is_current = false
WHEN NOT MATCHED AND s.step = 'add' THEN INSERT
  (metric_id, version, kind, name, description, sql_text, display, valid_from, valid_to, is_current, changed_by, change_note)
  VALUES (s.metric_id, s.version, s.kind, s.name, :description, :sql_text, s.display, current_timestamp(), NULL, true, :changed_by, :change_note)`;

const READ_OWN = `SELECT version, date_format(valid_from, 'yyyy-MM-dd HH:mm:ss') AS valid_from
FROM ${OWN_TABLE} WHERE account_id = :account_id AND metric_id = :metric_id AND is_current`;

const READ_SHARED = `SELECT metric_id, version, kind, name, description, sql_text, display,
       date_format(valid_from, 'yyyy-MM-dd HH:mm:ss') AS valid_from, changed_by, change_note
FROM ${SHARED_TABLE} WHERE metric_id = :metric_id AND is_current`;

// Back to the shared definition: the account's current version is closed and none added.
const RESET_OWN = `UPDATE ${OWN_TABLE} SET valid_to = current_timestamp(), is_current = false
WHERE account_id = :account_id AND metric_id = :metric_id AND is_current AND version = :base`;

// A deleted account's versions go with it.
const FORGET_OWN = `DELETE FROM ${OWN_TABLE} WHERE account_id = :account_id`;

/* ---------- the account's side ---------- */

/** The name the account gave in MEDUSA (shown on its versions), or "account N": never its email. */
async function nameOf(env, uid) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE user_id = ? AND k = 'settings'").bind(uid).first();
  let name = '';
  try { name = String(JSON.parse(row.v).name || '').trim(); } catch { /* no name set */ }
  return (name || `account ${uid}`).slice(0, 40);
}

/** A save (or giving one up) counts against the account's and everyone's allowance for the day. */
async function overLimit(env, uid) {
  const since = Date.now() - DAY;
  const [mine, all] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE kind = 'metricSave' AND key = ? AND ts > ?").bind(String(uid), since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE kind = 'metricSave' AND ts > ?").bind(since),
  ]);
  if (mine.results[0].n >= LIMITS.account) return `You've saved ${LIMITS.account} times today, the most a day. Try again tomorrow.`;
  if (all.results[0].n >= LIMITS.all) return 'MEDUSA has saved as many definitions today as it allows for everyone. Try again tomorrow.';
  await env.DB.prepare("INSERT INTO attempts (kind, key, ts) VALUES ('metricSave', ?, ?)").bind(String(uid), Date.now()).run();
  return null;
}

/** GET /api/market/metrics/mine: the account's own versions in use, and what Save does for it. */
export async function myMetrics(env, user) {
  let rows = [];
  try {
    rows = (await env.DB.prepare('SELECT metric_id, version, sql_text, description, based_on, valid_from, changed_by, change_note FROM market_user_metrics WHERE user_id = ?')
      .bind(user.id).all()).results;
  } catch (e) {
    if (!noTable(e)) throw e;   // before migration 005 there are none
  }
  return json({ rows, canSave: canSave(env), saves: isOwner(env, user.id) ? 'shared' : 'own', name: await nameOf(env, user.id) });
}

/** POST /api/market/metrics/save {metric_id, sql_text, description, note, base}: a new version in
 * Databricks, then in MEDUSA's copy. base is the version the page edited: the account's own version in
 * use (0 for none), or for the owner the shared version in use. */
export async function saveMetric(req, env, user) {
  if (!canSave(env)) return fail(503, 'Saving isn\'t set up on this MEDUSA (its Databricks secrets are missing). Preview still works.');
  const b = await readBody(req);
  const id = String(b.metric_id || '');
  const sqlText = String(b.sql_text || '').replace(/[\s;]+$/, '');
  const problem = sqlProblem(sqlText);
  if (problem) return fail(400, problem);
  if (!Number.isInteger(b.base) || b.base < 0) return fail(400, 'Which version was edited is missing.');
  const note = String(b.note || '').trim().slice(0, 300) || 'Changed on the Markets page';
  const described = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 1000) : null;
  let shared;
  try {
    shared = await env.DB.prepare('SELECT metric_id, version, description FROM market_metrics WHERE metric_id = ?').bind(id).first();
  } catch (e) {
    if (noTable(e)) return fail(409, 'The lakehouse\'s definitions haven\'t been published to MEDUSA yet.');
    throw e;
  }
  if (!shared) return fail(404, 'There is no definition with that name.');
  const limited = await overLimit(env, user.id);
  if (limited) return fail(429, limited);
  const owner = isOwner(env, user.id), who = await nameOf(env, user.id);
  const text = (v) => ['STRING', v];

  try {
    const conn = await connect(env);
    if (owner) {
      const [m] = await run(env, conn, SAVE_SHARED, {
        metric_id: text(id), base: ['INT', b.base], sql_text: text(sqlText), description: text(described ?? shared.description),
        changed_by: text(who), change_note: text(note),
      });
      if (Number(m.num_inserted_rows) !== 1) return fail(409, `The shared definition changed since this window loaded it (it was version ${b.base}). Reload the window to see the new one; your text is kept until you close it.`);
      const [row] = await run(env, conn, READ_SHARED, { metric_id: text(id) });
      const def = { ...row, version: Number(row.version) };
      let copied = true;
      try {
        await env.DB.prepare(`INSERT INTO market_metrics (metric_id, version, kind, name, description, sql_text, display, valid_from, changed_by, change_note)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
          ON CONFLICT(metric_id) DO UPDATE SET version = ?2, kind = ?3, name = ?4, description = ?5, sql_text = ?6, display = ?7, valid_from = ?8, changed_by = ?9, change_note = ?10`)
          .bind(def.metric_id, def.version, def.kind, def.name, def.description, def.sql_text, def.display, def.valid_from, def.changed_by, def.change_note).run();
        await rebuildAnswer(env);
      } catch { copied = false; }
      return json({ ok: true, saves: 'shared', definition: def, copied });
    }

    const [m] = await run(env, conn, SAVE_OWN, {
      account_id: ['BIGINT', user.id], metric_id: text(id), base: ['INT', b.base], sql_text: text(sqlText),
      description: text(described), based_on: ['INT', shared.version], changed_by: text(who), change_note: text(note),
    });
    if (Number(m.num_inserted_rows) !== 1) return fail(409, `Your own version of this changed since this window loaded it (it was ${b.base ? `version ${b.base}` : 'the shared one'}). Reload the window to see it; your text is kept until you close it.`);
    const [row] = await run(env, conn, READ_OWN, { account_id: ['BIGINT', user.id], metric_id: text(id) });
    const def = {
      metric_id: id, version: Number(row.version), sql_text: sqlText, description: described, based_on: shared.version,
      valid_from: row.valid_from, changed_by: who, change_note: note,
    };
    let copied = true;
    try {
      await env.DB.prepare(`INSERT INTO market_user_metrics (user_id, metric_id, version, sql_text, description, based_on, valid_from, changed_by, change_note)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(user_id, metric_id) DO UPDATE SET version = ?3, sql_text = ?4, description = ?5, based_on = ?6, valid_from = ?7, changed_by = ?8, change_note = ?9`)
        .bind(user.id, id, def.version, def.sql_text, def.description, def.based_on, def.valid_from, def.changed_by, def.change_note).run();
    } catch { copied = false; }   // saved in Databricks: the next daily publish brings it to MEDUSA
    return json({ ok: true, saves: 'own', definition: def, copied });
  } catch (e) {
    if (e instanceof DbxError) return fail(502, `${e.message} Nothing was saved in MEDUSA; if Databricks saved it after all, it appears after the next daily publish.`);
    throw e;
  }
}

/** POST /api/market/metrics/reset {metric_id, base}: the account goes back to the shared definition. Its
 * version in use (base) is closed in Databricks, none is added, and MEDUSA's copy of it goes. */
export async function resetMetric(req, env, user) {
  if (!canSave(env)) return fail(503, 'Saving isn\'t set up on this MEDUSA (its Databricks secrets are missing).');
  if (isOwner(env, user.id)) return fail(400, 'Your versions are the shared ones, so there is no own version to give up.');
  const b = await readBody(req);
  const id = String(b.metric_id || '');
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(id) || !Number.isInteger(b.base) || b.base < 1) return fail(400, 'Which version to give up is missing.');
  const limited = await overLimit(env, user.id);
  if (limited) return fail(429, limited);
  try {
    const conn = await connect(env);
    const [m] = await run(env, conn, RESET_OWN, { account_id: ['BIGINT', user.id], metric_id: ['STRING', id], base: ['INT', b.base] });
    if (Number(m.num_affected_rows) !== 1) return fail(409, 'Your own version of this changed since this window loaded it. Reload the window to see it.');
  } catch (e) {
    if (e instanceof DbxError) return fail(502, `${e.message} Nothing was changed.`);
    throw e;
  }
  try { await env.DB.prepare('DELETE FROM market_user_metrics WHERE user_id = ? AND metric_id = ?').bind(user.id, id).run(); } catch { /* the daily publish removes it */ }
  return json({ ok: true });
}

/** A deleted account's own versions: removed from Databricks and from MEDUSA's copy. Best effort: the
 * account is deleted even if Databricks can't be reached (a later deletion can be done by hand). */
export async function forgetMetrics(env, uid) {
  try { await env.DB.prepare('DELETE FROM market_user_metrics WHERE user_id = ?').bind(uid).run(); } catch { /* no table yet */ }
  if (!canSave(env)) return;
  try {
    const conn = await connect(env);
    await run(env, conn, FORGET_OWN, { account_id: ['BIGINT', uid] });
  } catch { /* the runbook has the statement to remove them by hand */ }
}
