# Step 15: Backfill 30 days of history

[← Lakehouse home](../../README.md) · [← Step 14](14-gold-market-and-health.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commits** | `accf52f` Lakehouse: reusable load-one-day workflow, used by the daily load and a new backfill (matrix, 4 days at a time) · `7997891` Lakehouse: backfill uploads 4 files at a time per day, and uploads retry up to 3 times |
| **Files** | [`.github/workflows/lakehouse-load-day.yml`](../../../.github/workflows/lakehouse-load-day.yml) · [`lakehouse-daily.yml`](../../../.github/workflows/lakehouse-daily.yml) · [`lakehouse-backfill.yml`](../../../.github/workflows/lakehouse-backfill.yml) |

## Goal

Load the 30 days before the existing data (2026-09-18 to 2026-10-17) through the whole pipeline,
and prove that every layer handles a large, late load correctly.

## Concepts

| Concept | Here |
|---|---|
| **One code path** | The "load one day" steps live in a **reusable workflow**; the daily load and the backfill both call it. |
| **Matrix job** | The backfill turns a first and last day into a list and runs one job per day, 4 at a time; `fail-fast: false` lets the other days finish when one fails. |
| **Input check** | The first job refuses ranges over 60 days or reversed dates. |
| **Parallelism multiplies** | 4 jobs × 16 uploads = 64 at once was too many for Databricks; each backfill job now uploads 4 at a time (16 in total, like one daily run). |
| **Retry what is idempotent** | Uploads retry up to 3 times (after 30 and 60 seconds), which is safe because re-uploading overwrites with the same checked files. |
| **Watermarks on load time** | Every silver and gold model picks up rows by when they were loaded, not by trading date, so 30 older days loaded late were picked up without any change to the models. |
| **SCD Type 2 records corrections** | Each coin's `first_candle_date` moved from 2026-10-18 to its true earlier day, so `dim_coin` closed the old version and opened a new one. The validity times are when the warehouse learned this, not when the coin started trading (see below). |

## The workflows

```yaml
# lakehouse-backfill.yml (core)
jobs:
  days:                      # turns start and end into ["2026-09-18", …, "2026-10-17"]
    …
  load:
    needs: days
    strategy:
      max-parallel: 4
      fail-fast: false
      matrix:
        date: ${{ fromJSON(needs.days.outputs.dates) }}
    uses: ./.github/workflows/lakehouse-load-day.yml
    with:
      date: ${{ matrix.date }}
      upload_concurrency: 4
    secrets: inherit
```

```bash
# lakehouse-load-day.yml, upload step
for attempt in 1 2 3; do
  if databricks fs cp -r ../data/landing dbfs:/Volumes/market/landing/binance --overwrite --concurrency "$CONCURRENCY"; then
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then sleep $((attempt * 30)); fi
done
exit 1
```

## How to run

1. GitHub → Actions → **Lakehouse backfill** → Run workflow → first and last day.
2. From `lakehouse/`: `databricks bundle run bronze`.
3. From `lakehouse/dbt/`: `../.venv/Scripts/dbt build`.

## Result

| Check | Result |
|---|---|
| Backfill | 30 days green in 46 minutes (second run, after the fix) |
| `dbt build` (everything) | 8 models and 58 tests passed in 3.5 minutes; `fct_candle_1m` merge 99 s, `fct_metrics_5m` 77 s |
| Silver | 39,739,735 one-minute candles; 6,520,207 metric snapshots |
| Gold | 32 days (2026-09-18 to 2026-10-19), 27,609 coin-days, 849 to 873 coins a day |
| New listings / delistings | 24 coins listed after 2026-09-18; 1 dropped out on 2026-10-13 and is now `not trading` in `dim_coin` |
| Completeness | 31 incomplete coin-days (17,225 missing minutes), mostly listing days that start mid-day; 10 days flagged `check` |
| `dim_coin` | 873 coins, each with one current version; the 872 that existed before have two versions each |

### Reading `dim_coin` after the backfill

| symbol | first_candle_date | dbt_valid_from (UTC) | dbt_valid_to (UTC) |
|---|---|---|---|
| BTCUSDT | 2026-10-18 | 2026-10-20 15:41 | 2026-10-20 17:34 |
| BTCUSDT | 2026-09-18 | 2026-10-20 17:34 | 9999-12-31 (current) |

Between 15:41 and 17:34 the warehouse only had two days of data, so it believed Bitcoin's first
candle was 2026-10-18. The snapshot after the backfill corrected that and kept the old belief as
history. The validity times record **when the warehouse knew something** (system or "transaction"
time), not when it happened in the market ("valid" time). Models that track both are called
bitemporal.

## Problems we hit

| Problem | How it showed | Fix |
|---|---|---|
| First backfill run: every day failed at the upload | `Put …/api/2.0/fs/directories/…/metrics: context canceled` | 64 uploads at once were too many; the backfill uploads 4 per job, and uploads retry up to 3 times |
