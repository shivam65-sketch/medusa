{{ config(materialized = 'table') }}

-- Gold: every time a coin's move so far that day became unusual for it, from January 2020 on,
-- and what the price did over the next 1, 4 and 24 hours. One row per coin-day at most: the
-- first hour of the day the move crossed the line. This is the history behind the live
-- scanner's evidence (event_evidence).
--
-- The rule is the same one the live scanner applies to today, so the evidence describes exactly
-- the moves it flags:
--   move so far = close of the hour / previous day's close - 1
--   z           = (move so far - avg_return_30d) / sd_return_30d
-- with the average and spread of the coin's daily returns over its previous 30 days with trades
-- (as in coin_baseline), at least 20 of them. An event is the first hour with |z| >= event_z.
--
-- The entry price is that hour's close: the live scanner can see the move before the hour ends,
-- so this is a slightly late (and so cautious) entry. Forward returns are raw price changes;
-- event_evidence turns them into continuation and applies the cost.
--
-- Reads the continuous hourly series (int_candle_1h_all), so delisted coins are included and the
-- evidence has no survivorship bias. Rebuilt on every run (about 16 million hours, under a minute).

with hours as (
    select symbol, hour_start, candle_date, close, quote_volume, trades
    from {{ ref('int_candle_1h_all') }}
),

-- Each coin's days, built from its hours the same way coin_daily is: the close is the last hour's.
days as (
    select
        symbol,
        candle_date                     as trade_date,
        max_by(close, hour_start)       as close,
        sum(quote_volume)               as quote_volume,
        sum(trades)                     as trades
    from hours
    group by symbol, candle_date
),

-- Previous close and daily return only when the previous row is the day before, as in coin_daily.
daily as (
    select
        *,
        case when lag(trade_date) over w = date_sub(trade_date, 1) then lag(close) over w end as prev_close,
        case when lag(trade_date) over w = date_sub(trade_date, 1) then close / lag(close) over w - 1 end as return_1d
    from days
    window w as (partition by symbol order by trade_date)
),

-- The coin's normal before each day: its previous 30 days with trades, not counting the day itself.
-- Days without trades (delisted contracts' flat candles) are left out, as in coin_baseline.
baseline as (
    select
        symbol,
        trade_date,
        prev_close,
        count(return_1d)     over w as history_days,
        avg(return_1d)       over w as avg_return_30d,
        stddev(return_1d)    over w as sd_return_30d,
        avg(quote_volume)    over w as avg_quote_volume_30d
    from daily
    where trades > 0
    window w as (partition by symbol order by trade_date rows between 30 preceding and 1 preceding)
),

scored as (
    select
        h.symbol,
        h.candle_date,
        h.hour_start,
        h.close,
        b.prev_close,
        b.history_days,
        b.avg_return_30d,
        b.sd_return_30d,
        b.avg_quote_volume_30d,
        h.close / b.prev_close - 1                                          as move_so_far,
        (h.close / b.prev_close - 1 - b.avg_return_30d) / b.sd_return_30d   as z
    from hours h
    join baseline b
      on b.symbol = h.symbol
     and b.trade_date = h.candle_date
    where b.history_days >= 20
      and b.sd_return_30d > 0
      and b.prev_close > 0
      and h.trades > 0
),

-- The first hour of each coin-day whose move crossed the line.
events as (
    select *
    from scored
    where abs(z) >= {{ var('event_z') }}
    qualify row_number() over (partition by symbol, candle_date order by hour_start) = 1
)

select
    e.symbol,
    e.candle_date                                       as event_date,
    e.hour_start                                        as event_hour,
    hour(e.hour_start)                                  as hour_of_day,
    case when e.z > 0 then 'up' else 'down' end         as direction,
    e.z,
    case when abs(e.z) < 4 then '3-4'
         when abs(e.z) < 6 then '4-6'
         else '6+' end                                  as z_band,
    -- Average daily traded value over the same 30 days, in USDT.
    case when e.avg_quote_volume_30d >= 100000000 then 'large'
         when e.avg_quote_volume_30d >= 10000000 then 'mid'
         else 'small' end                               as liquidity,
    e.move_so_far,
    e.prev_close,
    e.close                                             as entry_price,
    e.history_days,
    e.avg_return_30d,
    e.sd_return_30d,
    e.avg_quote_volume_30d,
    f1.close / e.close - 1                              as fwd_return_1h,
    f4.close / e.close - 1                              as fwd_return_4h,
    f24.close / e.close - 1                             as fwd_return_24h,
    case when e.candle_date < cast('{{ var("held_back_from") }}' as date)
         then 'in_sample' else 'held_back' end          as period
from events e
-- A missing hour (the coin stopped trading, or the data ends) leaves the forward return empty.
left join hours f1  on f1.symbol  = e.symbol and f1.hour_start  = e.hour_start + interval 1 hour
left join hours f4  on f4.symbol  = e.symbol and f4.hour_start  = e.hour_start + interval 4 hours
left join hours f24 on f24.symbol = e.symbol and f24.hour_start = e.hour_start + interval 24 hours
