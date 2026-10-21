# Step 20: Hourly history from Binance's monthly files

[← Lakehouse home](../../README.md) · [← Step 19](19-coin-baseline.md) · Next: [Step 21 →](21-silver-hourly-history.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `1460318` Lakehouse: history load of Binance's monthly 1-hour candles (downloader months, history workflow, bronze klines_1h) |
| **Files** | [`ingest/download_binance.py`](../../ingest/download_binance.py) · [`pipelines/bronze/klines_1h.sql`](../../pipelines/bronze/klines_1h.sql) · [`databricks.yml`](../../databricks.yml) · [`.github/workflows/lakehouse-history.yml`](../../../.github/workflows/lakehouse-history.yml) |

## Goal

Give the lakehouse years of history for the live scanner's evidence. 32 days of 1-minute data gave
only 296 unusual-move events; Binance's monthly 1-hour files go back to January 2020 for every USDT
perpetual, delisted coins included.

## Concepts

| Concept | Here |
|---|---|
| **A second source at a coarser grain** | Hourly candles for the long history, 1-minute candles for the recent days; the two are reconciled in step 21. |
| **Measure before loading** | The archive's own listing showed 895 USDT perpetuals and 22,221 monthly files (651 MB zipped) from 2020-01 to 2026-09, so the whole history was cheaper than expected. |
| **Schema drift across years** | Files before 2022 have no header row; newer files start with one. Read with "first row is a header", every older file would silently lose its first hour. Bronze reads every file without a header; the header lines arrive as rows whose `open_time` is the text `open_time`, are counted by a new `is_data_row` expectation, and are dropped in silver. |
| **Survivorship-free** | Delisted coins have monthly files up to their last month, so the history keeps the coins that died. |
| **Matrix by year** | One job per year, two at a time, 8 uploads each: the same load on Databricks as one daily run. A failed year can be run again on its own. |

## Code walkthrough

The downloader learned monthly datasets:

```python
DATASETS = {
    "klines_1m": ("daily", "klines/{symbol}/1m/{symbol}-1m-{period}.zip"),
    "metrics": ("daily", "metrics/{symbol}/{symbol}-metrics-{period}.zip"),
    "klines_1h": ("monthly", "klines/{symbol}/1h/{symbol}-1h-{period}.zip"),
}
PARTITION = {"daily": "date", "monthly": "month"}   # landing folder: date=… or month=…
```

```
python download_binance.py --symbols ALL --months 2020-01..2020-12
```

Bronze reads without a header and counts the header lines:

```sql
CREATE OR REFRESH STREAMING TABLE klines_1h (
  CONSTRAINT matches_file_layout EXPECT (_rescued_data IS NULL),
  CONSTRAINT has_symbol          EXPECT (symbol <> ''),
  CONSTRAINT is_data_row         EXPECT (open_time <> 'open_time')
)
AS SELECT regexp_extract(_metadata.file_name, '^(.+)-1h-', 1) AS symbol, month, open_time, …
FROM STREAM read_files('/Volumes/market/landing/binance/klines_1h/',
  format => 'csv', header => false, schema => '… month STRING', partitionColumns => 'month', …);
```

## How to run

1. `databricks bundle deploy` (from `lakehouse/`): the bronze pipeline gets `klines_1h.sql`.
2. GitHub → Actions → **Lakehouse history** → Run workflow, first year 2020, last year 2026.

## Result

| Year | Coins | Files | Rows | Header rows | Rescued |
|---|---|---|---|---|---|
| 2020 | 81 | 509 | 344,043 | 0 | 0 |
| 2021 | 139 | 1,404 | 1,000,037 | 0 | 0 |
| 2022 | 163 | 1,758 | 1,267,936 | 1,695 | 0 |
| 2023 | 253 | 2,436 | 1,742,482 | 2,436 | 0 |
| 2024 | 384 | 3,599 | 2,587,235 | 3,599 | 0 |
| 2025 | 611 | 5,977 | 4,284,344 | 5,977 | 0 |
| 2026 | 868 | 6,538 | 4,681,553 | 6,538 | 0 |

22,221 files and 15,907,630 rows. Binance started adding the header during 2022 (63 of that year's
files have none). Typed, the rows give 15,887,385 hours: exactly the 20,245 header lines fewer, no
duplicates, 895 coins, 2020-01-01 00:00 to 2026-09-30 23:00 UTC.

## Problems we hit

None in the load. The header change was found while measuring the files, before the pipeline was
written.
