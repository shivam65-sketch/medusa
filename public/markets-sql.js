// MEDUSA Markets: the SQL engine, a background worker started by markets.js.
//
// A SQLite database (sql.js: SQLite compiled to WebAssembly) holding the four tables the Markets
// page's queries read (markets-metrics.js). Every number on the Today view is the result of a query
// run here. The database lives only in this browser tab's memory and holds market data only: a query
// can't reach MEDUSA's server, the journal or anything else.
//
// WebAssembly is allowed for this worker only, and it can reach nothing outside MEDUSA (see _headers).

const SQLJS = '/vendor/sqljs-1.14.2';
importScripts(`${SQLJS}/sql-wasm.js`);

// The lakehouse's two tables, exactly as in MEDUSA's D1 (migrations/003_market.sql), so a query gives
// the same answer here as there. Plus the two tables that only exist in the browser.
const SCHEMA = `
CREATE TABLE market_baseline (
  symbol TEXT PRIMARY KEY, base_asset TEXT, status TEXT, as_of_date TEXT NOT NULL, last_close REAL NOT NULL,
  history_days INTEGER, avg_return_30d REAL, sd_return_30d REAL, avg_abs_return_30d REAL,
  avg_quote_volume_30d REAL, avg_log_volume_30d REAL, sd_log_volume_30d REAL, avg_abs_hour_return_30d REAL
);
CREATE TABLE market_evidence (
  direction TEXT NOT NULL, z_band TEXT NOT NULL, liquidity TEXT NOT NULL, horizon_hours INTEGER NOT NULL,
  events INTEGER, days INTEGER, avg_continuation REAL, median_continuation REAL, hit_rate REAL,
  in_sample_days INTEGER, in_sample_avg_continuation REAL, in_sample_t REAL,
  held_back_days INTEGER, held_back_avg_continuation REAL, held_back_t REAL, held_back_hit_rate REAL,
  side TEXT, held_back_net_after_cost REAL, verdict TEXT, round_trip_cost REAL,
  PRIMARY KEY (direction, z_band, liquidity, horizon_hours)
);
CREATE TABLE live_prices (symbol TEXT PRIMARY KEY, price REAL, quote_volume_24h REAL);
CREATE TABLE binance_markets (symbol TEXT PRIMARY KEY, market_type TEXT, yesterday_close REAL);`;

let db = null;
const prepared = new Map();   // query text -> prepared statement, reused every second

const ready = initSqlJs({ locateFile: (file) => `${SQLJS}/${file}` }).then((SQL) => {
  db = new SQL.Database();
  db.exec(SCHEMA);
});

/** Replace a table's rows in one transaction. Only the table's own columns are taken. */
function replace(table, part) {
  const known = new Set(db.exec(`SELECT name FROM pragma_table_info('${table}')`)[0].values.map((r) => r[0]));
  const cols = part.columns.filter((c) => known.has(c));
  const at = cols.map((c) => part.columns.indexOf(c));
  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM ${table}`);
    const st = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    for (const row of part.rows) st.run(at.map((i) => row[i] ?? null));
    st.free();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function upsertPrices(rows) {
  const st = db.prepare(`INSERT INTO live_prices (symbol, price, quote_volume_24h) VALUES (?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, quote_volume_24h = COALESCE(excluded.quote_volume_24h, quote_volume_24h)`);
  db.exec('BEGIN');
  for (const r of rows) st.run(r);
  db.exec('COMMIT');
  st.free();
}

/** Run each query with its parameters. A query can only read: the database is switched to read-only
 * while they run. One query failing doesn't stop the others. */
function runAll(jobs) {
  const out = {};
  db.exec('PRAGMA query_only = 1');
  try {
    for (const { id, sql, params } of jobs) {
      const t0 = performance.now();
      let st = prepared.get(sql);
      try {
        if (!st) {
          // Every previewed edit is a new query: past 64, start the collection again.
          if (prepared.size >= 64) { for (const s of prepared.values()) s.free(); prepared.clear(); }
          st = db.prepare(sql);
          prepared.set(sql, st);
        }
        st.bind(params || {});
        const columns = st.getColumnNames(), rows = [];
        while (st.step()) rows.push(st.get());
        st.reset();
        out[id] = { columns, rows, ms: Math.round((performance.now() - t0) * 10) / 10 };
      } catch (e) {
        if (st) { try { st.reset(); } catch { /* already broken */ } }
        out[id] = { error: e.message };
      }
    }
  } finally {
    db.exec('PRAGMA query_only = 0');
  }
  return out;
}

onmessage = async (e) => {
  const { id, op, load, markets, prices, jobs } = e.data;
  try {
    await ready;
    if (op === 'run') {
      if (load) { replace('market_baseline', load.market_baseline); replace('market_evidence', load.market_evidence); }
      if (markets) replace('binance_markets', { columns: ['symbol', 'market_type', 'yesterday_close'], rows: markets });
      if (prices && prices.length) upsertPrices(prices);
      postMessage({ id, ok: true, result: runAll(jobs || []) });
    } else {
      postMessage({ id, ok: true, result: null });   // 'init': the engine is ready
    }
  } catch (err) {
    postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
