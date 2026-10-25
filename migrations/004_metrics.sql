-- The definition of every number on MEDUSA's Markets page: the current version of each row of the
-- lakehouse's market.semantic.metric_definitions (lakehouse step 27). The page runs these queries in
-- its own SQLite engine. Like the other market tables it is shared by every account, and written only
-- by POST /api/market/ingest (src/market.js). Create it once, before deploying the code that reads it:
--   npx wrangler@4 d1 execute medusa --remote --file=migrations/004_metrics.sql
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
