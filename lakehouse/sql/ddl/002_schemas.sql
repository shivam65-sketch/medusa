-- 002_schemas.sql
-- One schema per layer of the medallion architecture.
CREATE SCHEMA IF NOT EXISTS market.landing
  COMMENT 'Raw files exactly as downloaded from data.binance.vision';

CREATE SCHEMA IF NOT EXISTS market.bronze
  COMMENT 'Rows loaded from the landing files, nothing changed';

CREATE SCHEMA IF NOT EXISTS market.silver
  COMMENT 'Checked and cleaned facts and dimensions';

CREATE SCHEMA IF NOT EXISTS market.gold
  COMMENT 'Daily tables the dashboard reads';