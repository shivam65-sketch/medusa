# How the daily pipeline works: questions and answers

[← Lakehouse home](../README.md)

Short answers to the questions people ask first, with links to the detailed pages.

## Which workflows are there, and when does each run?

| Workflow | When it runs | What it does |
|---|---|---|
| **Lakehouse daily load** (`lakehouse-daily.yml`) | Automatically every day at 13:23 UTC (18:53 India time); GitHub can start it late. Also a **Run workflow** button with an optional date. | The main job: "load one day" for yesterday, re-check the 7 days before against Binance, then "transform" if the load succeeded |
| **Lakehouse load one day** (`lakehouse-load-day.yml`) | Never on its own: the daily load and the backfill call it | Download one day for every coin, check it, upload it to Databricks |
| **Lakehouse transform** (`lakehouse-transform.yml`) | After every successful load, or by hand | Bronze pipeline, source freshness, `dbt build` of silver and gold with all tests, then publish the scanner's tables to MEDUSA |
| **Lakehouse backfill** (`lakehouse-backfill.yml`) | Only by hand, with a first and last day (up to 60) | Loads past days, 4 at a time, then runs the transform once |
| **Lakehouse history** (`lakehouse-history.yml`) | Only by hand, with a first and last year | Loads Binance's monthly hourly files, one job per year, then the transform. Ran once, on 2026-10-20 |
| **Lakehouse log run** (`lakehouse-log-run.yml`) | As the last job of each workflow above, whatever happened before; or by hand, with a first day | Writes the run, its jobs, steps and errors into `ops.logs` (and, for the daily load, MEDUSA's errors). By hand: fills those tables from GitHub's history |

## What happens on a normal day?

1. **13:23 UTC, load (about 2.5 minutes)**, on a fresh GitHub machine: list the coins in Binance's
   archive, download yesterday's files only (about 872 candle files and 744 metrics files), check
   every file's SHA-256 fingerprint, check that Binance has finished publishing the day, and upload
   that one day's folder with its manifest (every file's fingerprint) to the landing volume.
2. **Recheck (one to two minutes)**: compare the manifests of the 7 days before yesterday with
   Binance's fingerprints now, and load any file Binance changed or added since.
3. **Transform (about 5 minutes)**: the bronze pipeline loads only the new files; `dbt source
   freshness` checks bronze is recent; `dbt build` updates silver and gold and runs 131 tests.
4. **Publish to MEDUSA (about 7 seconds)**: `coin_baseline`, `event_evidence` and the current metric
   definitions (the shared ones and each account's own) are copied into MEDUSA's database through its
   write-only endpoint, and MEDUSA must report the same row counts as the lakehouse.
5. **Log (about a minute), always**: the run, its jobs and steps (dbt's counts), and every failed step
   or dbt check go into `ops.logs.etl_runs`, `etl_jobs`, `etl_steps` and `etl_errors`; MEDUSA's errors
   since yesterday's copy go into `ops.logs.app_events`.

A failure at any point stops the rest (except the log, which records it) and sends GitHub's failure email.

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
prices) comes straight from Binance to the browser and is compared with these daily tables there.

## What if Binance publishes late, or changes a file later?

A day that is not fully published stops with `NOT READY` and nothing is uploaded; re-run the failed
job later ([incident of 2026-10-21](operations.md#incidents)).

Binance can also rewrite a day's files after first publishing them (it did on 2026-10-21 at 11:55).
Every load keeps a manifest of each file's fingerprint, and the daily `recheck` job compares the
previous 7 days with Binance. A changed file is loaded again under a new name (bronze's Auto Loader
never re-reads a name it has loaded), silver keeps the newest version of each row, and the hourly and
daily tables rebuild that day. The run's page shows a warning when this happens
([ADR-023](decisions.md#adr-023-re-check-loaded-days-against-binance-for-a-week)).

## How do live prices get into the Markets page's SQL? Does Binance write into a table?

No. Binance only broadcasts: while the Markets page is open, the browser keeps one connection (a
WebSocket) to Binance's public stream, and about once a second Binance sends a message listing the
markets whose price changed. Binance doesn't know any table exists.

The page itself does the writing. Every number on it is calculated by SQL in a small SQLite database
inside the browser tab ([ADR-028](decisions.md#adr-028-every-number-is-a-sql-query-run-in-the-browser)).
About once a second, a timer in the page:

1. upserts the markets that changed into `live_prices` (`INSERT ... ON CONFLICT (symbol) DO UPDATE`,
   SQLite's `MERGE`), one row per market with its latest price;
2. runs the view's queries (9 on Today, about 50 ms in all);
3. redraws the numbers that changed.

There is no server in this loop and the page doesn't reload. MEDUSA's server only hands over the
lakehouse's daily tables when the page opens and every 30 minutes. Each viewer has their own database,
fed straight from Binance; closing the tab deletes it. In SQL Server terms: a database on your own
laptop, a small program running `MERGE` for every message from a feed, and a SQL Agent job re-running
the report's queries every second.

## Won't many people reading the same tables in MEDUSA cause locks?

No. The per-second queries run on each viewer's own copy in their browser, never on MEDUSA's
database. A page load reads the scanner's answer from Workers KV, where it is kept ready-made and
rebuilt by every publish ([ADR-026](decisions.md#adr-026-the-scanners-answer-is-kept-ready-made-in-workers-kv)).
D1 itself runs one query at a time per database, so requests queue instead of competing for locks, and
the only write is the daily publish: one transaction per table, so a reader gets the whole old copy or
the whole new one. What a free plan does limit is volume: D1 allows 5 million rows read a day, which is
why the answer moved to KV (100,000 reads a day).

## Where are the Markets page's queries kept, and what happens when one changes?

In Databricks, in `market.semantic.metric_definitions`: one row per number (or shared step) and
version, with its name, its meaning in words, its SQL and how its result is shown
([ADR-029](decisions.md#adr-029-metric-definitions-are-kept-in-databricks-and-published-with-the-data)).
A change adds a version and closes the old one, so every earlier definition is kept with who changed
it and why.

The page doesn't query Databricks. After every `dbt build`, whose tests check that each definition
can run (one current version, one read-only statement, valid display), the publish job copies the
current versions to MEDUSA's `market_metrics`, alongside the daily data. The page receives them with
that data, puts them into its SQLite database's queries and runs them about once a second. Each ‹›
panel says which version it ran. Until definitions have been published, the page uses its built-in
copy (`public/markets-metrics.js`) and says so. In SQL Server terms: the report's queries are kept
in a versioned table instead of inside the report, and the report reads them from there.

Since [step 28](steps/28-editing-the-definitions.md) a definition is changed from the page itself
(below), and each window's **History** lists every version.

## What happens when I press Save on the Markets page?

1. **In your browser.** The window has already previewed your query on your screen. Save first runs
   every number your change touches (not only the window's) once with it; if one would break, nothing
   is sent.
2. **MEDUSA's server** checks that you are signed in, that the query is one read-only statement with
   only the page's parameters (the same rules as the dbt tests), that the definition exists, and that
   you haven't used up the day's 20 saves.
3. **It signs in to Databricks** as its own service principal, `medusa-markets-writer`, which can only
   use the SQL warehouse and the two definitions tables (OAuth, a one-hour token).
4. **One `MERGE`** closes the version in use and adds the next one, with your query, your note, your
   name and the time. The query goes as a parameter, so Databricks stores it as text and never runs
   it. If someone saved a newer version since your window loaded, the `MERGE` changes nothing and you
   are asked to reload.
5. **MEDUSA's copy** is updated straight away, and your window, the Markets page and your other open
   windows switch to the new version. The next daily publish copies it from Databricks again, so the
   two can never drift apart.

Which table it goes to depends on the account: the owner's saves change the shared definition
(`metric_definitions`) that everyone uses; any other account's saves become its own version
(`user_metric_definitions`), used only on its own page. In SQL Server terms: an `UPDATE` of the current
row and an `INSERT` of the new one inside one transaction, through a stored procedure that runs under
its own login with permissions on two tables only.

## Can someone else's edit change the numbers I see?

Only the owner's. A save from any other account becomes that account's own version and changes nothing
for anyone else. The owner's save changes the shared definition, and every page uses it from then on;
its **History** keeps the old version, and **Use this version again** puts it back as the next version.
Your own versions stay yours until you press **Use the shared version again** (or delete your
account, which deletes them from Databricks and MEDUSA).

## Where can I see whether the pipeline ran, and what went wrong?

In Databricks, in `ops.logs` ([step 31](steps/31-ops-log-tables.md)). `SELECT * FROM
ops.logs.daily_etl_status` gives one row per day: whether the scheduled daily load ran, how late GitHub
started it (it is often hours late), its result, the day of data it loaded, and that day's manual runs and
errors; a day the schedule never ran shows *missing*. Each run is in `etl_runs` (scheduled, manual or
re-run, and what was typed when started by hand), its jobs in `etl_jobs` and their steps in `etl_steps`,
linked by their keys. `recent_failures` lists every error of the last 30 days, the ETL's (`etl_errors`,
with the line that says why) and MEDUSA's (`app_events`). The tables can't be changed afterwards: they
are append-only.

## How do I read the Insights graphs, and how do they help?

Each graph answers one question about the unusual moves since 2020 (the same moves behind Patterns), for
up or down moves and over the next 1, 4 or 24 hours, chosen at the top
([step 32](steps/32-insights-graphs.md)). *Kept going* is positive, *turned back* negative. **Year by
year** shows whether a tendency is there every year or only in one; **Spread of outcomes** how often a
move ran far against a fade (the risk to size for); **By the hour** and **By size and liquidity** where a
tendency is stronger; **The market by hour of the day** whether an hour that leaned one way in 2020–2024
kept doing it from 2025; **Every kind of move at a glance** the verdicts in one picture; **Every market
right now** today's moves against their volume, live. A click on a bar, cell or point opens the moves
behind it in a window of its own, and a row there opens that market's past moves.

They help to see whether a pattern is steady, where it is stronger and what can go wrong. They are not
signals: only a pattern that held up on the years held back (the verdicts in Patterns) has passed a test,
and a graph that suggests something new is an idea to test the same way.

## Why does the Insights history come as a file, not from MEDUSA's database?

It is about 21,000 rows, and only the browsers read it. Checking and writing that many rows into D1 every
day would take more CPU time than Cloudflare's free plan gives one request, and a fifth of its daily
writes. So the publish job checks the rows itself and sends one gzip file (0.6 MB), MEDUSA keeps it as it
is, and the browser unpacks it into its own SQL engine, with the lakehouse's column names, so a graph's
query runs in Databricks too ([ADR-034](decisions.md#adr-034-the-insights-history-goes-to-medusa-as-one-gzip-file-kept-as-it-is)).

## Can I change a graph?

Yes, like any number: its **‹›** opens its window, where its SQL can be edited and previewed (your version
is drawn under the current one), then saved as your own version or, for the owner, the shared one. The
SQL decides what is drawn; which columns go where is the chart spec in its display, which the page keeps
([ADR-035](decisions.md#adr-035-a-graph-is-a-definition-sql-plus-a-chart-spec-drawn-as-svg-by-the-page)).
A version that stops returning a column the graph draws can't be saved.

## What happens if a day of data doesn't arrive?

It used to go unnoticed: on 2026-10-28 Binance left out a day's candles, and every test still passed,
because a test looks at rows that exist. Now `gold.missing_days` compares the calendar with the days loaded
on every run, dbt warns, and the top of the Markets page says which days are missing. Every daily load
tries each of the last 7 days again, so a day that comes late fills itself and repairs what was built on
it, the next day's return included. A day older than that needs loading by hand, and the page says so
([step 32a](steps/32a-missing-days.md), [ADR-036](decisions.md#adr-036-a-missing-day-is-found-against-the-calendar-shown-on-the-page-and-tried-again-for-a-week)).
