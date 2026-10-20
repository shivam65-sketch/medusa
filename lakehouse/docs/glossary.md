# Glossary

[← Lakehouse home](../README.md)

The data engineering terms used in this project, in plain words.

| Term | Meaning | Where it appears here |
|---|---|---|
| **Asset Bundle** | Databricks' "infrastructure as code": a YAML file declaring jobs, pipelines and dashboards, deployed with one command | [`databricks.yml`](../databricks.yml) |
| **Atomic grain** | The finest level of detail stored. Everything coarser is built from it. | 1-minute candles |
| **Atomic write** | Writing a file under a temporary name and renaming it when complete, so a half-written file never appears | The downloader |
| **Auto Loader** | Databricks' incremental file loader: it remembers which files it has loaded and reads only new ones | Bronze pipeline |
| **Bronze / silver / gold** | The medallion layers: raw data, cleaned and typed data, business-ready tables | Schemas in `market` |
| **Catalog** | Top level of Unity Catalog's `catalog.schema.table` names, roughly a database in SQL Server | `market` |
| **Checksum (SHA-256)** | A fingerprint of a file's bytes. If the fingerprint doesn't match the published one, the file is damaged | The downloader |
| **CI/CD** | Automatically checking and deploying code when it changes | Planned |
| **Declarative** | Describing what should exist and letting the tool work out how | Bundles, pipelines |
| **Exactly once** | Each input is processed one time: never skipped, never twice | Auto Loader |
| **Expectation** | A data-quality rule in a Lakeflow pipeline that counts, drops or fails on bad rows | Bronze (count only) |
| **Generic / singular test** | dbt tests: a generic test is one line of YAML (`not_null`); a singular test is a SQL file returning bad rows (0 rows = pass) | `dbt/tests/` |
| **Hive-style partition** | A folder named `column=value`, read as a column | `date=2026-10-19` |
| **Idempotent** | Running something again gives the same result and does no harm | DDL, downloader, uploads |
| **Incremental model** | A dbt model that, after its first full build, processes only new data and merges it in | `fct_candle_1m` |
| **Lakehouse** | Data stored as open-format files in cheap storage, with warehouse features (tables, SQL, transactions) on top | The whole platform |
| **Landing zone** | Where raw files arrive, unchanged, before any processing | `market.landing.binance` |
| **Lineage** | Knowing where each piece of data came from | `source_file`, `loaded_at` |
| **Liquid clustering** | Delta's way of keeping data files grouped by chosen columns as data arrives, replacing partitions and Z-ordering | Silver tables |
| **Medallion architecture** | Organising data into bronze, silver and gold layers | The schemas |
| **MERGE (upsert)** | Insert new rows and update existing ones by a key, in one statement | Incremental models |
| **Rescued data** | A column that catches values that didn't fit the expected file layout, instead of losing them | `_rescued_data` |
| **Retention** | How long each kind of data is kept | [ADR-011](decisions.md#adr-011-keep-1-minute-candles-for-a-limited-time) |
| **Reverse ETL / serving layer** | Copying finished warehouse tables to where an app can serve them | The planned MEDUSA Markets page |
| **SCD Type 2** | Keeping the full history of a dimension's changes, one row per version | Planned `dim_coin` |
| **Schema drift** | A source changing its columns or format over time | Caught by `_rescued_data` |
| **Schema-on-read** | Applying column names and types when reading files, not when storing them | `read_files` in bronze |
| **Serverless** | Compute that starts when needed and stops afterwards, with nothing to manage | Pipeline, SQL warehouse |
| **Source freshness** | dbt's check of how long ago a source table last received data | `sources.yml` |
| **Storage / compute separation** | Data sits in storage; engines (warehouses) start up to work on it and can be stopped | Databricks |
| **Streaming table** | A table that is filled incrementally from a source, processing only new data each run | `bronze.klines_1m`, `bronze.metrics` |
| **Unity Catalog** | Databricks' governance layer: names, permissions and lineage for all data | `market` catalog |
| **Volume** | A Unity Catalog folder for files (not rows) | `market.landing.binance` |
