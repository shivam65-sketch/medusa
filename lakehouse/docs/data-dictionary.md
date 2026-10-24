# Data dictionary

[← Lakehouse home](../README.md)

Every dataset and table, with what the data really looks like. Numbers come from the loads of
2026-10-18 and 2026-10-19.

## Source: Binance's public archive

Base address: `https://data.binance.vision/data/futures/um/`, then `daily/` for the daily files or
`monthly/` for the hourly history

| Dataset | File path under the base address | Rows per coin per day |
|---|---|---|
| 1-minute candles | `daily/klines/{SYMBOL}/1m/{SYMBOL}-1m-{YYYY-MM-DD}.zip` | 1,440 |
| Market metrics | `daily/metrics/{SYMBOL}/{SYMBOL}-metrics-{YYYY-MM-DD}.zip` | 288 (one per 5 minutes) |
| 1-hour candles (history) | `monthly/klines/{SYMBOL}/1h/{SYMBOL}-1h-{YYYY-MM}.zip` | 24 (about 720 per monthly file) |

Every file has a `.CHECKSUM` file next to it, containing its SHA-256 fingerprint. The list of coins
comes from the archive's folder listing
(`https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=data/futures/um/daily/klines/`,
or `monthly/klines/` for the history), which returns up to 1,000 entries per page. Only USDT perpetuals are kept: names matching
`^[A-Z0-9]+USDT$`, which excludes USDC and BUSD pairs and dated futures such as `BTCUSDT_250926`.

## Landing: `market.landing.binance` (volume)

```
/Volumes/market/landing/binance/
├─ klines_1m/date=2026-10-19/BTCUSDT-1m-2026-10-19.csv.gz
├─ metrics/date=2026-10-19/BTCUSDT-metrics-2026-10-19.csv.gz
└─ klines_1h/month=2024-03/BTCUSDT-1h-2024-03.csv.gz
```

The files are Binance's CSVs, unchanged apart from being unzipped and gzipped. The daily files have
a header row; the monthly hourly files have one only from 2022.

A file Binance changed after its day was loaded is loaded again under a new name ending in the start
of its new fingerprint, for example `BTCUSDT-1m-2026-10-20.r3f9a1c2e.csv.gz`
([ADR-023](decisions.md#adr-023-re-check-loaded-days-against-binance-for-a-week)).

**Manifests** (`manifests/date=YYYY-MM-DD/manifest.csv`, from 2026-10-23): one row per coin and
daily dataset of the day's load.

| Column | Meaning |
|---|---|
| `dataset` | `klines_1m` or `metrics` |
| `symbol` | Binance symbol |
| `status` | `saved` or `missing` (Binance had no file) |
| `file` | The file's name in the landing folder |
| `sha256` | Binance's SHA-256 fingerprint of the zip; empty when missing |

On 2026-10-21: 1,814 rows (907 coins × 2 datasets), 1,624 saved, 190 missing.

## Bronze: `market.bronze.klines_1m`

One row per line of a candle file. Every source column is text, exactly as written in the file.
Built by [`pipelines/bronze/klines_1m.sql`](../pipelines/bronze/klines_1m.sql).

| Column | Type | Meaning | Example |
|---|---|---|---|
| `symbol` | STRING | Coin, taken from the **file name** (the candle files have no coin column) | `BTCUSDT` |
| `date` | STRING | Day, from the folder name `date=…` | `2026-10-19` |
| `open_time` | STRING | Start of the minute, milliseconds since 1970-01-01 UTC | `1792368000000` |
| `open`, `high`, `low`, `close` | STRING | Prices in USDT | `82077.90` |
| `volume` | STRING | Traded amount in the coin (base asset) | `124.928` |
| `close_time` | STRING | End of the minute, ms (open_time + 59,999) | `1792368059999` |
| `quote_volume` | STRING | Traded amount in USDT | `10254472.67370` |
| `count` | STRING | Number of trades in the minute | `3933` |
| `taker_buy_volume` | STRING | Volume of aggressive buys, in the coin; the input to the TAKER signal | `60.264` |
| `taker_buy_quote_volume` | STRING | Aggressive buys in USDT | `4946020.17240` |
| `ignore` | STRING | Unused by Binance, always `0` | `0` |
| `_rescued_data` | STRING | Anything that didn't fit the expected columns (should be empty) | |
| `source_file` | STRING | Full path of the file the row came from | `/Volumes/market/landing/binance/klines_1m/date=…/BTCUSDT-1m-….csv.gz` |
| `source_file_modified_at` | TIMESTAMP | When that file was uploaded | |
| `loaded_at` | TIMESTAMP | When the pipeline loaded the row | |

**What the data looks like:** 872 coins per day, every one with exactly 1,440 rows, so
1,255,680 rows per day. No rescued data so far.

## Bronze: `market.bronze.metrics`

One row per line of a metrics file. Built by [`pipelines/bronze/metrics.sql`](../pipelines/bronze/metrics.sql).

| Column | Type | Meaning |
|---|---|---|
| `symbol` | STRING | Coin (these files do have a coin column; it always matches the file name) |
| `date` | STRING | Day, from the folder name |
| `create_time` | STRING | Time of the 5-minute snapshot, `YYYY-MM-DD HH:MM:SS` UTC |
| `sum_open_interest` | STRING | Open interest: contracts still open, in the coin |
| `sum_open_interest_value` | STRING | Open interest in USDT |
| `count_toptrader_long_short_ratio` | STRING | Top traders: accounts long ÷ accounts short |
| `sum_toptrader_long_short_ratio` | STRING | Top traders: positions long ÷ positions short |
| `count_long_short_ratio` | STRING | All accounts: long ÷ short |
| `sum_taker_long_short_vol_ratio` | STRING | Aggressive buy volume ÷ aggressive sell volume |
| `_rescued_data`, `source_file`, `source_file_modified_at`, `loaded_at` | | As in `klines_1m` |

**What the data looks like:**
- 744 coins per day, fewer than the 872 with candles. On 2026-10-20 all 128 coins with candles but
  no metrics had no trades: delisted ("settling") contracts get flat candle files but no metrics.
- A full day should have 288 rows per coin, but many coins have fewer: on 2026-10-19, 135 of the
  744 files were incomplete, some with a single row. The day had 208,453 rows instead of 214,272.
- Rows inside a file are **not in time order**. Never rely on file order; silver sorts and checks.

## Bronze: `market.bronze.klines_1h`

One row per line of a monthly 1-hour candle file (January 2020 onward, loaded once by the history
workflow). Same columns as `klines_1m`, with `month` (from the folder `month=YYYY-MM`) instead of
`date`. Built by [`pipelines/bronze/klines_1h.sql`](../pipelines/bronze/klines_1h.sql).

The files are read **without a header**: Binance's files before 2022 have none, newer ones do. The
header lines of the newer files arrive as rows whose `open_time` is the text `open_time`; the
`is_data_row` expectation counts them and silver drops them.

**What the data looks like:** 22,221 files, 15,907,630 rows (20,245 of them header lines), 895
coins, 2020-01 to 2026-09; nothing rescued. Coins per year: 81 (2020), 139, 163, 253, 384, 611,
868 (2026).

## Silver: `market.silver.fct_candle_1m`

One row per coin per minute, typed and de-duplicated. Built incrementally by dbt from
`bronze.klines_1m` ([model](../dbt/models/silver/fct_candle_1m.sql)); clustered by `symbol`, `candle_date`.

| Column | Type | Meaning |
|---|---|---|
| `symbol` | STRING | Binance symbol |
| `open_time` | TIMESTAMP | Start of the minute, UTC |
| `candle_date` | DATE | Day of the minute, UTC |
| `open`, `high`, `low`, `close` | DOUBLE | Prices in USDT |
| `volume` | DOUBLE | Traded amount in the coin; 0 when nothing traded |
| `quote_volume` | DOUBLE | Traded amount in USDT |
| `trades` | BIGINT | Number of trades |
| `taker_buy_volume`, `taker_buy_quote_volume` | DOUBLE | Aggressive buying, in the coin and in USDT |
| `source_file` | STRING | Landing file the row came from |
| `bronze_loaded_at` | TIMESTAMP | When bronze loaded the row |

Key: (`symbol`, `open_time`), tested unique. **What the data looks like:** 1,255,680 rows per day
(872 coins); 23.6% of minutes have zero volume (313,313 on 2026-10-18, 278,972 on 2026-10-19).

## Silver: `market.silver.fct_metrics_5m`

One row per coin per 5 minutes, typed, renamed and de-duplicated. Built incrementally by dbt from
`bronze.metrics` ([model](../dbt/models/silver/fct_metrics_5m.sql)); clustered by `symbol`, `metric_date`.

| Column | Type | Meaning |
|---|---|---|
| `symbol` | STRING | Binance symbol |
| `metric_time` | TIMESTAMP | Time of the 5-minute snapshot, UTC |
| `metric_date` | DATE | Day of the snapshot, UTC |
| `open_interest` | DOUBLE | Contracts still open, in the coin |
| `open_interest_usdt` | DOUBLE | Open interest in USDT |
| `top_trader_account_ratio` | DOUBLE | Top traders: long accounts ÷ short accounts; NULL when Binance left it empty |
| `top_trader_position_ratio` | DOUBLE | Top traders: long positions ÷ short positions; can be NULL |
| `account_long_short_ratio` | DOUBLE | All accounts: long ÷ short; can be NULL |
| `taker_buy_sell_ratio` | DOUBLE | Aggressive buy volume ÷ aggressive sell volume; can be NULL, and 0 when nobody bought aggressively |
| `source_file`, `bronze_loaded_at` | | Lineage, as in `fct_candle_1m` |

Key: (`symbol`, `metric_time`), tested unique. **What the data looks like:** 744 coins; 1,204 of 1,488
coin-days complete (288 rows), the rest short, down to 1 row; taker ratio empty in 10,051 rows and
exactly 0 in 9,313.

## Silver: `market.silver.fct_candle_1h`

One row per coin per hour, rolled up from `fct_candle_1m` ([model](../dbt/models/silver/fct_candle_1h.sql));
clustered by `symbol`, `candle_date`. Key (`symbol`, `hour_start`), tested unique and reconciled with
the minute table.

| Column | Type | Meaning |
|---|---|---|
| `symbol` | STRING | Binance symbol |
| `hour_start` | TIMESTAMP | Start of the hour, UTC |
| `candle_date` | DATE | Day of the hour, UTC |
| `open`, `close` | DOUBLE | First trade's price, last minute's close (minutes without trades are skipped for open, high and low; ADR-019) |
| `high`, `low` | DOUBLE | Highest and lowest traded price in the hour |
| `volume`, `quote_volume` | DOUBLE | Traded amount in the coin and in USDT |
| `trades` | BIGINT | Number of trades |
| `taker_buy_volume`, `taker_buy_quote_volume` | DOUBLE | Aggressive buying |
| `vwap` | DOUBLE | quote_volume / volume; NULL when nothing traded |
| `taker_buy_share` | DOUBLE | taker_buy_volume / volume (0 to 1); NULL when nothing traded |
| `minutes` | BIGINT | 1-minute candles behind the hour; 60 when complete |
| `zero_volume_minutes` | BIGINT | Minutes in the hour with no trades |
| `last_bronze_loaded_at` | TIMESTAMP | Newest bronze load time among the hour's minutes |

**What the data looks like:** 20,928 hours per day, all complete; about 3,175 hours a day with no
trades at all, mostly thinly traded coins and the stock perpetuals.

## Silver: `market.silver.fct_candle_1h_archive`

One row per coin per hour from Binance's monthly 1-hour files, typed and de-duplicated; incremental
on bronze load time ([model](../dbt/models/silver/fct_candle_1h_archive.sql)); clustered by
`symbol`, `candle_date`. Key (`symbol`, `hour_start`), tested unique.

| Column | Type | Meaning |
|---|---|---|
| `symbol`, `hour_start`, `candle_date` | STRING, TIMESTAMP, DATE | Coin, start of the hour (UTC), day |
| `open`, `high`, `low`, `close` | DOUBLE | First trade, highest and lowest traded price, last trade (Binance's definition) |
| `volume`, `quote_volume`, `trades` | DOUBLE, DOUBLE, BIGINT | Traded in the coin, in USDT, number of trades |
| `taker_buy_volume`, `taker_buy_quote_volume` | DOUBLE | Aggressive buying |
| `source_file`, `bronze_loaded_at` | | Lineage |

**What the data looks like:** 15,887,385 hours (bronze's rows minus the 20,245 header lines), 895
coins, 2020-01-01 00:00 to 2026-09-30 23:00 UTC; 1,360,716 hours without a trade.

## Silver: `market.silver.int_candle_1h_all` (view)

One continuous hourly series per coin from January 2020 ([model](../dbt/models/silver/int_candle_1h_all.sql)):
`fct_candle_1h_archive` before the first day built from 1-minute candles, `fct_candle_1h` from then
on. Columns: `symbol`, `hour_start`, `candle_date`, `open`, `high`, `low`, `close`, `volume`,
`quote_volume`, `trades`, `taker_buy_volume`, `taker_buy_quote_volume`, and `source`
(`monthly_archive` or `minute_candles`). Tested: no hour twice; on the days both sources cover,
`assert_hourly_sources_agree` requires every hour in both with identical prices, volume and trades.

**What the data looks like (2026-10-21):** 15,621,354 archive hours (2020-01-01 to 2026-09-17) and
683,264 minute-built hours (2026-09-18 to 2026-10-20), 873 coins each.

## Silver: `market.silver.dim_coin` (snapshot)

One row per **version** of a coin's description (SCD Type 2), kept by the dbt snapshot
[`dim_coin`](../dbt/snapshots/dim_coin.yml) from the view `int_coin_status`.

| Column | Type | Meaning |
|---|---|---|
| `symbol` | STRING | Binance symbol, e.g. `1000PEPEUSDT` (the business key) |
| `base_asset` | STRING | The coin without multiplier or USDT, e.g. `PEPE` |
| `quote_asset` | STRING | Always `USDT` |
| `multiplier` | INT | Coins per quoted unit: 1, 1,000 or 1,000,000 |
| `first_candle_date` | DATE | First day with candles in the lakehouse |
| `status` | STRING | `trading`, or `not trading` after 3 days without a single trade (delisted contracts keep getting flat, zero-volume candles, so candles alone don't count) |
| `dbt_scd_id` | STRING | dbt's unique id for the version |
| `dbt_valid_from` | TIMESTAMP | When this version became true |
| `dbt_valid_to` | TIMESTAMP | When it stopped being true; 9999-12-31 for the current version |
| `dbt_updated_at` | TIMESTAMP | When dbt recorded the version |

Coins as of 2026-10-20: 872, all `trading`; 857 with multiplier 1, 12 with 1,000, 3 with 1,000,000. After the 30-day backfill: 873 coins (one delisted on 2026-10-13 is `not trading`), and the 872 earlier coins have a second version because their `first_candle_date` moved to 2026-09-18 or their true listing day. Validity times are when the warehouse recorded each version, not market events. Since [step 18](steps/18-active-coins.md) status comes from trades: 740 `trading`, 133 `not trading` (132 contracts Binance has delisted but still publishes flat candles for, and the coin that dropped out on 2026-10-13); 1,877 versions of 873 coins.

Which coins were trading at a given time:

```sql
SELECT symbol FROM market.silver.dim_coin
WHERE status = 'trading'
  AND TIMESTAMP '2026-10-20 18:00:00' BETWEEN dbt_valid_from AND dbt_valid_to;
```

`market.silver.int_coin_status` is the view the snapshot reads: each coin's state now, worked out
from `fct_candle_1h` (first day with candles, last day with trades).

## Gold: `market.gold.coin_daily`

One row per coin per UTC day ([model](../dbt/models/gold/coin_daily.sql)); clustered by `trade_date`,
`symbol`. Returns and changes are fractions (0.05 = +5%). Key (`symbol`, `trade_date`).

| Column | Meaning |
|---|---|
| `symbol`, `trade_date` | Coin and UTC day |
| `open`, `high`, `low`, `close` | The day's prices (USDT); open, high and low come from the hours that traded, and a day without trades keeps its flat price (ADR-019) |
| `return_1d` | close / previous day's close − 1; empty on a coin's first day and after a gap |
| `range_1d` | (high − low) / open |
| `volume`, `quote_volume`, `trades` | Traded in the coin, in USDT, number of trades |
| `taker_buy_share` | Share of volume that was aggressive buying (0–1) |
| `realized_volatility_1d` | √(Σ squared 1-minute log returns), not annualised |
| `max_move_1m` | Biggest single 1-minute move, up or down |
| `open_interest_open_usdt`, `open_interest_close_usdt`, `open_interest_change_1d` | Open interest at the first and last snapshot, and the change; empty when Binance has no metrics for the coin |
| `avg_taker_buy_sell_ratio`, `avg_top_trader_position_ratio`, `avg_account_long_short_ratio` | Day averages of the 5-minute ratios |
| `minutes`, `zero_volume_minutes`, `metric_snapshots` | Completeness: 1,440 minutes and 288 snapshots when complete |
| `last_bronze_loaded_at` | Newest bronze load time behind the day |

**What the data looks like:** 872 coins a day (744 with open interest), of which about 130 are
delisted contracts with flat, zero-volume candles (`trades = 0`). On 2026-10-19, among the 740 coins
that traded: 431 up, 306 down, 3 unchanged; median realised volatility 3.96%.

## Gold: `market.gold.market_daily`

The whole market, one row per UTC day, rebuilt from `coin_daily` on every run
([model](../dbt/models/gold/market_daily.sql)). Key `trade_date`.

| Column | Meaning |
|---|---|
| `coins`, `coins_up`, `coins_down`, `coins_flat` | Coins that traded that day; how many closed above, below or at the previous close |
| `coins_inactive` | Coins with candles but no trades that day (delisted contracts), not counted anywhere else |
| `breadth` | coins_up / (coins_up + coins_down) |
| `coins_moved_20pct` | Coins that rose or fell 20% or more |
| `median_return_1d`, `volume_weighted_return_1d` | The middle coin's return; returns weighted by USDT volume |
| `median_realized_volatility_1d` | The middle coin's realised volatility |
| `quote_volume`, `btc_volume_share` | USDT traded across all coins; Bitcoin's share of it |
| `taker_buy_share` | Volume-weighted share of aggressive buying |
| `open_interest_usdt` | Total open interest at the day's last snapshot (coins with metrics) |
| `btc_return_1d`, `eth_return_1d` | Bitcoin's and Ethereum's returns |

## Gold: `market.gold.data_health`

Is each day's data complete? One row per UTC day, rebuilt from `coin_daily` on every run
([model](../dbt/models/gold/data_health.sql)). Key `trade_date`.

| Column | Meaning |
|---|---|
| `coins`, `coins_complete_candles`, `coins_incomplete_candles`, `missing_minutes` | Candle completeness (1,440 minutes per coin) |
| `coins_inactive` | Coins with candles but not a single trade |
| `coins_with_metrics`, `coins_complete_metrics`, `coins_incomplete_metrics`, `missing_metric_snapshots` | Metric completeness (288 snapshots per coin) |
| `coins_new`, `coins_dropped` | Coins with no row the day before; coins that traded the day before but not this day |
| `last_loaded_at` | Newest bronze load time behind the day |
| `candle_status` | `complete`, or `check` when a coin is missing minutes or dropped out |

## Gold: `market.gold.unusual_moves`

Coin-days that were unusual for that coin, rebuilt from `coin_daily` on every run
([model](../dbt/models/gold/unusual_moves.sql)). Baseline: the coin's previous 30 trading days, not
including the day itself; at least 20 days of history needed. Key (`symbol`, `trade_date`).

| Column | Meaning |
|---|---|
| `return_1d`, `return_z` | The day's return, and how many standard deviations it was from the coin's 30-day average |
| `quote_volume`, `volume_z` | USDT traded, and its z-score on a log scale |
| `realized_volatility_1d`, `volatility_z` | The day's realised volatility and its z-score |
| `taker_buy_share` | Share of aggressive buying |
| `history_days` | Days behind the scores (20 to 30) |
| `reasons` | Why it's unusual: `big rise` / `big fall` (|return z| ≥ 3), `volume surge` (volume z ≥ 3), `volatility spike` (volatility z ≥ 3) |

## Gold: `market.gold.hour_profile`

Each coin's hour-of-day pattern over its whole history, rebuilt from `fct_candle_1h` on every run
([model](../dbt/models/gold/hour_profile.sql)). Key (`symbol`, `utc_hour`).

| Column | Meaning |
|---|---|
| `utc_hour` | 0 to 23 (UTC) |
| `days`, `first_date`, `last_date` | History behind the row |
| `avg_return`, `sd_return` | Average and spread of the return within the hour (close / open − 1) |
| `t_stat_return` | avg_return ÷ (sd_return ÷ √days); roughly, under 2 either way could be chance |
| `avg_abs_return` | Average size of the hour's move |
| `avg_volume_share`, `avg_quote_volume` | Share of the day's volume in this hour; USDT traded in it |
| `avg_taker_buy_share` | Average share of aggressive buying |

## Gold: `market.gold.coin_baseline`

Each coin's "normal" as of its latest day, for MEDUSA's live scanner; one row per coin, rebuilt on
every run ([model](../dbt/models/gold/coin_baseline.sql)). The window is the coin's last 30 days with
trades, up to and including `as_of_date`. Key `symbol`.

Today's move = live price / `last_close` − 1. Today's z-score = (today's move − `avg_return_30d`) /
`sd_return_30d`, unusual at 3 or more, as in `unusual_moves`.

| Column | Meaning |
|---|---|
| `symbol`, `base_asset`, `multiplier`, `status` | The coin, from `dim_coin`'s current version |
| `as_of_date` | The coin's latest day with trades |
| `last_close` | Close on `as_of_date`: today's reference price |
| `history_days` | Daily returns behind the averages (0 to 30); the scanner scores a coin from 20 |
| `avg_return_30d`, `sd_return_30d`, `avg_abs_return_30d` | Average, spread and average size of the daily return |
| `avg_range_30d` | Average (high − low) / open |
| `avg_volatility_30d`, `sd_volatility_30d` | Average and spread of daily realised volatility |
| `avg_quote_volume_30d`, `avg_log_volume_30d`, `sd_log_volume_30d` | USDT traded per day, and the average and spread of its logarithm |
| `avg_abs_hour_return_30d` | Typical size of a one-hour move on the same days, to compare with a round trip's fees |

**What the data looks like (2026-10-19):** 744 coins (740 trading); 731 with at least 20 days of
history. Bitcoin: daily spread 1.70%, typical hour move 0.23%. Median trading coin: typical hour move
0.66%; 5 trading coins move less than 0.1% an hour.

## Gold: `market.gold.intraday_events`

Every time a coin's move so far that day became unusual for it, from January 2020 on, delisted coins
included; at most one row per coin-day, the first hour that crossed the line
([model](../dbt/models/gold/intraday_events.sql)). Rebuilt on every run from `int_candle_1h_all`.

The rule is the live scanner's: move so far = hour's close / previous day's close − 1; z = (move so
far − `avg_return_30d`) / `sd_return_30d` over the coin's previous 30 days with trades (at least 20);
an event at |z| ≥ `event_z` (3).

| Column | Meaning |
|---|---|
| `symbol`, `event_date` | The coin and the UTC day (one row per pair) |
| `event_hour`, `hour_of_day` | Start of the first unusual hour, and its UTC hour (0–23) |
| `direction` | `up` or `down`: the sign of z |
| `z`, `z_band` | The z-score at `event_hour`, and its size: `3-4`, `4-6` or `6+` |
| `liquidity` | From `avg_quote_volume_30d`: `large` (≥ 100 million USDT a day), `mid` (≥ 10 million), `small` |
| `move_so_far`, `prev_close`, `entry_price` | The move, the previous day's close, and `event_hour`'s close |
| `history_days`, `avg_return_30d`, `sd_return_30d`, `avg_quote_volume_30d` | The coin's normal before the day |
| `fwd_return_1h`, `fwd_return_4h`, `fwd_return_24h` | Close 1, 4 or 24 hours later / `entry_price` − 1; empty if that hour doesn't exist |
| `period` | `in_sample` before `held_back_from` (2025-01-01), `held_back` from then on |

**What the data looks like (2026-10-22):** 21,110 events (13,488 up, 7,622 down) on 866 coins,
2020-02-07 to 2026-10-20; 9,618 in-sample, 11,492 held back. They crowd onto crash days: in 2021,
552 down events fell on 25 days.

## Gold: `market.gold.event_evidence`

What moves like today's did next ([model](../dbt/models/gold/event_evidence.sql)). One row per
`direction`, `z_band`, `liquidity` and `horizon_hours` (1, 4 or 24), plus a row per direction and
horizon with `z_band` and `liquidity` set to `all`: 60 rows. Rebuilt on every run.

Continuation is the forward return in the direction of the move (negative: it turned back). Averages,
spreads and t-statistics are over days, not events: each day's events are averaged first
([ADR-022](decisions.md#adr-022-judge-the-evidence-by-days-and-on-held-back-years)).

| Column | Meaning |
|---|---|
| `direction`, `z_band`, `liquidity`, `horizon_hours` | The kind of move and the horizon (the key) |
| `events`, `days` | Events with a return at this horizon, and the days they fell on, all years |
| `avg_continuation`, `median_continuation`, `hit_rate` | Day-weighted average, median over events, share that kept going |
| `in_sample_events`, `in_sample_days`, `in_sample_avg_continuation`, `in_sample_t`, `in_sample_hit_rate` | The same for 2020–2024 |
| `held_back_events`, `held_back_days`, `held_back_avg_continuation`, `held_back_t`, `held_back_hit_rate` | The same for 2025 on |
| `side` | `follow` or `fade`: the sign of the in-sample average |
| `in_sample_net_after_cost`, `held_back_net_after_cost` | The chosen side's average return minus `round_trip_cost` |
| `verdict` | `too few`, `no pattern`, `did not hold` or `held up` |
| `round_trip_cost` | The cost used (0.001 = 0.10%) |

**What the data looks like (2026-10-22):** 35 *no pattern*, 15 *too few*, 6 *did not hold*, 4 *held
up*, all fades: down 4–6σ on mid-sized coins over 1 hour (held back: +4.11% after cost), up 6σ+ on
mid-sized coins over 24 hours (+12.20%), and every up move over 1 hour (+0.23%) and 4 hours (+0.66%).

## Serving: MEDUSA's copy (Cloudflare D1)

After every transform, the publish job ([step 24](steps/24-publish-job.md)) copies two gold tables
into MEDUSA's database through `POST /api/market/ingest`
([ADR-024](decisions.md#adr-024-a-write-only-endpoint-for-the-serving-copy)). Each table is replaced as
a whole in one transaction. They are shared by every account and have no `user_id`
([`migrations/003_market.sql`](../../migrations/003_market.sql)).

| D1 table | Key | From | Columns |
|---|---|---|---|
| `market_baseline` | `symbol` | `gold.coin_baseline` | `symbol`, `base_asset`, `status`, `as_of_date`, `last_close`, `history_days`, `avg_return_30d`, `sd_return_30d`, `avg_abs_return_30d`, `avg_quote_volume_30d`, `avg_log_volume_30d`, `sd_log_volume_30d`, `avg_abs_hour_return_30d` |
| `market_evidence` | `direction`, `z_band`, `liquidity`, `horizon_hours` | `gold.event_evidence` | The key, `events`, `days`, `avg_continuation`, `median_continuation`, `hit_rate`, `in_sample_days`, `in_sample_avg_continuation`, `in_sample_t`, `held_back_days`, `held_back_avg_continuation`, `held_back_t`, `held_back_hit_rate`, `side`, `held_back_net_after_cost`, `verdict`, `round_trip_cost` |
| `market_publish` | `tbl` | Written by the endpoint | `tbl`, `as_of` (the lakehouse day), `rows`, `published_at` (ms) |

Types follow SQLite: text, `REAL` for numbers, `INTEGER` for counts; dates are `YYYY-MM-DD` text.

**What the data looks like (2026-10-22 23:46 UTC):** `market_baseline` 748 rows and `market_evidence`
60 rows, lakehouse day 2026-10-21, matching gold exactly.

### The scanner's answer, ready-made (Workers KV)

After replacing a table, the ingest saves the read endpoint's whole answer in Workers KV, key
`market/scanner.json` in the Lab's namespace
([ADR-026](decisions.md#adr-026-the-scanners-answer-is-kept-ready-made-in-workers-kv)). It is what
`GET /api/market/scanner` returns (about 160 KB):

| Part | Holds |
|---|---|
| `published` | One entry per table: `as_of`, `rows`, `published_at`, as in `market_publish` |
| `market_baseline`, `market_evidence` | `columns` (the D1 columns, in order) and `rows` (one list of values per row, in key order) |

## On the Markets page (browser only)

The page keeps a SQLite database in the browser tab and calculates every number on it with SQL
([ADR-028](decisions.md#adr-028-every-number-is-a-sql-query-run-in-the-browser);
[step 26](steps/26-numbers-built-by-sql.md)). It holds `market_baseline` and `market_evidence`, loaded
from the answer above with D1's schema, and two tables that exist only there. Nothing in it is stored
anywhere: closing the tab deletes it.

| Table | Key | Filled by | Columns |
|---|---|---|---|
| `live_prices` | `symbol` | Binance's live stream, upserted about once a second (and one price snapshot when the page opens) | `symbol`, `price` (last price), `quote_volume_24h` (USDT traded in the last 24 hours; empty until the market's first stream message) |
| `binance_markets` | `symbol` | Binance's contract list (once a day) and Binance's daily candles | `symbol`, `market_type` (`crypto`, `stock`, `commodity` or `other`), `yesterday_close` (only while the lakehouse doesn't have yesterday) |

The shared steps (models) every Today number reads, defined in `public/markets-metrics.js`:

| Model | Grain | Columns |
|---|---|---|
| `market_now` | One trading market | `symbol`, `market_type`, `price`, `quote_volume_24h`, `prev_close` (the lakehouse's close, or Binance's while the lakehouse is behind), `avg_return_30d`, `sd_return_30d`, `history_days`, `avg_quote_volume_30d` |
| `today` | One trading market | `symbol`, `market_type`, `price`, `move` (fraction), `z`, `sd_return_30d`, `volume_x` (24 hours ÷ a usual day), `liquidity` |
| `flagged` | One unusual market (\|z\| ≥ 3) | Every column of `today`, plus `direction` and `z_band` |
| `verdicts` | One kind of move (`direction`, `z_band`, `liquidity`) | `next_1h`, `next_4h`, `next_24h`: `fade 0.22%` (the side and its held-back result) when the pattern held up, otherwise the verdict |
