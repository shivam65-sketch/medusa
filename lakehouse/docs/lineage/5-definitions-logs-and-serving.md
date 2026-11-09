# 5. Definitions, logs and MEDUSA's copy

[← 4. Gold: moves and evidence](4-gold-moves-and-evidence.md) · [Lineage and transformations](README.md)

The tables that aren't built from candles: the definitions of the Markets page's numbers, the logs of every
run, and the copy of the gold tables that MEDUSA reads.

## `market.semantic.metric_definitions`

**One row per** version of a definition of a number on the Markets page. **Built from** no other table:
rows are written by two things, and never overwritten.
**Which rows:** every version ever made; the one in use has `is_current = true`.

| Writer | When | How |
|---|---|---|
| The seed files, [`sql/seed/001…`](../../sql/seed/) | When a step adds or changes definitions, run once by hand | One `MERGE` per file: it inserts the versions that aren't in the table yet and closes the ones they replace, so running a file twice changes nothing |
| The Markets page's **Save**, from the owner's account | When the owner edits a definition | MEDUSA's server runs one `MERGE` through the service principal `medusa-markets-writer`: it closes the version that was edited and adds the next, in one statement, so the two can't half happen. If someone saved in between, nothing changes |

How each column of a new version is set by a Save:

| Column | From | How |
|---|---|---|
| `metric_id` | The definition edited | Unchanged across versions |
| `version` | The table | The highest version of this definition + 1 |
| `kind`, `name`, `display` | The version in use | Carried over: `max_by(kind, version)` and so on. A Save never changes them |
| `description`, `sql_text` | The page | What was typed and edited |
| `valid_from` | | `current_timestamp()` |
| `valid_to`, `is_current` | | `NULL` and `true`. The version it replaces gets `valid_to = current_timestamp()` and `is_current = false` |
| `changed_by` | MEDUSA | The account's name in MEDUSA, never an email. The seed files write `Shivam` |
| `change_note` | The page | The note typed on Save. The seed files write why the step changed it |

**Checked by:** `assert_metric_definitions_one_current_version`, `assert_metric_definitions_valid`.

## `market.semantic.user_metric_definitions`

**One row per** version of a definition that one MEDUSA account changed for itself. **Built from** the Markets
page's **Save** by any account other than the owner's, through the same server and one `MERGE`. Only that
account's page uses the version.

| Column | From | How |
|---|---|---|
| `account_id` | MEDUSA's session | The signed-in account's number, never its email |
| `metric_id` | The definition edited | Unchanged |
| `version` | The table | That account's highest version of this definition + 1 |
| `sql_text`, `description`, `change_note` | The page | What was typed |
| `based_on` | `metric_definitions.version` | The shared version in use when the account saved |
| `valid_from`, `valid_to`, `is_current` | | As in `metric_definitions`. **Use the shared version again** closes the current version without adding one, which sends the account back to the shared definition |
| `changed_by` | MEDUSA | The account's name, or `account 12` if it has none |

**Checked by:** `assert_user_metric_definitions_valid`.

## The logs: `ops.logs`

Every table here is append-only (`delta.appendOnly = true`): rows are added and never changed or deleted. A
row is added only when its key isn't in the table yet (`where not exists`), so describing the same run twice
adds nothing. `logged_at` on every table is `current_timestamp()` when the row was written.

### `etl_runs`, `etl_jobs`, `etl_steps`, `etl_errors`

**Built from** GitHub's API, by [`ops/log_pipeline_run.py`](../../ops/log_pipeline_run.py). The last job of
every lakehouse workflow describes its own run, whose other jobs have all finished: the run, its jobs and
steps from GitHub, the log of a failed job, and dbt's counts and failures from the result files the
transform leaves (`run_results.json`, `sources.json`).

**`etl_runs`**, one row per run attempt:

| Column | From GitHub's run | How |
|---|---|---|
| `run_key` | `id`, `run_attempt` | `'gh:' + id + ':' + run_attempt` |
| `workflow`, `workflow_file` | `name`, `path` | `name`; the last part of `path` |
| `run_number`, `run_id`, `run_attempt`, `trigger_event` | `run_number`, `id`, `run_attempt`, `event` | Unchanged |
| `run_type` | `run_attempt`, `event` | Attempt 2 or more → `re-run`; event `schedule` → `scheduled`; else `manual` |
| `triggered_by` | The same, and the cron line | In words: `GitHub schedule: cron "23 13 * * *", every day at 13:23 UTC`, or `Started by hand…`, or `Re-run (attempt 2)…` |
| `scheduled_for` | `created_at`, the workflow file's cron line at the run's commit | The schedule's last time at or before GitHub created the run |
| `start_delay_minutes` | `run_started_at`, `scheduled_for` | Minutes between them, first attempt only |
| `inputs` | The values typed when started by hand | As JSON |
| `data_date` | The workflow's `--data-date` | The day loaded. A scheduled daily load loads the day before it started |
| `data_from`, `data_to` | The jobs' names, or the inputs | The first and last date (or year) in the jobs' names, such as `load (2026-10-01)`; else the `start` and `end` typed; else `data_date` |
| `status` | The jobs' results | `failure` if any job failed, `cancelled` if any was cancelled, else `success` |
| `started_at`, `finished_at`, `duration_seconds` | `run_started_at`, the jobs' `completed_at` | From the start to the last job's end |
| `jobs_total`, `jobs_succeeded`, `jobs_failed`, `jobs_skipped`, `jobs_cancelled` | The jobs | Counted, the log job itself left out |
| `message` | The above | `Daily load (scheduled) of 2026-10-24: all 3 jobs succeeded in 9m 12s` |
| `git_sha`, `branch`, `run_url` | `head_sha`, `head_branch`, `html_url` | Unchanged |

**`etl_jobs`**, one row per job: `job_key` is `run_key + ':' + job id`; `job_name` is GitHub's, with
`transform / transform` shortened to `transform`; `status` maps GitHub's result (`timed_out`,
`startup_failure` → `failure`); `data_date` is the date in the job's name, or the run's; `steps_total` counts
the steps without GitHub's set-up and clean-up; `failed_step` is the first step that failed; `message` says
what happened in words.

**`etl_steps`**, one row per step: `step_key` is `job_key + ':' + step number`. `details` is filled for two
steps of the transform, from dbt's result files:

| Step | `details` | How |
|---|---|---|
| Build and test silver and gold | `built`, `tests_passed`, `failed`, `warned`, `skipped`, `elapsed_seconds` | From `run_results.json`: models, snapshots and seeds that succeeded; tests with status `pass`; nodes with `error`, `fail` or `runtime error`; and so on |
| Check bronze is fresh | `sources`, `status` | From `sources.json`: how many sources were checked, and how many passed, warned or failed |

**`etl_errors`**, two kinds of row:

| Kind | `error_key` | How the rest is made |
|---|---|---|
| A failed step | `step_key + ':step'` | `category` `step_failed`, `severity` `error`; `message` names the job and step, with the error line from the job's log; `details` holds up to 15 log lines before GitHub marked the error |
| A dbt model, snapshot, test or source freshness that failed or warned | `job_key + ':dbt:' + dbt's id` | `category` `dbt_model`, `dbt_snapshot`, `dbt_test` or `dbt_freshness`; `severity` `error` or `warning`; `details` holds dbt's message, the number of failing rows and the table |

### `app_events`

**One row per** error MEDUSA had. **Built from** MEDUSA's own tables in Cloudflare D1: `app_logs` (the lines a
page reported with `level = 'error'`) and `server_events` (errors MEDUSA's server hit), read once a day by
[`ops/ship_app_events.py`](../../ops/ship_app_events.py) through MEDUSA's read-only export, `GET /api/ops/events`.

The high-water mark is MEDUSA's row id, not the time: the script asks Databricks for the highest `source_id`
of each source, then MEDUSA for the rows after it. A browser that was offline can send a line late, but it
still gets a new id, so nothing is skipped.

| Column | From MEDUSA | How |
|---|---|---|
| `event_id` | Source and id | `concat(source, ':', source_id)`: `browser:812` |
| `source` | Which table | `browser` (`app_logs`) or `server` (`server_events`) |
| `source_id` | `id` | Unchanged |
| `event_time` | `at` | `timestamp_millis(at)` |
| `severity` | | `'error'` |
| `area`, `message`, `details` | `area`, `msg`, `data` | Unchanged, except that MEDUSA leaves out the account and replaces anything that looks like an email address with `[email]` before sending |

### The views

| View | Built from | How |
|---|---|---|
| `daily_etl_status` | `etl_runs`, `etl_errors` | One row per day from the first logged run to today (`explode(sequence(…))`). Each run belongs to the day its first attempt started, and its result is its last attempt's. The scheduled daily load of that day gives `scheduled_status` (`missing` when there is none), its times, attempts and `data_date`; manual runs and errors are counted per day |
| `recent_failures` | `etl_errors` + `etl_jobs` + `etl_runs`, and `app_events` | The errors of the last 30 days from both, `union all`, newest first. `what` is `workflow / job / object` or `source / area` |
| `bronze_loads` | The bronze pipeline's event log, `event_log(TABLE(market.bronze.klines_1m))` | One row per load, table and rule: `rows_written` from `details:flow_progress.metrics.num_output_rows`, and each `EXPECT` rule's passed and failed rows from `details:flow_progress.data_quality.expectations`, `explode`d |

## MEDUSA's copy: Cloudflare D1

After every build passes its tests, [`serving/publish_to_medusa.py`](../../serving/publish_to_medusa.py) reads
five tables from Databricks and sends each to MEDUSA's write-only endpoint, `POST /api/market/ingest`.
MEDUSA checks every row (no unknown column; text, numbers, whole numbers and dates of the right type; the key
present and never repeated) and then, in one transaction:

```sql
DELETE FROM market_baseline;
INSERT INTO market_baseline (symbol, base_asset, …)
  SELECT json_extract(value, '$.symbol'), json_extract(value, '$.base_asset'), …
  FROM json_each(?1, '$.rows');                       -- ?1 is the whole request body
INSERT INTO market_publish (tbl, as_of, rows, published_at) VALUES (…)
  ON CONFLICT(tbl) DO UPDATE SET …;
```

The script then **reconciles**: MEDUSA must report exactly as many rows as gold has, or the step fails.

| D1 table | From | What changes on the way |
|---|---|---|
| `market_baseline` | `gold.coin_baseline` | `as_of_date` becomes text. Left out: `multiplier`, `avg_range_30d`, `avg_volatility_30d`, `sd_volatility_30d` |
| `market_evidence` | `gold.event_evidence` | Left out: `in_sample_events`, `in_sample_hit_rate`, `held_back_events`, `in_sample_net_after_cost` |
| `market_missing_days` | `gold.missing_days` | `trade_date` becomes text; `days_old` left out. The page ignores `waiting` |
| `market_metrics` | `semantic.metric_definitions` | Only `where is_current`; `valid_from` becomes text (`yyyy-MM-dd HH:mm:ss`); `valid_to` and `is_current` left out |
| `market_user_metrics` | `semantic.user_metric_definitions` | Only `where is_current`; `account_id` renamed `user_id`; `valid_from` as text |
| `market_publish` | Written by the endpoint | `tbl`; `as_of` = `max(trade_date)` of `gold.coin_daily`, the day the copy reflects; `rows`; `published_at` (milliseconds) |

A Save on the Markets page also writes the new version straight into `market_metrics` or
`market_user_metrics`, so it shows before the next publish.

## MEDUSA's copy: Workers KV

| Key | Built from | How |
|---|---|---|
| `market/scanner.json` | The D1 tables above, except `market_user_metrics` | Rebuilt by MEDUSA after a shared table is replaced: each table's `columns` and `rows`, and the `published` records. It is what `GET /api/market/scanner` answers, the same for every account |
| `market/insights.json.gz` | `gold.intraday_events`, `gold.hour_drift`, `gold.move_outcomes` | Built by the publish script, which checks the rows itself (about 21,000, too many for the ingest's row checks on the free plan), packs them into one gzip file and sends it with `PUT /api/market/insights`. MEDUSA keeps it as it is and reports its SHA-256 back, which must match |

What changes on the way into the Insights file:

| File table | From | What changes |
|---|---|---|
| `market_events` | `gold.intraday_events` | Kept: `symbol`, `event_date` and `event_hour` (as text), `hour_of_day`, `direction`, `z` (rounded to 3 decimals), `z_band`, `liquidity`, `move_so_far` and the three forward returns (6 decimals), `period`, `market_type`. Left out: `prev_close`, `entry_price` and the baseline columns |
| `market_hours` | `gold.hour_drift` | Every column; dates as text |
| `market_outcomes` | `gold.move_outcomes` | Every column; continuations rounded to 6 decimals, `hit_rate` to 4 |

## On the Markets page: the browser's tables

The page keeps a SQLite database in the browser tab and fills it from the two KV files and Binance. Closing
the tab deletes it.

| Table | Filled from |
|---|---|
| `market_baseline`, `market_evidence` | `market/scanner.json`, with D1's columns |
| `market_events`, `market_hours`, `market_outcomes` | `market/insights.json.gz`, when Insights or one of its windows opens |
| `live_prices` | Binance's live stream, about once a second: `symbol`, `price`, `quote_volume_24h` |
| `binance_markets` | Binance's contract list once a day (`market_type`, grouped as in `dim_market_type`), and Binance's daily candle for yesterday (`yesterday_close`, `yesterday_high`, `yesterday_low`) while the lakehouse doesn't have yesterday yet |

From here every number on the page is a query in `market_metrics` (or the account's own version) run over
these tables. What each of those queries calculates is the subject of a separate page.
