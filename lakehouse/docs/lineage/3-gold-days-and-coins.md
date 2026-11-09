# 3. Gold: days and coins

[← 2. Silver](2-silver.md) · [Lineage and transformations](README.md) · Next: [4. Gold: moves and evidence →](4-gold-moves-and-evidence.md)

The daily tables, the checks on each day's data, and each coin's normal. All are built from the recent
line: the minute candles since 18 September 2026 and the hours and days made from them. Models in
[`dbt/models/gold/`](../../dbt/models/gold/).

| Table | Read by |
|---|---|
| `coin_daily` | Every other table on this page |
| `coin_baseline` | MEDUSA's Markets page, as `market_baseline` ([page 5](5-definitions-logs-and-serving.md)) |
| `missing_days` | MEDUSA's Markets page, as `market_missing_days` |
| `market_daily`, `data_health`, `unusual_moves`, `hour_profile` | People, in Databricks. Nothing downstream |

## `market.gold.coin_daily`

**One row per** coin and UTC day. **Built from** `fct_candle_1h` (prices, volumes, completeness),
`fct_candle_1m` (volatility) and `fct_metrics_5m` (open interest and ratios). **Which rows:** every coin with
an hour that day, traded or not. **Refreshed** incrementally: a run rebuilds every day that received new
hours, **and the day after each**, because a day's return needs the day before's close. It reads the hours
of the day before as well.

```sql
new_days    = days in fct_candle_1h with last_bronze_loaded_at newer than this table's newest
target_days = new_days, plus each of them + 1 day
```

The three sources are joined on `symbol` and the day with `left join`, so a coin without metrics still has
its day.

### From the hours

| Column | From `fct_candle_1h` | How |
|---|---|---|
| `symbol`, `trade_date` | `symbol`, `candle_date` | Group keys |
| `open` | `open`, `hour_start`, `trades` | The first hour that traded: `min_by(open, hour_start) filter (where trades > 0)`; the first hour if none did |
| `high`, `low` | `high`, `low`, `trades` | `max(high)` and `min(low)` over the hours that traded; over all hours if none did |
| `close` | `close`, `hour_start` | `max_by(close, hour_start)`: the last hour's close |
| `return_1d` | `close`, and the coin's previous row | `close / previous_close - 1`, only when the previous row is the calendar day before (`lag(trade_date) = date_sub(trade_date, 1)`). Empty on a coin's first day and after a gap, so a return never spans two days |
| `range_1d` | `high`, `low`, `open` (above) | `(high - low) / open` |
| `volume`, `quote_volume`, `trades` | Same names | `sum(…)` |
| `taker_buy_share` | `taker_buy_volume`, `volume` | `sum(taker_buy_volume) / nullif(sum(volume), 0)`. From the day's totals, so a busy hour counts for more than a quiet one |
| `minutes`, `zero_volume_minutes` | Same names | `sum(…)`: 1,440 minutes when the day is complete |
| `last_bronze_loaded_at` | Same name | `max(…)`: the watermark for the next run |

### From the minutes

```sql
lag(close) over (partition by symbol, candle_date order by open_time) as previous_minute_close
```

The previous minute is looked up **within the same day**, so the first minute of a day has none: a day's
volatility covers its own 1,439 minute-to-minute moves, not the jump from yesterday's last minute.

| Column | From `fct_candle_1m` | How |
|---|---|---|
| `realized_volatility_1d` | `close` | `sqrt(sum(power(ln(close / previous_minute_close), 2)))`: the square root of the sum of squared 1-minute log returns, not annualised. Minutes with a price of 0 are skipped |
| `max_move_1m` | `close` | `max(abs(close / previous_minute_close - 1))`: the biggest single minute, up or down |

### From the 5-minute metrics

| Column | From `fct_metrics_5m` | How |
|---|---|---|
| `open_interest_open_usdt` | `open_interest_usdt`, `metric_time` | `min_by(open_interest_usdt, metric_time)`: the day's first snapshot |
| `open_interest_close_usdt` | The same | `max_by(…)`: the day's last snapshot |
| `open_interest_change_1d` | The two above | `close / nullif(open, 0) - 1` |
| `avg_taker_buy_sell_ratio` | `taker_buy_sell_ratio` | `avg(…)` of the day's snapshots; empty values are skipped |
| `avg_top_trader_position_ratio` | `top_trader_position_ratio` | `avg(…)` |
| `avg_account_long_short_ratio` | `account_long_short_ratio` | `avg(…)` |
| `metric_snapshots` | | `count(*)`, or 0 when the coin had no metrics that day: 288 when complete |

`fct_metrics_5m.top_trader_account_ratio` and `open_interest` (in the coin) are not carried into gold.
**Checked by:** `assert_coin_daily_reconciles_with_1h` (each day's minutes, trades and volume add up to the
hourly table's), `assert_coin_daily_minutes_in_range` (1 to 1,440), `assert_coin_daily_unique`.

## `market.gold.market_daily`

**One row per** UTC day. **Built from** `coin_daily`. **Which rows:** every day. Only coins that **traded**
(`trades > 0`) are counted in the figures; the delisted contracts' flat days (about 130 a day) would
otherwise add that many "unchanged" coins and pull the median return to exactly 0. **Refreshed** in full on
every run: about 870 rows a day to read, so there's no need to be clever.

| Column | From `coin_daily` | How |
|---|---|---|
| `trade_date` | `trade_date` | Group key |
| `coins` | | `count(*)` of the coins that traded |
| `coins_inactive` | `trades` | `count(*)` of the coins with `trades = 0` that day; 0 if none |
| `coins_up`, `coins_down`, `coins_flat` | `return_1d` | `count_if(return_1d > 0)`, `< 0`, `= 0`. A coin without a return (its first day, or after a gap) is in none of them |
| `breadth` | The two above | `coins_up / nullif(coins_up + coins_down, 0)`: 0.5 means as many up as down |
| `coins_moved_20pct` | `return_1d` | `count_if(abs(return_1d) >= 0.2)` |
| `median_return_1d` | `return_1d` | `percentile(return_1d, 0.5)`; empty returns are skipped |
| `volume_weighted_return_1d` | `return_1d`, `quote_volume` | `sum(return_1d * quote_volume) / sum(quote_volume of the coins with a return)`: each coin's return weighted by how much of it traded |
| `median_realized_volatility_1d` | `realized_volatility_1d` | `percentile(…, 0.5)` |
| `quote_volume` | `quote_volume` | `sum(…)` |
| `btc_volume_share` | `quote_volume` | BTCUSDT's quote volume ÷ the total |
| `taker_buy_share` | `taker_buy_share`, `quote_volume` | `sum(taker_buy_share * quote_volume) / sum(quote_volume of the coins with a share)`: weighted by quote volume |
| `open_interest_usdt` | `open_interest_close_usdt` | `sum(…)` |
| `btc_return_1d`, `eth_return_1d` | `return_1d` | BTCUSDT's and ETHUSDT's |

**Checked by:** `assert_market_daily_counts_every_coin` (traded plus inactive coins make up all of
`coin_daily`'s, and up, down and flat add up to the coins with a return).

## `market.gold.data_health`

**One row per** UTC day. **Built from** `coin_daily`, every coin, traded or not. **Which rows:** every day.
**Refreshed** in full.

```sql
lag(trade_date)  over (partition by symbol order by trade_date) as previous_date,
lead(trade_date) over (partition by symbol order by trade_date) as next_date
```

| Column | From `coin_daily` | How |
|---|---|---|
| `trade_date` | `trade_date` | Group key |
| `coins` | | `count(*)` |
| `coins_inactive` | `trades` | `count_if(trades = 0)` |
| `coins_complete_candles` | `minutes` | `count_if(minutes = 1440)` |
| `coins_incomplete_candles` | | `coins - coins_complete_candles` |
| `missing_minutes` | `minutes` | `count(*) * 1440 - sum(minutes)` |
| `coins_with_metrics` | `metric_snapshots` | `count_if(metric_snapshots > 0)` |
| `coins_complete_metrics` | `metric_snapshots` | `count_if(metric_snapshots = 288)` |
| `coins_incomplete_metrics` | | `coins_with_metrics - coins_complete_metrics` |
| `missing_metric_snapshots` | `metric_snapshots` | `sum(288 - metric_snapshots)` over the coins that have any |
| `coins_new` | `previous_date` | Coins without a row the calendar day before. On the very first day every coin counts as new |
| `coins_dropped` | `next_date` | Coins that had a row the day before and none on this day. Counted on the day they are missing |
| `last_loaded_at` | `last_bronze_loaded_at` | `max(…)` |
| `candle_status` | | `'complete'` when every coin has 1,440 minutes and none dropped, else `'check'` |

## `market.gold.missing_days`

**One row per** day that should be in the lakehouse and isn't; no rows is the good answer. Every other test
checks rows that exist, so a day that never arrived passes them all; this compares the calendar with the
days in `coin_daily`. **Built from** `coin_daily` and the date of the run. **Refreshed** in full, so a day
leaves the table by itself once its data arrives.

```sql
calendar = explode(sequence(min(trade_date), date_sub(current_date(), 1)))   -- every day to yesterday
missing  = calendar left join the days in coin_daily, where coin_daily has none
```

| Column | From | How |
|---|---|---|
| `trade_date` | The calendar | A day in it that `coin_daily` doesn't have |
| `days_old` | `trade_date`, the run's date | `datediff(current_date(), trade_date)` |
| `status` | `days_old` | 1 → `waiting` (yesterday; the daily load hasn't had its turn); 2 to 8 → `retrying` (the daily load tries it again every day); older → `manual` (load or repair it by hand) |

Because it depends on the run's date, this table can change without any new data.
**Checked by:** `assert_no_missing_days`, a warning, so the days that did arrive aren't held back.

## `market.gold.unusual_moves`

**One row per** coin and day that was unusual **for that coin**. **Built from** `coin_daily`. **Refreshed**
in full.

Each day is compared with the coin's previous 30 rows in `coin_daily`, not counting the day itself:

```sql
window w as (partition by symbol order by trade_date rows between 30 preceding and 1 preceding)
```

**Which rows:** days with at least 20 returns in that window (`history_days >= 20`), some volume
(`quote_volume > 0`), and at least one of the three z-scores at 3 or more (the return's either way).

| Column | From `coin_daily` | How |
|---|---|---|
| `symbol`, `trade_date`, `return_1d`, `quote_volume`, `realized_volatility_1d`, `taker_buy_share` | Same names | Unchanged |
| `history_days` | `return_1d` | `count(return_1d) over w`: how many of the 30 rows have a return |
| `return_z` | `return_1d` | `(return_1d - avg(return_1d) over w) / nullif(stddev(return_1d) over w, 0)` |
| `volume_z` | `quote_volume` | The same on `ln(quote_volume)`. Volumes are compared on a log scale because they are skewed: a doubling counts the same for a coin that trades a million as for one that trades a billion |
| `volatility_z` | `realized_volatility_1d` | The same on `realized_volatility_1d` |
| `reasons` | The three z-scores | `concat_ws(', ', …)` of `big rise` or `big fall` (\|return_z\| ≥ 3), `volume surge` (volume_z ≥ 3), `volatility spike` (volatility_z ≥ 3) |

**Checked by:** `assert_unusual_moves_unique_and_explained`.

## `market.gold.hour_profile`

**One row per** coin and UTC hour of the day (0 to 23). **Built from** `fct_candle_1h`, so from 18 September
2026 only. **Which rows:** hours with a price above 0. **Refreshed** in full.

Each hour first gets its return and its share of the coin's day, then each coin and hour of the day is
summed up over all its days:

| Column | From `fct_candle_1h` | How |
|---|---|---|
| `symbol` | `symbol` | Group key |
| `utc_hour` | `hour_start` | `hour(hour_start)`: group key |
| `days` | | `count(*)`: how many days have this hour |
| `first_date`, `last_date` | `candle_date` | `min(…)`, `max(…)` |
| `avg_return` | `close`, `open` | `avg(close / open - 1)` |
| `sd_return` | The same | `stddev(close / open - 1)` |
| `t_stat_return` | The two above | `avg_return / (sd_return / sqrt(days))`: below 2 either way, the average could easily be chance |
| `avg_abs_return` | The same | `avg(abs(close / open - 1))`: how much the hour moves, either way |
| `avg_volume_share` | `quote_volume` | Each hour's `quote_volume / sum(quote_volume) over (partition by symbol, candle_date)`, averaged |
| `avg_quote_volume` | `quote_volume` | `avg(…)` |
| `avg_taker_buy_share` | `taker_buy_share` | `avg(…)` of the hours' shares |

**Checked by:** `assert_hour_profile_valid`.

## `market.gold.coin_baseline`

**One row per** coin: its normal as of its latest day, which the Markets page compares today's move with.
**Built from** `coin_daily`, `fct_candle_1h` and `dim_coin`. **Which rows:** every coin with a day that
traded. Days without trades are left out, so a delisted contract with only flat days gets no baseline.
**Refreshed** in full.

It works in three steps:

```sql
-- 1. Each traded day, numbered back from the latest, with the 3-day range ending on it
traded_days = coin_daily where trades > 0, with
    row_number() over (partition by symbol order by trade_date desc)       as days_back,
    max(high) over three_days / nullif(min(low) over three_days, 0) - 1    as range_3d,
    count(*)  over three_days                                              as days_in_range
    -- three_days = the day and the 2 traded days before it
-- 2. Keep the last 30
last_30 = traded_days where days_back <= 30
-- 3. One row per coin from those 30 days
```

The 3-day ranges are worked out before the last 30 are picked, so the oldest of the 30 still has the two
days before it.

| Column | From | How |
|---|---|---|
| `symbol` | `coin_daily.symbol` | Group key |
| `base_asset`, `multiplier`, `status` | `dim_coin` | The current version (`dbt_valid_to = 9999-12-31`) |
| `as_of_date` | `trade_date` | `max(…)`: the coin's latest traded day |
| `last_close` | `close`, `trade_date` | `max_by(close, trade_date)`: that day's close |
| `history_days` | `return_1d` | `count(return_1d)` over the 30 days |
| `avg_return_30d`, `sd_return_30d` | `return_1d` | `avg(…)`, `stddev(…)` |
| `avg_abs_return_30d` | `return_1d` | `avg(abs(…))` |
| `avg_range_30d` | `range_1d` | `avg(…)` |
| `avg_volatility_30d`, `sd_volatility_30d` | `realized_volatility_1d` | `avg(…)`, `stddev(…)` |
| `avg_quote_volume_30d` | `quote_volume` | `avg(…)` |
| `avg_log_volume_30d`, `sd_log_volume_30d` | `quote_volume` | `avg(ln(…))`, `stddev(ln(…))`, as in `unusual_moves` |
| `avg_abs_hour_return_30d` | `fct_candle_1h.close`, `open` | `avg(abs(close / open - 1))` over the coin's hours on the same 30 days: does it move enough within an hour to pay for a round trip's fees? |
| `high_3d`, `low_3d` | `high`, `low` | `max(high)` and `min(low)` of the last 3 traded days (`days_back <= 3`) |
| `high_2d`, `low_2d` | `high`, `low` | The same over the last 2: the page adds yesterday from Binance when the lakehouse doesn't have it yet |
| `avg_range_3d_30d` | `range_3d` | `avg(range_3d)` over the 30 days, counting only days with a full 3-day window: the coin's usual 3-day range |

**The window differs from `unusual_moves` on purpose.** `unusual_moves` judges a finished day, so it leaves
that day out. `coin_baseline` is the normal for **today**, whose previous 30 days run up to and including the
latest day in the lakehouse. Both use the same formula for the return and the z-score.
**Checked by:** `assert_coin_baseline_valid` (every trading coin has a baseline from the last few days, a
positive price, 0 to 30 days of history, no negative spreads, and a 3-day range that holds the last close).
