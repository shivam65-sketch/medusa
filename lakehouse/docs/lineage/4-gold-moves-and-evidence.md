# 4. Gold: moves and evidence

[← 3. Gold: days and coins](3-gold-days-and-coins.md) · [Lineage and transformations](README.md) · Next: [5. Definitions, logs and MEDUSA's copy →](5-definitions-logs-and-serving.md)

The history line: every hour since January 2020, delisted coins included, so the evidence isn't flattered
by looking only at the coins that survived. All four tables read `silver.int_candle_1h_all`, directly or
through `intraday_events`, and are rebuilt in full on every run (about 16 million hours, under a minute).

```
int_candle_1h_all ──→ intraday_events ──→ event_evidence    (does a kind of move have an edge?)
        │                    └──────────→ move_outcomes     (how did such moves turn out?)
        └───────────→ hour_drift                            (does the market lean in an hour?)
dim_market_type joins intraday_events and hour_drift
```

Two settings split the history in two (from [`dbt_project.yml`](../../dbt/dbt_project.yml)):

```sql
case when day < cast('{{ var("held_back_from") }}' as date)   -- 2025-01-01
     then 'in_sample' else 'held_back' end as period
```

**In-sample** (2020 to 2024) is where a side is chosen. **Held back** (2025 on) played no part in choosing it
and is where the choice is checked.

## `market.gold.intraday_events`

**One row per** coin and day at most: the first hour of the day in which the coin's move so far became
unusual for it. **Built from** `int_candle_1h_all` and `dim_market_type`. **Which rows:** the first hour of a
coin-day with \|z\| ≥ 3 (`event_z`), when the coin has at least 20 days of history.

The rule is the one the live scanner applies to today, so the evidence describes exactly the moves it flags.
It is built in five steps:

| Step | What it makes | How |
|---|---|---|
| 1. `days` | Each coin's days, from its hours | `close = max_by(close, hour_start)`, `quote_volume = sum(…)`, `trades = sum(…)`: as `coin_daily`, but from the long series |
| 2. `daily` | The previous close and the daily return | `lag(close)` and `close / lag(close) - 1`, only when the previous row is the day before |
| 3. `baseline` | The coin's normal before each day | Over its previous 30 days **with trades**, not counting the day itself (`rows between 30 preceding and 1 preceding`, `where trades > 0`): `count(return_1d)`, `avg(return_1d)`, `stddev(return_1d)`, `avg(quote_volume)` |
| 4. `scored` | Every traded hour of a day, scored | `move_so_far = close / prev_close - 1`; `z = (move_so_far - avg_return_30d) / sd_return_30d`; only with 20 or more days of history, a spread above 0 and a previous close above 0 |
| 5. `events` | The first hour over the line | `where abs(z) >= 3`, then `qualify row_number() over (partition by symbol, candle_date order by hour_start) = 1` |

| Column | From | How |
|---|---|---|
| `symbol` | `symbol` | Unchanged |
| `event_date` | `candle_date` | The day of the event |
| `event_hour` | `hour_start` | The first hour that crossed the line |
| `hour_of_day` | `event_hour` | `hour(…)`, 0 to 23 UTC |
| `direction` | `z` | `'up'` when z > 0, else `'down'` |
| `z` | Step 4 | Unchanged |
| `z_band` | `z` | \|z\| below 4 → `'3-4'`, below 6 → `'4-6'`, else `'6+'` |
| `liquidity` | `avg_quote_volume_30d` | ≥ 100,000,000 USDT a day → `'large'`, ≥ 10,000,000 → `'mid'`, else `'small'` |
| `move_so_far` | Step 4 | Unchanged |
| `prev_close` | Step 2 | The day before's close |
| `entry_price` | `close` | The event hour's close. The scanner sees a move before its hour ends, so this is a slightly late, cautious entry |
| `history_days`, `avg_return_30d`, `sd_return_30d`, `avg_quote_volume_30d` | Step 3 | Unchanged |
| `fwd_return_1h` | `int_candle_1h_all.close` | The close of the hour that starts 1 hour after `event_hour`, ÷ `entry_price` − 1: the price change in the hour after entry |
| `fwd_return_4h`, `fwd_return_24h` | The same | The same, 4 and 24 hours on. Empty when that hour doesn't exist (the coin stopped trading, or the data ends) |
| `period` | `event_date` | `in_sample` before 2025-01-01, else `held_back` |
| `market_type` | `dim_market_type` | `market_type_on(m, event_date)` ([page 2](2-silver.md#marketsilverdim_market_type-seed)): `unknown` when not listed, `crypto` for a stock or commodity ticker before its listing day, else the listed type |

**Checked by:** `assert_intraday_events_valid` (at most one event per coin-day, \|z\| at or above the line,
direction and band agreeing with z, 20 or more days of history, the hour on the event's day, a positive
entry price, and the right period for the date).

## `market.gold.event_evidence`

**One row per** kind of move (`direction`, `z_band`, `liquidity`) and horizon (1, 4 or 24 hours), plus an
`'all'` kind per direction and horizon. **Built from** `intraday_events`. **Which rows:** only moves on
`crypto` and `other` markets. Stock and commodity perpetuals began in December 2025, so they have no
in-sample years to choose a side on; they are left out rather than mixed in with crypto's.

**Continuation** is a move's forward return turned to its own direction: positive means it kept going,
negative means it turned back.

```sql
case when direction = 'up' then 1 else -1 end
  * case horizon_hours when 1 then fwd_return_1h when 4 then fwd_return_4h else fwd_return_24h end
```

Each move is repeated once per horizon (`cross join (values (1), (4), (24))`), and counted four times: in its
own kind and in its direction's `'all'` kind, each in its own period and in period `'all'`.

**Days, not moves, are the unit.** Coins move together: one crash day can hold hundreds of moves, and they
are not hundreds of separate proofs. So each day's moves are averaged first, and the statistics are taken
over days:

```sql
per_day = avg(continuation) as day_continuation, count(*) as events, count_if(continuation > 0) as wins
          group by direction, z_band, liquidity, period, horizon_hours, event_date
stats   = sum(events), count(*) as days, sum(wins) / sum(events) as hit_rate,
          avg(day_continuation) as avg_continuation,
          avg(day_continuation) / (stddev(day_continuation) / sqrt(count(*))) as t_stat
```

Each kind's `'all'`-period stats make the row; its `'in_sample'` and `'held_back'` stats are joined on beside
them.

| Column | From | How |
|---|---|---|
| `direction`, `z_band`, `liquidity`, `horizon_hours` | `intraday_events` | Keys; `z_band` and `liquidity` are `'all'` on the `'all'` kind |
| `events`, `days`, `avg_continuation`, `hit_rate` | `stats`, period `'all'` | As above. `hit_rate` counts moves, not days |
| `median_continuation` | `continuation` | `percentile(continuation, 0.5)` over every move, period `'all'` |
| `in_sample_events`, `in_sample_days`, `in_sample_avg_continuation`, `in_sample_t`, `in_sample_hit_rate` | `stats`, period `'in_sample'` | As above |
| `held_back_events`, `held_back_days`, `held_back_avg_continuation`, `held_back_t`, `held_back_hit_rate` | `stats`, period `'held_back'` | As above |
| `side` | `in_sample_avg_continuation` | `'follow'` when it is 0 or above, `'fade'` when below. Chosen on the in-sample years only |
| `in_sample_net_after_cost` | `side`, `in_sample_avg_continuation` | `side × in_sample_avg_continuation − 0.001` (+1 for follow, −1 for fade) |
| `held_back_net_after_cost` | `side`, `held_back_avg_continuation` | The same for the held-back years |
| `verdict` | The columns above | In this order: `'too few'` if either period has fewer than 30 days; `'no pattern'` if \|in_sample_t\| < 2; `'held up'` if `side × held_back_t ≥ 2` and both periods' averages, turned to the side, beat the 0.10% cost; else `'did not hold'` |
| `round_trip_cost` | The setting | 0.001 |

**Checked by:** `assert_event_evidence_reconciles` (each kind and horizon appears once; in-sample and held-back
moves make up all moves; no row has more days than moves).

## `market.gold.move_outcomes`

**One row per** type of market, kind of move (`direction`, `z_band`, `liquidity`), horizon and period
(`in_sample`, `held_back` or `all`). **Built from** `intraday_events`. **Which rows:** every type of market,
each on its own, so a stock's move is compared with stocks'.

`event_evidence` decides whether a kind of move has an edge; this table describes what happened, for the
playbook. So the unit is the **move**, not the day (how far one trade can go is a question about moves), and
it keeps the tails. Continuation is made the same way, each move counted in its own period and in `'all'`.
There is no `'all'` kind.

| Column | From | How |
|---|---|---|
| `market_type`, `direction`, `z_band`, `liquidity`, `horizon_hours`, `period` | `intraday_events` | Group keys (`group by all`) |
| `moves` | | `count(*)` |
| `days` | `event_date` | `count(distinct event_date)`: how many separate days stand behind the moves, because moves bunch on crash days |
| `median_continuation` | Continuation | `percentile(continuation, 0.5)` |
| `hit_rate` | Continuation | `count_if(continuation > 0) / count(*)` |
| `p05_continuation`, `p95_continuation` | Continuation | `percentile(…, 0.05)` and `percentile(…, 0.95)`: where the worst and best 5% of moves ended |

The percentiles are worked out here, not on the page: each sorts about 21,000 moves, 1.6 seconds in a
browser that runs its queries every second. **Checked by:** `assert_move_outcomes_valid`.

## `market.gold.hour_drift`

**One row per** year, period, UTC hour, liquidity group (or `'all'`) and type of market (or `'all'`). The rows
with both at `'all'` are the whole market. **Built from** `int_candle_1h_all` and `dim_market_type`.
**Which rows:** hours with a price above 0 and at least one trade, on coin-days with 20 or more days of
history.

The question is whether the whole market tends to rise or fall in a given hour. It is answered by days, in
four steps:

| Step | What it makes | How |
|---|---|---|
| 1. `hours` | Each coin's hour return | `least(greatest(close / open - 1, -0.1), 0.1)`: clipped to ±10%, so one listing spike can't decide an hour |
| 2. `liquidity` | Each coin's liquidity on each day | Its daily quote volume averaged over its previous 30 days with trades (at least 20), grouped as in `intraday_events`: large, mid or small |
| 3. `day_hours` | The market's move in each hour of each day | `avg(hour_return)` over the coins in the group, each coin counted once; `coins = count(*)`. `grouping sets` make four groupings at once: liquidity × type, liquidity alone, type alone, and every coin. A grouping that leaves a column out shows `'all'` in it |
| 4. The table | Statistics over those days | Grouped by `year(candle_date)`, period, hour, liquidity and type |

| Column | From `day_hours` | How |
|---|---|---|
| `year`, `period`, `utc_hour`, `liquidity`, `market_type` | | Group keys |
| `days` | | `count(*)`: day-hours behind the row |
| `first_date`, `last_date` | `candle_date` | `min(…)`, `max(…)` |
| `coin_hours` | `coins` | `sum(…)`: coin-hours behind the row |
| `sum_return`, `sum_sq_return` | `market_return` | `sum(market_return)` and `sum(market_return * market_return)` |
| `up_days` | `market_return` | `count_if(market_return > 0)` |
| `avg_return`, `sd_return` | `market_return` | `avg(…)`, `stddev(…)` |
| `t_stat` | The two above | `avg_return / (sd_return / sqrt(days))`. Beyond ±2 is unlikely to be chance for one test; with 24 hours tested, a few pass by luck |

**Why the sums are kept:** any group of rows can be combined exactly, so the Insights graphs can pool all the
years, or 2020–2024 against 2025 on, from a few hundred rows:

```
n        = Σ days
mean     = Σ sum_return / n
variance = (Σ sum_sq_return − n × mean²) / (n − 1)
t        = mean / (√variance / √n)
```

**Checked by:** `assert_hour_drift_valid` (one row per key, hours 0 to 23, at least one day behind each row,
no more up days than days, sums that can be pooled, and every group's days within `'all'`'s).
