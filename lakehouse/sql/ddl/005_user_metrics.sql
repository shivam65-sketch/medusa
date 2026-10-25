-- 005_user_metrics.sql
-- Personal versions of the Markets page's definitions. Any MEDUSA account can change the SQL of a
-- number (or of a shared step) for itself: its versions are kept here, only that account's page uses
-- them, and the shared definitions in metric_definitions stay as they are. Like metric_definitions,
-- a change never overwrites a row: it closes the account's current version and adds the next one
-- (SCD Type 2). Closing the current version without adding one sends the account back to the shared
-- definition. MEDUSA writes here through its server when someone presses Save on the page.
-- Safe to run again: IF NOT EXISTS skips what already exists.
CREATE TABLE IF NOT EXISTS market.semantic.user_metric_definitions (
  account_id  BIGINT    NOT NULL COMMENT 'The MEDUSA account the version belongs to: its number, never its email',
  metric_id   STRING    NOT NULL COMMENT 'The definition it changes: a metric_id of metric_definitions',
  version     INT       NOT NULL COMMENT '1 for the first personal version of this definition for this account, then 2, 3 ...',
  sql_text    STRING    NOT NULL COMMENT 'The query, in SQLite\'s dialect and kept portable to Databricks',
  description STRING             COMMENT 'What the number means with this query, in plain words',
  based_on    INT                COMMENT 'The shared version (metric_definitions.version) the account started from',
  valid_from  TIMESTAMP NOT NULL COMMENT 'When this version came into use',
  valid_to    TIMESTAMP          COMMENT 'When it was replaced or given up, empty while it is current',
  is_current  BOOLEAN   NOT NULL COMMENT 'True for the version in use. None current: the account uses the shared definition',
  changed_by  STRING    NOT NULL COMMENT 'The name the account gave in MEDUSA, or account and its number: never an email',
  change_note STRING             COMMENT 'Why it changed',
  -- Informational, like metric_definitions: the dbt tests enforce it.
  CONSTRAINT user_metric_definitions_pk PRIMARY KEY (account_id, metric_id, version)
)
COMMENT 'Each MEDUSA account\'s own versions of the Markets definitions. The shared ones are in metric_definitions.';
