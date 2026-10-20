# Step 9: Silver 1-minute candles

[← Lakehouse home](../../README.md) · [← Step 8](08-dbt-setup.md) · Next: [Step 10 →](10-silver-metrics.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commits** | `56c36cc` Lakehouse: silver fct_candle_1m (typed, incremental merge, liquid clustering) with tests and source freshness · `5ece862` step 9 docs; dbt usage statistics off |
| **Files** | [`dbt/models/sources.yml`](../../dbt/models/sources.yml) · [`dbt/models/silver/fct_candle_1m.sql`](../../dbt/models/silver/fct_candle_1m.sql) · [`dbt/models/silver/_silver.yml`](../../dbt/models/silver/_silver.yml) · [`dbt/tests/`](../../dbt/tests/) |

## Goal

The first silver table: one row per coin per minute, with real types, tested, and updated
incrementally from bronze.

## Concepts

| Concept | In this model |
|---|---|
| **Sources** | The bronze tables are declared once in `sources.yml` and referenced with `source('bronze', 'klines_1m')`, which gives dbt the lineage. **Source freshness** warns when bronze hasn't loaded anything for 36 hours and errors at 72. |
| **Incremental model** | The first run builds the whole table. Later runs read only bronze rows loaded after the newest `bronze_loaded_at` already in silver and **MERGE** them on `(symbol, open_time)`, so re-running never duplicates. |
| **`try_cast`** | Text that isn't a valid number becomes NULL instead of failing the run; `not_null` tests catch it. |
| **`timestamp_millis`** | Binance's milliseconds become a UTC timestamp (the warehouse's session time zone is `Etc/UTC`). |
| **DOUBLE for measures** | See [ADR-014](../decisions.md#adr-014-double-not-decimal-for-prices-and-volumes). |
| **De-duplication** | `QUALIFY row_number() … = 1` keeps the most recently loaded copy of a minute. |
| **Liquid clustering** | `liquid_clustered_by = ['symbol', 'candle_date']`: Databricks groups data files by coin and day, so a query for one coin or one day reads fewer files. It replaces partitioning and Z-ordering (see [ADR-015](../decisions.md#adr-015-liquid-clustering-instead-of-partitions)). |
| **Generic vs singular tests** | Generic: one line of YAML (`not_null`). Singular: a SQL file in `tests/` that returns the bad rows; 0 rows means pass. |
| **Severity** | Duplicates are an **error** and stop the build; impossible candles are a **warning**, so one bad candle from Binance doesn't stop everything. |
| **`dbt build`** | Runs models and their tests in dependency order. |

## Code walkthrough

```sql
{{ config(
    materialized = 'incremental',
    incremental_strategy = 'merge',
    unique_key = ['symbol', 'open_time'],
    liquid_clustered_by = ['symbol', 'candle_date'],
    on_schema_change = 'fail'
) }}

with source as (
    select * from {{ source('bronze', 'klines_1m') }}
    {% if is_incremental() %}
    where loaded_at > (select max(bronze_loaded_at) from {{ this }})   -- only new bronze rows
    {% endif %}
),
typed as (
    select symbol,
           timestamp_millis(try_cast(open_time as bigint)) as open_time,
           try_cast(open as double) as open,          -- … high, low, close, volumes the same way
           try_cast(`count` as bigint) as trades,
           source_file, loaded_at as bronze_loaded_at
    from source
)
select symbol, open_time, to_date(open_time) as candle_date, …
from typed
where open_time is not null
qualify row_number() over (partition by symbol, open_time order by bronze_loaded_at desc) = 1
```

`on_schema_change = 'fail'` stops an incremental run if the model's columns change, instead of
silently writing a different shape into the existing table.

Tests: 9 `not_null` tests in `_silver.yml`, plus `assert_candle_unique` (error),
`assert_candle_ohlc_range` (warn) and `assert_candle_taker_within_volume` (warn).

## How to run

From `lakehouse/dbt/`:

```
../.venv/Scripts/dbt source freshness
../.venv/Scripts/dbt build --select fct_candle_1m
```

## Result

| Check | Result |
|---|---|
| Source freshness | Both bronze tables `pass` (loaded 1.7 hours earlier) |
| First build | Created with `CREATE OR REPLACE TABLE AS SELECT`, 2,511,360 rows, 22.9 s; 1 model and 12 tests passed in 41 s |
| Rows per day | 1,255,680 on 2026-10-18 and on 2026-10-19, 872 coins each |
| Table | Delta, clustered by `["symbol","candle_date"]`, 1 file, 69 MB (about 28 bytes per row) |
| Second build | A MERGE with 0 source rows and 0 inserted: re-running adds nothing |

Checked read-only before writing the model: no duplicate (coin, minute), no value that failed to
convert, no open or close outside the low–high range, every minute on its file's date.

**A fact for gold:** 592,285 of the 2,511,360 minutes (23.6%) have **zero volume**: small coins
often go a whole minute without a trade. Volatility and liquidity measures must allow for these
flat minutes.

## Problems we hit

| Problem | Fix |
|---|---|
| dbt wrote a `.user.yml` file (an anonymous id for dbt Labs' usage statistics) into the project, and it was committed | Usage statistics switched off in `dbt_project.yml` (`flags: send_anonymous_usage_stats: false`), `.user.yml` added to `.gitignore` and removed from Git |
