// MEDUSA's copy of the market data lakehouse's small gold tables, for the live scanner.
//
// Once a day the lakehouse's publish job sends each table here: POST /api/market/ingest with
//   Authorization: Bearer <MARKET_INGEST_TOKEN>
//   {"table": "market_baseline", "as_of": "2026-10-22", "rows": [{...}, ...]}
// The Worker checks every row against the table's columns, then replaces the table's rows and records
// the publish in one D1 batch, which is a single transaction: a reader sees the old copy or the new
// one, never half of each. This endpoint can only replace these market tables; its token opens nothing
// else, which is why the job doesn't get a token for the whole database (ADR-024).

import { json, fail } from './http.js';

const MAX_BYTES = 2 * 1024 * 1024;

// The tables the lakehouse may publish: their key, their columns and what each column holds.
const TEXT = 'text', NUM = 'num', INT = 'int', DATE = 'date';
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
};

const fits = {
  [TEXT]: (v) => typeof v === 'string' && v.length <= 40,
  [NUM]: (v) => typeof v === 'number' && Number.isFinite(v),
  [INT]: (v) => Number.isInteger(v),
  [DATE]: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
};

/** The first problem with the rows, or null: unknown or wrongly typed columns, missing keys, repeats. */
function checkRows(spec, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'rows must be a non-empty list.';
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

/** Whether the request carries the ingest token. Both sides are hashed first, so the comparison
 * takes the same time whatever the token, and it never says how much of a guess was right. */
async function hasToken(req, env) {
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!got) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(env.MARKET_INGEST_TOKEN)),
    crypto.subtle.digest('SHA-256', enc.encode(got)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** POST /api/market/ingest: replace one market table with the rows sent. */
export async function marketIngest(req, env) {
  if (!env.MARKET_INGEST_TOKEN) return fail(503, 'Market data is not set up: the MARKET_INGEST_TOKEN secret is missing.');
  if (!(await hasToken(req, env))) return fail(401, 'Wrong or missing token.');
  if (Number(req.headers.get('content-length') || 0) > MAX_BYTES) return fail(413, 'That request is too big.');
  const text = await req.text();
  if (text.length > MAX_BYTES) return fail(413, 'That request is too big.');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'The body must be JSON.');
  }

  const spec = TABLES[body.table];
  if (!spec) return fail(400, `Unknown table. Use one of: ${Object.keys(TABLES).join(', ')}.`);
  if (!fits[DATE](body.as_of)) return fail(400, 'as_of must be a date, YYYY-MM-DD.');
  const problem = checkRows(spec, body.rows);
  if (problem) return fail(400, problem);

  // SQLite reads every column straight from the request's JSON (json_each over "$.rows"), so the Worker
  // binds the body as one value: no statement per row, and the free plan's 10 ms of CPU go a long way.
  // Column names come from TABLES above, never from the request.
  const cols = Object.keys(spec.columns);
  const db = env.DB;
  const [, , , counted] = await db.batch([
    db.prepare(`DELETE FROM ${body.table}`),
    db.prepare(`INSERT INTO ${body.table} (${cols.join(', ')})
                SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?1, '$.rows')`)
      .bind(text),
    db.prepare(`INSERT INTO market_publish (tbl, as_of, rows, published_at) VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(tbl) DO UPDATE SET as_of = ?2, rows = ?3, published_at = ?4`)
      .bind(body.table, body.as_of, body.rows.length, Date.now()),
    db.prepare(`SELECT COUNT(*) AS n FROM ${body.table}`),
  ]);
  return json({ ok: true, table: body.table, as_of: body.as_of, rows: counted.results[0].n });
}
