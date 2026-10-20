# Step 10: Silver market metrics

[← Lakehouse home](../../README.md) · [← Step 9](09-silver-candles.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commits** | `5ece862` Lakehouse: step 9 docs; dbt usage statistics off and .user.yml kept out of Git · `c35af3d` Lakehouse: silver fct_metrics_5m (open interest and long/short ratios) with tests |
| **Files** | [`dbt/models/silver/fct_metrics_5m.sql`](../../dbt/models/silver/fct_metrics_5m.sql) · [`dbt/models/silver/_silver_metrics.yml`](../../dbt/models/silver/_silver_metrics.yml) · [`dbt/tests/assert_metrics_*.sql`](../../dbt/tests/) |

## Goal

The second silver table: one row per coin per 5 minutes with open interest and the long/short
ratios, renamed clearly, typed and tested, updated incrementally like the candles.

## Concepts

- **Test what is true of the data.** The data was profiled read-only before the tests were written.
  - Binance leaves ratio values empty fairly often, so the ratio columns get no `not_null` test; they're documented as nullable.
  - A taker buy/sell ratio of exactly 0 is legitimate (no aggressive buying in those 5 minutes), so the value test is *not negative*, not *positive*. A *positive* test would have flagged 9,313 valid rows.
- **Silver keeps what arrived.** Incomplete days aren't patched here; counting gaps per coin and day is gold's data-health job.
- **Clear names.** Binance's column names are replaced with ones that say what they hold:

| Bronze (Binance) | Silver |
|---|---|
| `create_time` (text) | `metric_time` (TIMESTAMP, UTC) and `metric_date` |
| `sum_open_interest` | `open_interest` |
| `sum_open_interest_value` | `open_interest_usdt` |
| `count_toptrader_long_short_ratio` | `top_trader_account_ratio` |
| `sum_toptrader_long_short_ratio` | `top_trader_position_ratio` |
| `count_long_short_ratio` | `account_long_short_ratio` |
| `sum_taker_long_short_vol_ratio` | `taker_buy_sell_ratio` |

## Code walkthrough

Same pattern as `fct_candle_1m`: an incremental MERGE on (`symbol`, `metric_time`), clustered by
`symbol`, `metric_date`, with `try_to_timestamp` for the time and `try_cast` for the values, and
de-duplication with `QUALIFY`.

Tests (8): `not_null` on `symbol`, `metric_time`, `metric_date`, `open_interest`, `open_interest_usdt`;
`assert_metrics_unique` (error), `assert_metrics_on_5_minute_grid` (warn),
`assert_metrics_not_negative` (warn).

## How to run

From `lakehouse/dbt/`: `../.venv/Scripts/dbt build --select fct_metrics_5m`

## Result

| Check | Result |
|---|---|
| Build | 1 model and 8 tests passed; model 20.9 s |
| Rows | 203,566 on 2026-10-18 and 208,453 on 2026-10-19; 744 coins each day |
| Complete coin-days | 1,204 of 1,488 have all 288 snapshots; 284 are short, the worst with 1 row |
| Ratios missing | Taker ratio 5,809 and 4,242 per day; top-trader ratios about 1,200 in total; account ratio 341 |
| Taker ratio exactly 0 | 9,313 rows |

**Also checked in this step:** the candles' incremental logic. The second run of `fct_candle_1m`
committed a MERGE with 0 source rows and 0 inserted, so re-running added nothing.

## Problems we hit

None in the build. The test design changed during profiling: the first draft tested that every
ratio was positive, which the data showed to be wrong.
