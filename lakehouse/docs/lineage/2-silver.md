# 2. Silver

[← 1. From Binance to bronze](1-binance-to-bronze.md) · [Lineage and transformations](README.md) · Next: [3. Gold: days and coins →](3-gold-days-and-coins.md)

Silver turns bronze's text into typed rows, one per key, and adds the tables that describe coins and
markets. Every model is a `SELECT` in [`dbt/models/silver/`](../../dbt/models/silver/); dbt wraps it in a
`MERGE`, a `CREATE TABLE` or a `CREATE VIEW`.

## The pattern of the three typed tables

`fct_candle_1m`, `fct_metrics_5m` and `fct_candle_1h_archive` are made the same way, in four steps:

1. **Watermark.** Read only the bronze rows loaded after the newest `bronze_loaded_at` already in the table:

   ```sql
   where loaded_at > (select max(bronze_loaded_at) from {{ this }})
   ```

   It is the time a row was **loaded**, not the day it describes, so a day that arrives a week late, or a
   file the recheck loaded again, is still picked up.
2. **Types.** `try_cast` every text column to a number or a time. A value that isn't one becomes `NULL`.
3. **Drop rows without a time.** `where open_time is not null`. This is the only reason a row is dropped.
4. **One row per key, newest load wins:**

   ```sql
   qualify row_number() over (partition by symbol, open_time order by bronze_loaded_at desc) = 1
   ```

   then dbt `MERGE`s the result on the key: a key already in the table is updated, a new one is inserted.

## `market.silver.fct_candle_1m`

**One row per** coin and minute. **Built from** `bronze.klines_1m`. **Which rows:** rows whose `open_time`
reads as a number, the newest load of each minute. **Refreshed** incrementally (`MERGE` on `symbol`,
`open_time`).

| Column | From | How |
|---|---|---|
| `symbol` | `symbol` | Unchanged |
| `open_time` | `open_time` | `timestamp_millis(try_cast(open_time as bigint))`: milliseconds to a UTC time |
| `candle_date` | `open_time` (the new one) | `to_date(open_time)`. The day comes from the minute itself, not from the folder, so a file in the wrong folder can't put minutes on the wrong day |
| `open`, `high`, `low`, `close` | Same names | `try_cast(… as double)` |
| `volume`, `quote_volume` | Same names | `try_cast(… as double)` |
| `trades` | `count` | `try_cast(count as bigint)`, renamed |
| `taker_buy_volume`, `taker_buy_quote_volume` | Same names | `try_cast(… as double)` |
| `source_file` | `source_file` | Unchanged |
| `bronze_loaded_at` | `loaded_at` | Renamed. The watermark for this table and for `fct_candle_1h` |

**Left behind:** `date` (the day comes from `open_time`), `close_time` (always the end of the same minute),
`ignore`, `_rescued_data`, `source_file_modified_at`.
**Checked by:** `assert_candle_unique`, `assert_candle_ohlc_range` (open and close between low and high),
`assert_candle_taker_within_volume`.

## `market.silver.fct_metrics_5m`

**One row per** coin and 5 minutes. **Built from** `bronze.metrics`. **Which rows:** rows whose
`create_time` reads as a time, the newest load of each. **Refreshed** incrementally (`MERGE` on `symbol`,
`metric_time`).

Binance's column names say how a ratio is counted (`count_` by accounts, `sum_` by position size) but not
what it is, so silver renames them:

| Column | From | How |
|---|---|---|
| `symbol` | `symbol` | Unchanged |
| `metric_time` | `create_time` | `try_to_timestamp(create_time, 'yyyy-MM-dd HH:mm:ss')` |
| `metric_date` | `metric_time` | `to_date(metric_time)` |
| `open_interest` | `sum_open_interest` | `try_cast(… as double)`, renamed. In the coin |
| `open_interest_usdt` | `sum_open_interest_value` | The same, in USDT |
| `top_trader_account_ratio` | `count_toptrader_long_short_ratio` | Top traders' accounts long ÷ accounts short |
| `top_trader_position_ratio` | `sum_toptrader_long_short_ratio` | Top traders' positions long ÷ short |
| `account_long_short_ratio` | `count_long_short_ratio` | All accounts long ÷ short |
| `taker_buy_sell_ratio` | `sum_taker_long_short_vol_ratio` | Aggressive buy volume ÷ aggressive sell volume |
| `source_file`, `bronze_loaded_at` | `source_file`, `loaded_at` | As in `fct_candle_1m` |

A ratio Binance left empty stays `NULL`; that isn't an error.
**Checked by:** `assert_metrics_unique`, `assert_metrics_on_5_minute_grid`, `assert_metrics_not_negative`.

## `market.silver.fct_candle_1h`

**One row per** coin and hour, from 18 September 2026. **Built from** `fct_candle_1m`. **Which rows:**
every hour with at least one minute. **Refreshed** incrementally, a whole day at a time: a run finds every
day that received a minute loaded after the newest `last_bronze_loaded_at` already here, and rebuilds every
hour of those days. An hour is a sum of minutes, so merging only the new minutes would leave half-built
hours.

```sql
where candle_date in (
    select distinct candle_date from fct_candle_1m
    where bronze_loaded_at > (select max(last_bronze_loaded_at) from {{ this }}))
```

Every column is an aggregate over the hour's minutes, `group by symbol, date_trunc('HOUR', open_time)`:

| Column | From | How |
|---|---|---|
| `symbol`, `candle_date` | Same names | Group keys |
| `hour_start` | `open_time` | `date_trunc('HOUR', open_time)` |
| `open` | `open`, `open_time`, `volume` | The first minute **that traded**: `min_by(open, open_time) filter (where volume > 0)`. If no minute traded, the first minute's open |
| `high` | `high`, `volume` | `max(high)` over the minutes that traded; over all minutes if none did |
| `low` | `low`, `volume` | `min(low)`, the same way |
| `close` | `close`, `open_time` | `max_by(close, open_time)`: the last minute's close |
| `volume`, `quote_volume`, `trades`, `taker_buy_volume`, `taker_buy_quote_volume` | Same names | `sum(…)` |
| `vwap` | `quote_volume`, `volume` | `sum(quote_volume) / nullif(sum(volume), 0)`: the average price paid; empty when nothing traded |
| `taker_buy_share` | `taker_buy_volume`, `volume` | `sum(taker_buy_volume) / nullif(sum(volume), 0)`: the share of the volume that was aggressive buying |
| `minutes` | | `count(*)`: 60 when the hour is complete |
| `zero_volume_minutes` | `volume` | `count_if(volume = 0)` |
| `last_bronze_loaded_at` | `bronze_loaded_at` | `max(…)`: the watermark for `coin_daily` |

**Why open, high and low skip the flat minutes:** Binance fills a minute without trades with a flat candle
at the previous close. Counting them made an hour open at the previous hour's close and widened its range.
Built this way, every hour matches Binance's own hourly candle. The close needs no such rule: a flat
minute's close is the last trade's price anyway.
**Checked by:** `assert_candle_1h_reconciles_with_1m` (each day's minutes, trades, volume and quote volume
add up to the 1-minute table's), `assert_candle_1h_minutes_in_range` (1 to 60),
`assert_candle_1h_vwap_in_range`, `assert_candle_1h_unique`, and `assert_hourly_sources_agree` (below).

## `market.silver.fct_candle_1h_archive`

**One row per** coin and hour, from January 2020. **Built from** `bronze.klines_1h`. **Which rows:** rows
whose `open_time` reads as a number. The header lines (`open_time` is the text `open_time`) become `NULL`
here and are dropped. **Refreshed** incrementally, as the typed tables above.

| Column | From | How |
|---|---|---|
| `symbol` | `symbol` | Unchanged |
| `hour_start` | `open_time` | `timestamp_millis(try_cast(open_time as bigint))` |
| `candle_date` | `hour_start` | `to_date(hour_start)` |
| `open` … `taker_buy_quote_volume`, `trades` | Same names, `count` | `try_cast`, `count` renamed `trades` |
| `source_file`, `bronze_loaded_at` | `source_file`, `loaded_at` | As in `fct_candle_1m` |

These are Binance's own hourly candles, so they have no `vwap`, `taker_buy_share` or minute counts.
**Checked by:** `assert_candle_1h_archive_unique`, and `assert_hourly_sources_agree`: on the days both
tables cover, every hour must be in both, with the same prices to one part in a billion, and the same
volume and trades.

## `market.silver.int_candle_1h_all` (view)

**One row per** coin and hour, from January 2020 to yesterday. **Built from** `fct_candle_1h_archive` and
`fct_candle_1h`. **Which rows:** the archive's hours **before** the first day of `fct_candle_1h`
(`min(candle_date)`, 18 September 2026), then every hour of `fct_candle_1h`, joined with `union all`.
**Refreshed:** it's a view, so it is always current.

| Column | From | How |
|---|---|---|
| `symbol`, `hour_start`, `candle_date`, `open`, `high`, `low`, `close`, `volume`, `quote_volume`, `trades`, `taker_buy_volume`, `taker_buy_quote_volume` | The same columns of either table | Unchanged |
| `source` | | `'monthly_archive'` or `'minute_candles'`: which table the hour came from |

Where both tables have an hour they agree exactly (`assert_hourly_sources_agree`), so switching from one to
the other leaves no seam. **Checked by:** `assert_candle_1h_all_unique`.

## `market.silver.int_coin_status` (view)

**One row per** coin. **Built from** `fct_candle_1h`. **Which rows:** every coin with an hour.
**Refreshed:** a view; the snapshot below reads it on every build.

| Column | From | How |
|---|---|---|
| `symbol` | `symbol` | Group key |
| `base_asset` | `symbol` | The multiplier in front (`1000000`, `100000`, `10000`, `1000` or `1M` followed by a capital letter) and `USDT` at the end removed: `1000PEPEUSDT` → `PEPE`, `1MBABYDOGEUSDT` → `BABYDOGE` |
| `quote_asset` | | `'USDT'` |
| `multiplier` | `symbol` | The prefix as a number: none → 1, `1M` → 1,000,000, `1000` → 1,000 |
| `first_candle_date` | `candle_date` | `min(candle_date)`: the first day with candles **in this table**, so 18 September 2026 for every coin older than that |
| `status` | `trades`, `candle_date` | `'trading'` when the coin's last day with a trade is within the table's last 3 days (`>= date_sub(latest_date, 2)`), else `'not trading'`. Having candles proves nothing (delisted contracts get flat ones); having trades does. Three days, so one late file doesn't make a false "delisted" |

## `market.silver.dim_coin` (snapshot)

**One row per** version of a coin's description. **Built from** `int_coin_status`, by a dbt snapshot
([`snapshots/dim_coin.yml`](../../dbt/snapshots/dim_coin.yml)). **Which rows:** every version ever seen.
**Refreshed** on every build: a Type 2 slowly changing dimension.

On each build dbt compares each coin's row in the view with its current version here, on four columns
(`check_cols: base_asset, multiplier, first_candle_date, status`). If one has changed, the current version
is closed and a new one added; if nothing changed, nothing is written. In SQL Server terms it is a `MERGE`
that updates `dbt_valid_to` on the old row and inserts the new one.

| Column | From | How |
|---|---|---|
| `symbol`, `base_asset`, `quote_asset`, `multiplier`, `first_candle_date`, `status` | `int_coin_status` | Copied when the version is written |
| `dbt_valid_from` | | When the build that wrote this version ran |
| `dbt_valid_to` | | `9999-12-31` while current; set to the next build's time when a newer version replaces it |
| `dbt_updated_at` | | When dbt recorded the version |
| `dbt_scd_id` | `symbol`, `dbt_updated_at` | A hash of the two: dbt's own key for the version |

The current version of a coin is `where dbt_valid_to = cast('9999-12-31' as timestamp)`.
**Checked by:** `assert_dim_coin_one_current_version`, and `assert_trading_coins_have_trades`, which checks
`status` against the trades in `gold.coin_daily`.

## `market.silver.dim_market_type` (seed)

**One row per** symbol the lakehouse has seen. **Built from** Binance's live contract list
(`fapi.binance.com/fapi/v1/exchangeInfo`), by [`ingest/refresh_market_types.py`](../../ingest/refresh_market_types.py),
run on a person's computer because that address turns away many cloud servers. The script writes
[`dbt/seeds/dim_market_type.csv`](../../dbt/seeds/dim_market_type.csv), which is committed; `dbt seed`
loads it on every build. **Which rows:** every USDT perpetual Binance lists (`contractType` `PERPETUAL` or
`TRADIFI_PERPETUAL`), plus every symbol already in the file: a market Binance stops listing keeps its row,
so its old moves keep their type.

| Column | From (Binance's contract list) | How |
|---|---|---|
| `symbol` | `symbol` | Unchanged |
| `market_type` | `underlyingType` | `COIN` → `crypto`; `EQUITY`, `HK_EQUITY`, `KR_EQUITY`, `CN_EQUITY` → `stock`; `COMMODITY` → `commodity`; anything else (indices, a currency, pre-IPO markets) → `other`. The same groups as the Markets page |
| `underlying_type` | `underlyingType` | Unchanged |
| `contract_type` | `contractType` | Unchanged |
| `onboard_date` | `onboardDate` | Milliseconds to a UTC date: the day Binance listed the contract now on this symbol |

The gold tables use it through one rule, the macro
[`market_type_on`](../../dbt/macros/market_type_on.sql), because a stock contract can take over an old
crypto ticker (MDTUSDT was a token until 2024 and has been Medtronic since 2026):

```sql
case when list.symbol is null then 'unknown'                        -- not in the file yet
     when list.market_type in ('stock', 'commodity')
      and day < list.onboard_date then 'crypto'                      -- before the stock took the ticker
     else list.market_type end
```

**Checked by:** `assert_market_types_known` (a warning when a trading market isn't in the file yet).
