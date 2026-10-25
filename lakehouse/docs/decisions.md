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
| 013 | [Serve the public dashboard from a daily copy](#adr-013-serve-the-public-dashboard-from-a-daily-copy) | Accepted; "public" superseded by ADR-025 |
| 014 | [DOUBLE, not DECIMAL, for prices and volumes](#adr-014-double-not-decimal-for-prices-and-volumes) | Accepted |
| 015 | [Liquid clustering instead of partitions](#adr-015-liquid-clustering-instead-of-partitions) | Accepted |
| 016 | [Coin history from the candles, with a grace period](#adr-016-coin-history-from-the-candles-with-a-grace-period) | Accepted; status rule superseded by ADR-018 |
| 017 | [Orchestrate the daily chain in GitHub Actions](#adr-017-orchestrate-the-daily-chain-in-github-actions) | Accepted |
| 018 | [A coin trades only if it has trades](#adr-018-a-coin-trades-only-if-it-has-trades) | Accepted |
| 019 | [Hourly candles follow the exchange's definition](#adr-019-hourly-candles-follow-the-exchanges-definition) | Accepted |
| 020 | [Long history from Binance's monthly hourly files](#adr-020-long-history-from-binances-monthly-hourly-files) | Accepted |
| 021 | [Load a day only after Binance has finished publishing it](#adr-021-load-a-day-only-after-binance-has-finished-publishing-it) | Accepted; replaces the 06:00 UTC time in ADR-003 |
| 022 | [Judge the evidence by days and on held-back years](#adr-022-judge-the-evidence-by-days-and-on-held-back-years) | Accepted |
| 023 | [Re-check loaded days against Binance for a week](#adr-023-re-check-loaded-days-against-binance-for-a-week) | Accepted |
| 024 | [A write-only endpoint for the serving copy](#adr-024-a-write-only-endpoint-for-the-serving-copy) | Accepted; builds ADR-013 |
| 025 | [The scanner is for signed-in accounts](#adr-025-the-scanner-is-for-signed-in-accounts) | Accepted; replaces "public" in ADR-013; caching superseded by ADR-026 |
| 026 | [The scanner's answer is kept ready-made in Workers KV](#adr-026-the-scanners-answer-is-kept-ready-made-in-workers-kv) | Accepted; replaces the caching in ADR-025 |
| 027 | [The live layer runs in each browser](#adr-027-the-live-layer-runs-in-each-browser) | Accepted |
| 028 | [Every number is a SQL query, run in the browser](#adr-028-every-number-is-a-sql-query-run-in-the-browser) | Accepted; where the definitions are kept: ADR-029 |
| 029 | [Metric definitions are kept in Databricks and published with the data](#adr-029-metric-definitions-are-kept-in-databricks-and-published-with-the-data) | Accepted |

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

**Status:** Accepted, 2026-10-20. The daily copy stands (built in steps 23 and 24, ADR-024); serving
it on a *public* page was replaced by [ADR-025](#adr-025-the-scanner-is-for-signed-in-accounts).

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

## ADR-017: Orchestrate the daily chain in GitHub Actions

**Status:** Accepted, 2026-10-20

**Context:** After each upload, bronze, a freshness check and dbt must run in order. A Lakeflow Job
could chain the pipeline and a dbt task, but whether Free Edition allows the dbt task type is
unconfirmed ([ADR-010](#adr-010-lakeflow-pipeline-for-bronze-dbt-for-silver-and-gold)), and a
job-side dbt profile would need the workspace address and warehouse id in the repository.

**Decision:** A reusable workflow, `lakehouse-transform.yml`, runs `databricks bundle run bronze`,
then `dbt source freshness` and `dbt build`. The daily load and the backfill call it after their
uploads succeed; it can also be started by hand. The warehouse's HTTP path is looked up by name on
every run and masked in the log.

**Consequences:** The whole chain lives in one place, with one set of secrets and one failure email.
dbt is installed on every run (pip's cache keeps that quick). Everything depends on GitHub's
schedule; if a Databricks-side dbt task becomes possible, the transform can move there.

## ADR-018: A coin trades only if it has trades

**Status:** Accepted, 2026-10-20. Supersedes the status rule of
[ADR-016](#adr-016-coin-history-from-the-candles-with-a-grace-period).

**Context:** ADR-016 counted a coin as trading while it had candles. Binance keeps publishing flat,
zero-volume candles for contracts it has delisted ("settling"): 132 of the 873 coins on 2026-10-19,
confirmed against Binance's own contract list. They were counted as trading, added about 130
"unchanged" coins to every day and pulled the median return to exactly 0.

**Decision:** A coin is *trading* while it has had at least one trade in the last 3 days, and *not
trading* after that. Market-wide measures (`market_daily`) count only coin-days with trades; coin-days
with candles but no trades are counted separately as `coins_inactive`. Candles are still kept and
loaded: they are what the source publishes.

**Consequences:** `dim_coin` recorded 132 corrections as new versions, dated when the warehouse
learned of them, not when the coins stopped trading. Market medians and counts are now real. A test
checks the status against the last 3 days of trades in `coin_daily`.

## ADR-019: Hourly candles follow the exchange's definition

**Status:** Accepted, 2026-10-21

**Context:** Binance fills a minute without trades with a flat candle at the previous price.
Rolling minutes up into hours counted those flat candles, so about 10,600 hours opened at the
previous hour's close and about 2,200 had a slightly wider range than Binance's own hourly candle,
mostly TradFi perpetuals that pause between sessions. The difference only showed when the
minute-built hours were reconciled with Binance's hourly files.

**Decision:** Hourly (and daily) open, high and low come from the minutes (hours) that traded: open
is the first trade, high and low are traded prices. A period with no trades at all keeps its flat
price. A test compares the minute-built hours with Binance's hourly files wherever both exist.

**Consequences:** Every overlapping hour matches the exchange exactly (266,031 of 266,031).
`fct_candle_1h` and `coin_daily` were rebuilt once with a full refresh so the rule applies to all
past days.

## ADR-020: Long history from Binance's monthly hourly files

**Status:** Accepted, 2026-10-21

**Context:** The scanner's evidence needs many past examples; 32 days of 1-minute data gave 296.
Loading years of 1-minute candles would be about 460 million rows a year. Binance also publishes
monthly 1-hour files for every USDT perpetual since January 2020, delisted coins included: 22,221
files, 651 MB zipped, about 16 million rows.

**Decision:** Load the monthly hourly files once (a history workflow, one job per year) into
`bronze.klines_1h` and `silver.fct_candle_1h_archive`, and serve one continuous hourly series,
`int_candle_1h_all`: archive hours before the first minute-built day, minute-built hours after.
Long-horizon analysis reads hours; minute detail stays limited to the recent period (ADR-011).

**Consequences:** Six years of survivorship-free history at hourly grain for a small cost. Files
before 2022 have no header row, so bronze reads every file without a header and silver drops the
header lines. The archive stops at the last published month; the daily 1-minute load extends the
series from there, so the history workflow doesn't need to run again.

## ADR-021: Load a day only after Binance has finished publishing it

**Status:** Accepted, 2026-10-22. Replaces the 06:00 UTC run time of ADR-003.

**Context:** The first scheduled daily load (2026-10-21, for 2026-10-20) failed when one download
lost its connection ("Connection reset by peer"). Looking into it showed a bigger problem. Binance
publishes a day's metrics files around 06:40–07:40 UTC the next day and its 1-minute candles
around 08:00–12:00 UTC (measured 14–20 October), all after the 06:00 schedule. GitHub had started
that run late, at 11:19, when 88 coins' candle files were still missing; they appeared at 11:55.
The downloader counts an unpublished file as *missing*, which is normal for delisted coins, so
without the network error the run would have loaded the day without those 88 coins. The next
run only fetches its own day, so they would never have been loaded.

**Decision:**
- The daily load runs at 13:00 UTC.
- A daily run over every coin refuses a day that isn't fully published, and nothing is uploaded.
  It counts as unpublished when a dataset has no files at all, or when a coin has a metrics file
  but no candle file. That pattern was checked on 14–20 October and never occurs on a complete
  day; the reverse (candles but no metrics, about 120 coins a day) is normal.
- The downloader retries a connection that drops in the middle of a download, as well as one
  that fails to open: 4 tries, 5, 10 and 15 seconds apart.

**Consequences:** Yesterday's data arrives in the afternoon (18:30 India time), not the morning.
A late day fails loudly, with a failure email, instead of loading part of the day; re-running the
failed job later loads it. Binance's publishing time isn't guaranteed, so this can still happen
occasionally.

## ADR-022: Judge the evidence by days and on held-back years

**Status:** Accepted, 2026-10-22

**Context:** The live scanner will show what moves like today's did next. Measured naively,
almost anything looks significant. Coins move together, so events bunch on a few days: in 2021, 552
down events fell on 25 days. Counting them as 552 independent observations overstates the
evidence many times over. And 60 kinds of move and horizon are tested at once, so some will look
good by luck. A pattern also has to pay for trading.

**Decision:**
- Events use exactly the scanner's rule (`coin_baseline`'s 30-day normal, |z| ≥ 3), from the
  continuous hourly series with delisted coins, entering at the close of the hour the move crossed
  the line.
- Statistics are clustered by day: each day's events are averaged first; the average, spread and
  t-statistic are taken over days.
- 2020–2024 chooses the side (follow or fade); 2025 onward only checks it. *Held up* needs
  in-sample |t| ≥ 2, held-back t ≥ 2 on the same side, and a profit after a 0.10% round trip in both
  periods. Fewer than 20 days in either period is *too few*.
- The thresholds and the cost are dbt variables, and the evidence table shows every number behind
  each verdict, not just the verdict.

**Consequences:** Most kinds of move get *no pattern* or *did not hold* (56 of 60 on 2026-10-22),
which is the honest answer. The four that held up all fade the move. The 0.10% cost is optimistic
for small coins and funding isn't counted, so the scanner presents the evidence alongside each flag,
not as a trading signal. The held-back years stay useful only while they aren't used to tune the
rules; changing a threshold after looking at them would turn them into in-sample data.

## ADR-023: Re-check loaded days against Binance for a week

**Status:** Accepted, 2026-10-23

**Context:** Binance can rewrite a day's files after first publishing them: on 2026-10-21 it rewrote
every 1-minute candle file of 2026-10-20 at 11:55, after some of them had been published earlier.
The checksum check proves a file wasn't damaged in transfer, not that Binance won't replace it
later. A day loaded before such a rewrite would keep the old version, and a file that appears late
(for a coin whose candles exist but whose metrics came later) would never be loaded. Two more facts
shape the fix: bronze's Auto Loader never re-reads a file name it has already loaded, and the
landing files are gzipped CSV, so their original fingerprint can't be recomputed later.

**Decision:**
- Every complete daily load writes a manifest next to its files
  (`manifests/date=YYYY-MM-DD/manifest.csv`): for each coin and dataset, saved or missing, the file
  name, and Binance's SHA-256 fingerprint.
- After each daily load, a `recheck` job compares the manifests of the 7 days before yesterday with
  Binance's current `.CHECKSUM` files. A file that changed is downloaded, checked, and saved under a
  new name ending in the start of its new fingerprint (`BTCUSDT-1m-2026-10-20.r3f9a1c2e.csv.gz`), so
  Auto Loader loads it as a new file. A file that appeared is loaded under its usual name. The day's
  manifest is updated, and a warning appears on the run's page. A file that disappeared is only
  reported.
- Silver already keeps the newest row for each coin and minute (or 5 minutes), so corrected values
  replace the old ones, and the incremental hourly and daily models rebuild the days touched.

**Consequences:** A rewrite within a week is picked up automatically on the next daily run, at the
cost of about 12,700 small checksum requests a day (one to two minutes). Older days are not
re-checked. Rows that a rewrite removes would stay in silver (MERGE adds and updates, it doesn't
delete); none have been seen. A failed recheck fails the run (failure email) but doesn't hold back
the new day's transform. Days loaded before 2026-10-23 have no manifest and are skipped.

## ADR-024: A write-only endpoint for the serving copy

**Status:** Accepted, 2026-10-23. How ADR-013's daily copy is built.

**Context:** The live scanner needs `coin_baseline` and `event_evidence` in MEDUSA's database (D1).
The publish job runs in GitHub Actions. It could write to D1 with a Cloudflare API token, but a token
that can write D1 can read and change every table: accounts, password hashes, encrypted exchange
keys. Such a token stored outside Cloudflare would be the most valuable secret in the project.

**Decision:**
- MEDUSA exposes `POST /api/market/ingest`, protected by its own secret (`MARKET_INGEST_TOKEN`,
  compared in constant time). It can only replace the tables in its own list (`market_baseline`,
  `market_evidence`); table and column names never come from the request.
- Every row is validated (columns, types, required values, unique keys, size) before anything is
  written. Each table is replaced in one D1 batch, a single transaction, together with a
  `market_publish` row (day, rows, time).
- The publish job runs after `dbt build` and fails unless MEDUSA reports exactly gold's row count.

**Consequences:** A leaked ingest token could overwrite public market numbers until the next daily
publish, and nothing else; rotating it means saving a new value in Cloudflare and GitHub. The
endpoint is public, so it is a little more attack surface than a private database API, which the
token and validation cover. The payload is limited to 2 MB and the request to Cloudflare's free CPU
budget, so a much larger table would need to be sent in parts.


## ADR-025: The scanner is for signed-in accounts

**Status:** Accepted, 2026-10-23. Replaces the "public page" in ADR-013; the daily copy stays. The
caching described below was replaced by [ADR-026](#adr-026-the-scanners-answer-is-kept-ready-made-in-workers-kv)
on 2026-10-25: Cloudflare's cache does nothing on a `workers.dev` address.

**Context:** ADR-013 planned a public Markets page, so that anyone, recruiters included, could see
the analysis without an account. When the scanner was built (step 25), the owner decided against a
public page: MEDUSA is an app for its account holders, and every other page and API needs a sign-in.

**Decision:** The scanner is a page inside MEDUSA, and its data, `GET /api/market/scanner`, is
behind the same session check as the journal. The answer holds no one's own data, so it is the same
for every account: Cloudflare's cache keeps one copy for everyone (under an internal key no outside
request can reach, and only after the session is checked) and each browser its own
(`Cache-Control: private`, never a shared proxy), each for 5 minutes. Live prices still come straight
from Binance to the browser.

**Consequences:** There is no anonymous traffic on the market tables or the Worker, and no public
address to protect besides the sign-in. Seeing the scanner needs an account (anyone can create one),
so the README shows it with screenshots instead of a public link.

## ADR-026: The scanner's answer is kept ready-made in Workers KV

**Status:** Accepted, 2026-10-25. Replaces the caching in ADR-025.

**Context:** ADR-025 kept one copy of the scanner's answer in Cloudflare's cache for 5 minutes. In
production every answer said `x-cache: MISS`: Cloudflare's Cache API works for Workers on a custom
domain, and MEDUSA runs on a `workers.dev` address. So every page load read both tables from D1,
about 810 rows. The free plan allows 5 million rows read a day, shared with the journal: about 6,000
page loads. Locks were not the issue: D1 runs one query at a time, the read takes about a millisecond,
and the only write is the daily publish, one transaction per table.

**Decision:**
- The ingest rebuilds the answer after every publish and saves it in Workers KV, under
  `market/scanner.json` in the Lab's namespace. The Lab finds its own keys through D1 and never lists
  the namespace, so the two don't meet.
- `GET /api/market/scanner` returns the KV value. When it is missing (before the first publish, or
  after a failed rebuild, which deletes the old value instead of leaving it stale), it reads D1 and
  keeps that answer for 10 minutes. `x-cache` says `KV` or `D1`; the publish job's summary shows
  whether MEDUSA rebuilt the answer.

**Consequences:** Page loads read no D1 rows; KV allows 100,000 reads and 1,000 writes a day, and a
publish uses 2 writes. The answer changes when the data is published (write-through) instead of up
to 5 minutes later. KV can take up to a minute to show a new value everywhere and remembers a missing
key for up to a minute. A failed rebuild costs D1 reads until the next publish, not stale data; a
fallback copy that raced a publish lasts at most 10 minutes. It works the same on a custom domain.

## ADR-027: The live layer runs in each browser

**Status:** Accepted, 2026-10-25. Records how the live layer was built in step 25.

**Context:** Day trading needs today's prices, about once a second, for about 740 markets. A server
could subscribe to Binance and pass prices on, but that needs a process that stays running (Kafka, a
streaming service, or Cloudflare Durable Objects), and keeping live prices in D1 would mean about 64
million row writes a day against a free allowance of 100,000. Binance publishes the same stream to
anyone, without a key.

**Decision:** While the Markets page is open, each browser holds one WebSocket to Binance's public
stream (`wss://fstream.binance.com/market/ws/!miniTicker@arr`), after one REST snapshot of every price
(messages carry only the markets that changed). Prices live only in the tab's memory. MEDUSA's server
never sees them. Until the lakehouse publishes yesterday (about 13:30 UTC), yesterday's closes come
from Binance's daily candles, once a day per browser.

**Consequences:** No server and no cost, and it scales with users: each browser is its own consumer.
Live numbers are unchecked and belong to each browser (two people can see prices a second apart);
nothing live is stored, so there is no live history and no alert while the page is closed. Both
would need a server-side stream (for example Kafka) later. Binance refuses some regions; the page then
shows only the daily numbers.

## ADR-028: Every number is a SQL query, run in the browser

**Status:** Accepted, 2026-10-25. Since step 27 the definitions are kept in Databricks and
`public/markets-metrics.js` is their built-in copy ([ADR-029](#adr-029-metric-definitions-are-kept-in-databricks-and-published-with-the-data)).

**Context:** Release 1.6.0 showed every number on the Markets page as a SQL query, but JavaScript
did the calculating and wrote the query to match, with the prices on screen pasted in. The rule
lived in two places, and editing the query would have changed nothing. The owner wants the SQL to
build the numbers, and the definitions to be stored in Databricks and editable on the page (steps 27
and 28). The queries can't run in D1 (no live prices there, and edited SQL on the shared database
could read the accounts) or in Databricks (seconds per query, quota, and a token the browser can't
hold).

**Decision:**
- SQLite runs in the browser: sql.js 1.14.2 (WebAssembly, MIT), kept in the repository under
  `public/vendor/`, in a background worker that alone may run WebAssembly and reaches only MEDUSA.
- It holds `market_baseline` and `market_evidence` with D1's schema, and two browser-only tables:
  `live_prices` (upserted from the stream) and `binance_markets` (type and Binance's close).
- Every Today number is defined once in `public/markets-metrics.js`: shared steps (`market_now` →
  `today` → `flagged`, and `verdicts`) put in front of a query as `WITH ... AS (...)`, and one query
  per card or table, with parameters `:kind`, `:yesterday` and `:symbol`.
- About once a second the page writes the changed prices and runs the queries in read-only mode; a
  run longer than 15 seconds restarts the engine.
- Copies add the browser-only tables as `VALUES`, as they were for the result on screen, and fill in
  the parameters, so they run in D1, or in Databricks with its table names, and return that result.

**Consequences:** Each rule is written once (the 3σ line only in `flagged`), and the SQL on screen
is the SQL that ran. Every query matched the previous JavaScript rule, and 34 copies gave the same
answers in SQLite and Databricks. It costs a 700 KB download the first time (cached for a year) and
about 50 ms of work a second. Queries must stay portable between SQLite and Databricks: no
SQLite-only functions, `CAST` where SQLite divides whole numbers, `NULLIF` against division by zero.
Search, sorting and pages in Every market stay in the page: they don't change any number.

## ADR-029: Metric definitions are kept in Databricks and published with the data

**Status:** Accepted, 2026-10-25. Where ADR-028's definitions are kept.

**Context:** After step 26 every number on the Markets page was a SQL query, but the queries lived in
`public/markets-metrics.js`: changing a definition meant changing code and deploying MEDUSA, and
nothing recorded what a number meant last week. The owner wants the definitions (name, meaning, SQL)
stored in Databricks, changed from the page (step 28), and the page to follow the change. The page
can't read Databricks itself: a warehouse query takes seconds, wakes the warehouse, uses the daily
quota and needs a token a browser can't hold.

**Decision:**
- A table, `market.semantic.metric_definitions`, is the master copy: one row per definition and
  version (`metric_id`, `version`, `kind`, `name`, `description`, `sql_text`, `display`), with
  SCD Type 2 columns (`valid_from`, `valid_to`, `is_current`) and who changed it and why. A change
  adds a version and closes the old one; nothing is overwritten or deleted.
- The primary key is declared (informational in Unity Catalog), and dbt tests are the contract: one
  current version per id, versions without gaps, plain ids, one read-only statement per query, valid
  JSON for the display. They run in every `dbt build`, before the publish.
- The daily publish copies the current version of each to MEDUSA's D1 (`market_metrics`, replaced
  as a whole) through the same write-only endpoint (ADR-024), and the scanner's answer in KV carries
  it to the page (ADR-026). The history stays in Databricks.
- The page runs the published definitions. `public/markets-metrics.js` stays as the built-in copy,
  used until definitions are published, and the page says which one it is using.

**Consequences:** A definition changes without a deploy, every version is kept with its author and
reason, and a broken definition stops at the tests instead of reaching the page. A change made in
Databricks reaches the page with the next publish, not at once; step 28 publishes on save. Two copies
of version 1 exist (the table and the built-in file), so the built-in copy can fall behind; it only
matters before the first publish. The ingest token can now also replace `market_metrics`: a leak could
change the queries the page runs, but they run read-only in each browser's own database, which holds
only public market data.
