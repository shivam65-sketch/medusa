-- 001_bronze_loads.sql
-- What every bronze load did, from the Lakeflow pipeline's own event log (lakehouse step 31): for each
-- load and table, the rows written and how many rows passed or failed each expectation
-- (matches_file_layout, has_symbol, and is_data_row on the hourly history).
--
-- event_log() is a table function that reads the event log of the pipeline that owns the table it is
-- given; any of the pipeline's tables gives the whole pipeline's log. Only the pipeline's owner may call
-- it, so this view is how anyone else with access to ops.logs reads it.
--
-- Run by the job lakehouse-ops-views, after the bronze pipeline has run at least once (the view needs
-- its tables). Safe to run again.

CREATE OR REPLACE VIEW ops.logs.bronze_loads (
  event_time     COMMENT 'When the load finished writing the table, UTC',
  update_id      COMMENT 'The pipeline update (one run of the bronze pipeline)',
  table_name     COMMENT 'The bronze table written, e.g. market.bronze.klines_1m',
  rows_written   COMMENT 'Rows the load added to the table',
  expectation    COMMENT 'The data quality rule checked (the CONSTRAINT ... EXPECT lines of the pipeline files)',
  passed_records COMMENT 'Rows that met it',
  failed_records COMMENT 'Rows that did not (kept anyway: bronze only counts them)'
)
COMMENT 'Every bronze load: rows written and each expectation result, from the bronze pipeline event log. One row per load, table and expectation.'
AS
SELECT
  e.timestamp,
  e.origin.update_id,
  e.origin.flow_name,
  CAST(e.details:flow_progress.metrics.num_output_rows AS BIGINT),
  x.name,
  x.passed_records,
  x.failed_records
FROM event_log(TABLE(market.bronze.klines_1m)) AS e
LATERAL VIEW explode(from_json(e.details:flow_progress.data_quality.expectations,
  'array<struct<name:string,passed_records:bigint,failed_records:bigint>>')) q AS x
WHERE e.event_type = 'flow_progress'
  AND e.details:flow_progress.data_quality IS NOT NULL;

ALTER VIEW ops.logs.bronze_loads SET TAGS ('domain' = 'ops', 'layer' = 'logs', 'personal_data' = 'false');
