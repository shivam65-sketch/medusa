# How the daily pipeline works: questions and answers

[← Lakehouse home](../README.md)

Short answers to the questions people ask first, with links to the detailed pages.

## Which workflows are there, and when does each run?

| Workflow | When it runs | What it does |
|---|---|---|
| **Lakehouse daily load** (`lakehouse-daily.yml`) | Automatically every day at 13:23 UTC (18:53 India time); GitHub can start it late. Also a **Run workflow** button with an optional date. | The main job: "load one day" for yesterday, re-check the 7 days before against Binance, then "transform" if the load succeeded |
| **Lakehouse load one day** (`lakehouse-load-day.yml`) | Never on its own: the daily load and the backfill call it | Download one day for every coin, check it, upload it to Databricks |
| **Lakehouse transform** (`lakehouse-transform.yml`) | After every successful load, or by hand | Bronze pipeline, source freshness, `dbt build` of silver and gold with all tests |
| **Lakehouse backfill** (`lakehouse-backfill.yml`) | Only by hand, with a first and last day (up to 60) | Loads past days, 4 at a time, then runs the transform once |
| **Lakehouse history** (`lakehouse-history.yml`) | Only by hand, with a first and last year | Loads Binance's monthly hourly files, one job per year, then the transform. Ran once, on 2026-10-20 |

## What happens on a normal day?

1. **13:23 UTC, load (about 2.5 minutes)**, on a fresh GitHub machine: list the coins in Binance's
   archive, download yesterday's files only (about 872 candle files and 744 metrics files), check
   every file's SHA-256 fingerprint, check that Binance has finished publishing the day, and upload
   that one day's folder with its manifest (every file's fingerprint) to the landing volume.
2. **Recheck (one to two minutes)**: compare the manifests of the 7 days before yesterday with
   Binance's fingerprints now, and load any file Binance changed or added since.
3. **Transform (about 5 minutes)**: the bronze pipeline loads only the new files; `dbt source
   freshness` checks bronze is recent; `dbt build` updates silver and gold and runs 111 tests.

A failure at any point stops the rest and sends GitHub's failure email.

## Does it download the whole history every day?

No. Every layer only takes what is new:

| Layer or table | What a daily run reads |
|---|---|
| Download | Yesterday's files only |
| Landing volume | One new `date=…` folder; earlier days stay as they are |
| Bronze | Only the new files: Auto Loader remembers every file it has loaded |
| `fct_candle_1m`, `fct_metrics_5m` | Only rows loaded since the last run (incremental, MERGE) |
| `fct_candle_1h` | Only the new day's hours |
| `coin_daily` | The new day and the day after it (a return needs the previous close) |
| `fct_candle_1h_archive` | Nothing: the history was loaded once |
| `dim_coin` | Every coin's current description, recording only changes |
| `market_daily`, `data_health`, `unusual_moves`, `hour_profile`, `coin_baseline` | Rebuilt in full: they are small and built from `coin_daily` |
| `intraday_events`, `event_evidence` | Rebuilt in full from the hourly series since 2020 (about 40 seconds), because yesterday's events only get their 24-hour result today and the statistics cover every year |

Nothing is downloaded twice; the only history that is re-read is inside Databricks, for the evidence.

## Where does dbt run?

dbt turns each model into SQL and sends it to the **Databricks SQL warehouse**, which does the work
and writes the tables. That is the same whether dbt is started on a developer's computer (from
`lakehouse/.venv`) or by the transform workflow on a GitHub machine (installed on each run). Both
write the same `market.silver` and `market.gold` tables.

## Why is "load one day" a separate workflow? What is a backfill?

"Load one day" holds the steps for one day (download, check, upload) in one place. The daily load
calls it for yesterday; the backfill calls it once for each day of a range. The two can never drift
apart, much like two jobs calling the same stored procedure.

A **backfill** loads past days that are missing. It was used once to load the 30 days before the
platform started (2026-09-18 to 2026-10-17), because each coin's "normal" needs 30 days of history.
It is also the way to catch up if the daily run fails for several days.

## Which checks run during a load?

The checks live in the downloader, so every workflow that downloads gets them:

| Check | Daily load | Backfill | History |
|---|---|---|---|
| SHA-256 fingerprint of every file against Binance's `.CHECKSUM` | Yes | Yes | Yes |
| Dropped downloads retried (4 tries) | Yes | Yes | Yes |
| Day fully published (no dataset empty, no coin with metrics but no candles) | Yes | Yes | Not needed: finished months |
| Manifest of the day written (each file's fingerprint) | Yes | Yes | No |
| The 7 days before yesterday re-checked against Binance | Yes (job `recheck`) | No: the next daily run checks them | No |

A failed check stops the step before anything is uploaded ([ADR-021](decisions.md#adr-021-load-a-day-only-after-binance-has-finished-publishing-it)).

## Why was the history workflow needed?

The evidence behind the live scanner needs many past examples: 32 days of 1-minute data gave only
296 unusual moves. Six years of 1-minute data would be about 2.7 billion rows, too much for the free
plan. Binance's monthly 1-hour files cover every coin since January 2020, delisted coins included,
in about 16 million rows. They were loaded once ([step 20](steps/20-hourly-history.md)); since then
the daily load extends the hourly series forward, so it never needs to run again.

## Why are there more candle files than metrics files?

On 2026-10-20, 872 coins had a candle file and 744 a metrics file. All 128 coins with candles but no
metrics had **no trades**: they are contracts Binance has delisted ("settling"). Binance keeps
publishing flat candle files for them, but no metrics, since a delisted contract has no open
positions to measure. Every coin that trades has both files.

## Where is the data kept along the way?

1. **Download:** on the GitHub machine's disk (`lakehouse/data/landing/…`, gzipped CSV). GitHub
   deletes the machine after the job, so this copy is temporary.
2. **Upload:** the Databricks landing volume `/Volumes/market/landing/binance/`, one folder per
   dataset and day. This copy is kept; removing landing files after about 30 days is planned
   ([ADR-011](decisions.md#adr-011-keep-1-minute-candles-for-a-limited-time)), and Binance keeps the
   originals.
3. **Bronze:** Auto Loader copies the rows into the bronze Delta tables and keeps a checkpoint (the
   list of files already loaded) with the pipeline.

When the downloader runs on a developer's computer for testing, files go to
`lakehouse/data/landing/`, which Git ignores.

## How often are the gold tables rebuilt?

Once a day, at the end of the daily run, and whenever the transform or `dbt build` is run by hand.
Nothing runs hourly: Binance publishes its files once a day. The live part of the scanner (today's
prices) will come straight from Binance to the browser and be compared with these daily tables.

## What if Binance publishes late, or changes a file later?

A day that is not fully published stops with `NOT READY` and nothing is uploaded; re-run the failed
job later ([incident of 2026-10-21](operations.md#incidents)).

Binance can also rewrite a day's files after first publishing them (it did on 2026-10-21 at 11:55).
Every load keeps a manifest of each file's fingerprint, and the daily `recheck` job compares the
previous 7 days with Binance. A changed file is loaded again under a new name (bronze's Auto Loader
never re-reads a name it has loaded), silver keeps the newest version of each row, and the hourly and
daily tables rebuild that day. The run's page shows a warning when this happens
([ADR-023](decisions.md#adr-023-re-check-loaded-days-against-binance-for-a-week)).
