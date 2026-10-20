# Step 16: Gold for unusual moves and hour-of-day patterns

[← Lakehouse home](../../README.md) · [← Step 15](15-backfill.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `c4aeb05` Lakehouse: gold unusual_moves (z-scores vs own 30 days) and hour_profile (hour-of-day with t-stats) |
| **Files** | [`dbt/models/gold/unusual_moves.sql`](../../dbt/models/gold/unusual_moves.sql) · [`dbt/models/gold/hour_profile.sql`](../../dbt/models/gold/hour_profile.sql) · [`dbt/models/gold/_gold.yml`](../../dbt/models/gold/_gold.yml) · [`dbt/tests/assert_unusual_moves_unique_and_explained.sql`](../../dbt/tests/assert_unusual_moves_unique_and_explained.sql) · [`dbt/tests/assert_hour_profile_valid.sql`](../../dbt/tests/assert_hour_profile_valid.sql) |

## Goal

Two analytical tables that compare each coin with its own history: which days were unusual for
that coin, and how it behaves at each hour of the day.

## Concepts

| Concept | Here |
|---|---|
| **z-score** | (today − the coin's average) ÷ the coin's standard deviation; puts coins of every size on one scale. A day is unusual at 3 or more, roughly 1 day in 370 for a normal bell curve. |
| **Window frame excluding today** | `rows between 30 preceding and 1 preceding`: the baseline is the 30 days before, so the move being scored doesn't hide itself. |
| **Log scale for volume** | Volumes are skewed; a doubling counts the same for a small and a large coin. |
| **Minimum history** | No score until a coin has 20 days of history. |
| **t-statistic** | average ÷ (standard deviation ÷ √days): is a pattern bigger than chance? Roughly, under 2 either way could be noise. |
| **`QUALIFY` in tests** | Filters on a window function, so one test checks uniqueness and the other rules together. |

## Code walkthrough

```sql
-- unusual_moves: the coin's previous 30 days, not including today
count(return_1d)            over w as history_days,
avg(return_1d)              over w as avg_return_30d,
stddev(return_1d)           over w as sd_return_30d,
avg(ln(quote_volume))       over w as avg_log_volume_30d,
…
window w as (partition by symbol order by trade_date rows between 30 preceding and 1 preceding)
…
(return_1d - avg_return_30d) / nullif(sd_return_30d, 0) as return_z
…
where abs(return_z) >= 3 or volume_z >= 3 or volatility_z >= 3
```

```sql
-- hour_profile
close / open - 1                                                         as hour_return,
quote_volume / nullif(sum(quote_volume) over (partition by symbol, candle_date), 0) as volume_share
…
avg(hour_return) / nullif(stddev(hour_return) / sqrt(count(*)), 0)        as t_stat_return
```

## How to run

From `lakehouse/dbt/`: `../.venv/Scripts/dbt build --select unusual_moves hour_profile`

## Result

2 models and 7 tests passed (about 6 seconds each).

`unusual_moves`: 349 coin-days flagged, scored from 2026-10-09 (the first day with 20 days of
history). The strongest:

| Coin | Day | Return | Return z | Volume z | Reasons |
|---|---|---|---|---|---|
| ZEREBROUSDT | 2026-10-14 | +71.2% | 26.1 | 9.2 | big rise, volume surge, volatility spike |
| SIRENUSDT | 2026-10-15 | +46.6% | 24.7 | 8.3 | big rise, volume surge, volatility spike |
| KAIAUSDT | 2026-10-09 | +61.2% | 17.1 | 9.5 | big rise, volume surge, volatility spike |
| 1000RATSUSDT | 2026-10-13 | −51.0% | −13.9 | 8.0 | big fall, volume surge, volatility spike |
| CTKUSDT | 2026-10-12 | −6.3% | −1.7 | 10.6 | volume surge, volatility spike |

CTKUSDT shows why z-scores matter: an ordinary price move on a volume 10 standard deviations above normal.

`hour_profile`: 20,952 rows (873 coins × 24 hours). For Bitcoin over 32 days, 13:00–15:00 UTC are
the busiest hours (7–8.5% of the day's volume each), and no hour has a t-statistic above 2 (the
highest, 22:00 UTC, is 1.82). Over this short window, no hour is distinguishable from noise.

## Problems we hit

None.
