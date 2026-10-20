# Step 18: Count only coins that actually trade

[← Lakehouse home](../../README.md) · [← Step 17](17-daily-chain.md) · Next: [Step 19 →](19-coin-baseline.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `c584f93` Lakehouse: count only coins that trade (delisted contracts still get flat candles); coin status from trades |
| **Files** | [`dbt/models/silver/int_coin_status.sql`](../../dbt/models/silver/int_coin_status.sql) · [`dbt/models/gold/market_daily.sql`](../../dbt/models/gold/market_daily.sql) · [`dbt/models/gold/data_health.sql`](../../dbt/models/gold/data_health.sql) · [`dbt/tests/assert_market_daily_counts_every_coin.sql`](../../dbt/tests/assert_market_daily_counts_every_coin.sql) · [`dbt/tests/assert_trading_coins_have_trades.sql`](../../dbt/tests/assert_trading_coins_have_trades.sql) (new) |
| **Decision** | [ADR-018](../decisions.md#adr-018-a-coin-trades-only-if-it-has-trades) |

## Goal

Make sure every table counts only coins that really trade, before the live scanner is built on top
of them: the scanner must never flag a dead contract, and each coin's "normal" must not be skewed.

## What was wrong

While testing the first scanner query, 129 coins had no spread of daily volume at all. They weren't
missing data: they had candles every day, all flat, all with zero volume.

| Check | Result |
|---|---|
| Coins in the archive, last day | 873 |
| Coins with at least one trade in their last 3 days | 740 |
| Coins with no trades in their last 3 days | 133 |
| Those 133 in Binance's own contract list (`/fapi/v1/exchangeInfo`) | 132 are `SETTLING` (delisted, being settled); 1 is gone (the coin that dropped out on 2026-10-13) |
| The 740 active coins | 519 crypto perpetuals and 220 TradFi perpetuals (stocks and similar), all `TRADING`, plus 1 coin delisted within the last 3 days |

Binance keeps publishing flat, zero-volume candles for contracts it has delisted. The tables treated
"has candles" as "trades", so on 2026-10-19 `market_daily` counted 135 "unchanged" coins (132 of
them dead) and its median return was exactly 0. [Step 14](14-gold-market-and-health.md) explained
that zero as "the unchanged coins sit in the middle"; this is why they were there.

## Concepts

| Concept | Here |
|---|---|
| **A row isn't proof of activity** | The archive's meaning changed without its format changing. Checking that data arrived isn't enough; check what it means. |
| **Cross-source validation** | Comparing the archive with Binance's own contract list showed what the zero-volume coins were. |
| **SCD Type 2 records a correction** | `dim_coin` closed the `trading` version of 132 coins and opened `not trading` versions dated when this build ran, although some stopped trading as early as 2026-09-24. System time (when the warehouse learned it) differs from valid time (when it happened). |
| **Cheaper lineage** | `int_coin_status` now reads the hourly table (about 670,000 rows) instead of the 1-minute table (about 40 million and growing by 1.26 million a day); the days and trades are the same. |
| **Cross-layer test** | A new test checks silver (`dim_coin`) against gold (`coin_daily`): every coin called trading must have traded in the last 3 days, and every coin called not trading must not have. |

## Code walkthrough

```sql
-- int_coin_status.sql
max(case when trades > 0 then candle_date end) as last_trade_date      -- from fct_candle_1h
…
case when last_trade_date >= date_sub(latest_date, 2) then 'trading' else 'not trading' end as status
```

```sql
-- market_daily.sql
with active   as (select * from {{ ref('coin_daily') }} where trades > 0),
     inactive as (select trade_date, count(*) as coins_inactive
                  from {{ ref('coin_daily') }} where trades = 0 group by trade_date),
     days     as (select trade_date, count(*) as coins, … from active group by trade_date)
select d.trade_date, d.coins, coalesce(i.coins_inactive, 0) as coins_inactive, …
```

`data_health` also gets `coins_inactive`. The reconciliation test now checks that active plus
inactive coins make up every coin in `coin_daily`, and that up, down and flat add up to the active
coins with a return.

## How to run

From `lakehouse/dbt/`: `../.venv/Scripts/dbt build`

## Result

`PASS=77 WARN=0 ERROR=0` (9 models, 1 snapshot, 67 tests) in 3 minutes 36 seconds.

| | Before | After |
|---|---|---|
| `dim_coin` current versions | 872 trading, 1 not trading | 740 trading, 133 not trading (1,877 versions of 873 coins) |
| `market_daily`, 2026-10-19: coins | 872 | 740 active + 132 `coins_inactive` |
| Unchanged coins | 135 | 3 |
| Median coin return | 0 (an artifact) | +0.40% |
| Median realised volatility | 3.7% | 3.96% |
| Breadth | 0.585 | 0.585 (flat coins never counted in breadth) |

## Problems we hit

None in the build; the problem was the finding itself.
