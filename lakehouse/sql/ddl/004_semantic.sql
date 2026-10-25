-- 004_semantic.sql
-- The semantic layer: the definitions of the numbers MEDUSA shows (its metrics), kept as data.
-- Each metric's name, meaning and SQL live here, and every change adds a new version instead of
-- overwriting the old one, the same way dim_coin keeps a coin's history (SCD Type 2).
-- MEDUSA's Markets page runs the current versions, and step 28 lets the owner edit them from the page.
-- Safe to run again: IF NOT EXISTS skips what already exists.
CREATE SCHEMA IF NOT EXISTS market.semantic
  COMMENT 'Definitions of the numbers the apps show: name, meaning and SQL, with every version kept';

CREATE TABLE IF NOT EXISTS market.semantic.metric_definitions (
  metric_id   STRING    NOT NULL COMMENT 'Stable id the page uses, e.g. breadth. It never changes',
  version     INT       NOT NULL COMMENT '1 for the first definition, then 2, 3 ... one row per change',
  kind        STRING    NOT NULL COMMENT 'model = a shared step other queries read by name (like a view), metric = a number or table on the page',
  name        STRING    NOT NULL COMMENT 'The name shown on the page',
  description STRING             COMMENT 'What the number means, in plain words',
  sql_text    STRING    NOT NULL COMMENT 'The query, in SQLite\'s dialect and kept portable to Databricks',
  display     STRING             COMMENT 'How the result is shown, as JSON: a card\'s text, or each column\'s label and format',
  valid_from  TIMESTAMP NOT NULL COMMENT 'When this version came into use',
  valid_to    TIMESTAMP          COMMENT 'When a newer version replaced it, empty while it is current',
  is_current  BOOLEAN   NOT NULL COMMENT 'True for the one version in use',
  changed_by  STRING    NOT NULL COMMENT 'Who made this version: a name, never an email',
  change_note STRING             COMMENT 'Why it changed',
  -- Informational: Unity Catalog records the key for readers and tools but doesn't enforce it.
  -- The dbt tests on this table do (one row per metric and version, one current version per metric).
  CONSTRAINT metric_definitions_pk PRIMARY KEY (metric_id, version)
)
COMMENT 'Every version of every metric definition. The current one per metric has is_current = true.';

-- In Databricks an apostrophe in a string is written \' ('' would join two strings and drop it).
-- The first run of this file used '' in these two comments, so they are set again here.
ALTER TABLE market.semantic.metric_definitions ALTER COLUMN sql_text
  COMMENT 'The query, in SQLite\'s dialect and kept portable to Databricks';
ALTER TABLE market.semantic.metric_definitions ALTER COLUMN display
  COMMENT 'How the result is shown, as JSON: a card\'s text, or each column\'s label and format';
