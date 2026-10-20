# Step 12: Silver hourly candles

[← Lakehouse home](../../README.md) · [← Step 11](11-dim-coin.md) · Next: [Step 13 →](13-gold-coin-daily.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `2ba41c7` Lakehouse: silver fct_candle_1h (hourly roll-up, incremental by day) with reconciliation tests |
| **Files** | [`dbt/models/silver/fct_candle_1h.sql`](../../dbt/models/silver/fct_candle_1h.sql) · [`dbt/models/silver/_silver_candle_1h.yml`](../../dbt/models/silver/_silver_candle_1h.yml) · [`dbt/tests/assert_candle_1h_*.sql`](../../dbt/tests/) |

From this step on, Claude writes the files straight into the project; the owner reads them, runs
every command and commits.

## Goal

Roll the 1-minute candles up into hourly ones: the first aggregation model, and the base for
hour-of-day patterns and the daily gold tables.

## Concepts

| Concept | Here |
|---|---|
| **Grain** | What one row means. This table's grain is one coin per hour; `fct_candle_1m`'s is one coin per minute. |
| **`min_by` / `max_by`** | An hour's open is the first minute's open (`min_by(open, open_time)`), its close the last minute's close (`max_by(close, open_time)`); high and low are `max` and `min`. |
| **Derived measures** | `vwap` = quote volume ÷ volume; `taker_buy_share` = aggressive buying ÷ volume. `nullif(…, 0)` gives NULL instead of a division error when nothing traded. |
| **Completeness column** | `minutes`: how many 1-minute candles built the hour (60 when complete). |
| **Incremental by affected day** | An hour can't be merged a minute at a time, so each run finds the days that got new minutes and rebuilds every hour of those days, then merges them in. |
| **Reconciliation test** | Per day, the hourly table's minutes, trades and volumes must equal the minute table's. |
| **Comparing decimals** | DOUBLE arithmetic can land a hair off (`12.810000000000002` against a high of `12.81`), so the VWAP-in-range test allows one part in a billion. |

## Code walkthrough

```sql
with minutes as (
    select * from {{ ref('fct_candle_1m') }}
    {% if is_incremental() %}
    where candle_date in (
        select distinct candle_date from {{ ref('fct_candle_1m') }}
        where bronze_loaded_at > (select max(last_bronze_loaded_at) from {{ this }})
    )
    {% endif %}
)
select symbol,
       date_trunc('HOUR', open_time)                  as hour_start,
       candle_date,
       min_by(open, open_time)                        as open,
       max(high) as high, min(low) as low,
       max_by(close, open_time)                       as close,
       sum(volume) as volume, …,
       sum(quote_volume) / nullif(sum(volume), 0)     as vwap,
       sum(taker_buy_volume) / nullif(sum(volume), 0) as taker_buy_share,
       count(*) as minutes, count_if(volume = 0) as zero_volume_minutes,
       max(bronze_loaded_at) as last_bronze_loaded_at
from minutes
group by symbol, date_trunc('HOUR', open_time), candle_date
```

Tests (14): 10 `not_null`; `assert_candle_1h_unique`, `assert_candle_1h_minutes_in_range`,
`assert_candle_1h_reconciles_with_1m` (errors); `assert_candle_1h_vwap_in_range` (warning).

## How to run

From `lakehouse/dbt/`: `../.venv/Scripts/dbt build --select fct_candle_1h`

## Result

| Check | Result |
|---|---|
| Build | 1 model and 14 tests passed; model 13.3 s, 34 s in all |
| Rows | 20,928 per day (872 coins × 24 hours), every hour complete (60 minutes) |
| Hours with no trades | 3,180 and 3,170 (their `vwap` and `taker_buy_share` are NULL) |
| Reconciliation | Volume and trades match the minute table exactly |

**Found in the data:** Binance lists perpetuals on company stocks (CVNA, NAVER, PYPL, DDOG, SONY,
RIVN, MARA, BYD and others). They trade thinly, which is where most of the tiny-volume hours come from.

**A first look (two days only, not a conclusion):** Bitcoin's average taker-buy share by UTC hour
ranged from 0.43 (13:00) to 0.63 (08:00), and its busiest hour was 14:00 with about 2.0 billion
USDT traded.

## Problems we hit

| Problem | Fix |
|---|---|
| The files were committed and pushed, but the build was skipped | Found because `market.silver` had no `fct_candle_1h` and dbt's log showed no run; ran the build afterwards |
| While testing, 19 hours had a VWAP a hair outside their low–high range | Pure floating-point rounding; the test compares with a one-in-a-billion tolerance |
