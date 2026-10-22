# Architecture

[← Lakehouse home](../README.md)

## What the platform does

Every day it collects the previous day's market data for every Binance USDⓈ-M perpetual future
(about 870 coins), keeps the full history in a lakehouse, and turns it into daily tables that
dashboards analyse: yesterday on its own, and yesterday against the past.

## Data flow

```mermaid
flowchart TB
  subgraph GH["GitHub Actions · daily 13:23 UTC"]
    D1["download_binance.py<br>list coins · download · SHA-256 check · unzip · gzip"]
    D2["databricks fs cp<br>upload to the landing volume"]
    D1 --> D2
  end
  BIN["data.binance.vision<br>(Binance's public archive)"] --> D1
  subgraph DBX["Databricks Free Edition · catalog market"]
    L["landing.binance (volume)<br>klines_1m/date=…/ · metrics/date=…/ · klines_1h/month=…/"]
    BR["bronze.klines_1m · bronze.metrics · bronze.klines_1h<br>streaming tables (Auto Loader)"]
    SI["silver (dbt)<br>typed facts · dim_coin (SCD2) · 1h candles · hourly series since 2020"]
    GO["gold (dbt)<br>coin_daily · market_daily · unusual_moves · hour_profile · data_health<br>coin_baseline · intraday_events · event_evidence"]
    L --> BR --> SI --> GO
  end
  D2 --> L
  GO -.->|"daily copy (planned)"| CF["MEDUSA live scanner<br>Cloudflare D1 + live Binance stream"]
```

## Where each part runs

| Part | Runs on | Why there |
|---|---|---|
| Download, checksum, upload | GitHub Actions (free for public repositories) | Databricks Free Edition only allows internet access to a short list of trusted sites, so the download has to happen outside it. A fresh Linux machine per run, so nothing is left over between days. |
| Storage, compute, tables | Databricks Free Edition | Unity Catalog, Delta tables, serverless compute, pipelines and dashboards, with no cost. |
| Bronze loading | Lakeflow Declarative Pipeline (serverless, triggered) | Auto Loader loads each new file exactly once and remembers what it has loaded. |
| Silver and gold | dbt Core on the SQL warehouse | SQL models with tests, snapshots, documentation and lineage. |
| Orchestration | GitHub Actions: load, then transform ([ADR-017](decisions.md#adr-017-orchestrate-the-daily-chain-in-github-actions)) | One place for the whole chain, one set of secrets and one failure email. |
| Deploying Databricks resources | Databricks Asset Bundle ([`databricks.yml`](../databricks.yml)) | Jobs and pipelines are defined as code and deployed with one command. |
| Live scanner (planned) | MEDUSA on Cloudflare, with live prices streamed from Binance to the browser | Readers can't sign in to a Databricks workspace, and day trading needs today's prices: a daily copy of the small gold tables in MEDUSA's database gives each coin's normal, and the browser compares the live market with it. |

## Catalog layout

Unity Catalog names everything `catalog.schema.object`, like a database, schema and table in
SQL Server.

| Object | Kind | Purpose |
|---|---|---|
| `market` | Catalog | The whole platform |
| `market.landing` | Schema | Raw files |
| `market.landing.binance` | Volume (managed) | Daily files, one folder per dataset and day: `klines_1m/date=2026-10-19/BTCUSDT-1m-2026-10-19.csv.gz` |
| `market.bronze` | Schema | Raw rows: `klines_1m`, `metrics`, `klines_1h` (monthly history files) |
| `market.silver` | Schema | Typed, checked tables (dbt), including `fct_candle_1h_archive` and the continuous hourly series `int_candle_1h_all` |
| `market.gold` | Schema | Tables the live scanner and analysis read (dbt): daily tables, each coin's `coin_baseline`, and the scanner's evidence (`intraday_events`, `event_evidence`) |

## Daily timeline (UTC)

| Time | What happens |
|---|---|
| ~06:40–07:40 | Binance publishes the previous day's metrics files |
| ~08:00–12:00 | Binance publishes the previous day's 1-minute candle files (measured 14–20 October 2026) |
| 13:23 | GitHub Actions downloads every coin's files (~1 minute), checks they are all published and match their checksums, and uploads them with the day's manifest (~2.5 minutes in total); a day that isn't fully published stops here ([ADR-021](decisions.md#adr-021-load-a-day-only-after-binance-has-finished-publishing-it)) |
| Right after | Recheck: the previous 7 days' manifests are compared with Binance's fingerprints, and changed or new files are loaded under new names ([ADR-023](decisions.md#adr-023-re-check-loaded-days-against-binance-for-a-week)) |
| Right after | The same run's `transform` job: bronze pipeline, `dbt source freshness`, `dbt build` (silver and gold, with tests) |

## Volumes of data

| Dataset | Per day | Notes |
|---|---|---|
| 1-minute candles | ~872 files, 1,255,680 rows, ~33 MB gzipped | 1,440 rows per coin |
| Market metrics (open interest, long/short ratios) | ~744 files, ~205,000 rows, ~9 MB gzipped | Should be 288 rows per coin; many coins have fewer |
| A year of candles | ~460 million rows | Why 1-minute data is kept for a limited time (see [retention](decisions.md#adr-011-keep-1-minute-candles-for-a-limited-time)) |

## Free Edition limits that shaped the design

- Serverless compute only; one SQL warehouse, size 2X-Small.
- At most 5 job tasks at a time, and one active pipeline per pipeline type.
- A daily fair-use quota: going over shuts compute off for the rest of the day.
- Internet access from inside Databricks is limited to trusted sites.
- Non-commercial use only.

## What's left out on purpose

See [Decisions](decisions.md#adr-012-tools-left-out-on-purpose): Airflow, PySpark, Kafka, Great
Expectations, Terraform and a second warehouse each have a reason.
