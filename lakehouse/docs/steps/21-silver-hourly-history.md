# Step 21: Silver hourly history, and the two hourly sources reconciled

[← Lakehouse home](../../README.md) · [← Step 20](20-hourly-history.md)

| | |
|---|---|
| **Built** | 2026-10-21 |
| **Commit** | `e69b1ff` Lakehouse: silver hourly history (archive table, continuous series); hourly open/high/low from traded minutes; the two hourly sources reconciled |
| **Files** | [`dbt/models/silver/fct_candle_1h_archive.sql`](../../dbt/models/silver/fct_candle_1h_archive.sql) · [`dbt/models/silver/int_candle_1h_all.sql`](../../dbt/models/silver/int_candle_1h_all.sql) · [`dbt/models/silver/_silver_candle_1h_archive.yml`](../../dbt/models/silver/_silver_candle_1h_archive.yml) · [`dbt/models/silver/fct_candle_1h.sql`](../../dbt/models/silver/fct_candle_1h.sql) · [`dbt/models/gold/coin_daily.sql`](../../dbt/models/gold/coin_daily.sql) · [`dbt/models/sources.yml`](../../dbt/models/sources.yml) · [`dbt/tests/assert_hourly_sources_agree.sql`](../../dbt/tests/assert_hourly_sources_agree.sql) · [`assert_candle_1h_archive_unique.sql`](../../dbt/tests/assert_candle_1h_archive_unique.sql) · [`assert_candle_1h_all_unique.sql`](../../dbt/tests/assert_candle_1h_all_unique.sql) |
| **Decisions** | [ADR-019](../decisions.md#adr-019-hourly-candles-follow-the-exchanges-definition) · [ADR-020](../decisions.md#adr-020-long-history-from-binances-monthly-hourly-files) |

## Goal

Type the archive's hourly candles, join them with the hours built from 1-minute candles into one
continuous series from January 2020, and prove that the two sources agree where they overlap.

## What the reconciliation found

Comparing the archive with our own hourly table on the overlap (2026-09-18 to 2026-09-30, 266,031
hours, 864 coins): every hour was in both, and close, volume and trades were identical. But:

| | Hours | Why |
|---|---|---|
| Open differed | 10,611 | Every one had no-trade minutes at the start. Binance fills a minute without trades with a flat candle at the previous price; our hour took that as its open (10,593 times exactly the previous hour's close). Binance's own hourly candle opens at the first real trade. |
| High or low differed | 2,232 | Ours was always wider, never narrower: the carried-over price sat outside the hour's traded range. |

Most were TradFi perpetuals (TENCENT, HK0700, TMF and others), which pause between sessions.
Built from traded minutes only, all 266,031 hours match exactly.

## Concepts

| Concept | Here |
|---|---|
| **Reconciliation finds definition bugs** | Neither source looked wrong on its own; comparing two independent sources at the same grain showed the difference. |
| **Align with the source of truth** | The exchange's own definition: open = first trade, high and low = traded prices. |
| **Full refresh after a logic change** | Incremental models only rebuild new days, so `fct_candle_1h` and `coin_daily` were rebuilt from scratch once. |
| **One series, two sources, no seam** | Archive hours before the first minute-built day, minute-built hours from then on; a test checks no hour appears twice. |
| **Freshness only where it applies** | The history source is a one-time load, so its freshness check is switched off (`freshness: null`); the daily sources keep theirs. |

## Code walkthrough

```sql
-- fct_candle_1h: open, high and low from the minutes that traded
coalesce(min_by(open, open_time) filter (where volume > 0), min_by(open, open_time)) as open,
coalesce(max(high) filter (where volume > 0), max(high))                           as high,
coalesce(min(low) filter (where volume > 0), min(low))                             as low,
```

`coin_daily` applies the same rule to the hours (`filter (where trades > 0)`).

```sql
-- int_candle_1h_all (view)
with cutoff as (select min(candle_date) as first_minute_day from {{ ref('fct_candle_1h') }})
select …, 'monthly_archive' as source from {{ ref('fct_candle_1h_archive') }} a
cross join cutoff c where a.candle_date < c.first_minute_day
union all
select …, 'minute_candles' as source from {{ ref('fct_candle_1h') }} m
```

`assert_hourly_sources_agree` joins the two sources on (symbol, hour) over the days both cover and
fails on any hour missing from either side, or any price, volume or trade count that differs
(prices to one part in a billion).

## How to run

From `lakehouse/dbt/`:

```
../.venv/Scripts/dbt build --full-refresh --select fct_candle_1h+ fct_candle_1h_archive+ --exclude dim_coin
```

`dim_coin` is left out on purpose: a full refresh must never touch the coin history.

## Result

`PASS=69 WARN=0 ERROR=0` (10 models, 59 tests) in 1 minute 47 seconds; the reconciliation passed.

| `int_candle_1h_all` | Hours | Coins | From | To |
|---|---|---|---|---|
| `monthly_archive` | 15,621,354 | 873 | 2020-01-01 00:00 | 2026-09-17 23:00 |
| `minute_candles` | 683,264 | 873 | 2026-09-18 00:00 | 2026-10-20 23:00 |

`fct_candle_1h_archive` holds 15,887,385 hours (895 coins), exactly the 20,245 header lines fewer
than bronze. The project now has 12 models and 86 tests.

## Problems we hit

The open/high/low definition difference above, found by the reconciliation before the evidence
tables were built on top of it.
