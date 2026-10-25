-- Medusa database (Cloudflare D1 = SQLite). Safe to run more than once.
-- Every journal table has a user_id: each account only ever sees its own rows.
-- An existing single-user database is upgraded with migrations/001_accounts.sql instead.

-- Accounts. Passwords and recovery codes are stored only as keyed hashes (src/auth.js); the
-- two-step secret is encrypted.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pw TEXT NOT NULL,
  recovery TEXT NOT NULL,
  totp TEXT,
  totp_pending TEXT,
  totp_last INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  pw_changed_at INTEGER,
  recovery_at INTEGER
);

-- Signed-in devices. `id` is the SHA-256 of the cookie's random token, never the token itself.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Failed sign-ins, sign-ups and the like, for rate limiting. Rows older than a day are deleted.
CREATE TABLE IF NOT EXISTS attempts (kind TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_lookup ON attempts (kind, key, ts);

-- Filled CoinDCX futures orders, as imported.
CREATE TABLE IF NOT EXISTS orders (
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  pair TEXT NOT NULL,
  mcur TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  lev REAL,
  otype TEXT,
  stage TEXT,
  status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS orders_pair ON orders (user_id, pair, mcur);
CREATE INDEX IF NOT EXISTS orders_side ON orders (user_id, side);

-- CoinDCX's own profit/loss, fee and funding records.
CREATE TABLE IF NOT EXISTS txs (
  user_id INTEGER NOT NULL,
  k TEXT NOT NULL,
  pair TEXT,
  mcur TEXT,
  order_id TEXT,
  stage TEXT,
  amount REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, k)
);
CREATE INDEX IF NOT EXISTS txs_pair ON txs (user_id, pair, mcur);

-- Closed round-trip trades, rebuilt from the two tables above after each import.
CREATE TABLE IF NOT EXISTS trades (
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  pair TEXT NOT NULL,
  sym TEXT NOT NULL,
  base TEXT NOT NULL,
  mcur TEXT NOT NULL,
  side TEXT NOT NULL,
  open_ts INTEGER NOT NULL,
  close_ts INTEGER NOT NULL,
  qty REAL NOT NULL,
  entry REAL NOT NULL,
  exit REAL NOT NULL,
  pnl REAL NOT NULL,
  fees REAL NOT NULL,
  funding REAL NOT NULL,
  net REAL NOT NULL,
  lev REAL,
  entry_type TEXT,
  exit_kind TEXT,
  orders INTEGER NOT NULL,
  pnl_source TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS trades_pair ON trades (user_id, pair, mcur);
CREATE INDEX IF NOT EXISTS trades_close ON trades (user_id, close_ts);

-- Stop-loss and take-profit orders (any status), for drawing them on each trade's chart.
CREATE TABLE IF NOT EXISTS triggers (
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  pair TEXT NOT NULL,
  mcur TEXT NOT NULL,
  side TEXT NOT NULL,
  kind TEXT NOT NULL,
  price REAL NOT NULL,
  status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS triggers_pair ON triggers (user_id, pair, mcur);

-- Your journal notes on each trade. Kept separate so imports never touch them.
CREATE TABLE IF NOT EXISTS annotations (
  user_id INTEGER NOT NULL,
  trade_id TEXT NOT NULL,
  setup TEXT,
  tags TEXT,
  mistakes TEXT,
  emotion TEXT,
  rating INTEGER,
  plan INTEGER,
  risk REAL,
  notes TEXT,
  chart TEXT,
  updated_at INTEGER,
  PRIMARY KEY (user_id, trade_id)
);

-- Daily journal: plan, review and mood for each day.
CREATE TABLE IF NOT EXISTS days (
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  plan TEXT,
  review TEXT,
  mood INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (user_id, date)
);

-- Per-account settings, import progress and the encrypted CoinDCX key.
CREATE TABLE IF NOT EXISTS kv (user_id INTEGER NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (user_id, k));

-- Coin logos, fetched once and shared by everyone (they are public images).
CREATE TABLE IF NOT EXISTS logos (
  base TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  source TEXT,
  fetched_at INTEGER NOT NULL
);

-- MEDUSA Lab: lists of data files (Downloads/Uploads folders), results and strategy files (details in migrations/002_lab.sql).
CREATE TABLE IF NOT EXISTS lab_datasets (
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,        -- binance (Downloads folder) | upload (Uploads folder)
  market TEXT NOT NULL,        -- futures | spot
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,      -- 1m ... 1w
  start_ts INTEGER NOT NULL,   -- first candle's open time (ms)
  end_ts INTEGER NOT NULL,     -- last candle's open time (ms)
  candles INTEGER NOT NULL,
  funding INTEGER NOT NULL DEFAULT 0,  -- number of funding rates included
  bytes INTEGER NOT NULL,      -- size of the compressed file in KV
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS lab_runs (
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,         -- JSON: the headline numbers shown in the list
  bytes INTEGER NOT NULL,      -- size of the compressed result in KV (results/<user_id>/<id>)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS lab_strategies (
  user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,          -- file name
  code TEXT NOT NULL,          -- the Python source
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- Market data for the live scanner: a daily copy of the market data lakehouse's gold tables, shared by
-- every account (nothing personal, so no user_id). Written only by POST /api/market/ingest (src/market.js).
-- Each coin's "normal" as of its latest day (from gold.coin_baseline). The scanner compares the live
-- price with last_close and scores the move with avg_return_30d and sd_return_30d.
CREATE TABLE IF NOT EXISTS market_baseline (
  symbol TEXT PRIMARY KEY,           -- Binance symbol, e.g. BTCUSDT
  base_asset TEXT,
  status TEXT,                       -- trading | not trading
  as_of_date TEXT NOT NULL,          -- the coin's latest day with trades (UTC, YYYY-MM-DD)
  last_close REAL NOT NULL,          -- close on as_of_date: today's reference price
  history_days INTEGER,              -- daily returns behind the averages (0-30); scored from 20
  avg_return_30d REAL,
  sd_return_30d REAL,
  avg_abs_return_30d REAL,
  avg_quote_volume_30d REAL,         -- USDT a day; also decides the liquidity band
  avg_log_volume_30d REAL,
  sd_log_volume_30d REAL,
  avg_abs_hour_return_30d REAL
);

-- What moves like today's did next (from gold.event_evidence): one row per kind of move and horizon.
CREATE TABLE IF NOT EXISTS market_evidence (
  direction TEXT NOT NULL,           -- up | down
  z_band TEXT NOT NULL,              -- 3-4 | 4-6 | 6+ | all
  liquidity TEXT NOT NULL,           -- large | mid | small | all
  horizon_hours INTEGER NOT NULL,    -- 1 | 4 | 24
  events INTEGER,
  days INTEGER,
  avg_continuation REAL,             -- returns are fractions: 0.01 = 1%
  median_continuation REAL,
  hit_rate REAL,
  in_sample_days INTEGER,
  in_sample_avg_continuation REAL,
  in_sample_t REAL,
  held_back_days INTEGER,
  held_back_avg_continuation REAL,
  held_back_t REAL,
  held_back_hit_rate REAL,
  side TEXT,                         -- follow | fade
  held_back_net_after_cost REAL,
  verdict TEXT,                      -- held up | did not hold | no pattern | too few
  round_trip_cost REAL,
  PRIMARY KEY (direction, z_band, liquidity, horizon_hours)
);

-- The definition of every number on the Markets page (the current version of each row of the lakehouse's
-- market.semantic.metric_definitions). The page runs these queries in its own SQLite engine.
CREATE TABLE IF NOT EXISTS market_metrics (
  metric_id TEXT PRIMARY KEY,        -- e.g. breadth
  version INTEGER NOT NULL,          -- the version in use
  kind TEXT NOT NULL,                -- model (a shared step) | metric (a number or table on the page)
  name TEXT NOT NULL,
  description TEXT,
  sql_text TEXT NOT NULL,            -- the query the page runs
  display TEXT,                      -- JSON: a card's text, or each column's label and format
  valid_from TEXT,                   -- when this version came into use (UTC)
  changed_by TEXT,
  change_note TEXT
);

-- One row per market table: when it was last published, for which day, and how many rows it holds.
CREATE TABLE IF NOT EXISTS market_publish (
  tbl TEXT PRIMARY KEY,              -- market_baseline | market_evidence | market_metrics
  as_of TEXT,                        -- the lakehouse day the copy reflects
  rows INTEGER NOT NULL,
  published_at INTEGER NOT NULL      -- ms since 1970
);
