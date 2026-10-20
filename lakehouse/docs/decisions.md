# Decisions

[← Lakehouse home](../README.md)

Architecture decision records (ADRs): one entry per significant choice. Each says what was
decided, why, and what it costs. An accepted decision isn't edited later; if it changes, a new
entry replaces it and the old one is marked *Superseded*.

| # | Decision | Status |
|---|---|---|
| 001 | [Build the lakehouse inside the MEDUSA repository](#adr-001-build-the-lakehouse-inside-the-medusa-repository) | Accepted |
| 002 | [Databricks Free Edition as the lakehouse](#adr-002-databricks-free-edition-as-the-lakehouse) | Accepted |
| 003 | [Download outside Databricks, with GitHub Actions](#adr-003-download-outside-databricks-with-github-actions) | Accepted |
| 004 | [Use Binance's archive files, not its API](#adr-004-use-binances-archive-files-not-its-api) | Accepted |
| 005 | [Store landing files as gzipped CSV](#adr-005-store-landing-files-as-gzipped-csv) | Accepted |
| 006 | [DDL as numbered, re-runnable files](#adr-006-ddl-as-numbered-re-runnable-files) | Accepted |
| 007 | [Deploy with a Databricks Asset Bundle](#adr-007-deploy-with-a-databricks-asset-bundle) | Accepted |
| 008 | [Personal access tokens for authentication](#adr-008-personal-access-tokens-for-authentication) | Accepted |
| 009 | [Bronze keeps every column as text](#adr-009-bronze-keeps-every-column-as-text) | Accepted |
| 010 | [Lakeflow pipeline for bronze, dbt for silver and gold](#adr-010-lakeflow-pipeline-for-bronze-dbt-for-silver-and-gold) | Accepted |
| 011 | [Keep 1-minute candles for a limited time](#adr-011-keep-1-minute-candles-for-a-limited-time) | Accepted |
| 012 | [Tools left out on purpose](#adr-012-tools-left-out-on-purpose) | Accepted |
| 013 | [Serve the public dashboard from a daily copy](#adr-013-serve-the-public-dashboard-from-a-daily-copy) | Accepted |
| 014 | [DOUBLE, not DECIMAL, for prices and volumes](#adr-014-double-not-decimal-for-prices-and-volumes) | Accepted |
| 015 | [Liquid clustering instead of partitions](#adr-015-liquid-clustering-instead-of-partitions) | Accepted |
| 016 | [Coin history from the candles, with a grace period](#adr-016-coin-history-from-the-candles-with-a-grace-period) | Accepted |

---

## ADR-001: Build the lakehouse inside the MEDUSA repository

**Status:** Accepted, 2026-10-20

**Context:** MEDUSA is an existing trading journal and backtesting app on Cloudflare. Its own
trading data is far too small to justify a data pipeline; market data for every coin is not.

**Decision:** The lakehouse lives in `lakehouse/` in the MEDUSA repository, as MEDUSA's market data
platform, instead of in a separate repository.

**Consequences:** One project tells one story (app + data platform). Cloudflare only deploys `src/`
and `public/`, so nothing in `lakehouse/` reaches the website. The lakehouse needs its own
`.gitignore` (MEDUSA tracks a `.zip` file, so a repository-wide `*.zip` rule would be wrong), and
the workflow must sit at the repository root in `.github/workflows/`.

## ADR-002: Databricks Free Edition as the lakehouse

**Status:** Accepted, 2026-10-20

**Context:** The platform needs storage that keeps history, SQL compute, scheduled pipelines and
dashboards, at no cost, with no expiry date (trials of other warehouses end after 30–60 days).

**Decision:** Databricks Free Edition: Unity Catalog, Delta tables, serverless pipelines, jobs, a
SQL warehouse, AI/BI dashboards and Genie.

**Consequences:** Real lakehouse tooling, but inside Free Edition's limits (see
[Architecture](architecture.md#free-edition-limits-that-shaped-the-design)): serverless only, one
small warehouse, one active pipeline per type, a daily fair-use quota, restricted internet access,
non-commercial use.

## ADR-003: Download outside Databricks, with GitHub Actions

**Status:** Accepted, 2026-10-20

**Context:** Free Edition only allows internet access to a limited set of trusted sites, so a
Databricks job can't be relied on to fetch files from Binance. A Cloudflare Worker gets 10 ms of
CPU per request, too little to unzip and move hundreds of files.

**Decision:** A GitHub Actions workflow downloads, checks and uploads the files every day at
06:00 UTC. It's free for public repositories and runs for minutes if needed.

**Consequences:** Two systems take part in each daily run (GitHub, then Databricks). Credentials for
Databricks are stored as GitHub secrets. GitHub pauses scheduled workflows in public repositories
after 60 days without commits, so that needs watching.

## ADR-004: Use Binance's archive files, not its API

**Status:** Accepted, 2026-10-20

**Context:** Binance's futures API refuses requests from some countries, including the US, where
GitHub's servers mostly are. The archive at data.binance.vision is plain file hosting, publishes a
SHA-256 checksum next to every file, and lists its own folders.

**Decision:** All data comes from the archive's daily files. The coin list comes from the archive's
own folder listing.

**Consequences:** No API key and no country blocking. Data arrives once a day, a few hours after
midnight UTC. Funding rates are only published as monthly files, so they will arrive late and be
merged in when each month's file appears.

## ADR-005: Store landing files as gzipped CSV

**Status:** Accepted, 2026-10-20

**Context:** Binance publishes each file as a `.zip`. Databricks' file reader can't read `.zip`,
but reads `.csv.gz` directly.

**Decision:** The downloader verifies the zip's checksum, takes the CSV out and stores it gzipped,
in Hive-style folders: `<dataset>/date=YYYY-MM-DD/<file>.csv.gz`.

**Consequences:** About half the size of plain CSV. The `date=` folder becomes a `date` column, and a
single day can be reloaded or deleted on its own. The original zip isn't kept, but it can always
be downloaded again from Binance.

## ADR-006: DDL as numbered, re-runnable files

**Status:** Accepted, 2026-10-20

**Context:** Typing DDL into the SQL editor leaves no history and can't be repeated reliably.

**Decision:** Catalog, schemas and volume are created by numbered files in `sql/ddl/`
(`001_`, `002_`, `003_`), each using `IF NOT EXISTS`, run in order by a job. A later change gets a
new numbered file; files that have already run are never edited. Tables loaded by pipelines are
defined in the pipeline files instead, because there the pipeline file is the table's DDL.

**Consequences:** The whole structure can be rebuilt from Git at any time, and running it again is
harmless. No `GRANT` statements yet, because there is only one user.

## ADR-007: Deploy with a Databricks Asset Bundle

**Status:** Accepted, 2026-10-20

**Context:** Jobs and pipelines created by clicking in the UI can't be reviewed, versioned or
recreated.

**Decision:** Every Databricks resource is declared in `databricks.yml` and deployed with
`databricks bundle deploy`. The SQL warehouse is found by name (`lookup`), and the workspace address
comes from the CLI profile, so no IDs or addresses are stored in the public repository. One target,
`prod`, because Free Edition has a single workspace.

**Consequences:** The workspace always matches the file after a deploy. A team setup would add `dev`
and `staging` targets.

## ADR-008: Personal access tokens for authentication

**Status:** Accepted, 2026-10-20

**Context:** Databricks recommends OAuth, but a community report says OAuth sign-in isn't supported
on Free Edition hosts.

**Decision:** Personal access tokens, 90-day lifetime: one for the local CLI (stored in
`~/.databrickscfg`, outside the repository) and a separate one for GitHub Actions (stored as an
encrypted GitHub secret), so either can be revoked without breaking the other.

**Consequences:** Tokens expire and must be renewed (see [Operations](operations.md#secrets-and-renewals)).
The professional upgrade is a service principal (a robot account) with OAuth, if Free Edition
allows it.

## ADR-009: Bronze keeps every column as text

**Status:** Accepted, 2026-10-20

**Context:** Bronze should hold exactly what arrived. If bronze converted types, one odd value or a
format change would stop the load and the original value would be lost.

**Decision:** Bronze reads the files with an explicit schema in which every column is `STRING`, and
adds `_rescued_data` for anything that doesn't fit the expected layout. Quality rules in bronze only
count problems; they never drop rows. Converting types is silver's job.

**Consequences:** Bronze never fails because of the data, and a change in Binance's file layout
("schema drift") is visible in `_rescued_data` instead of being lost. Silver has to cast every
column and handle bad values.

## ADR-010: Lakeflow pipeline for bronze, dbt for silver and gold

**Status:** Accepted, 2026-10-20

**Context:** Both Lakeflow pipelines and dbt can transform data on Databricks; using both for the
same job would duplicate work.

**Decision:** Each tool has one job. The Lakeflow pipeline with Auto Loader loads files into bronze,
which is what it's best at (incremental, exactly-once file loading). dbt builds silver and gold:
SQL models, tests, snapshots for history (SCD Type 2), source freshness checks, and generated docs
with lineage.

**Consequences:** A daily job will run the pipeline first, then dbt. Whether Free Edition allows
the job's built-in dbt task is unconfirmed; the fallback is running `dbt build` in GitHub Actions.

## ADR-011: Keep 1-minute candles for a limited time

**Status:** Accepted, 2026-10-20

**Context:** 1-minute candles are the finest detail available (the "atomic grain"): hourly and daily
figures can be built from them, never the other way round. They are also by far the biggest table,
about 460 million rows a year.

**Decision:** Store 1-minute candles, and build hourly and daily tables from them with dbt.
Dashboards only read the hourly and daily tables. Retention: landing files about 30 days (Binance
keeps the originals), 1-minute candles about 12 months, hourly and daily tables forever.

**Consequences:** Analysis that needs minute detail (realised volatility, the biggest 1-minute move
of the day, intraday drawdown) works for the last year; everything older uses the hourly and daily
tables.

## ADR-012: Tools left out on purpose

**Status:** Accepted, 2026-10-20

| Tool | Why it isn't used |
|---|---|
| Airflow | Needs a server running all day, and there's no free host for one. Lakeflow Jobs and GitHub Actions do its job here. |
| PySpark | Spark already runs underneath Databricks SQL; writing PySpark would only add Python, with no benefit for this data. |
| Kafka | The data arrives once a day as files, not as a stream. |
| Great Expectations | dbt tests and pipeline expectations already cover data quality. |
| Terraform | The Asset Bundle manages Databricks, and Wrangler already manages Cloudflare. |
| A second warehouse | One warehouse is enough; a second would only copy the data. |

## ADR-013: Serve the public dashboard from a daily copy

**Status:** Accepted, 2026-10-20 (not built yet)

**Context:** Recruiters can't sign in to a Databricks workspace, so the analysis needs a public page.
A public page that queried Databricks directly would wake the warehouse on every visit, use up the
free quota, and need a Databricks token behind a public website.

**Decision:** After each daily run, a GitHub Action reads the small gold tables through the
Databricks SQL API and loads them into MEDUSA's Cloudflare database. MEDUSA serves a public Markets
page from that copy (a "serving layer", also called reverse ETL).

**Consequences:** The public page is fast and free, and the warehouse stays private. The page is at
most one day behind, which matches the daily data anyway.

## ADR-014: DOUBLE, not DECIMAL, for prices and volumes

**Status:** Accepted, 2026-10-20

**Context:** Silver has to turn bronze's text into numbers. Money is often stored as DECIMAL for
exactness, but the analysis here is returns, volatility and averages over millions of rows.

**Decision:** Prices and volumes are DOUBLE; trade counts are BIGINT.

**Consequences:** Binance publishes at most 8 decimal places, and DOUBLE keeps 15–17 significant
digits, so no published value is changed. Calculations stay fast and avoid Spark's DECIMAL rules,
where multiplying two wide DECIMALs can round away precision. DOUBLE isn't suitable for exact
accounting (adding up money to the cent); nothing in this platform does that.

## ADR-015: Liquid clustering instead of partitions

**Status:** Accepted, 2026-10-20

**Context:** Large tables are queried by coin and by day. The older approach is to partition by
date (one folder per day) and Z-order by coin, which creates many small files for small days and
has to be maintained.

**Decision:** Silver tables use Delta liquid clustering on (`symbol`, date) through dbt's
`liquid_clustered_by`.

**Consequences:** Databricks keeps the files organised by coin and day as data arrives, works with
incremental MERGE, and the clustering keys can be changed later without rewriting the table by hand.

## ADR-016: Coin history from the candles, with a grace period

**Status:** Accepted, 2026-10-20

**Context:** A coin dimension needs each coin's description and whether it trades, with history.
Binance's archive has no listing or delisting dates; the exchange's own instrument list comes from
its API, which this platform doesn't use ([ADR-004](#adr-004-use-binances-archive-files-not-its-api)).

**Decision:** Work the description out from the data already loaded: base asset and multiplier from
the symbol, first day from the earliest candle, and status from the latest candle, with a coin
counted as *not trading* only after 3 days without candles. A dbt snapshot (`strategy: check`) keeps
every change (SCD Type 2).

**Consequences:** No extra source to maintain. A delisting appears in the history up to 3 days
late, and `valid_from` times are when the snapshot ran, not the exchange's exact listing moment.
Loading older history would move `first_candle_date` earlier and record that as a new version.

