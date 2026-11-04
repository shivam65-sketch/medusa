# Step 32b: repairing a missing day

[← Lakehouse home](../../README.md) · [← Step 32a](32a-missing-days.md)

| | |
|---|---|
| **Built** | 2026-11-04, after 32a |
| **Files** | [`ingest/repair_day.py`](../../ingest/repair_day.py), [`.github/workflows/lakehouse-repair-day.yml`](../../../.github/workflows/lakehouse-repair-day.yml); changed: [`ingest/recheck_binance.py`](../../ingest/recheck_binance.py), [`ingest/download_binance.py`](../../ingest/download_binance.py), the daily load and load-one-day workflows |
| **Decisions** | [ADR-039](../decisions.md#adr-039-a-day-binance-never-published-is-repaired-by-hand-from-the-months-file-or-its-trades-after-a-check) |
| **Runbook** | [Repairing a day Binance never published](../operations.md#repairing-a-day-binance-never-published) |

## Goal

Step 32a finds a missing day and shows it. Most days fill themselves, because Binance publishes them late.
2026-10-28 didn't: on 4 November the fill from October's monthly file stopped, because the monthly file skips
that day too, for every coin. The goal of this step: a dependable way to repair a day Binance never
published, that only runs when someone starts it, and proves its result before loading anything.

| What Binance has for 28 October | |
|---|---|
| Daily 1-minute, 5-minute and 1-hour candles | No |
| October's monthly 1-minute and 1-hour files | Yes, but they skip the 28th: 43,200 rows, 30 days instead of 31 |
| Aggregate trades, mark and index price candles | No |
| Daily metrics | Yes |
| **Raw trades, every trade of the day** | **Yes**, for example BTC 19 MB and PEPE 41 MB |

## Concepts

| Concept | Here | In SQL Server terms |
|---|---|---|
| **Rebuilding from a finer grain** | A 1-minute candle is a summary of the trades in that minute, so it can be rebuilt from them: first and last price, highest and lowest, totals and a count | Recomputing a lost summary table with `GROUP BY` minute from the detail table it came from |
| **Reconciliation before load** | Before the repair, a day Binance did publish is rebuilt the same way and compared with Binance's own candles, every number of every minute. Any difference stops the run | Comparing a rebuilt aggregate with the original with `EXCEPT` both ways before switching to it |
| **Provenance** | The day's manifest says how each coin's file was made: `saved`, `cut_from_month` or `rebuilt_from_trades` | A `source` column on a load audit table |
| **Fallback chain** | For each coin, the best source that has the day: the daily file, then the month's file, then the trades | `COALESCE` across sources, in order of preference |
| **Run by hand only** | A `workflow_dispatch` workflow with no schedule, sharing the daily load's queue so the two never run at once | A SQL Agent job with no schedule, run when needed |

## What was built

**`repair_day.py`** (standard library only):
1. **Check.** Rebuilds the check day (default: the day before) from its trades for 16 coins: BTC, ETH, SOL,
   PEPE and an even spread of the rest. It compares them with Binance's daily candles, every column, as exact
   decimals. One difference and it stops with nothing saved.
2. **Repair.** For each coin, by `--method`: `auto` tries Binance's daily file, then the month's file, then
   the trades. `monthly` and `trades` use one source only.
3. **Metrics.** Loads the day's metrics files the normal way.
4. **Manifest.** Writes the day's manifest with how each file was made. A coin that failed stops the run
   without one, so nothing half-done is uploaded.

How a candle is rebuilt matches Binance's own:

| Column | From the minute's trades |
|---|---|
| `open`, `close` | First and last trade's price |
| `high`, `low` | Highest and lowest price |
| `volume`, `quote_volume` | Quantities and USDT values added up, as exact decimals |
| `count` | Number of trades |
| `taker_buy_volume`, `taker_buy_quote_volume` | The same, for trades where the buyer took the price (`is_buyer_maker` false) |
| A minute with no trades | Open, high, low and close at the last close, everything else 0 |

The day starts at 00:00 if the coin had candles the day before, or at its first trade if it was listed that
day. It ends at 23:59 if the coin trades the next day, or at its last trade if it was delisted.

**A coin with no trades all day.** Binance keeps publishing a file for a delisted contract that no longer
trades: 1,440 flat minutes at its last price, every volume 0. Such a coin has no trades file, so there is
nothing to rebuild from. When it has Binance's candles the day before and the day after, the repair writes
the same flat day (`flat_no_trades`), and the check compares this rule with a dead contract's real file too.

**`lakehouse-repair-day.yml`**, Actions → **Lakehouse repair day** → Run workflow, with four boxes:

| Box | |
|---|---|
| Date | The day to repair |
| Method | `auto`, `monthly` or `trades` |
| Check date | A day Binance did publish; empty for the day before |
| Only run the comparison | Repair and load nothing |

Then the upload, the transform and the log, as after a daily load. The run is logged in `ops.logs.etl_runs`
with what was typed.

**Changed:**
- **The recheck** (`recheck_binance.py`) now includes repaired files. If Binance publishes the real daily
  file later, it comes in under a new name and replaces the repair, as any changed file does
  ([ADR-023](../decisions.md#adr-023-re-check-loaded-days-against-binance-for-a-week)).
- **The daily load lost its checkbox** *Cut the 1-minute candles out of the month's file*, and the downloader
  its `--from-monthly` option: repairs have one place now.
- **The download's *NOT READY* message** now adds that a day still missing after a few days may never come,
  and points to the repair.
- **The run log** (`ops/log_pipeline_run.py`) knows the new workflow, as *Repair*, so filling the log tables
  by hand picks up its runs too.

## How it was checked

| Check | Result |
|---|---|
| 27 October rebuilt from trades and compared with Binance's candles, BTC and POWR (23 minutes with no trades) | Every number of every minute matched |
| The workflow's check on the real coin list, 27 October | 14 coins with data that day, 20,160 minutes: all matched |
| A repair of 28 October for POWR, DOGE and XRP, run locally into a scratch folder | 3 days rebuilt, 1,440 minutes each from 00:00 UTC; 3 metrics files; manifest marks them `rebuilt_from_trades` |
| **The first real run**, 28 October, method `trades` (run 41810015217, 9 min 53 s) | 751 coins rebuilt, 1,081,440 rows (751 × 1,440); 751 coins and 18,024 hours in the hourly history; BTC's day joins its neighbours (opens at the 27th's close, closes at the 29th's open); `missing_days` empty but for yesterday; no warnings |
| The 135 markets on the 27th and 29th but not the 28th | All dead contracts: zero trades and zero volume on both days, so no trades file. `data_health` marked the 28th *check*. This led to the flat day |
| The flat day, 27 October, AGIX, AMB and ALPACA | Matches Binance's own flat files, every number of every minute |
| `cut_from_month` for 28 October | Correctly finds no rows, because October's file skips the day |
| The three workflow files | Valid YAML, inputs as expected |

## Problems we hit

- **The month's file skips the day too.** The 32a fill assumed the monthly file holds every day. For
  28 October it doesn't, and the fill said Binance hadn't finished publishing, which sent the owner to wait for
  something that would never come. Counting the rows per day in the monthly file found it.
- **751 isn't a normal day any more.** The first real run filled every market that traded, but the days
  either side have 881 and 887. The 135 missing were dead contracts with Binance's flat placeholder files, so
  the repair now writes the same flat day for them.
- **A check that skipped without a word.** The flat rule asks for the coin's candles the day after, and when
  the check day is the 27th, the day after is the missing 28th. The dead contracts in the sample couldn't be
  compared and were left out silently. The check now compares the content without that condition, looks for
  two dead contracts if the sample has none, and says so if it can't find any.
- **A test that would have written into the repo.** The repair uses separate processes, and on Windows each
  one starts from the module's own settings, so pointing the landing folder elsewhere from a test script
  wouldn't reach them. The local tests ran on a copy of the scripts in a scratch folder instead.

## Next

- **Run 28 October again** with the flat day, method `trades`: the 135 dead contracts get their flat files,
  and the coins already loaded are written under the same names, which bronze doesn't load twice. Then
  `data_health` for the 28th should match its neighbours, and issue 15 is closed.
- **The five markets with non-Latin names** (issue 43) have data only from 1 November. Their history before
  that is a separate backfill, not a repair.
