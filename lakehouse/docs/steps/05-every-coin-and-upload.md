# Step 5: Every coin, uploaded to Databricks

[← Lakehouse home](../../README.md) · [← Step 4](04-downloader.md) · Next: [Step 6 →](06-daily-github-action.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `343f802` Lakehouse: download every USDT perpetual, 16 at a time |
| **Files** | [`ingest/download_binance.py`](../../ingest/download_binance.py) (second version) |

## Goal

Download every USDT perpetual instead of one coin, upload the files to the landing volume, and
query them in Databricks.

## Concepts

- **The coin list comes from the source itself:**
  - The archive is an Amazon S3 bucket that lists its own folders, 1,000 entries per page.
  - The script reads every page and keeps names matching `^[A-Z0-9]+USDT$`.
  - New listings appear automatically; coins delisted long ago come back as `missing`.
- **Parallel downloads:** the script waits on the network, not the CPU, so 16 downloads run at once
  (a thread pool). About 1.5 minutes instead of about 15.
- **Upload to the landing zone:** `databricks fs cp` copies the local landing folder into the volume.
  The daily GitHub run uses the same command.
- **Schema-on-read:** `read_files` queries files directly, without loading them into a table first.
  Good for exploring; bronze makes it permanent and incremental.

## Code walkthrough

What changed from step 4:

| Part | What it does |
|---|---|
| `all_perpetuals()` | Requests `…/data.binance.vision?delimiter=/&prefix=data/futures/um/daily/klines/&marker=…`, reads the XML, keeps matching names, follows `NextMarker` until `IsTruncated` is `false` |
| `--symbols ALL` | Uses `all_perpetuals()` instead of a typed list |
| `ThreadPoolExecutor(max_workers=16)` | Runs `download_one()` for every (dataset, coin) pair, 16 at a time; `--workers` changes the number |
| Printing | One line per file only when 20 coins or fewer; otherwise just the summary |

## How to run

From `lakehouse/ingest/`:

```
python download_binance.py --symbols ALL --date 2026-10-19
databricks fs cp -r ../data/landing dbfs:/Volumes/market/landing/binance --concurrency 16
databricks fs ls dbfs:/Volumes/market/landing/binance/klines_1m
```

The `dbfs:` prefix tells the CLI that the destination is in Databricks.

## Result

```
904 USDT perpetuals in Binance's archive
2026-10-19: 1614 saved, 2 skipped, 192 missing, 0 failed
```

| | Files | Notes |
|---|---|---|
| klines_1m | 872 | Every file has all 1,440 minutes |
| metrics | 744 | 135 files are incomplete; some hold a single row |
| missing | 192 | 32 coins without candles that day, 160 without metrics |
| Size | about 42 MB a day | 33 MB candles, 9 MB metrics |

Querying the raw files in the SQL editor:

```sql
SELECT COUNT(*) AS candle_rows, COUNT(DISTINCT _metadata.file_path) AS files
FROM read_files('/Volumes/market/landing/binance/klines_1m/', format => 'csv', header => true);
-- 1,255,680 rows (872 coins × 1,440 minutes) from 872 files
```
