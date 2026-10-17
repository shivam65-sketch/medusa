-- MEDUSA Lab: the lists of your data files, results and strategy files.
-- The files themselves are in Workers KV (binding LAB), in three folders: downloads/<user_id>/<id>,
-- uploads/<user_id>/<id> and results/<user_id>/<id>. The Worker also creates
-- these tables by itself the first time the Lab is used, so running this is optional:
--   npx wrangler@4 d1 execute medusa --remote --file=migrations/002_lab.sql
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
