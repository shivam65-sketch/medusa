-- MEDUSA's copy of the market data lakehouse's small gold tables, for the live scanner.
-- Shared by every account (market data, nothing personal), so these tables have no user_id.
-- They are written only by POST /api/market/ingest (src/market.js), which replaces a table's rows in
-- one transaction, and read by the scanner. Create them once:
--   npx wrangler@4 d1 execute medusa --remote --file=migrations/003_market.sql

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

-- One row per market table: when it was last published, for which day, and how many rows it holds.
CREATE TABLE IF NOT EXISTS market_publish (
  tbl TEXT PRIMARY KEY,              -- market_baseline | market_evidence
  as_of TEXT,                        -- the lakehouse day the copy reflects
  rows INTEGER NOT NULL,
  published_at INTEGER NOT NULL      -- ms since 1970
);
