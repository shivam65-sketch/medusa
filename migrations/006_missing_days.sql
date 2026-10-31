-- The days the lakehouse should have and doesn't (from gold.missing_days), so the Markets page can say
-- so. Usually empty. Like the other market tables it is written only by POST /api/market/ingest
-- (src/market.js) and holds nothing personal. Create it once:
--   npx wrangler@4 d1 execute medusa --remote --file=migrations/006_missing_days.sql

CREATE TABLE IF NOT EXISTS market_missing_days (
  trade_date TEXT PRIMARY KEY,       -- the UTC day, YYYY-MM-DD
  status TEXT NOT NULL               -- waiting | retrying | manual
);
