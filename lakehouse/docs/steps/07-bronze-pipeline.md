# Step 7: Bronze layer

[← Lakehouse home](../../README.md) · [← Step 6](06-daily-github-action.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `7e13ea3` Lakehouse: bronze pipeline loading landing files with Auto Loader |
| **Files** | [`pipelines/bronze/klines_1m.sql`](../../pipelines/bronze/klines_1m.sql) · [`pipelines/bronze/metrics.sql`](../../pipelines/bronze/metrics.sql) · [`databricks.yml`](../../databricks.yml) (the `pipelines:` block) |

## Goal

Load every landing file into two Delta tables, `market.bronze.klines_1m` and `market.bronze.metrics`,
reading each file exactly once.

## Concepts

| Concept | What it means here |
|---|---|
| **Streaming table = Auto Loader** | Databricks keeps a list of the files it has loaded. Each run reads only new files, and no file is loaded twice ("exactly once"). |
| **The pipeline file is the DDL** | `CREATE OR REFRESH STREAMING TABLE` defines the table and how it's filled, in one place. The catalog and schema come from `databricks.yml`, so the SQL uses short names. |
| **Everything as text** ([ADR-009](../decisions.md#adr-009-bronze-keeps-every-column-as-text)) | Values are stored exactly as written. Converting types is silver's job, so odd data can't stop the load. |
| **`_rescued_data`** | If Binance changes its file layout ("schema drift"), the unexpected part lands here instead of being lost. |
| **Lineage columns** | `source_file`, `source_file_modified_at` and `loaded_at` trace every row back to its file. |
| **Expectations that only count** | `EXPECT` rules without `ON VIOLATION` record problems in the pipeline's data-quality view but keep every row. |
| **Triggered and serverless** | The pipeline runs, finishes and stops, so it only uses quota while it's working. |

## Code walkthrough

```sql
CREATE OR REFRESH STREAMING TABLE klines_1m (
  CONSTRAINT matches_file_layout EXPECT (_rescued_data IS NULL),   -- counted, not dropped
  CONSTRAINT has_symbol          EXPECT (symbol <> '')
)
COMMENT 'Raw 1-minute candles from data.binance.vision, one row per file line, all columns as text'
AS SELECT
  regexp_extract(_metadata.file_name, '^(.+)-1m-', 1) AS symbol,   -- the coin is only in the file name
  date,                                                              -- from the folder date=YYYY-MM-DD
  open_time, open, high, low, close, volume, close_time, quote_volume, `count`,
  taker_buy_volume, taker_buy_quote_volume, ignore,
  _rescued_data,
  _metadata.file_path              AS source_file,                   -- lineage
  _metadata.file_modification_time AS source_file_modified_at,
  current_timestamp()              AS loaded_at
FROM STREAM read_files(                                              -- STREAM = Auto Loader
  '/Volumes/market/landing/binance/klines_1m/',
  format            => 'csv',
  header            => true,
  schema            => 'open_time STRING, open STRING, … , ignore STRING, date STRING',
  rescuedDataColumn => '_rescued_data',
  partitionColumns  => 'date'
);
```

`metrics.sql` follows the same pattern. Its files do have a `symbol` column, so it's read from the
file instead of the file name.

The pipeline in `databricks.yml`:

```yaml
  pipelines:
    bronze:
      name: lakehouse-bronze
      catalog: market
      schema: bronze           # tables land in market.bronze
      serverless: true         # Free Edition only offers serverless
      continuous: false        # triggered: runs, then stops
      channel: CURRENT
      libraries:
        - file:
            path: ./pipelines/bronze/klines_1m.sql
        - file:
            path: ./pipelines/bronze/metrics.sql
```

## How to run

From `lakehouse/`:

```
databricks bundle validate
databricks bundle deploy
databricks bundle run bronze
```

## Result

| Table | Day | Rows | Coins | Rescued rows |
|---|---|---|---|---|
| `bronze.klines_1m` | 2026-10-18 | 1,255,680 | 872 | 0 |
| `bronze.klines_1m` | 2026-10-19 | 1,255,680 | 872 | 0 |
| `bronze.metrics` | 2026-10-18 | 203,566 | 744 | 0 |
| `bronze.metrics` | 2026-10-19 | 208,453 | 744 | 0 |

- **The first run** loaded `klines_1m` in two batches, 1,440,000 rows and then 1,071,360. Auto Loader
  reads at most 1,000 files per batch by default, and there were 1,744 candle files.
- **The second run** added 0 rows, which proves exactly-once loading.

## Problems we hit

| Problem | How it showed | Fix |
|---|---|---|
| The `date` column disappeared once the columns were listed explicitly | `UNRESOLVED_COLUMN … date`, then `CF_MISSING_PARTITION_COLUMN_ERROR` | With an explicit schema, the folder column must be listed in the schema (`date STRING`) and named in `partitionColumns => 'date'`. Found while testing the queries, before the pipeline was written. |

## Next

Silver with dbt: cast the text columns to proper types, turn `open_time` into a timestamp, sort and
check the metrics, build the coin history (SCD Type 2), and roll 1-minute candles up to hourly.
