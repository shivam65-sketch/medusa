// MEDUSA's copy of the market data lakehouse's small tables, for the live scanner: each market's normal
// (market_baseline), the evidence (market_evidence), the definition of every number on the page
// (market_metrics) and each account's own versions of those definitions (market_user_metrics).
//
// Once a day the lakehouse's publish job sends each table here: POST /api/market/ingest with
//   Authorization: Bearer <MARKET_INGEST_TOKEN>
//   {"table": "market_baseline", "as_of": "2026-10-22", "rows": [{...}, ...]}
// The Worker checks every row against the table's columns, then replaces the table's rows and records
// the publish in one D1 batch, which is a single transaction: a reader sees the old copy or the new
// one, never half of each. This endpoint can only replace these market tables; its token opens nothing
// else, which is why the job doesn't get a token for the whole database (ADR-024).
//
// The live scanner page reads them back through GET /api/market/scanner, for signed-in accounts only.
// That answer is the same for everyone, so it is built once when the data changes and kept ready-made
// in Workers KV (ADR-026): page loads read one KV value, not D1.

import { json, fail, hasBearer, SECURITY } from './http.js';

const MAX_BYTES = 2 * 1024 * 1024;

// The tables the lakehouse may publish: their key, their columns and what each column holds.
// TEXT is a short value (a symbol, a label); LONG a longer one (a query, a description, JSON).
const TEXT = 'text', LONG = 'long', NUM = 'num', INT = 'int', DATE = 'date', TIME = 'time';
export const TABLES = {
  market_baseline: {
    maxRows: 3000,
    key: ['symbol'],
    required: ['symbol', 'as_of_date', 'last_close'],
    columns: {
      symbol: TEXT, base_asset: TEXT, status: TEXT, as_of_date: DATE, last_close: NUM, history_days: INT,
      avg_return_30d: NUM, sd_return_30d: NUM, avg_abs_return_30d: NUM, avg_quote_volume_30d: NUM,
      avg_log_volume_30d: NUM, sd_log_volume_30d: NUM, avg_abs_hour_return_30d: NUM,
    },
  },
  market_evidence: {
    maxRows: 500,
    key: ['direction', 'z_band', 'liquidity', 'horizon_hours'],
    required: ['direction', 'z_band', 'liquidity', 'horizon_hours'],
    columns: {
      direction: TEXT, z_band: TEXT, liquidity: TEXT, horizon_hours: INT, events: INT, days: INT,
      avg_continuation: NUM, median_continuation: NUM, hit_rate: NUM,
      in_sample_days: INT, in_sample_avg_continuation: NUM, in_sample_t: NUM,
      held_back_days: INT, held_back_avg_continuation: NUM, held_back_t: NUM, held_back_hit_rate: NUM,
      side: TEXT, held_back_net_after_cost: NUM, verdict: TEXT, round_trip_cost: NUM,
    },
  },
  // The definition of every number on the Markets page: the current version of each row of the
  // lakehouse's market.semantic.metric_definitions (lakehouse step 27). The page runs these queries.
  market_metrics: {
    maxRows: 200,
    key: ['metric_id'],
    required: ['metric_id', 'version', 'kind', 'name', 'sql_text'],
    columns: {
      metric_id: TEXT, version: INT, kind: TEXT, name: LONG, description: LONG, sql_text: LONG,
      display: LONG, valid_from: TIME, changed_by: TEXT, change_note: LONG,
    },
  },
  // Each account's own versions: the current version of each row of the lakehouse's
  // market.semantic.user_metric_definitions (lakehouse step 28). Saving on the page writes here too
  // (metrics.js); the daily publish replaces it as a whole, so it always ends up matching Databricks.
  // It may be empty, and it is never part of the shared answer below (only its own account reads a row).
  market_user_metrics: {
    maxRows: 20000,
    allowEmpty: true,
    key: ['user_id', 'metric_id'],
    required: ['user_id', 'metric_id', 'version', 'sql_text'],
    columns: {
      user_id: INT, metric_id: TEXT, version: INT, sql_text: LONG, description: LONG, based_on: INT,
      valid_from: TIME, changed_by: TEXT, change_note: LONG,
    },
  },
};
// The tables in the scanner's answer, which is the same for every account.
const SHARED = ['market_baseline', 'market_evidence', 'market_metrics'];
// The Insights data (lakehouse step 32), one file in KV; only its publish records are in the answer.
const INSIGHTS = ['market_events', 'market_hours'];

const fits = {
  [TEXT]: (v) => typeof v === 'string' && v.length <= 40,
  [LONG]: (v) => typeof v === 'string' && v.length <= 20000,
  [NUM]: (v) => typeof v === 'number' && Number.isFinite(v),
  [INT]: (v) => Number.isInteger(v),
  [DATE]: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  [TIME]: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(v),
};

/** The first problem with the rows, or null: unknown or wrongly typed columns, missing keys, repeats. */
function checkRows(spec, rows) {
  if (!Array.isArray(rows) || (rows.length === 0 && !spec.allowEmpty)) return 'rows must be a non-empty list.';
  if (rows.length > spec.maxRows) return `at most ${spec.maxRows} rows.`;
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return `row ${i} is not an object.`;
    for (const [col, v] of Object.entries(r)) {
      const kind = spec.columns[col];
      if (!kind) return `row ${i}: unknown column ${col}.`;
      if (v !== null && !fits[kind](v)) return `row ${i}: ${col} is not a valid ${kind}.`;
    }
    for (const col of spec.required) if (r[col] === null || r[col] === undefined) return `row ${i}: ${col} is missing.`;
    const key = spec.key.map((c) => r[c]).join('|');
    if (seen.has(key)) return `row ${i}: ${spec.key.join(', ')} appears twice.`;
    seen.add(key);
  }
  return null;
}

/** POST /api/market/ingest: replace one market table with the rows sent. */
export async function marketIngest(req, env) {
  if (!env.MARKET_INGEST_TOKEN) return fail(503, 'Market data is not set up: the MARKET_INGEST_TOKEN secret is missing.');
  if (!(await hasBearer(req, env.MARKET_INGEST_TOKEN))) return fail(401, 'Wrong or missing token.');
  if (Number(req.headers.get('content-length') || 0) > MAX_BYTES) return fail(413, 'That request is too big.');
  const text = await req.text();
  if (text.length > MAX_BYTES) return fail(413, 'That request is too big.');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'The body must be JSON.');
  }

  if (!TABLES[body.table]) return fail(400, `Unknown table. Use one of: ${Object.keys(TABLES).join(', ')}.`);
  if (!fits[DATE](body.as_of)) return fail(400, 'as_of must be a date, YYYY-MM-DD.');
  const done = await replaceTable(env, body.table, body.as_of, body.rows, text);
  if (done.error) return fail(400, done.error);
  return json({ ok: true, table: body.table, as_of: body.as_of, rows: done.rows, served: done.served });
}

/** Replace a market table with rows that pass its checks, in one transaction, and record it in
 * market_publish; after a shared table the scanner's answer is rebuilt. Used by the ingest and by
 * reloading the definitions from the lakehouse (metrics.js). `text` is JSON with the rows at $.rows
 * (the ingest's own body). {rows, served} or {error}. */
export async function replaceTable(env, table, asOf, rows, text = JSON.stringify({ rows })) {
  const spec = TABLES[table];
  const problem = checkRows(spec, rows);
  if (problem) return { error: problem };
  // SQLite reads every column straight from the JSON (json_each over "$.rows"), so the Worker binds it
  // as one value: no statement per row, and the free plan's 10 ms of CPU go a long way. Column names
  // come from TABLES above, never from the request.
  const cols = Object.keys(spec.columns);
  const db = env.DB;
  const [, , , counted] = await db.batch([
    db.prepare(`DELETE FROM ${table}`),
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')})
                SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?1, '$.rows')`)
      .bind(text),
    db.prepare(`INSERT INTO market_publish (tbl, as_of, rows, published_at) VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(tbl) DO UPDATE SET as_of = ?2, rows = ?3, published_at = ?4`)
      .bind(table, asOf, rows.length, Date.now()),
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`),
  ]);
  // A shared table changed, so the scanner's ready-made answer is rebuilt now (personal versions aren't in it).
  const served = SHARED.includes(table) ? await rebuildAnswer(env) : '-';
  return { rows: counted.results[0].n, served };
}

/** Rebuild the scanner's ready-made answer after a shared table changed: 'kv'. If that fails, the old
 * answer is removed rather than left behind, and readers get the new data from D1 until the next
 * publish: 'd1'. */
export async function rebuildAnswer(env) {
  try {
    await env.LAB.put(ANSWER_KEY, await buildAnswer(env));
    return 'kv';
  } catch {
    await env.LAB.delete(ANSWER_KEY).catch(() => {});
    return 'd1';
  }
}

/* ---------- the Insights data (lakehouse step 32): one file, kept as it is ---------- */

// The Insights graphs read every unusual move since 2020 and the market's drift by hour: about 21,000
// rows, too many to check one by one within the free plan's CPU time and bigger than an ingest may be.
// So the publish job checks them itself and sends them as one gzip file of JSON, with the same token.
// MEDUSA keeps the file in KV exactly as it came (it never unpacks it), records the publish in
// market_publish, and gives it to signed-in pages, whose SQL engine unpacks it (ADR-034). The job
// reconciles by the file's SHA-256, which MEDUSA reports back.
const INSIGHTS_KEY = 'market/insights.json.gz';
const INSIGHTS_MAX = 10 * 1024 * 1024;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** PUT /api/market/insights: the Insights file. Headers: x-as-of (the lakehouse day) and x-rows
 * ({"market_events": n, "market_hours": n}), which the publish records keep. */
export async function insightsPut(req, env) {
  if (!env.MARKET_INGEST_TOKEN) return fail(503, 'Market data is not set up: the MARKET_INGEST_TOKEN secret is missing.');
  if (!(await hasBearer(req, env.MARKET_INGEST_TOKEN))) return fail(401, 'Wrong or missing token.');
  const asOf = req.headers.get('x-as-of') || '';
  if (!fits[DATE](asOf)) return fail(400, 'x-as-of must be a date, YYYY-MM-DD.');
  let rows = null;
  try { rows = JSON.parse(req.headers.get('x-rows') || 'null'); } catch { /* checked below */ }
  if (!rows || typeof rows !== 'object' || Object.keys(rows).length !== INSIGHTS.length
      || INSIGHTS.some((t) => !Number.isInteger(rows[t]) || rows[t] < 1)) {
    return fail(400, `x-rows must give the rows of ${INSIGHTS.join(' and ')}, as JSON.`);
  }
  if (Number(req.headers.get('content-length') || 0) > INSIGHTS_MAX) return fail(413, 'That file is too big.');
  const body = await req.arrayBuffer();
  if (body.byteLength > INSIGHTS_MAX) return fail(413, 'That file is too big.');
  const head = new Uint8Array(body, 0, Math.min(2, body.byteLength));
  if (head[0] !== 0x1f || head[1] !== 0x8b) return fail(400, 'The body must be a gzip file.');
  const sha256 = hex(await crypto.subtle.digest('SHA-256', body));
  const publishedAt = Date.now();
  await env.LAB.put(INSIGHTS_KEY, body, { metadata: { as_of: asOf, rows, sha256, bytes: body.byteLength, published_at: publishedAt } });
  const db = env.DB;
  await db.batch(INSIGHTS.map((t) => db.prepare(
    `INSERT INTO market_publish (tbl, as_of, rows, published_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(tbl) DO UPDATE SET as_of = ?2, rows = ?3, published_at = ?4`).bind(t, asOf, rows[t], publishedAt)));
  // The scanner's answer carries the publish records, so pages learn there is a new file.
  const served = await rebuildAnswer(env);
  return json({ ok: true, as_of: asOf, rows, bytes: body.byteLength, sha256, published_at: publishedAt, served });
}

/** GET /api/market/insights?v=<published_at>: the file as it was sent (gzip; the page unpacks it).
 * Asked for by the version in the scanner's answer, a browser keeps it for a day; any other version
 * (a KV copy that hasn't caught up yet, or no version) isn't kept, so a new file is never hidden. */
export async function insightsGet(env, url) {
  const { value, metadata } = await env.LAB.getWithMetadata(INSIGHTS_KEY, { type: 'stream' });
  if (!value) return fail(404, 'The lakehouse hasn\'t published the Insights data to MEDUSA yet.');
  const m = metadata || {};
  const current = url.searchParams.get('v') === String(m.published_at);
  return new Response(value, {
    headers: {
      'content-type': 'application/gzip',
      'cache-control': current ? 'private, max-age=86400, immutable' : 'no-store',
      'x-as-of': String(m.as_of || ''),
      'x-published-at': String(m.published_at || ''),
      ...SECURITY,
    },
  });
}

/* ---------- the read side: what the live scanner page loads ---------- */

// Behind the sign-in like the rest of MEDUSA (worker.js checks the session first, ADR-025), but the
// same answer for every account: it holds no one's own data. Rows go out as lists in the column order
// of TABLES, much smaller than one object per row.
//
// The answer is kept ready-made in Workers KV (ADR-026). The ingest above rebuilds it after every
// publish, so a page load reads one KV value instead of about 810 D1 rows, and it is never older than
// the last publish. (Cloudflare's Cache API, used before, does nothing on a workers.dev address.)
// It sits in the Lab's KV namespace under market/; the Lab finds its own keys through D1 and never
// lists the namespace. When the answer isn't there (before the first publish, or after a failed
// rebuild) it comes from D1 and is kept for 10 minutes, so even a copy that raced a publish soon goes.
// x-cache says which answered: KV or D1. Each browser keeps its copy 5 minutes ("private").
const ANSWER_KEY = 'market/scanner.json';
const FALLBACK_SECONDS = 600;

const readAnswer = (body, from) => new Response(body, {
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, max-age=300',
    'x-cache': from,
    ...SECURITY,
  },
});

/** The market tables and their publish records, read in one batch: one transaction, so the tables and
 * their records always belong together. Before migration 004 has run there is no market_metrics, and the
 * answer goes without it (the page then uses its built-in definitions). */
async function buildAnswer(env, names = SHARED) {
  const db = env.DB;
  let results;
  try {
    results = await db.batch([
      ...names.map((t) => db.prepare(
        `SELECT ${Object.keys(TABLES[t].columns).join(', ')} FROM ${t} ORDER BY ${TABLES[t].key.join(', ')}`)),
      db.prepare(`SELECT tbl, as_of, rows, published_at FROM market_publish WHERE tbl IN (${[...SHARED, ...INSIGHTS].map((t) => `'${t}'`).join(', ')})`),
    ]);
  } catch (e) {
    if (names.includes('market_metrics') && /no such table: market_metrics/i.test(String(e && e.message))) {
      return buildAnswer(env, names.filter((t) => t !== 'market_metrics'));
    }
    throw e;
  }
  const answer = { published: Object.fromEntries(results.at(-1).results.map(({ tbl, ...p }) => [tbl, p])) };
  names.forEach((t, i) => {
    const columns = Object.keys(TABLES[t].columns);
    answer[t] = { columns, rows: results[i].results.map((r) => columns.map((c) => r[c])) };
  });
  return JSON.stringify(answer);
}

/** GET /api/market/scanner: {published: {table: {as_of, rows, published_at}}, table: {columns, rows}}. */
export async function marketScanner(env) {
  const kept = await env.LAB.get(ANSWER_KEY);
  if (kept) return readAnswer(kept, 'KV');
  let body;
  try {
    body = await buildAnswer(env);
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return fail(503, 'Market data is not set up on this server (migrations/003_market.sql).');
    throw e;
  }
  await env.LAB.put(ANSWER_KEY, body, { expirationTtl: FALLBACK_SECONDS }).catch(() => {});
  return readAnswer(body, 'D1');
}
