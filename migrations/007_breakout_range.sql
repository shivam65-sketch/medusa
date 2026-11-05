-- Each market's range, for the Breakout watch on the Markets page (lakehouse step 32.4, ADR-041): the highest
-- high and lowest low of its last 3 days with trades and of its last 2, and its usual 3-day range, from
-- gold.coin_baseline. Run it once, before deploying the Worker that sends these columns:
--   npx wrangler@4 d1 execute medusa --remote --file=migrations/007_breakout_range.sql
-- SQLite has no ADD COLUMN IF NOT EXISTS, so a second run stops at the first line with "duplicate column
-- name", which changes nothing.

ALTER TABLE market_baseline ADD COLUMN high_3d REAL;            -- highest high of the last 3 days with trades
ALTER TABLE market_baseline ADD COLUMN low_3d REAL;             -- lowest low of the same 3 days
ALTER TABLE market_baseline ADD COLUMN high_2d REAL;            -- the same over the last 2 days, which the page
ALTER TABLE market_baseline ADD COLUMN low_2d REAL;             --   joins with yesterday from Binance when needed
ALTER TABLE market_baseline ADD COLUMN avg_range_3d_30d REAL;   -- the usual 3-day range (high / low - 1) over 30 days
