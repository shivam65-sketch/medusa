# Step 19: Each coin's normal (`coin_baseline`)

[← Lakehouse home](../../README.md) · [← Step 18](18-active-coins.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `fe70049` Lakehouse: gold coin_baseline (each coin's normal for the live scanner) with tests |
| **Files** | [`dbt/models/gold/coin_baseline.sql`](../../dbt/models/gold/coin_baseline.sql) · [`dbt/models/gold/_gold.yml`](../../dbt/models/gold/_gold.yml) · [`dbt/tests/assert_coin_baseline_valid.sql`](../../dbt/tests/assert_coin_baseline_valid.sql) |

## Goal

One row per coin with the numbers MEDUSA's live scanner compares today's live price against: the
first table built for the scanner.

## Concepts

| Concept | Here |
|---|---|
| **Feature table** | The batch layer works out in advance exactly what the live layer needs, so the browser does one small calculation per coin per tick instead of querying history. |
| **One definition everywhere** | Today's move = live price / `last_close` − 1, the same formula as `coin_daily.return_1d`; today's z-score uses the coin's last 30 traded days, the same baseline as `unusual_moves`. A live flag and the next morning's checked flag follow the same rule. |
| **Only real trading days** | Days without trades are left out (step 18), so delisted contracts get no baseline. |
| **Cost awareness** | `avg_abs_hour_return_30d`, the typical one-hour move, shows whether a coin moves enough in an hour to pay for a round trip's fees. |

## Code walkthrough

```sql
with traded_days as (
    select *, row_number() over (partition by symbol order by trade_date desc) as days_back
    from {{ ref('coin_daily') }}
    where trades > 0
),
last_30 as (select * from traded_days where days_back <= 30),
daily as (
    select symbol,
           max(trade_date)            as as_of_date,
           max_by(close, trade_date)  as last_close,      -- today's reference price
           count(return_1d)           as history_days,
           avg(return_1d)             as avg_return_30d,
           stddev(return_1d)          as sd_return_30d,
           avg(ln(quote_volume))      as avg_log_volume_30d, …
    from last_30 group by symbol
),
hourly as (                                               -- typical one-hour move, same days
    select h.symbol, avg(abs(h.close / h.open - 1)) as avg_abs_hour_return_30d
    from {{ ref('fct_candle_1h') }} h
    join last_30 d on d.symbol = h.symbol and d.trade_date = h.candle_date
    group by h.symbol
)
select … from daily left join coins (dim_coin's current version) left join hourly
```

Tests (6): `unique` and `not_null` on `symbol`; `not_null` on `status`, `as_of_date`, `last_close`;
`assert_coin_baseline_valid`: every trading coin has a baseline no more than 2 days old, with a
positive price, 0 to 30 days of history and no negative spreads.

## How to run

From `lakehouse/dbt/`: `../.venv/Scripts/dbt build`

## Result

`PASS=84 WARN=0 ERROR=0` (10 models, 1 snapshot, 73 tests) in 2 minutes 5 seconds.

| | Value |
|---|---|
| Coins with a baseline | 744 (740 trading, 4 delisted within the last 30 days) |
| Scorable (20 or more days of history) | 731 |
| Bitcoin | Daily spread 1.70%, typical hour move 0.23%, 11.3 billion USDT a day |
| Median trading coin's typical hour move | 0.66% |
| Trading coins moving less than 0.1% an hour | 5 (too quiet to beat fees) |

## Problems we hit

None. Testing the next step showed that 32 days of history give only 296 unusual-move events, too
few for evidence; step 20 loads two years of hourly history from Binance's monthly files.
