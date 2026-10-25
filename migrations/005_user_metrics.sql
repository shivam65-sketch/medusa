-- Each account's own versions of the Markets definitions: the current version of each row of the
-- lakehouse's market.semantic.user_metric_definitions (lakehouse step 28). Only that account's page
-- uses them; the shared definitions are in market_metrics. Written when someone saves on the page
-- (POST /api/market/metrics/save, src/metrics.js) and replaced as a whole by the lakehouse's daily
-- publish, so it always ends up matching Databricks. Create it once, before deploying the code that
-- reads it:
--   npx wrangler@4 d1 execute medusa --remote --file=migrations/005_user_metrics.sql
CREATE TABLE IF NOT EXISTS market_user_metrics (
  user_id INTEGER NOT NULL,          -- the account it belongs to
  metric_id TEXT NOT NULL,           -- the definition it changes (market_metrics.metric_id)
  version INTEGER NOT NULL,          -- the account's version in use
  sql_text TEXT NOT NULL,            -- the query the account's page runs instead of the shared one
  description TEXT,
  based_on INTEGER,                  -- the shared version it was edited from
  valid_from TEXT,                   -- when this version came into use (UTC)
  changed_by TEXT,
  change_note TEXT,
  PRIMARY KEY (user_id, metric_id)
);
