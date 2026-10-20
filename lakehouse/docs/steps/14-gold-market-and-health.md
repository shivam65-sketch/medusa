# Step 14: Gold for the whole market and for data health

[← Lakehouse home](../../README.md) · [← Step 13](13-gold-coin-daily.md) · Next: [Step 15 →](15-backfill.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `4d6b2cd` Lakehouse: gold market_daily and data_health with tests |
| **Files** | [`dbt/models/gold/market_daily.sql`](../../dbt/models/gold/market_daily.sql) · [`dbt/models/gold/data_health.sql`](../../dbt/models/gold/data_health.sql) · [`dbt/models/gold/_gold.yml`](../../dbt/models/gold/_gold.yml) · [`dbt/tests/assert_market_daily_counts_every_coin.sql`](../../dbt/tests/assert_market_daily_counts_every_coin.sql) |

## Goal

Two small daily tables: the market as a whole, and how complete each day's data is.

## Concepts

| Concept | Here |
|---|---|
| **Not everything needs to be incremental** | Both are plain tables rebuilt on every run from `coin_daily` (about 870 rows a day): seconds of work, and always consistent. Incremental logic is worth its complexity only for big tables. |
| **Median vs weighted average** | The median treats every coin equally; the volume-weighted return counts big coins more. When they disagree, large and small coins moved differently. |
| **Breadth** | The share of moving coins that went up; a rally on weak breadth is carried by a few coins. |
| **Data observability** | `data_health` makes the pipeline report on itself: missing minutes and snapshots, coins appearing or vanishing. |
| **`lag` and `lead`** | `lag` finds a coin's previous day (is it new?), `lead` its next day (did it drop out?). |
| **Built-in `unique` test** | For a one-column key, dbt's generic `unique` test replaces a custom SQL file. |

## Code walkthrough

`market_daily`, one aggregate over `coin_daily` per day:

```sql
count_if(return_1d > 0)                                   as coins_up,
percentile(return_1d, 0.5)                                as median_return_1d,
sum(return_1d * quote_volume)
  / nullif(sum(case when return_1d is not null then quote_volume end), 0)
                                                          as volume_weighted_return_1d,
sum(case when symbol = 'BTCUSDT' then quote_volume end)   as btc_quote_volume,
…
coins_up / nullif(coins_up + coins_down, 0)               as breadth
```

`data_health`, completeness per day, plus new and dropped coins found with `lag`/`lead`:

```sql
count_if(minutes = 1440)                                  as coins_complete_candles,
count(*) * 1440 - sum(minutes)                            as missing_minutes,
count_if(previous_date is null or previous_date <> date_sub(trade_date, 1)) as coins_new,
…
case when d.coins = d.coins_complete_candles and coalesce(x.coins_dropped, 0) = 0
     then 'complete' else 'check' end                     as candle_status
```

Tests (7): `unique` and `not_null` on both tables' `trade_date`, `not_null` on `coins`,
`accepted_values` on `candle_status`, and `assert_market_daily_counts_every_coin` (every coin is
counted; up + down + unchanged = coins with a return).

## How to run

From `lakehouse/dbt/`: `../.venv/Scripts/dbt build --select market_daily data_health`

## Result

`market_daily`, 2026-10-19:

| Measure | Value |
|---|---|
| Breadth | 0.585 (431 up, 306 down, 135 unchanged) |
| Median coin's return | exactly 0 (the unchanged coins sit in the middle) |
| Volume-weighted return | +2.58% |
| Bitcoin | −0.21%, 21.7% of all volume |
| Coins that moved 20% or more | 9 |
| Total open interest | 25.9 billion USDT |

`data_health`:

| | 2026-10-18 | 2026-10-19 |
|---|---|---|
| Coins with all 1,440 minutes | 872 of 872 | 872 of 872 |
| Coins with metrics / all 288 snapshots | 744 / 595 | 744 / 609 |
| Missing metric snapshots | 10,706 | 5,819 |
| New / dropped coins | 872 (first day) / 0 | 0 / 0 |
| Candle status | complete | complete |

2 models and 7 tests passed.

## Problems we hit

None.
