-- 007_ops_logs.sql
-- The operations logs (lakehouse step 31), in the ops catalog made by 006_layout.sql:
--   pipeline_events  one row per job of every lakehouse workflow run (load, recheck, transform ...),
--                    and one more for each dbt model or test that failed; written by GitHub Actions
--                    at the end of every run, whether it succeeded or not
--   app_events       MEDUSA's failures: errors its pages reported (the Markets page among them) and
--                    errors its server hit; copied from MEDUSA once a day by the daily run
--   recent_failures  a view: the errors of both, last 30 days, newest first
--
-- Both tables are append-only (delta.appendOnly): Databricks refuses UPDATE and DELETE on them, for
-- every user, so a log can't be changed after the fact. Unity Catalog has no insert-only permission
-- (MODIFY also allows updates and deletes), so the table enforces it instead. Nothing is ever
-- deleted: the tables grow by a few thousand rows a year. Neither holds personal data: app_events
-- never records which account had the failure.
--
-- Every row has an event_id made by its writer from where it came from, so writing the same events
-- twice (a retried run) adds nothing: the writers insert only ids that aren't here yet.
--
-- Safe to run again. CHECK constraints can only be added with ALTER TABLE, and adding one that exists
-- fails, so each is dropped (if there) and added again. Descriptions avoid apostrophes.

CREATE TABLE IF NOT EXISTS ops.logs.pipeline_events (
  event_id         STRING    NOT NULL COMMENT 'Unique id from where the row came from: gh:<run id>:<attempt>:<job id>, plus :dbt:<node> for a dbt node',
  event_time       TIMESTAMP NOT NULL COMMENT 'When the job finished, UTC',
  severity         STRING    NOT NULL COMMENT 'info (it worked), warning (cancelled, or a dbt warning) or error (it failed)',
  status           STRING    NOT NULL COMMENT 'success, failure, cancelled or skipped',
  source           STRING    NOT NULL COMMENT 'What ran it: github_actions',
  workflow         STRING    NOT NULL COMMENT 'The workflow, e.g. Lakehouse daily load',
  job              STRING    NOT NULL COMMENT 'The job inside the workflow, e.g. load, recheck, transform, or backfill load (2026-10-01)',
  component        STRING    NOT NULL COMMENT 'What the row is about: job (the whole job) or dbt (one dbt model, snapshot or test)',
  message          STRING    NOT NULL COMMENT 'One line for a person: what happened and, on failure, the step that failed',
  details          STRING             COMMENT 'JSON with the rest: each step and its result, the failed step, the dbt node, its message and failing rows',
  data_date        DATE               COMMENT 'The day of market data the run loaded, when there is exactly one',
  started_at       TIMESTAMP          COMMENT 'When the job started, UTC',
  duration_seconds INT                COMMENT 'How long the job took',
  run_id           BIGINT    NOT NULL COMMENT 'GitHub Actions run number of the workflow run',
  run_attempt      INT       NOT NULL COMMENT '1, or more when the run was re-run',
  run_url          STRING             COMMENT 'Link to the run on GitHub (public repository)',
  git_sha          STRING             COMMENT 'The commit the run used',
  trigger          STRING             COMMENT 'What started the run: schedule or workflow_dispatch (by hand)',
  logged_at        TIMESTAMP NOT NULL COMMENT 'When the row was written to Databricks',
  -- Informational, like the semantic tables: the writers make the ids unique.
  CONSTRAINT pipeline_events_pk PRIMARY KEY (event_id)
)
COMMENT 'Every job of every lakehouse workflow run, and each dbt model or test that failed. Written by GitHub Actions at the end of every run. Append-only.'
TBLPROPERTIES ('delta.appendOnly' = 'true');

ALTER TABLE ops.logs.pipeline_events DROP CONSTRAINT IF EXISTS pipeline_events_severity;
ALTER TABLE ops.logs.pipeline_events ADD CONSTRAINT pipeline_events_severity CHECK (severity IN ('info', 'warning', 'error'));
ALTER TABLE ops.logs.pipeline_events DROP CONSTRAINT IF EXISTS pipeline_events_status;
ALTER TABLE ops.logs.pipeline_events ADD CONSTRAINT pipeline_events_status CHECK (status IN ('success', 'failure', 'cancelled', 'skipped'));
ALTER TABLE ops.logs.pipeline_events DROP CONSTRAINT IF EXISTS pipeline_events_component;
ALTER TABLE ops.logs.pipeline_events ADD CONSTRAINT pipeline_events_component CHECK (component IN ('job', 'dbt'));

CREATE TABLE IF NOT EXISTS ops.logs.app_events (
  event_id   STRING    NOT NULL COMMENT 'Unique id: browser:<id> or server:<id>, from the row id in MEDUSA',
  source     STRING    NOT NULL COMMENT 'browser (an error a MEDUSA page reported) or server (an error the MEDUSA server hit)',
  source_id  BIGINT    NOT NULL COMMENT 'The row id in MEDUSA (D1 app_logs or server_events). The daily copy continues after the highest one already here',
  event_time TIMESTAMP NOT NULL COMMENT 'When it happened, UTC',
  severity   STRING    NOT NULL COMMENT 'error (only errors are copied)',
  area       STRING    NOT NULL COMMENT 'Part of MEDUSA: markets, lab, journal, api, app (pages), or ingest, metrics, import, server (server)',
  message    STRING    NOT NULL COMMENT 'The error, as MEDUSA wrote it',
  details    STRING             COMMENT 'JSON with the rest: where in the code, the address and status code. Secrets are removed before MEDUSA stores a line',
  logged_at  TIMESTAMP NOT NULL COMMENT 'When the daily run copied it to Databricks',
  CONSTRAINT app_events_pk PRIMARY KEY (event_id)
)
COMMENT 'MEDUSA errors: those its pages reported (the Markets page among them) and those its server hit. Copied from MEDUSA once a day. Never says which account. Append-only.'
TBLPROPERTIES ('delta.appendOnly' = 'true');

ALTER TABLE ops.logs.app_events DROP CONSTRAINT IF EXISTS app_events_source;
ALTER TABLE ops.logs.app_events ADD CONSTRAINT app_events_source CHECK (source IN ('browser', 'server'));
ALTER TABLE ops.logs.app_events DROP CONSTRAINT IF EXISTS app_events_severity;
ALTER TABLE ops.logs.app_events ADD CONSTRAINT app_events_severity CHECK (severity IN ('warning', 'error'));

-- One list of what went wrong, from both tables.
CREATE OR REPLACE VIEW ops.logs.recent_failures (
  event_time COMMENT 'When it happened, UTC',
  origin     COMMENT 'pipeline (a lakehouse workflow) or app (MEDUSA)',
  what       COMMENT 'Workflow and job, or MEDUSA source and area',
  message    COMMENT 'What went wrong',
  details    COMMENT 'JSON with the rest',
  link       COMMENT 'The GitHub run, for pipeline rows'
)
COMMENT 'Every error of the last 30 days from pipeline_events and app_events, newest first.'
AS
SELECT event_time, 'pipeline', concat(workflow, ' / ', job), message, details, run_url
FROM ops.logs.pipeline_events
WHERE severity = 'error' AND event_time >= current_timestamp() - INTERVAL 30 DAYS
UNION ALL
SELECT event_time, 'app', concat(source, ' / ', area), message, details, CAST(NULL AS STRING)
FROM ops.logs.app_events
WHERE severity = 'error' AND event_time >= current_timestamp() - INTERVAL 30 DAYS
ORDER BY event_time DESC;

ALTER TABLE ops.logs.pipeline_events SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
ALTER TABLE ops.logs.app_events SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
ALTER VIEW ops.logs.recent_failures SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
