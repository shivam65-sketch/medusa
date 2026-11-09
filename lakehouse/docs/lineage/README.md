# Lineage and transformations

[← Lakehouse home](../../README.md)

How every column of every table is made, and where it comes from. The
[data dictionary](../data-dictionary.md) says what a column **means**. These pages say how it is **made**:
which upstream columns it comes from, the SQL that turns them into it, and why it is done that way.
[How the data works](../../../docs/how-the-data-works.md) follows the whole journey table by table; this
goes one level down, column by column.

| Page | Tables |
|---|---|
| [1. From Binance to bronze](1-binance-to-bronze.md) | Binance's files, the landing volume, `bronze.klines_1m`, `bronze.metrics`, `bronze.klines_1h` |
| [2. Silver](2-silver.md) | `fct_candle_1m`, `fct_metrics_5m`, `fct_candle_1h`, `fct_candle_1h_archive`, `int_candle_1h_all`, `int_coin_status`, `dim_coin`, `dim_market_type` |
| [3. Gold: days and coins](3-gold-days-and-coins.md) | `coin_daily`, `market_daily`, `data_health`, `missing_days`, `unusual_moves`, `hour_profile`, `coin_baseline` |
| [4. Gold: moves and evidence](4-gold-moves-and-evidence.md) | `intraday_events`, `event_evidence`, `move_outcomes`, `hour_drift` |
| [5. Definitions, logs and MEDUSA's copy](5-definitions-logs-and-serving.md) | `semantic.metric_definitions`, `semantic.user_metric_definitions`, `ops.logs`, MEDUSA's D1 tables, the files in Workers KV, the Markets page's tables in the browser |

What each number on the Markets page shows and how it is worked out from these tables is in
[The Markets page, explained](../../../docs/markets-page/README.md).

## How to read each table

Every table starts with four facts, then one row per column:

| Fact | What it says |
|---|---|
| **One row per** | The grain: what a single row stands for |
| **Built from** | The tables or files it reads |
| **Which rows** | What is kept and what is left out |
| **How it is refreshed** | Incremental (only what changed is rebuilt and merged in) or rebuilt in full on every run |

In the column tables, **From** names the upstream column (`table.column`, or just the column when the
table is the one in **Built from**), and **How** is the transformation. *Unchanged* means the value is
copied as it is.

## Rules that hold on every page

- **Time is UTC.** A day is a UTC day, 00:00 to 23:59 UTC (05:30 to 05:29 the next morning in India).
- **Returns, changes and shares are fractions.** 0.05 means +5%, 0.5 means half.
- **Prices are in USDT.** `volume` is the amount traded in the coin itself; `quote_volume` is the same
  trades in USDT.
- **Bronze keeps text; silver makes types.** Every bronze column is the text from the file. Silver turns it
  into numbers and times with `try_cast`, which gives `NULL` for a value that isn't a number instead of
  stopping the run. A row is dropped only when its time can't be read.
- **One row per key, newest load wins.** When the same coin and minute arrive twice (Binance rewrote a file
  and the recheck loaded it again), silver keeps the row loaded last.
- **Empty, not zero, when a number can't be worked out.** Divisions use `nullif(x, 0)`, so a coin that
  didn't trade has an empty taker share, not an error and not a misleading 0.
- **Flat candles aren't trades.** Binance fills a minute without trades with a flat candle at the last
  price, and keeps publishing flat days for contracts it has delisted. So open, high and low come from the
  minutes and hours that traded, and "trading" always means `trades > 0`.
- **Two lines of history.** The recent line (1-minute candles from 18 September 2026) feeds the daily
  tables and the live page. The long line (Binance's hourly files from January 2020, delisted coins
  included) feeds the evidence and the hour patterns.

## The main paths, column by column

Each path reads top to bottom: a column, then what it becomes in the next table.

**The price, to today's z on the Markets page**

```
bronze.klines_1m.close                 text, as in Binance's file
 → silver.fct_candle_1m.close           try_cast(close as double)
 → silver.fct_candle_1h.close           the hour's last minute: max_by(close, open_time)
 → gold.coin_daily.close                the day's last hour: max_by(close, hour_start)
 → gold.coin_daily.return_1d            close / the day before's close − 1
 → gold.coin_baseline.avg_return_30d    average of return_1d over the coin's last 30 days with trades
   gold.coin_baseline.sd_return_30d     their standard deviation
 → MEDUSA market_baseline               the same columns, copied after every build
 → the page's z                         (live move − avg_return_30d) / sd_return_30d
```

**Volume, to a coin's liquidity group**

```
bronze.klines_1h.quote_volume          text, Binance's hourly file (2020 on)
 → silver.fct_candle_1h_archive.quote_volume   try_cast as double
 → silver.int_candle_1h_all.quote_volume       the archive before 18 Sep 2026, minute-built hours after
 → gold.intraday_events.avg_quote_volume_30d   a day's sum, averaged over the 30 days with trades before
 → gold.intraday_events.liquidity              large ≥ 100 million USDT, mid ≥ 10 million, else small
 → gold.event_evidence.liquidity               one of the keys the verdicts are grouped by
```

**Aggressive buying**

```
bronze.klines_1m.taker_buy_volume      text
 → silver.fct_candle_1m.taker_buy_volume       double
 → silver.fct_candle_1h.taker_buy_share        sum(taker_buy_volume) / sum(volume) in the hour
 → gold.coin_daily.taker_buy_share             the same over the day (from the hours' sums)
 → gold.market_daily.taker_buy_share           every coin's share, weighted by its quote volume
```

**Open interest**

```
bronze.metrics.sum_open_interest_value text, one value every 5 minutes
 → silver.fct_metrics_5m.open_interest_usdt    renamed, double
 → gold.coin_daily.open_interest_open_usdt     the day's first snapshot: min_by(…, metric_time)
   gold.coin_daily.open_interest_close_usdt    the day's last: max_by(…, metric_time)
 → gold.coin_daily.open_interest_change_1d     close / open − 1
 → gold.market_daily.open_interest_usdt        sum of every coin's close
```

**A past move, to its verdict**

```
silver.int_candle_1h_all.close         every hour since 2020
 → gold.intraday_events.z               (hour close / the day before's close − 1 − average) / spread
 → gold.intraday_events.fwd_return_4h   the close 4 hours after the event hour's close / that close − 1
 → gold.event_evidence.avg_continuation the 4-hour returns turned to the move's direction, averaged per day,
                                        then over days
 → gold.event_evidence.verdict          held up, did not hold, no pattern or too few
 → MEDUSA market_evidence → the page's "fade 0.22%" or the verdict in words
```

## Databricks SQL in SQL Server terms

The models are written in Databricks SQL. Most of it reads like T-SQL; these are the parts that don't.

| Here | What it does | In SQL Server |
|---|---|---|
| `try_cast(x as double)` | `NULL` when `x` isn't a number | `TRY_CAST(x AS float)` |
| `timestamp_millis(n)` | Milliseconds since 1970-01-01 to a timestamp | `DATEADD(ms, n % 86400000, DATEADD(day, n / 86400000, '1970-01-01'))` |
| `try_to_timestamp(s, 'yyyy-MM-dd HH:mm:ss')` | Text to a timestamp, `NULL` if it doesn't parse | `TRY_CONVERT(datetime2, s, 120)` |
| `to_date(t)` | The day of a timestamp | `CAST(t AS date)` |
| `date_trunc('HOUR', t)` | The start of the hour | `DATETRUNC(hour, t)` (2022) |
| `min_by(a, b)`, `max_by(a, b)` | The value of `a` on the row with the smallest or largest `b` | No single function: `FIRST_VALUE(a) OVER (ORDER BY b)`, or a `TOP 1` subquery |
| `max(x) filter (where c)` | An aggregate over only the rows that meet `c` | `MAX(CASE WHEN c THEN x END)` |
| `count_if(c)` | Rows that meet `c` | `SUM(CASE WHEN c THEN 1 ELSE 0 END)` |
| `qualify row_number() over (…) = 1` | Filter on a window function in the same query | Put the `ROW_NUMBER()` in a CTE, then `WHERE rn = 1` |
| `window w as (…)` then `avg(x) over w` | Name a window once and reuse it | Write the same `OVER (…)` each time |
| `rows between 30 preceding and 1 preceding` | The 30 rows before this one, not this one | The same frame |
| `percentile(x, 0.5)` | The exact median of a group | `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x)`, which is a window function there |
| `stddev(x)` | Sample standard deviation | `STDEV(x)` |
| `ln(x)`, `power(x, 2)`, `sqrt(x)` | Natural log, square, square root | `LOG(x)`, `POWER(x, 2)`, `SQRT(x)` |
| `least(greatest(x, -0.1), 0.1)` | Clip `x` to between −0.1 and 0.1 | `LEAST(GREATEST(x, -0.1), 0.1)` (2022) |
| `explode(sequence(a, b))` | One row per day from `a` to `b` | A calendar table, or `GENERATE_SERIES` over day numbers (2022) |
| `grouping sets (…)` | Several `GROUP BY`s in one pass | The same |
| `group by all` | Group by every column that isn't aggregated | List the columns |
| `cross join (values (1), (4), (24)) as h(horizon_hours)` | Repeat each row once per value | The same table value constructor |
| `regexp_extract(s, pattern, 1)` | The part of `s` a regular expression captures | No built-in regular expressions |
| `inline(from_json(:rows, '…'))` | JSON text to rows | `OPENJSON(@rows) WITH (…)` |
| `current_timestamp()` | Now (the lakehouse runs in UTC) | `SYSUTCDATETIME()` |
| A dbt `{{ ref('x') }}` | The table `x`, and a line in the lineage | A table name |
| A dbt `{{ var('event_z') }}` | A setting from `dbt_project.yml` | A variable |
| A dbt `{% if is_incremental() %}` | Only on a run that adds to a table that already exists | An `IF` in a stored procedure |

## The settings

Some rules are settings in [`dbt/dbt_project.yml`](../../dbt/dbt_project.yml), so they are named once and
used everywhere:

| Setting | Value | Used by |
|---|---|---|
| `event_z` | 3 | `intraday_events`: a move is unusual at \|z\| ≥ 3 |
| `round_trip_cost` | 0.001 (0.10%) | `event_evidence`: fees and slippage to enter and leave once |
| `held_back_from` | 2025-01-01 | `intraday_events`, `hour_drift`: the first day of the held-back period |
| `evidence_min_days` | 30 | `event_evidence`: fewer days in either period is *too few* |
| `evidence_min_t` | 2 | `event_evidence`: the t-statistic a pattern needs |

The tests that prove a table adds up to the one it came from are named under each table, as
**Checked by**. They live in [`dbt/tests/`](../../dbt/tests/) and run on every build; a row returned is a
failure.
