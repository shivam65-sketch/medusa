# Step 32a: a day that goes missing

[← Lakehouse home](../../README.md) · [← Step 32](32-insights-graphs.md)

| | |
|---|---|
| **Built** | 2026-10-31, between 32.1 and 32.2 |
| **Commits** | `75bd8d4` (the missing-days check and the catch-up, and the page's table and selection fixes) |
| **Files** | [`dbt/models/gold/missing_days.sql`](../../dbt/models/gold/missing_days.sql) and its test [`assert_no_missing_days.sql`](../../dbt/tests/assert_no_missing_days.sql) · [`serving/publish_to_medusa.py`](../../serving/publish_to_medusa.py) · [`.github/workflows/lakehouse-daily.yml`](../../../.github/workflows/lakehouse-daily.yml) (the catch-up) · [`migrations/006_missing_days.sql`](../../../migrations/006_missing_days.sql) · [`src/market.js`](../../../src/market.js) · [`public/markets.js`](../../../public/markets.js) |
| **Decisions** | [ADR-036](../decisions.md#adr-036-a-missing-day-is-found-against-the-calendar-shown-on-the-page-and-tried-again-for-a-week) |

## Goal

Binance's archive left out the candles of 2026-10-28, and nothing noticed:
[every test passed, the next day's run succeeded and the Markets page looked normal](32-insights-graphs.md#a-hole-in-the-history-28-october).
It was found by a person running a query. The goal of this step: a missing day should be found by the
pipeline, shown to whoever reads the page, and filled by itself whenever that is possible.

| Why nothing noticed | What this step does |
|---|---|
| Tests look at rows that exist, and a day that never arrived has no rows to fail | `gold.missing_days` compares the calendar with the days loaded |
| A daily load only fetches its own day; the recheck only covers days that have a manifest | The daily run tries every recent day with no manifest again |
| The page showed the newest day, not the holes behind it | The Markets page says which days are missing, and when the lakehouse has stopped arriving |

## Concepts

| Concept | Here | In SQL Server terms |
|---|---|---|
| **Date spine** | `sequence(first_day, yesterday)` exploded into one row per calendar day, left-joined to the days loaded. A row with no match is a hole | A calendar table (or a recursive CTE of dates) with a `LEFT JOIN … WHERE x IS NULL` |
| **Completeness against what should exist** | A test can only look at rows. To see what is absent, build the rows that should be there first | `EXCEPT` against a list of expected dates |
| **Warn, don't fail** | A missing day is a warning: stopping the run would hold back the days that did arrive, for something nobody here can fix | An Agent job step that logs and goes on to the next step |
| **Late-arriving data** | Data that comes after the days around it have been processed. Silver merges by key, and `coin_daily` rebuilds a day and the day after it, so a late day repairs everything above it | A late-arriving fact loaded with `MERGE`, plus re-running the dependent aggregates |
| **Idempotent retry** | The catch-up can run any number of times: a day that loads gets a manifest and is never tried again, and a day that doesn't leaves nothing behind | A job that checks a control table before it starts, and a transaction that rolls back |

## What was built

**1. Finding it: `gold.missing_days`.** The calendar from the first day in `coin_daily` to yesterday,
against the days `coin_daily` has. One row per missing day; no rows is the good answer. Because it is
rebuilt every run, a day leaves by itself when its data arrives. Its `status` says who is dealing with it:

| `status` | The day is | What happens |
|---|---|---|
| `waiting` | Yesterday | Normal until the daily load has run. Not a problem: no warning and nothing on the page |
| `retrying` | 2 to 8 days old | The daily load tries it again every day. dbt warns, and the page says so |
| `manual` | Older | Nothing tries it any more, so it has to be loaded by hand. dbt warns, and the page says so |

**2. Warning about it: `assert_no_missing_days`.** A dbt test with severity `warn`. The run stays green,
and the warning lands in `ops.logs.etl_errors`, so it shows in `recent_failures`.

**3. Showing it: the Markets page.** The publish job copies the table to MEDUSA as `market_missing_days`
(usually empty), and it goes out in the scanner's answer. The top of the status box then says, on the
page and in every window:

> **Not in the lakehouse: 28 Oct.** Each market's normal and the history are built without that day until
> it is loaded, and the day after has no daily move. The daily load tries again every day.

**A second warning the page works out itself.** When the load fails, the transform doesn't run, so nothing
is published and no table can report it. So the page compares the newest lakehouse day with yesterday, and
two days or more apart says *The lakehouse is N days behind*.

**4. Fixing it: the catch-up.** A new step in the daily run's `recheck` job. For each of the last 7 days
(2 to 8 days old) with no manifest, it runs the normal download for that day. A day is complete or nothing:

| The day at Binance | What the step does |
|---|---|
| Complete | Downloads it and writes its manifest. The next step uploads it, and the transform in the same run takes it through bronze, silver, gold and on to MEDUSA. A yellow warning, **Late day loaded**, marks it on the run's page |
| Still not ready | Removes whatever it downloaded for that day, the same rule as the daily load ([ADR-021](../decisions.md#adr-021-load-a-day-only-after-binance-has-finished-publishing-it)), and warns **Day still missing**. Tomorrow's run tries again |

Nothing else had to change for a late day to repair everything. `fct_candle_1m` and `fct_metrics_5m` load
by `loaded_at`, so a late file is simply new rows. `coin_daily` rebuilds each day with new candles and the
day after it, which brings back the next day's return. The tables above it are rebuilt in full on every run.

**5. When the data really arrives.** The page said the lakehouse publishes at *about 13:30 UTC*. The ETL log
shows that is wrong: the run is set for 13:23, but GitHub started every scheduled run from 23 to 30 October
200 to 362 minutes late, and they finished between 16:50 and 19:36 UTC. The page now says *usually by
20:00 UTC*.

## Two page fixes that shipped with it

**A table jumped back to the left, and selected text disappeared.** The owner reported both on the Markets
page. Every second the page drew a table as new HTML and replaced the old one whenever a number had
changed. The box that scrolls is inside what was replaced, so each new box started at the left, a scrollbar
being dragged lost its element, and a selection inside it was gone before it could be copied. Holding a
part still while the pointer is over it, which the page already did for some parts, could not fix this:
the moment the pointer left, the table was replaced and jumped back.

`put()` in `public/markets.js` now updates what changed instead: the new HTML is parsed, and a short
function walks it next to what is on the page, changing only the text and attributes that differ. The
elements stay, so scrolling, focus and hover stay with them, and the numbers go on updating while a table
is scrolled. While text is selected in a part, that part holds still so it can be copied.

**A drag across a table's row opened the row.** Selecting text that starts and ends in one row fires a
click on that row, which opened a trade, a market or a backtest run. Such a click is now ignored, on every
page.

The Journal, the Lab and Dev tools never had the first problem: they aren't redrawn on a timer.

## Result

| Check | Result |
|---|---|
| The query, on the real tables | Finds exactly `2026-10-28 retrying` and `2026-10-30 waiting` (run on 31 October, before that day's load finished) |
| `dbt parse` | The model, its 5 column tests and the singular test parse; workflow and YAML files load |
| The catch-up, on real Binance | The step's own text, taken from the workflow file and run in a scratch folder. 28 Oct: 753 metrics files fetched, *NOT READY klines_1m*, everything for that day removed, so nothing to upload. 27 Oct, with its manifest hidden: 881 candle files, 753 metrics files and a manifest, ready to upload. The five days with manifests: skipped. Exit code 0 |
| MEDUSA, locally | The ingest takes no rows and real rows, and refuses a bad date, a repeated day and a wrong token. Without the D1 table, as if the code were deployed before the migration, the scanner's answer is still a normal 200 without that table |
| The page, locally | One missing day, seven with one needing a manual load (the list stops at five, *and 2 more*), and `waiting` hidden. *7 days behind* on the local copy, whose data really is from 23 October |
| Scrolling and selecting, with a real mouse | In the window from the owner's screenshot: the scrollbar dragged to the end and held at 202 of 202 for 5 seconds while prices updated. Text selected in a row stayed selected and the row did not open. Row clicks, Patterns and all seven Insights graphs still work |
| Live, the first run | **Lakehouse transform** run 8, started by hand, 4 min 25 s: 17 models and snapshots built, `missing_days` among them, 144 tests passed and 1 warned, the expected `assert_no_missing_days`, which reached `ops.logs.etl_errors`. `gold.missing_days` holds one row, `2026-10-28 retrying`, and MEDUSA's `market_missing_days` the same, lakehouse day 2026-10-30 |
| Not tested | A real Ctrl+C: the test browser's key press doesn't reach the clipboard on any page, the Journal included |

## Problems we hit

- **A guard that wasn't needed.** The catch-up first skipped days before 23 October, when manifests began.
  Listing the volume showed they began on the 22nd, and that the 7-day window can no longer reach them.
  The guard went.
- **A cached page in a test.** The check of the page without the D1 table ran on the browser's 5-minute
  copy of the answer, so only the server's side of that case was really tested. The page's side is one
  line, a table that isn't there reads as no rows.

## Next

- **Fill 28 October.** The daily file may never come. Binance's monthly 1-minute file for October is
  expected around 2 November: check that it holds the day, then cut that day out of it. The live API stays
  the last resort.
- **32.2:** see [step 32](32-insights-graphs.md#next-322-and-323).
