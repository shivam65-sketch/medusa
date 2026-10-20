# Step 13: Gold, one row per coin per day

[← Lakehouse home](../../README.md) · [← Step 12](12-silver-hourly-candles.md) · Next: [Step 14 →](14-gold-market-and-health.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `78feebe` Lakehouse: gold coin_daily (returns, realised volatility, taker share, open interest) with reconciliation tests |
| **Files** | [`dbt/models/gold/coin_daily.sql`](../../dbt/models/gold/coin_daily.sql) · [`dbt/models/gold/_gold.yml`](../../dbt/models/gold/_gold.yml) · [`dbt/tests/assert_coin_daily_*.sql`](../../dbt/tests/) |

## Goal

The first gold table: everything a dashboard needs about each coin's day, in one row.

## Concepts

| Concept | Here |
|---|---|
| **Gold = business-ready** | Silver keeps clean data at each grain; gold answers questions ("how did each coin do yesterday?"). |
| **Each measure from the right grain** | Open, close and volume from the hourly table (cheap); volatility from the 1-minute table, as the square root of the sum of squared 1-minute log returns ("realised volatility"). |
| **Join at the same grain** | Candles and metrics are each reduced to one row per (coin, day), then joined; a left join keeps coins without metrics. |
| **Window across days** | `lag(close) over (partition by symbol order by trade_date)`; the return is only calculated when the previous row really is the day before. |
| **Incremental with a dependency** | When day D arrives, the run rebuilds D and D+1 (D+1's return needs D's close), reading D−1 for the lag. |
| **Fractions** | 0.05 means +5% everywhere; dashboards format it. |
| **Reconciliation** | Per day, `coin_daily`'s minutes, trades and volume equal `fct_candle_1h`'s. |

## Code walkthrough

```sql
-- incremental: the days that got new candles, plus the day after each
new_days    as (select distinct candle_date as d from {{ ref('fct_candle_1h') }}
                where last_bronze_loaded_at > (select max(last_bronze_loaded_at) from {{ this }})),
target_days as (select d from new_days union select date_add(d, 1) from new_days),

daily as (select symbol, candle_date as trade_date,
                 min_by(open, hour_start) as open, max(high) as high, min(low) as low,
                 max_by(close, hour_start) as close, sum(volume) as volume, …
          from hours group by symbol, candle_date),

minute_moves as (select symbol, candle_date as trade_date,
                        sqrt(sum(power(ln(close / previous_minute_close), 2))) as realized_volatility_1d,
                        max(abs(close / previous_minute_close - 1))            as max_move_1m
                 from minute_returns where previous_minute_close > 0 and close > 0
                 group by symbol, candle_date),

metrics as (select symbol, metric_date as trade_date,
                   min_by(open_interest_usdt, metric_time) as open_interest_open_usdt,
                   max_by(open_interest_usdt, metric_time) as open_interest_close_usdt, …
            from {{ ref('fct_metrics_5m') }} group by symbol, metric_date)

select …,
       case when p.previous_date = date_sub(p.trade_date, 1)
            then p.close / p.previous_close - 1 end as return_1d, …
from with_previous p
left join minute_moves m using …
left join metrics      x using …
```

Tests (12): 9 `not_null`; `assert_coin_daily_unique`, `assert_coin_daily_minutes_in_range`,
`assert_coin_daily_reconciles_with_1h` (errors).

## How to run

From `lakehouse/dbt/`: `../.venv/Scripts/dbt build --select coin_daily`

## Result

| Check | Result |
|---|---|
| Build | 1 model and 12 tests passed; model 13.2 s, 31 s in all |
| Rows | 872 per day; 744 with open interest |
| 2026-10-19 | 431 coins up, 306 down, 135 unchanged; 48.6 billion USDT traded (31.9 billion on Sunday 2026-10-18) |
| Extremes on 2026-10-19 | Best BRUSDT +53.8%, worst SIRENUSDT −37.7%; biggest 1-minute move 28.6% (CTUSDT) |
| Typical coin | Realised volatility 3.7% a day; taker-buy share 0.49 |

`return_1d` is empty on 2026-10-18 for every coin: it's the first day in the lakehouse, so there's
no previous close.

## Problems we hit

None.
