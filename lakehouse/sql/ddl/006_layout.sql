-- 006_layout.sql
-- The catalog layout (lakehouse step 30). One catalog per kind of data, so each is its own
-- permission boundary:
--   market   public market data, from Binance's files to the numbers MEDUSA shows (no personal data)
--   journal  each MEDUSA account's trades, private (filled in step 32)
--   ops      logs of the pipelines and of MEDUSA (filled in step 31)
-- Existing schemas and tables keep their names: renaming them would break dbt, the bronze pipeline,
-- the publish job, the Markets page's Databricks copies and the docs, for no gain.
--
-- Catalog Explorer lists schemas alphabetically, so each market schema's description starts with
-- its place in the flow ("1 of 5 · Landing" ... "5 of 5 · Semantic"). The descriptions written by
-- 002_schemas.sql are replaced here (a file that has run is never edited, ADR-006).
--
-- Safe to run again. Descriptions avoid apostrophes: in Databricks '' joins two strings.

-- market: what each schema is, in the order the data flows.
COMMENT ON CATALOG market IS 'Public crypto market data: Binance USD-M futures, from the raw files to the numbers MEDUSA shows. No personal data.';
COMMENT ON SCHEMA market.landing IS '1 of 5 · Landing: Binance files exactly as downloaded and checksum-verified, in the volume binance';
COMMENT ON SCHEMA market.bronze IS '2 of 5 · Bronze: every file line as a row, all columns as text, nothing dropped (Lakeflow pipeline)';
COMMENT ON SCHEMA market.silver IS '3 of 5 · Silver: typed and checked facts and dimensions (dbt)';
COMMENT ON SCHEMA market.gold IS '4 of 5 · Gold: business-ready daily tables that the Markets page and analysis read (dbt)';
COMMENT ON SCHEMA market.semantic IS '5 of 5 · Semantic: the definitions of the numbers MEDUSA shows (name, meaning, SQL), every version kept';

-- Tags: what kind of data each catalog holds, and each schema's layer.
ALTER CATALOG market SET TAGS ('domain' = 'market', 'personal_data' = 'false');
ALTER SCHEMA market.landing SET TAGS ('layer' = 'landing');
ALTER SCHEMA market.bronze SET TAGS ('layer' = 'bronze');
ALTER SCHEMA market.silver SET TAGS ('layer' = 'silver');
ALTER SCHEMA market.gold SET TAGS ('layer' = 'gold');
ALTER SCHEMA market.semantic SET TAGS ('layer' = 'semantic');

-- The schema Databricks created with the catalog, never used. RESTRICT (the default) refuses to drop
-- a schema that holds anything, so nothing can be lost here.
DROP SCHEMA IF EXISTS market.default;

-- ops: logs (step 31).
CREATE CATALOG IF NOT EXISTS ops
  COMMENT 'Operations: logs of the lakehouse pipelines and of MEDUSA (lakehouse step 31). No market data and no personal data.';
ALTER CATALOG ops SET TAGS ('domain' = 'ops', 'personal_data' = 'false');
CREATE SCHEMA IF NOT EXISTS ops.logs
  COMMENT 'Append-only event logs: pipeline_events (builds, loads, transforms, publishes) and app_events (MEDUSA serving side)';
ALTER SCHEMA ops.logs SET TAGS ('layer' = 'logs');
DROP SCHEMA IF EXISTS ops.default;

-- journal: private trades (step 32). Its schemas are created when step 32 needs them.
CREATE CATALOG IF NOT EXISTS journal
  COMMENT 'Private: the trades of each MEDUSA account, copied from MEDUSA every day (lakehouse step 32). Every table carries account_id.';
ALTER CATALOG journal SET TAGS ('domain' = 'journal', 'personal_data' = 'true');
DROP SCHEMA IF EXISTS journal.default;
