# 1. From Binance to bronze

[← Lineage and transformations](README.md) · Next: [2. Silver →](2-silver.md)

Binance's files are copied into the lakehouse without changing a value. Up to bronze, the only things
added are the coin's name where the file doesn't have it, and where each row came from.

## Binance's files

Binance publishes three datasets for every USD-M perpetual on its public archive, `data.binance.vision`
(the addresses are in the [data dictionary](../data-dictionary.md#source-binances-public-archive)):

| Dataset | One file per | Lines in a file | Used for |
|---|---|---|---|
| 1-minute candles | Coin and day | 1,440, after a header line | Everything recent |
| Market metrics | Coin and day | 288, one every 5 minutes, after a header line | Open interest and long/short ratios |
| 1-hour candles | Coin and month | About 720; files before 2022 have no header line | The history since January 2020 |

Each file is a zip holding one CSV, with a `.CHECKSUM` file beside it holding the zip's SHA-256
fingerprint.

## Landing: `market.landing.binance`

**One file per** coin, dataset and day (or month). **Built from** Binance's zips, by
[`ingest/download_binance.py`](../../ingest/download_binance.py) in GitHub Actions. **Which files:** every
USDT perpetual Binance has ever published (names ending in `USDT` with no `_` or space, so no USDC pairs
and no dated futures such as `BTCUSDT_250926`). **Refreshed** every day for yesterday.

For each coin and day the script:

1. downloads the zip and its `.CHECKSUM` file;
2. works out the zip's SHA-256 and compares it with Binance's. If they differ, nothing is saved, so a
   damaged or half-downloaded file never reaches the lakehouse;
3. takes the CSV out of the zip and saves it gzip-compressed, **byte for byte the same text**, as
   `klines_1m/date=2026-10-19/BTCUSDT-1m-2026-10-19.csv.gz` (or `metrics/date=…`, or `klines_1h/month=…`);
4. writes a line in the day's manifest (`manifests/date=…/manifest.csv`): dataset, coin, `saved` or
   `missing`, the file name and Binance's fingerprint.

The workflow then copies the folder to the volume with `databricks fs cp -r`. The folder names
`date=YYYY-MM-DD` and `month=YYYY-MM` are deliberate: bronze reads them as a column.

Two scripts can add files to the landing later. Both save files bronze will read as new ones:

| Script | When | What it saves |
|---|---|---|
| [`recheck_binance.py`](../../ingest/recheck_binance.py) | Every day, for the last few days | A file Binance rewrote after it was loaded (it rewrote every 1-minute file of 2026-10-20 the next day). Its fingerprint no longer matches the manifest, so it is downloaded again and saved under a new name with the start of the new fingerprint: `BTCUSDT-1m-2026-10-20.r3f9a1c2e.csv.gz`. Silver keeps the newest row for each minute, so the new values replace the old |
| [`repair_day.py`](../../ingest/repair_day.py) | By hand only (step 32b) | A day Binance never published, under the usual names. The manifest says how each file was made |

### How a repaired day's candles are made

When a day is missing from Binance's daily archive, `repair_day.py` takes each coin's 1-minute candles from
the first of these that works: Binance's daily file (in case it has appeared), the day cut out of the
month's file, or the day rebuilt from Binance's raw trades. A rebuilt candle is made the way Binance makes
its own:

| Column | Made from the minute's trades |
|---|---|
| `open`, `close` | The first and last trade's price |
| `high`, `low` | The highest and lowest trade price |
| `volume` | The trades' quantities added up |
| `quote_volume` | Each trade's price × quantity, added up |
| `count` | The number of trades |
| `taker_buy_volume`, `taker_buy_quote_volume` | The same two sums, only for trades where the buyer took the price (`is_buyer_maker` false) |
| A minute with no trades | Open, high, low and close at the previous minute's close; volumes and count 0 |

Before saving anything, the script rebuilds a day Binance did publish and compares it number by number with
Binance's own file; any difference stops the repair. A coin with no trades all day (a delisted contract)
gets 1,440 flat minutes at its last price, as Binance's own files have.

## What every bronze table has in common

The bronze tables are **streaming tables** in a Lakeflow pipeline ([`pipelines/bronze/`](../../pipelines/bronze/)),
fed by `read_files`, which is Auto Loader:

- **Each file is read once.** Auto Loader remembers the files it has loaded, so a run reads only new ones.
  That is why a rewritten file has to arrive under a new name.
- **Every column is text** (`STRING`), as written in the file. A value that isn't a number can't stop the
  load; silver deals with it.
- **Nothing is dropped.** The `EXPECT` rules count the rows that break them (the pipeline's data quality tab,
  and `ops.logs.bronze_loads`) and keep them.
- **Three columns say where each row came from:**

| Column | From | How |
|---|---|---|
| `source_file` | `_metadata.file_path` | The landing file's full path |
| `source_file_modified_at` | `_metadata.file_modification_time` | When that file was copied to the volume |
| `loaded_at` | `current_timestamp()` | When this load ran. Silver's watermark: it reads only rows loaded after the newest it already has |

- **`_rescued_data`:** anything on a line that didn't fit the columns expected; empty when the line was as
  expected. The rule `matches_file_layout` counts the lines where it isn't.

## `market.bronze.klines_1m`

**One row per** line of a 1-minute file: 1,440 per coin per day. **Built from**
`landing/binance/klines_1m/date=*/`. **Which rows:** every line; the header line is read as the header
(`header => true`). **Refreshed** incrementally: new files only.

| Column | From | How |
|---|---|---|
| `symbol` | The file name | `url_decode(regexp_extract(_metadata.file_name, '^(.+)-1m-', 1))`: everything before `-1m-`. The candle files have no coin column. `url_decode` turns `%E7%89%9B` back into `牛`, because not every name is Latin letters |
| `date` | The folder name `date=2026-10-19` | `partitionColumns => 'date'` |
| `open_time` | CSV column 1 | Unchanged: milliseconds since 1970, as text (`1792368000000` is 2026-10-19 00:00 UTC) |
| `open`, `high`, `low`, `close` | CSV columns 2–5 | Unchanged |
| `volume` | CSV column 6 | Unchanged |
| `close_time` | CSV column 7 | Unchanged (always `open_time` + 59,999) |
| `quote_volume` | CSV column 8 | Unchanged |
| `count` | CSV column 9 | Unchanged; becomes `trades` in silver |
| `taker_buy_volume`, `taker_buy_quote_volume` | CSV columns 10–11 | Unchanged |
| `ignore` | CSV column 12 | Unchanged (always 0) |
| `_rescued_data`, `source_file`, `source_file_modified_at`, `loaded_at` | | As above |

Rules counted: `matches_file_layout` (`_rescued_data IS NULL`), `has_symbol` (`symbol <> ''`).

## `market.bronze.metrics`

**One row per** line of a metrics file: 288 per coin per day. **Built from** `landing/binance/metrics/date=*/`.
**Which rows:** every line. **Refreshed** incrementally.

| Column | From | How |
|---|---|---|
| `symbol` | CSV `symbol` | Unchanged. These files do have a coin column, and it always matches the file name |
| `date` | The folder name | As in `klines_1m` |
| `create_time` | CSV `create_time` | Unchanged: `2026-10-19 00:05:00`, as text |
| `sum_open_interest`, `sum_open_interest_value` | CSV | Unchanged |
| `count_toptrader_long_short_ratio`, `sum_toptrader_long_short_ratio` | CSV | Unchanged |
| `count_long_short_ratio`, `sum_taker_long_short_vol_ratio` | CSV | Unchanged; sometimes empty in Binance's files |
| `_rescued_data`, `source_file`, `source_file_modified_at`, `loaded_at` | | As above |

Rules counted: `matches_file_layout`, `has_symbol`.

## `market.bronze.klines_1h`

**One row per** line of a monthly 1-hour file, header lines included. **Built from**
`landing/binance/klines_1h/month=*/`. **Which rows:** every line. The files are read **without** a header
(`header => false`), because Binance's files before 2022 have none: reading them with a header would lose
their first hour. The newer files' header lines arrive as rows whose `open_time` is the text `open_time`,
and silver drops them. **Refreshed** incrementally; loaded once for the history.

| Column | From | How |
|---|---|---|
| `symbol` | The file name | `url_decode(regexp_extract(_metadata.file_name, '^(.+)-1h-', 1))` |
| `month` | The folder name `month=2024-03` | `partitionColumns => 'month'` |
| `open_time` … `ignore` | CSV columns 1–12 | Unchanged, as in `klines_1m` (the start of the hour) |
| `_rescued_data`, `source_file`, `source_file_modified_at`, `loaded_at` | | As above |

Rules counted: `matches_file_layout`, `has_symbol`, and `is_data_row` (`open_time <> 'open_time'`), which
counts the header lines.
