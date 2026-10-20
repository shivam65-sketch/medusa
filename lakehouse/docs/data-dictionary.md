# Data dictionary

[← Lakehouse home](../README.md)

Every dataset and table, with what the data really looks like. Numbers come from the loads of
2026-10-18 and 2026-10-19.

## Source: Binance's public archive

Base address: `https://data.binance.vision/data/futures/um/daily/`

| Dataset | File path under the base address | Rows per coin per day |
|---|---|---|
| 1-minute candles | `klines/{SYMBOL}/1m/{SYMBOL}-1m-{YYYY-MM-DD}.zip` | 1,440 |
| Market metrics | `metrics/{SYMBOL}/{SYMBOL}-metrics-{YYYY-MM-DD}.zip` | 288 (one per 5 minutes) |

Every file has a `.CHECKSUM` file next to it, containing its SHA-256 fingerprint. The list of coins
comes from the archive's folder listing
(`https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=data/futures/um/daily/klines/`),
which returns up to 1,000 entries per page. Only USDT perpetuals are kept: names matching
`^[A-Z0-9]+USDT$`, which excludes USDC and BUSD pairs and dated futures such as `BTCUSDT_250926`.

## Landing: `market.landing.binance` (volume)

```
/Volumes/market/landing/binance/
├─ klines_1m/date=2026-10-19/BTCUSDT-1m-2026-10-19.csv.gz
└─ metrics/date=2026-10-19/BTCUSDT-metrics-2026-10-19.csv.gz
```

The files are Binance's CSVs, unchanged apart from being unzipped and gzipped. Each has a header row.

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
- 744 coins per day, fewer than the 872 with candles.
- A full day should have 288 rows per coin, but many coins have fewer: on 2026-10-19, 135 of the
  744 files were incomplete, some with a single row. The day had 208,453 rows instead of 214,272.
- Rows inside a file are **not in time order**. Never rely on file order; silver sorts and checks.

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
| `status` | STRING | `trading`, or `not trading` after 3 days without candles |
| `dbt_scd_id` | STRING | dbt's unique id for the version |
| `dbt_valid_from` | TIMESTAMP | When this version became true |
| `dbt_valid_to` | TIMESTAMP | When it stopped being true; 9999-12-31 for the current version |
| `dbt_updated_at` | TIMESTAMP | When dbt recorded the version |

Coins as of 2026-10-20: 872, all `trading`; 857 with multiplier 1, 12 with 1,000, 3 with 1,000,000.

Which coins were trading at a given time:

```sql
SELECT symbol FROM market.silver.dim_coin
WHERE status = 'trading'
  AND TIMESTAMP '2026-10-20 18:00:00' BETWEEN dbt_valid_from AND dbt_valid_to;
```

`market.silver.int_coin_status` is the view the snapshot reads: each coin's state now, worked out
from `fct_candle_1m`.

## Gold

Planned (dbt). The planned tables are listed in [Architecture](architecture.md#data-flow).
