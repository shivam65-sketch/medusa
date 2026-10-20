# Step 4: Downloader

[← Lakehouse home](../../README.md) · [← Step 3](03-setup-job.md) · Next: [Step 5 →](05-every-coin-and-upload.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `bca690b` Lakehouse: Binance daily downloader with checksum check |
| **Files** | [`ingest/download_binance.py`](../../ingest/download_binance.py) (first version: one coin at a time) |

## Goal

Download one day of Binance futures data, prove each file is intact, and save it to a local landing
folder. Python standard library only, so there's nothing to install.

## Concepts

| Concept | In this script |
|---|---|
| **Landing zone** | Raw files are kept exactly as published; everything later is rebuilt from them |
| **Checksum verification** | Binance publishes a SHA-256 fingerprint for every file. A file whose fingerprint doesn't match is never saved |
| **Idempotent** | A file that's already saved is skipped, so the script can run again safely |
| **Atomic write** | Written as `<name>.tmp` and renamed when complete, so a half-written file never appears |
| **Hive-style partitions** | Files go into `date=YYYY-MM-DD` folders, which Databricks reads as a `date` column |
| **Missing vs failed** | *Missing* (HTTP 404) means not published yet or not trading, which is normal. *Failed* means a checksum mismatch or a network error, and the script exits with code 1 |

## Code walkthrough

| Part | What it does |
|---|---|
| `DATASETS` | Maps a dataset name to its path in the archive: `klines_1m` → `klines/{symbol}/1m/{symbol}-1m-{day}.zip`, `metrics` → `metrics/{symbol}/{symbol}-metrics-{day}.zip` |
| `LANDING` | `lakehouse/data/landing`, inside `data/`, which `.gitignore` excludes |
| `fetch(url)` | Downloads a URL. Returns `None` on 404; retries network errors twice, waiting 2 s then 4 s |
| `download_one()` | 1. Skip if the output exists. 2. Download the zip; 404 → `missing`. 3. Download `.CHECKSUM`, compare SHA-256; mismatch → error. 4. Take the single CSV out of the zip. 5. Write it gzipped to a `.tmp` file, then rename |
| `main()` | Reads `--symbols`, `--date` (default: yesterday in UTC) and `--datasets`; prints one line per file and a summary; exit code 1 if anything failed |

The checksum check, the heart of the script:

```python
expected = checksum.decode().split()[0].lower()      # the .CHECKSUM file: "<sha256>  <file name>"
actual = hashlib.sha256(data).hexdigest()
if actual != expected:
    raise RuntimeError(f"{url}: checksum mismatch (expected {expected}, got {actual})")
```

## How to run

From `lakehouse/ingest/`:

```
python download_binance.py --symbols BTCUSDT --date 2026-10-19
```

## Result

| Test | Output |
|---|---|
| First run | `saved` for both klines_1m and metrics |
| Same command again | `skipped` for both (idempotent) |
| `--date 2026-10-20` (not published yet) | `missing` for both, exit code 0 |

What the files contain (BTCUSDT, 2026-10-19):
- `klines_1m`: a header plus 1,440 rows, one per minute; `open_time` in milliseconds; about 60 KB gzipped.
- `metrics`: a header plus 288 rows, one per 5 minutes. The rows are **not in time order**.

## Problems we hit

| Problem | Cause | Fix |
|---|---|---|
| A second copy of the script in `lakehouse/` | Saved before the `ingest/` folder existed | Deleted it (`rm ../download_binance.py`) |
| "Nothing gets pushed" | The file was staged (`git add`) but not committed | `git save`, then `git push`. Git has three stages: add, commit, push |
