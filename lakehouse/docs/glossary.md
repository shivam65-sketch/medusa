# Glossary

[← Lakehouse home](../README.md)

The data engineering terms used in this project, in plain words.

| Term | Meaning | Where it appears here |
|---|---|---|
| **Append-only table** | A table that only takes new rows: updates and deletes are refused, for everyone. In Delta, the table property `delta.appendOnly = true` | Every table in `ops.logs` ([step 31](steps/31-ops-log-tables.md)) |
| **Artifact (GitHub Actions)** | A file a job keeps for later jobs of the same run, for a few days | The transform keeps dbt's result files for the run's log job |
| **Asset Bundle** | Databricks' "infrastructure as code": a YAML file declaring jobs, pipelines and dashboards, deployed with one command | [`databricks.yml`](../databricks.yml) |
| **Atomic grain** | The finest level of detail stored. Everything coarser is built from it. | 1-minute candles |
| **Atomic write** | Writing a file under a temporary name and renaming it when complete, so a half-written file never appears | The downloader |
| **Audit log** | A record of what happened that is never changed afterwards, so it can be trusted | `ops.logs.etl_runs` and the tables under it |
| **Auto Loader** | Databricks' incremental file loader: it remembers which files it has loaded and reads only new ones | Bronze pipeline |
| **Backfill** | Running the pipeline for past dates to load history | `lakehouse-backfill.yml` |
| **Basis point (bp)** | One hundredth of a percent: 0.01%, or 0.0001 as a fraction | The market by hour of the day, in Insights |
| **Bitemporal** | Tracking both when something was true in the world and when the warehouse knew it | `dim_coin` after the backfill |
| **Breadth** | The share of moving coins that went up | `market_daily.breadth` |
| **Bronze / silver / gold** | The medallion layers: raw data, cleaned and typed data, business-ready tables | Schemas in `market` |
| **Catalog** | Top level of Unity Catalog's `catalog.schema.table` names, roughly a database in SQL Server; here one per kind of data, each its own permission boundary | `market`, `journal`, `ops` ([ADR-032](decisions.md#adr-032-one-catalog-per-kind-of-data-described-and-tagged-in-place-no-renames)) |
| **Catch-up load** | A scheduled load that also tries again the recent days that never finished, so a late day fills itself | The `recheck` job's step **Load recent days that never finished** |
| **Chart spec** | A small description of how to draw a query's result: which column goes on which axis, how marks are coloured, what a click opens. The query decides what, the spec how it looks | A definition's `display.chart` ([ADR-035](decisions.md#adr-035-a-graph-is-a-definition-sql-plus-a-chart-spec-drawn-as-svg-by-the-page)) |
| **Checksum (SHA-256)** | A fingerprint of a file's bytes. If the fingerprint doesn't match the published one, the file is damaged | The downloader |
| **CI/CD** | Automatically checking and deploying code when it changes | Planned |
| **Clustering by day** | Averaging each day's events first and doing the statistics over days, because events on the same day (coins moving together) aren't independent | `event_evidence` |
| **Continuation** | The return after a move, in the move's direction: positive means it kept going, negative means it turned back | `event_evidence` |
| **Data contract** | The rules data must meet before a consumer gets it, checked automatically; data that breaks them doesn't reach the consumer | The dbt tests on `metric_definitions`: a broken definition stops the publish |
| **Data domain** | One area of data with its own owner, meaning and access rules (market data, a person's trades, logs). Keeping domains apart means a grant on one never opens another | One catalog per domain: `market`, `journal`, `ops` |
| **Data observability** | A pipeline reporting on its own data: completeness, freshness, unexpected changes | `data_health` |
| **Date spine** | One row per calendar day, built to compare data against, so that a day with nothing shows up as a row with no match | `gold.missing_days` |
| **Declarative** | Describing what should exist and letting the tool work out how | Bundles, pipelines |
| **Dimension / fact** | Kimball's split: facts are measurements (candles), dimensions describe what is measured (coins) | `dim_coin`, `fct_candle_1m` |
| **DOM** | The page as the browser holds it: a tree of elements. Replacing an element loses what it was holding, such as its scroll position or a text selection | `put()` in `public/markets.js` changes only what differs, so the elements stay |
| **Drill-down (drill-through)** | Clicking a part of a graph or table to open the detail behind it, with what was clicked passed on as parameters | A bar, cell, point or row on Insights opens a window of the moves behind it |
| **Event study** | Finding every moment something specific happened and measuring what followed it | `intraday_events` |
| **Exactly once** | Each input is processed one time: never skipped, never twice | Auto Loader |
| **Expectation** | A data-quality rule in a Lakeflow pipeline that counts, drops or fails on bad rows | Bronze (count only) |
| **Exposure (dbt)** | A declaration that something outside dbt (a dashboard, an app) uses certain models, so the lineage reaches it and dbt can select everything it depends on | `markets_page` in [`exposures.yml`](../dbt/models/exposures.yml) |
| **Foreign key (informational)** | A column that names a row of another table, declared so readers and tools see the relationship, but not checked by the database | `etl_jobs.run_key` → `etl_runs`, `etl_steps.job_key` → `etl_jobs` |
| **Generic / singular test** | dbt tests: a generic test is one line of YAML (`not_null`); a singular test is a SQL file returning bad rows (0 rows = pass) | `dbt/tests/` |
| **Governance tag** | A `key = value` label on a catalog, schema, table or column that says what kind of data it is; searchable, queryable in `information_schema`, and what access rules and audits select on | `domain`, `layer`, `personal_data` on every table |
| **Grain** | What one row of a table means, e.g. one coin per hour | `fct_candle_1h` |
| **Header / detail** | A parent table and its child rows: an order and its lines. Each child carries its parent's key | `etl_runs` → `etl_jobs` → `etl_steps` |
| **Heatmap** | A grid of cells coloured by a number: here blue above zero, red below, grey near zero or where the data is too thin | Every kind of move at a glance; By size and liquidity |
| **Held-back test (out-of-sample)** | Choosing a rule on one period and checking it on another that played no part in choosing it | `event_evidence` (2025 on) |
| **High-water mark (watermark)** | The highest value already processed, kept so the next run continues after it. On insert order (an id), late rows aren't missed | MEDUSA's errors copied after the highest id in `ops.logs.app_events` |
| **Histogram** | Bars counting how many values fall in each range (bin) | Spread of outcomes: moves per 1% step |
| **Hive-style partition** | A folder named `column=value`, read as a column | `date=2026-10-19` |
| **Idempotent** | Running something again gives the same result and does no harm | DDL, downloader, uploads, the metric definitions' seed (`MERGE ... WHEN NOT MATCHED`) |
| **Incremental model** | A dbt model that, after its first full build, processes only new data and merges it in | `fct_candle_1m` |
| **Informational constraint** | A key declared so readers and tools know what a row means, but not enforced by the database (SQL Server: `NOT ENFORCED`); something else checks it | `metric_definitions`' primary key, checked by dbt tests |
| **Lakehouse** | Data stored as open-format files in cheap storage, with warehouse features (tables, SQL, transactions) on top | The whole platform |
| **Lambda architecture** | A slow, complete and checked batch layer plus a fast, approximate live layer, combined where the data is served; the batch layer later replaces the live numbers | The live scanner: this lakehouse plus Binance's live stream, combined in each browser ([ADR-027](decisions.md#adr-027-the-live-layer-runs-in-each-browser)) |
| **Landing zone** | Where raw files arrive, unchanged, before any processing | `market.landing.binance` |
| **Late-arriving data** | Data that comes after the days around it have been processed, so what was built from it has to be built again | A late Binance day: `coin_daily` rebuilds it and the day after it |
| **Least privilege** | Giving each credential only the access its job needs, so a leak does as little harm as possible | MEDUSA's ingest token can only replace the serving tables ([ADR-024](decisions.md#adr-024-a-write-only-endpoint-for-the-serving-copy)); the save login can only use the warehouse and the two definitions tables |
| **Lineage** | Knowing where each piece of data came from, and what uses it | `source_file`, `loaded_at`; each Markets number's query; the `markets_page` exposure |
| **Liquid clustering** | Delta's way of keeping data files grouped by chosen columns as data arrives, replacing partitions and Z-ordering | Silver tables |
| **Look-ahead bias** | Using information that wasn't available at the time, which makes history look better than live results | Avoided: each day's normal uses only earlier days |
| **Manifest** | A list of the files a load produced, with each file's fingerprint, kept so the load can be checked against the source later | `manifests/date=…/manifest.csv` ([ADR-023](decisions.md#adr-023-re-check-loaded-days-against-binance-for-a-week)) |
| **Matrix job** | GitHub Actions running the same job once per value in a list, several at a time | The backfill |
| **Medallion architecture** | Organising data into bronze, silver and gold layers | The schemas |
| **Median** | The middle value: half are above it, half below. Unlike the average, a few extreme values can't pull it | `MEDIAN(kept_going_pct)` in the Insights graphs |
| **MERGE (upsert)** | Insert new rows and update existing ones by a key, in one statement | Incremental models; `live_prices` on the Markets page (`INSERT ... ON CONFLICT DO UPDATE`) |
| **Metadata (technical)** | Data about the data: names, types, descriptions, owners, tags, lineage. Kept with the tables, it lets a reader understand a table without opening the code | Every catalog, schema, table and column described in Databricks (step 30) |
| **Metrics layer (semantic layer)** | Defining each business number once, as data (name, definition, SQL), on shared steps (models), so every report computes it the same way | `market.semantic.metric_definitions`, run by the Markets page ([ADR-028](decisions.md#adr-028-every-number-is-a-sql-query-run-in-the-browser), [ADR-029](decisions.md#adr-029-metric-definitions-are-kept-in-databricks-and-published-with-the-data)) |
| **Multiple testing** | Testing many ideas at once: some pass by luck, so each needs a stricter check | 60 rows in `event_evidence` |
| **Naming convention** | Written rules for names, so a name says what a thing is: its layer, its kind (fact, dimension, building block), its grain and its units | `fct_candle_1m`, `dim_coin`, `int_candle_1h_all`, `_at`, `_usdt` ([step 30](steps/30-catalog-layout.md#naming-rules)) |
| **Natural key** | A key made from what the row is about, not a number the database hands out, so every writer makes the same key for the same thing and a repeat is recognised | `gh:<run>:<attempt>:<job>` in the ETL logs |
| **OAuth client credentials (machine to machine)** | How a program signs in without a person: it trades its client id and secret for a short-lived token, limited to a *scope* (what the token may be used for) | MEDUSA's server gets a one-hour token for its service principal with the `sql` scope (Free Edition refuses `all-apis`) |
| **Optimistic concurrency** | Instead of locking a row while someone edits it, the change says which version it was based on, and is refused if the row changed in the meantime. SQL Server: checking a `rowversion` in the `WHERE` clause | A save carries `:base`, the version the window edited; if someone saved first, the `MERGE` changes nothing and the window is told to reload (409) |
| **Parameterized statement** | A SQL statement sent with its values separately, as named parameters, so a value is always treated as data and can never change the statement itself (no SQL injection). SQL Server: `sp_executesql` with parameters | Every save: the edited SQL is the parameter `:sql_text`, stored by Databricks and never run there ([ADR-031](decisions.md#adr-031-edits-are-saved-to-databricks-by-medusas-server-as-shared-or-personal-versions)) |
| **Persist docs (dbt)** | dbt's option to write the descriptions in its YAML files into the database as table and column comments on every build, so one text in Git documents both dbt and the database | `+persist_docs` in `dbt_project.yml` |
| **Personal data (PII)** | Anything that identifies or describes a person, here an account number or a name. It is labelled so it can be found, kept apart and deleted on request | `personal_data=true` on `user_metric_definitions` and the `journal` catalog |
| **Push and pull** | Push: the source sends data as it happens (streaming). Pull: the reader asks for data when it wants it (batch) | Binance pushes live prices; the Markets page pulls the daily tables |
| **Query parameter** | A named value a query takes when it runs (`:kind`), like a report parameter in SSRS | The Markets page's type filter, yesterday's date, one market |
| **Rate limit** | A cap on how often something may be done in a period, so one user (or a bug) can't use up a shared resource | Saves to Databricks: 20 a day per account and 300 in all; history reads 60 and 600 (every one wakes the SQL warehouse) |
| **Reconciliation test** | A check that two layers add up to the same totals | `assert_candle_1h_reconciles_with_1m` |
| **Rescued data** | A column that catches values that didn't fit the expected file layout, instead of losing them | `_rescued_data` |
| **Retention** | How long each kind of data is kept | [ADR-011](decisions.md#adr-011-keep-1-minute-candles-for-a-limited-time) |
| **Reusable workflow** | A GitHub Actions workflow other workflows call, so shared steps live in one place | `lakehouse-load-day.yml` |
| **Reverse ETL / serving layer** | Copying finished warehouse tables to where an app can serve them | `market_baseline` and `market_evidence` in MEDUSA's D1, published after each transform |
| **Run metadata** | What a run did (its jobs, steps, times, results), read after the fact from the scheduler rather than written by each job | The log job reads its own run from GitHub's API |
| **SCD Type 2** | Keeping the full history of a dimension's changes, one row per version, with when each was valid | `dim_coin`; `metric_definitions` and `user_metric_definitions` (`version`, `valid_from`, `valid_to`, `is_current`) |
| **Schema drift** | A source changing its columns or format over time | Caught by `_rescued_data` |
| **Schema-on-read** | Applying column names and types when reading files, not when storing them | `read_files` in bronze |
| **Seed** | Fixed starting data loaded by a script kept in the repository, so a new environment gets the same rows | [`sql/seed/`](../sql/seed/): version 1 of the metric definitions |
| **Serverless** | Compute that starts when needed and stops afterwards, with nothing to manage | Pipeline, SQL warehouse |
| **Service principal** | A Databricks identity for a program rather than a person, with its own grants and secrets; it keeps working when people change, and can be given exactly the access its job needs | `medusa-markets-writer`: Can use on the warehouse, and `SELECT, MODIFY` on the two definitions tables only |
| **Settling (contract)** | Binance's status for a futures contract it has delisted and is closing out. The archive keeps publishing flat, zero-volume candles for it | Why status comes from trades ([ADR-018](decisions.md#adr-018-a-coin-trades-only-if-it-has-trades)) |
| **Single source of truth (master copy)** | One place where a piece of information is kept and changed; every other copy is made from it and never edited | `metric_definitions` in Databricks; MEDUSA's `market_metrics` and the page's built-in copy follow it |
| **Snapshot (dbt)** | dbt's built-in way to record changes to a table over time as SCD Type 2 | `dim_coin` |
| **Snapshot file** | A table (or a few) exported as one file for a client to load, instead of the client querying the database | The Insights file ([ADR-034](decisions.md#adr-034-the-insights-history-goes-to-medusa-as-one-gzip-file-kept-as-it-is)) |
| **Source freshness** | dbt's check of how long ago a source table last received data | `sources.yml` |
| **Storage / compute separation** | Data sits in storage; engines (warehouses) start up to work on it and can be stopped | Databricks |
| **Streaming table** | A table that is filled incrementally from a source, processing only new data each run | `bronze.klines_1m`, `bronze.metrics` |
| **Sufficient statistics** | The sums from which a statistic can be recomputed for any group of rows: count, sum, sum of squares give the mean and variance of any combination | `gold.hour_drift` keeps `days`, `sum_return`, `sum_sq_return` |
| **Survivorship bias** | Results that look better than reality because failed items (here, delisted coins) were left out | Why `dim_coin` keeps history |
| **SVG** | Scalable Vector Graphics: shapes and text described as markup, drawn by the browser at any size | Every Insights graph (`public/markets-charts.js`) |
| **t-statistic** | average ÷ (standard deviation ÷ √n): whether a pattern is bigger than chance | `hour_profile.t_stat_return` |
| **Unity Catalog** | Databricks' governance layer: names, permissions and lineage for all data | `market` catalog |
| **Vendoring** | Keeping a pinned copy of a third-party library in your own repository instead of loading it from elsewhere at run time | sql.js in `public/vendor/sqljs-1.14.2/` (its fingerprints checked against the publisher's) |
| **Volume** | A Unity Catalog folder for files (not rows) | `market.landing.binance` |
| **VWAP** | Volume-weighted average price: total USDT traded ÷ total coins traded | `fct_candle_1h.vwap` |
| **WebAssembly** | A compact program format browsers run at near-native speed, which lets software written for computers (like SQLite) run in a web page | The Markets page's SQL engine |
| **WebSocket** | A connection that stays open so the server can send messages whenever it has something new, instead of the browser asking again and again | Binance's live stream to the Markets page |
| **Window frame** | The rows a window function looks at, e.g. the 30 rows before the current one | `unusual_moves` |
| **Write-through cache** | A ready-made copy that is rebuilt whenever the data is written, so readers never get an old one | The scanner's answer in Workers KV ([ADR-026](decisions.md#adr-026-the-scanners-answer-is-kept-ready-made-in-workers-kv)); a saved definition, written into MEDUSA's D1 as soon as Databricks has it |
| **z-score** | How many standard deviations a value is from the average | `unusual_moves` |
