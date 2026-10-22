# Step 22: Evidence: what moves like today's did next

[← Lakehouse home](../../README.md) · [← Step 21](21-silver-hourly-history.md)

| | |
|---|---|
| **Built** | 2026-10-22 |
| **Commit** | `66165dc` Lakehouse: gold intraday_events and event_evidence (what unusual moves did next, judged on held-back years) |
| **Files** | [`dbt/models/gold/intraday_events.sql`](../../dbt/models/gold/intraday_events.sql) · [`dbt/models/gold/event_evidence.sql`](../../dbt/models/gold/event_evidence.sql) · [`dbt/models/gold/_gold.yml`](../../dbt/models/gold/_gold.yml) · [`dbt/dbt_project.yml`](../../dbt/dbt_project.yml) (vars) · [`dbt/tests/assert_intraday_events_valid.sql`](../../dbt/tests/assert_intraday_events_valid.sql) · [`dbt/tests/assert_event_evidence_reconciles.sql`](../../dbt/tests/assert_event_evidence_reconciles.sql) |
| **Decisions** | [ADR-022](../decisions.md#adr-022-judge-the-evidence-by-days-and-on-held-back-years) |

## Goal

When the live scanner flags "this coin is up 3.4 times its usual daily move", it should also say
what moves like that did next, from six years of history: did they keep going or turn back, over
the next 1, 4 and 24 hours, and does that survive trading costs?

## Concepts

| Concept | Here |
|---|---|
| **Event study** | Find every moment something specific happened (an unusual move) and measure what followed it. |
| **Same rule live and in history** | An event uses exactly the scanner's rule: move so far = hour's close / previous day's close − 1, z = (move − average daily return) / spread of daily returns over the coin's previous 30 days with trades (as in `coin_baseline`). The evidence describes exactly the moves the scanner will flag. |
| **No look-ahead** | Each day's "normal" uses only the 30 days before it. The entry price is the close of the hour the move crossed the line, a little later than the scanner can see it. |
| **Survivorship-free** | Events come from the continuous hourly series since 2020 (step 21), which keeps coins that were later delisted. |
| **Continuation** | The forward return in the direction of the move: positive means it kept going, negative means it turned back. |
| **Days, not events** | Coins move together: one crash day gave hundreds of down events. They are not hundreds of independent proofs. Each day's events are averaged first, and the average, spread and t-statistic are taken over days (statistics "clustered by day"). |
| **Held-back test** | The side (follow the move or fade it) is chosen on 2020–2024 only. 2025–2026 played no part in choosing it and is used only to check it. |
| **Multiple testing** | Testing 60 rows means a few will look good by luck. Asking for t ≥ 2 in-sample *and* in the held-back years, on the same side, makes a lucky pass much rarer. |
| **Parameters in one place** | The 3σ line, the 0.10% round-trip cost, the split date and the thresholds are dbt `vars` in `dbt_project.yml`. |

## Code walkthrough

`intraday_events` builds days from the hourly series, the coin's normal before each day, then the
first hour each day the move crossed the line:

```sql
baseline as (                              -- the coin's previous 30 days with trades
    select symbol, trade_date, prev_close,
        count(return_1d) over w as history_days,
        avg(return_1d)   over w as avg_return_30d,
        stddev(return_1d) over w as sd_return_30d,
        avg(quote_volume) over w as avg_quote_volume_30d
    from daily
    where trades > 0
    window w as (partition by symbol order by trade_date rows between 30 preceding and 1 preceding)
),
...
events as (
    select * from scored
    where abs(z) >= {{ var('event_z') }}
    qualify row_number() over (partition by symbol, candle_date order by hour_start) = 1
)
```

The forward returns join the same hourly series 1, 4 and 24 hours later; a missing hour (the coin
stopped trading) leaves the return empty.

`event_evidence` turns the events into continuation, averages each day first, and judges each
kind of move:

```sql
per_day as (                               -- one row per kind of move, period, horizon and day
    select direction, z_band, liquidity, period, horizon_hours, event_date,
           avg(continuation) as day_continuation, count(*) as events, count_if(continuation > 0) as wins
    from with_all_years group by all
),
stats as (                                 -- averages and t-statistics over days
    select ..., sum(events) as events, count(*) as days,
           avg(day_continuation) / nullif(stddev(day_continuation) / sqrt(count(*)), 0) as t_stat
    from per_day group by all
)
```

The verdict: *too few* (under 20 days in either period), *no pattern* (in-sample |t| under 2),
*held up* (the in-sample side has t ≥ 2 in the held-back years and beats the 0.10% cost in both
periods), otherwise *did not hold*.

## How to run

```
cd lakehouse/dbt
../.venv/Scripts/dbt build --select intraday_events+
```

The daily `dbt build` rebuilds both tables from then on.

## Result

**PASS=27 WARN=0 ERROR=0** (2 models, 25 tests) in 1 minute 31 seconds; `intraday_events` took
16 s, `event_evidence` 23 s. The project now has 14 models and 111 tests.

| `intraday_events` | |
|---|---|
| Events | 21,110 (13,488 up, 7,622 down) |
| Coins | 866 |
| Days | 2020-02-07 to 2026-10-20 |
| In-sample / held-back | 9,618 / 11,492 |
| With a 24-hour return | 21,077 |

Events crowd onto crash days: in 2021, 552 down events fell on just 25 days.

`event_evidence` has 60 rows: 35 *no pattern*, 15 *too few*, 6 *did not hold*, 4 *held up*. Every
row that held up fades the move:

| Move | Horizon | In-sample (days, average, t) | Held back (days, average, t) | Held back, after cost |
|---|---|---|---|---|
| Down 4–6σ, mid-sized coins | 1 h | 48 days, −2.03%, −3.2 | 39 days, −4.21%, −2.5 | +4.11% (it bounced) |
| Up 6σ or more, mid-sized coins | 24 h | 84 days, −5.36%, −2.6 | 57 days, −12.30%, −4.1 | +12.20% (it fell back) |
| Every up move | 1 h | 1,143 days, −0.27%, −3.2 | 636 days, −0.33%, −2.3 | +0.23% |
| Every up move | 4 h | 1,142 days, −0.48%, −3.5 | 636 days, −0.76%, −3.9 | +0.66% |

Down moves taken together show no pattern at any horizon.

**Limits:** 0.10% is a cheap round trip for small and mid-sized coins, funding payments aren't
counted, a fade means shorting, and with 60 rows tested one of the four could still be luck. The
scanner shows the evidence and its verdict; it is not a trading signal on its own.

## Problems we hit

None in the build. The evidence query was tried read-only on the real data first; that showed how
strongly events cluster on crash days, which is why the statistics count days, not events.
