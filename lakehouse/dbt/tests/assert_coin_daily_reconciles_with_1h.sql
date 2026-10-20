-- Reconciliation: gold's daily table must add up to silver's hourly table, day by day: the same
-- minutes, trades and volume. Any row returned is a day that doesn't add up.

with hour_totals as (
    select candle_date as trade_date,
           sum(minutes) as minutes,
           sum(trades)  as trades,
           sum(volume)  as volume
    from {{ ref('fct_candle_1h') }}
    group by candle_date
),

day_totals as (
    select trade_date,
           sum(minutes) as minutes,
           sum(trades)  as trades,
           sum(volume)  as volume
    from {{ ref('coin_daily') }}
    group by trade_date
)

select
    coalesce(h.trade_date, d.trade_date) as trade_date,
    h.minutes as hour_minutes, d.minutes as day_minutes,
    h.trades  as hour_trades,  d.trades  as day_trades,
    h.volume  as hour_volume,  d.volume  as day_volume
from hour_totals h
full outer join day_totals d on d.trade_date = h.trade_date
where h.trade_date is null
   or d.trade_date is null
   or h.minutes <> d.minutes
   or h.trades <> d.trades
   or abs(h.volume - d.volume) > 1e-9 * greatest(abs(h.volume), 1)
