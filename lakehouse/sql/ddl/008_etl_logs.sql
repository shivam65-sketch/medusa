-- 008_etl_logs.sql
-- The ETL logs as related tables (lakehouse step 31), replacing pipeline_events from 007_ops_logs.sql:
--
--   etl_runs     one row per GitHub Actions run of a lakehouse workflow: which workflow, scheduled or
--     |          manual, the day(s) it loaded, when, how long, the result, and how many jobs did what
--     +-- etl_jobs     one row per job of the run (load, recheck, transform, a backfill day ...)
--     |     +-- etl_steps   one row per step of the job; dbt's steps carry their counts
--     +-- etl_errors   the ETL runtime errors and warnings: a failed step with the end of its log, and
--                      each dbt model, test or freshness check that failed or warned
--   daily_etl_status  a view: one row per day, did the scheduled run happen, when, with what result
--   recent_failures   the view of 007, now from etl_errors and app_events
--
-- Keys are text made from GitHub's ids, so every writer makes the same key for the same thing:
--   run_key  gh:<run id>:<attempt>        job_key  <run_key>:<job id>        step_key  <job_key>:<step number>
-- Primary and foreign keys are informational in Unity Catalog (like the semantic tables'): the writer
-- keeps them true, and Catalog Explorer draws the relationships from them.
--
-- Like the other logs, the tables are append-only (delta.appendOnly), nothing is deleted, and nothing
-- in them is about a person: a manual run is just "manual".
--
-- pipeline_events (one table for all of this) is dropped here. 007 has run and is not edited (ADR-006),
-- so running setup_ddl from the start makes it there and drops it here. Safe to run again.

CREATE TABLE IF NOT EXISTS ops.logs.etl_runs (
  run_key          STRING    NOT NULL COMMENT 'gh:<run id>:<attempt>. One row per attempt: a re-run is a new attempt of the same run',
  workflow         STRING    NOT NULL COMMENT 'The workflow: Lakehouse daily load, Lakehouse backfill, Lakehouse history or Lakehouse transform',
  workflow_file    STRING             COMMENT 'Its file in .github/workflows/',
  run_number       INT                COMMENT 'The run number GitHub shows, e.g. 9 for Lakehouse daily load #9',
  run_id           BIGINT    NOT NULL COMMENT 'GitHub id of the run',
  run_attempt      INT       NOT NULL COMMENT '1, or 2 and up for a re-run',
  run_type         STRING    NOT NULL COMMENT 'scheduled (started by the daily schedule), manual (started by hand) or re-run (attempt 2 and up)',
  triggered_by     STRING    NOT NULL COMMENT 'How it started, in words, e.g. GitHub schedule (13:23 UTC) or started by hand with Run workflow',
  trigger_event    STRING             COMMENT 'GitHub event: schedule or workflow_dispatch',
  scheduled_for    TIMESTAMP          COMMENT 'For a scheduled run: the time the schedule (the cron line of the workflow file at that commit) set it for, UTC',
  start_delay_minutes INT             COMMENT 'For a scheduled run (first attempt): minutes GitHub started it after scheduled_for',
  inputs           STRING             COMMENT 'JSON of what was typed when it was started by hand, e.g. the day or the range to load',
  data_date        DATE               COMMENT 'The day of market data loaded, when the run loaded exactly one day',
  data_from        DATE               COMMENT 'First day of market data the run covered (a backfill or history range)',
  data_to          DATE               COMMENT 'Last day of market data the run covered',
  status           STRING    NOT NULL COMMENT 'success (every job that ran succeeded), failure (a job failed) or cancelled',
  started_at       TIMESTAMP          COMMENT 'When the run started, UTC',
  finished_at      TIMESTAMP          COMMENT 'When its last job finished, UTC',
  duration_seconds INT                COMMENT 'From start to the last job finishing',
  jobs_total       INT                COMMENT 'Jobs in the run (the log job itself not counted)',
  jobs_succeeded   INT                COMMENT 'Jobs that succeeded',
  jobs_failed      INT                COMMENT 'Jobs that failed',
  jobs_skipped     INT                COMMENT 'Jobs that did not run (a job they needed failed, or they were not needed)',
  jobs_cancelled   INT                COMMENT 'Jobs cancelled',
  message          STRING    NOT NULL COMMENT 'One line for a person, e.g. Daily load (scheduled) of 2026-10-24: all 3 jobs succeeded in 8m 50s',
  git_sha          STRING             COMMENT 'The commit the run used',
  branch           STRING             COMMENT 'The branch it ran on',
  run_url          STRING             COMMENT 'Link to the run on GitHub (public repository)',
  logged_at        TIMESTAMP NOT NULL COMMENT 'When the row was written to Databricks',
  CONSTRAINT etl_runs_pk PRIMARY KEY (run_key)
)
COMMENT 'One row per run of a lakehouse workflow on GitHub Actions (daily load, backfill, history, transform): scheduled or manual, the days loaded, the result. Append-only.'
TBLPROPERTIES ('delta.appendOnly' = 'true');

CREATE TABLE IF NOT EXISTS ops.logs.etl_jobs (
  job_key          STRING    NOT NULL COMMENT '<run_key>:<GitHub job id>',
  run_key          STRING    NOT NULL COMMENT 'The run it belongs to (etl_runs)',
  job_id           BIGINT    NOT NULL COMMENT 'GitHub id of the job',
  job_name         STRING    NOT NULL COMMENT 'load, recheck, transform, days, or a matrix job such as load (2026-10-01)',
  status           STRING    NOT NULL COMMENT 'success, failure, cancelled or skipped',
  data_date        DATE               COMMENT 'The day of market data the job loaded, when there is one',
  started_at       TIMESTAMP          COMMENT 'When the job started, UTC',
  finished_at      TIMESTAMP          COMMENT 'When it finished, UTC',
  duration_seconds INT                COMMENT 'How long it took',
  steps_total      INT                COMMENT 'Its steps (GitHub set-up and clean-up steps not counted)',
  failed_step      STRING             COMMENT 'The first step that failed, when one did',
  message          STRING    NOT NULL COMMENT 'One line for a person, e.g. transform failed at step Build and test silver and gold after 5m 05s',
  job_url          STRING             COMMENT 'Link to the job and its log on GitHub',
  logged_at        TIMESTAMP NOT NULL COMMENT 'When the row was written to Databricks',
  CONSTRAINT etl_jobs_pk PRIMARY KEY (job_key),
  CONSTRAINT etl_jobs_run_fk FOREIGN KEY (run_key) REFERENCES ops.logs.etl_runs
)
COMMENT 'One row per job of each lakehouse workflow run (etl_runs). Append-only.'
TBLPROPERTIES ('delta.appendOnly' = 'true');

CREATE TABLE IF NOT EXISTS ops.logs.etl_steps (
  step_key         STRING    NOT NULL COMMENT '<job_key>:<step number>',
  job_key          STRING    NOT NULL COMMENT 'The job it belongs to (etl_jobs)',
  run_key          STRING    NOT NULL COMMENT 'The run (etl_runs), kept here too so a step joins its run directly',
  step_number      INT       NOT NULL COMMENT 'Its place in the job, as GitHub numbers it',
  step_name        STRING    NOT NULL COMMENT 'The step, e.g. Download and check Binance files or Build and test silver and gold',
  status           STRING    NOT NULL COMMENT 'success, failure, cancelled or skipped',
  started_at       TIMESTAMP          COMMENT 'When the step started, UTC',
  finished_at      TIMESTAMP          COMMENT 'When it finished, UTC',
  duration_seconds INT                COMMENT 'How long it took',
  details          STRING             COMMENT 'JSON with what the step reported, e.g. for dbt build: models built, tests passed, failed, warned, skipped',
  logged_at        TIMESTAMP NOT NULL COMMENT 'When the row was written to Databricks',
  CONSTRAINT etl_steps_pk PRIMARY KEY (step_key),
  CONSTRAINT etl_steps_job_fk FOREIGN KEY (job_key) REFERENCES ops.logs.etl_jobs,
  CONSTRAINT etl_steps_run_fk FOREIGN KEY (run_key) REFERENCES ops.logs.etl_runs
)
COMMENT 'One row per step of each job (etl_jobs), with how long it took. The dbt steps also carry their counts. GitHub set-up and clean-up steps are left out. Append-only.'
TBLPROPERTIES ('delta.appendOnly' = 'true');

CREATE TABLE IF NOT EXISTS ops.logs.etl_errors (
  error_key        STRING    NOT NULL COMMENT 'Unique: <step_key or job_key>:step or :dbt:<dbt node>',
  run_key          STRING    NOT NULL COMMENT 'The run (etl_runs)',
  job_key          STRING    NOT NULL COMMENT 'The job (etl_jobs)',
  step_key         STRING             COMMENT 'The step it happened in (etl_steps), when known',
  event_time       TIMESTAMP NOT NULL COMMENT 'When it happened, UTC',
  severity         STRING    NOT NULL COMMENT 'error (it failed) or warning (it passed with a warning)',
  category         STRING    NOT NULL COMMENT 'step_failed, dbt_model, dbt_snapshot, dbt_test or dbt_freshness',
  object           STRING             COMMENT 'What failed: the step, or the dbt model, test or source',
  message          STRING    NOT NULL COMMENT 'What went wrong, in one line',
  details          STRING             COMMENT 'JSON with the rest: the end of the step log (GitHub hides secrets), or the dbt message and failing rows',
  logged_at        TIMESTAMP NOT NULL COMMENT 'When the row was written to Databricks',
  CONSTRAINT etl_errors_pk PRIMARY KEY (error_key),
  CONSTRAINT etl_errors_run_fk FOREIGN KEY (run_key) REFERENCES ops.logs.etl_runs,
  CONSTRAINT etl_errors_job_fk FOREIGN KEY (job_key) REFERENCES ops.logs.etl_jobs,
  CONSTRAINT etl_errors_step_fk FOREIGN KEY (step_key) REFERENCES ops.logs.etl_steps
)
COMMENT 'ETL runtime errors and warnings: each failed step with the end of its log, and each dbt model, test or freshness check that failed or warned. Append-only.'
TBLPROPERTIES ('delta.appendOnly' = 'true');

ALTER TABLE ops.logs.etl_runs DROP CONSTRAINT IF EXISTS etl_runs_run_type;
ALTER TABLE ops.logs.etl_runs ADD CONSTRAINT etl_runs_run_type CHECK (run_type IN ('scheduled', 'manual', 're-run'));
ALTER TABLE ops.logs.etl_runs DROP CONSTRAINT IF EXISTS etl_runs_status;
ALTER TABLE ops.logs.etl_runs ADD CONSTRAINT etl_runs_status CHECK (status IN ('success', 'failure', 'cancelled'));
ALTER TABLE ops.logs.etl_jobs DROP CONSTRAINT IF EXISTS etl_jobs_status;
ALTER TABLE ops.logs.etl_jobs ADD CONSTRAINT etl_jobs_status CHECK (status IN ('success', 'failure', 'cancelled', 'skipped'));
ALTER TABLE ops.logs.etl_steps DROP CONSTRAINT IF EXISTS etl_steps_status;
ALTER TABLE ops.logs.etl_steps ADD CONSTRAINT etl_steps_status CHECK (status IN ('success', 'failure', 'cancelled', 'skipped'));
ALTER TABLE ops.logs.etl_errors DROP CONSTRAINT IF EXISTS etl_errors_severity;
ALTER TABLE ops.logs.etl_errors ADD CONSTRAINT etl_errors_severity CHECK (severity IN ('warning', 'error'));
ALTER TABLE ops.logs.etl_errors DROP CONSTRAINT IF EXISTS etl_errors_category;
ALTER TABLE ops.logs.etl_errors ADD CONSTRAINT etl_errors_category CHECK (category IN ('step_failed', 'dbt_model', 'dbt_snapshot', 'dbt_test', 'dbt_freshness'));

-- Every day from the first logged run to today, so a day the schedule never ran shows as missing.
-- A run belongs to the day its first attempt started (when the schedule fired). A re-run only changes its result.
CREATE OR REPLACE VIEW ops.logs.daily_etl_status (
  day                  COMMENT 'The day, UTC',
  scheduled_status     COMMENT 'Result of the day scheduled daily load (its last attempt): success, failure, cancelled, or missing when it never ran',
  scheduled_started_at COMMENT 'When the scheduled run started (GitHub can start it late)',
  scheduled_for        COMMENT 'The time the schedule set it for, as the workflow file said then (06:00, 13:00, later 13:23 UTC)',
  started_late_minutes COMMENT 'Minutes GitHub started it after scheduled_for',
  attempts             COMMENT 'Attempts of the scheduled run: more than 1 means it was re-run',
  data_date_loaded     COMMENT 'The day of market data the scheduled run loaded',
  manual_runs          COMMENT 'Runs started by hand that day, any lakehouse workflow',
  manual_runs_failed   COMMENT 'Of those, how many failed',
  errors               COMMENT 'ETL errors logged that day (etl_errors, severity error)',
  summary              COMMENT 'The scheduled run message'
)
COMMENT 'One row per day: did the scheduled daily load run, when, with what result and for which day of data, plus that day manual runs and errors. Built from etl_runs and etl_errors.'
AS
WITH runs AS (
  SELECT *, CAST(first_started AS DATE) AS day
  FROM (SELECT *, MIN(started_at) OVER (PARTITION BY run_id) AS first_started,
               MAX(CASE WHEN run_attempt = 1 THEN start_delay_minutes END) OVER (PARTITION BY run_id) AS first_delay,
               ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY run_attempt DESC) AS last_attempt
        FROM ops.logs.etl_runs)
),
scheduled AS (
  SELECT day, status, first_started AS started_at, scheduled_for, first_delay, run_attempt, data_date, message,
         ROW_NUMBER() OVER (PARTITION BY day ORDER BY first_started DESC) AS newest
  FROM runs
  WHERE last_attempt = 1 AND workflow = 'Lakehouse daily load' AND trigger_event = 'schedule'
),
manual AS (
  SELECT day, COUNT(*) AS runs, COUNT_IF(status = 'failure') AS failed
  FROM runs WHERE run_type = 'manual' GROUP BY day
),
errs AS (
  SELECT CAST(event_time AS DATE) AS day, COUNT(*) AS errors
  FROM ops.logs.etl_errors WHERE severity = 'error' GROUP BY 1
),
days AS (
  SELECT explode(sequence(first_day, current_date())) AS day FROM (SELECT MIN(day) AS first_day FROM runs)
)
SELECT
  d.day,
  coalesce(s.status, 'missing'),
  s.started_at,
  s.scheduled_for,
  s.first_delay,
  s.run_attempt,
  s.data_date,
  coalesce(m.runs, 0),
  coalesce(m.failed, 0),
  coalesce(e.errors, 0),
  s.message
FROM days AS d
LEFT JOIN scheduled AS s ON s.day = d.day AND s.newest = 1
LEFT JOIN manual AS m ON m.day = d.day
LEFT JOIN errs AS e ON e.day = d.day
ORDER BY d.day DESC;

-- The view of 007, now from etl_errors (with the job link) and app_events.
CREATE OR REPLACE VIEW ops.logs.recent_failures (
  event_time COMMENT 'When it happened, UTC',
  origin     COMMENT 'pipeline (a lakehouse workflow) or app (MEDUSA)',
  what       COMMENT 'Workflow, job and what failed, or MEDUSA source and area',
  message    COMMENT 'What went wrong',
  details    COMMENT 'JSON with the rest',
  link       COMMENT 'The GitHub job, for pipeline rows'
)
COMMENT 'Every error of the last 30 days from etl_errors and app_events, newest first.'
AS
SELECT e.event_time, 'pipeline', concat(r.workflow, ' / ', j.job_name, ' / ', coalesce(e.object, e.category)), e.message, e.details, j.job_url
FROM ops.logs.etl_errors AS e
JOIN ops.logs.etl_jobs AS j ON j.job_key = e.job_key
JOIN ops.logs.etl_runs AS r ON r.run_key = e.run_key
WHERE e.severity = 'error' AND e.event_time >= current_timestamp() - INTERVAL 30 DAYS
UNION ALL
SELECT event_time, 'app', concat(source, ' / ', area), message, details, CAST(NULL AS STRING)
FROM ops.logs.app_events
WHERE severity = 'error' AND event_time >= current_timestamp() - INTERVAL 30 DAYS
ORDER BY event_time DESC;

DROP TABLE IF EXISTS ops.logs.pipeline_events;

ALTER TABLE ops.logs.etl_runs SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
ALTER TABLE ops.logs.etl_jobs SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
ALTER TABLE ops.logs.etl_steps SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
ALTER TABLE ops.logs.etl_errors SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
ALTER VIEW ops.logs.daily_etl_status SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
ALTER VIEW ops.logs.recent_failures SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
