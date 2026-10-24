# Glossary

[← Lakehouse home](../README.md)

The data engineering terms used in this project, in plain words.

| Term | Meaning | Where it appears here |
|---|---|---|
| **Asset Bundle** | Databricks' "infrastructure as code": a YAML file declaring jobs, pipelines and dashboards, deployed with one command | [`databricks.yml`](../databricks.yml) |
| **Atomic grain** | The finest level of detail stored. Everything coarser is built from it. | 1-minute candles |
| **Atomic write** | Writing a file under a temporary name and renaming it when complete, so a half-written file never appears | The downloader |
| **Auto Loader** | Databricks' incremental file loader: it remembers which files it has loaded and reads only new ones | Bronze pipeline |
| **Backfill** | Running the pipeline for past dates to load history | `lakehouse-backfill.yml` |
| **Bitemporal** | Tracking both when something was true in the world and when the warehouse knew it | `dim_coin` after the backfill |
| **Breadth** | The share of moving coins that went up | `market_daily.breadth` |
| **Bronze / silver / gold** | The medallion layers: raw data, cleaned and typed data, business-ready tables | Schemas in `market` |
| **Catalog** | Top level of Unity Catalog's `catalog.schema.table` names, roughly a database in SQL Server | `market` |
| **Checksum (SHA-256)** | A fingerprint of a file's bytes. If the fingerprint doesn't match the published one, the file is damaged | The downloader |
| **CI/CD** | Automatically checking and deploying code when it changes | Planned |
| **Clustering by day** | Averaging each day's events first and doing the statistics over days, because events on the same day (coins moving together) aren't independent | `event_evidence` |
| **Continuation** | The return after a move, in the move's direction: positive means it kept going, negative means it turned back | `event_evidence` |
| **Data observability** | A pipeline reporting on its own data: completeness, freshness, unexpected changes | `data_health` |
| **Declarative** | Describing what should exist and letting the tool work out how | Bundles, pipelines |
| **Dimension / fact** | Kimball's split: facts are measurements (candles), dimensions describe what is measured (coins) | `dim_coin`, `fct_candle_1m` |
| **Event study** | Finding every moment something specific happened and measuring what followed it | `intraday_events` |
| **Exactly once** | Each input is processed one time: never skipped, never twice | Auto Loader |
| **Expectation** | A data-quality rule in a Lakeflow pipeline that counts, drops or fails on bad rows | Bronze (count only) |
| **Exposure (dbt)** | A declaration that something outside dbt (a dashboard, an app) uses certain models, so the lineage reaches it and dbt can select everything it depends on | `markets_page` in [`exposures.yml`](../dbt/models/exposures.yml) |
| **Generic / singular test** | dbt tests: a generic test is one line of YAML (`not_null`); a singular test is a SQL file returning bad rows (0 rows = pass) | `dbt/tests/` |
| **Grain** | What one row of a table means, e.g. one coin per hour | `fct_candle_1h` |
| **Held-back test (out-of-sample)** | Choosing a rule on one period and checking it on another that played no part in choosing it | `event_evidence` (2025 on) |
| **Hive-style partition** | A folder named `column=value`, read as a column | `date=2026-10-19` |
| **Idempotent** | Running something again gives the same result and does no harm | DDL, downloader, uploads |
| **Incremental model** | A dbt model that, after its first full build, processes only new data and merges it in | `fct_candle_1m` |
| **Lakehouse** | Data stored as open-format files in cheap storage, with warehouse features (tables, SQL, transactions) on top | The whole platform |
| **Lambda architecture** | A slow, complete and checked batch layer plus a fast, approximate live layer, combined where the data is served; the batch layer later replaces the live numbers | The live scanner: this lakehouse plus Binance's live stream, combined in each browser ([ADR-027](decisions.md#adr-027-the-live-layer-runs-in-each-browser)) |
| **Landing zone** | Where raw files arrive, unchanged, before any processing | `market.landing.binance` |
| **Lineage** | Knowing where each piece of data came from, and what uses it | `source_file`, `loaded_at`; each Markets number's query; the `markets_page` exposure |
| **Liquid clustering** | Delta's way of keeping data files grouped by chosen columns as data arrives, replacing partitions and Z-ordering | Silver tables |
| **Least privilege** | Giving each credential only the access its job needs, so a leak does as little harm as possible | MEDUSA's ingest token can only replace two market tables ([ADR-024](decisions.md#adr-024-a-write-only-endpoint-for-the-serving-copy)) |
| **Look-ahead bias** | Using information that wasn't available at the time, which makes history look better than live results | Avoided: each day's normal uses only earlier days |
| **Manifest** | A list of the files a load produced, with each file's fingerprint, kept so the load can be checked against the source later | `manifests/date=…/manifest.csv` ([ADR-023](decisions.md#adr-023-re-check-loaded-days-against-binance-for-a-week)) |
| **Matrix job** | GitHub Actions running the same job once per value in a list, several at a time | The backfill |
| **Medallion architecture** | Organising data into bronze, silver and gold layers | The schemas |
| **MERGE (upsert)** | Insert new rows and update existing ones by a key, in one statement | Incremental models; `live_prices` on the Markets page (`INSERT ... ON CONFLICT DO UPDATE`) |
| **Metrics layer (semantic layer)** | Defining each business number once, as data (name, definition, SQL), on shared steps (models), so every report computes it the same way | `public/markets-metrics.js`; Databricks in step 27 ([ADR-028](decisions.md#adr-028-every-number-is-a-sql-query-run-in-the-browser)) |
| **Multiple testing** | Testing many ideas at once: some pass by luck, so each needs a stricter check | 60 rows in `event_evidence` |
| **Push and pull** | Push: the source sends data as it happens (streaming). Pull: the reader asks for data when it wants it (batch) | Binance pushes live prices; the Markets page pulls the daily tables |
| **Query parameter** | A named value a query takes when it runs (`:kind`), like a report parameter in SSRS | The Markets page's type filter, yesterday's date, one market |
| **Reconciliation test** | A check that two layers add up to the same totals | `assert_candle_1h_reconciles_with_1m` |
| **Rescued data** | A column that catches values that didn't fit the expected file layout, instead of losing them | `_rescued_data` |
| **Retention** | How long each kind of data is kept | [ADR-011](decisions.md#adr-011-keep-1-minute-candles-for-a-limited-time) |
| **Reusable workflow** | A GitHub Actions workflow other workflows call, so shared steps live in one place | `lakehouse-load-day.yml` |
| **Reverse ETL / serving layer** | Copying finished warehouse tables to where an app can serve them | `market_baseline` and `market_evidence` in MEDUSA's D1, published after each transform |
| **SCD Type 2** | Keeping the full history of a dimension's changes, one row per version | `dim_coin` |
| **Schema drift** | A source changing its columns or format over time | Caught by `_rescued_data` |
| **Schema-on-read** | Applying column names and types when reading files, not when storing them | `read_files` in bronze |
| **Serverless** | Compute that starts when needed and stops afterwards, with nothing to manage | Pipeline, SQL warehouse |
| **Settling (contract)** | Binance's status for a futures contract it has delisted and is closing out. The archive keeps publishing flat, zero-volume candles for it | Why status comes from trades ([ADR-018](decisions.md#adr-018-a-coin-trades-only-if-it-has-trades)) |
| **Snapshot (dbt)** | dbt's built-in way to record changes to a table over time as SCD Type 2 | `dim_coin` |
| **Source freshness** | dbt's check of how long ago a source table last received data | `sources.yml` |
| **Storage / compute separation** | Data sits in storage; engines (warehouses) start up to work on it and can be stopped | Databricks |
| **Streaming table** | A table that is filled incrementally from a source, processing only new data each run | `bronze.klines_1m`, `bronze.metrics` |
| **Survivorship bias** | Results that look better than reality because failed items (here, delisted coins) were left out | Why `dim_coin` keeps history |
| **t-statistic** | average ÷ (standard deviation ÷ √n): whether a pattern is bigger than chance | `hour_profile.t_stat_return` |
| **Unity Catalog** | Databricks' governance layer: names, permissions and lineage for all data | `market` catalog |
| **Vendoring** | Keeping a pinned copy of a third-party library in your own repository instead of loading it from elsewhere at run time | sql.js in `public/vendor/sqljs-1.14.2/` (its fingerprints checked against the publisher's) |
| **Volume** | A Unity Catalog folder for files (not rows) | `market.landing.binance` |
| **VWAP** | Volume-weighted average price: total USDT traded ÷ total coins traded | `fct_candle_1h.vwap` |
| **WebAssembly** | A compact program format browsers run at near-native speed, which lets software written for computers (like SQLite) run in a web page | The Markets page's SQL engine |
| **WebSocket** | A connection that stays open so the server can send messages whenever it has something new, instead of the browser asking again and again | Binance's live stream to the Markets page |
| **Window frame** | The rows a window function looks at, e.g. the 30 rows before the current one | `unusual_moves` |
| **Write-through cache** | A ready-made copy that is rebuilt whenever the data is written, so readers never get an old one | The scanner's answer in Workers KV ([ADR-026](decisions.md#adr-026-the-scanners-answer-is-kept-ready-made-in-workers-kv)) |
| **z-score** | How many standard deviations a value is from the average | `unusual_moves` |
