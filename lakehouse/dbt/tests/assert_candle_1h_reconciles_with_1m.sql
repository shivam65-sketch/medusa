-- Reconciliation: the hourly table must add up to the 1-minute table, day by day: the same
-- minutes, trades, volume and quote volume. Any row returned is a day that doesn't add up.
-- Volumes are DOUBLEs added in a different order, so they're compared with a tiny tolerance.

with minute_totals as (
    select candle_date,
           count(*)          as minutes,
           sum(trades)       as trades,
           sum(volume)       as volume,
           sum(quote_volume) as quote_volume
    from {{ ref('fct_candle_1m') }}
    group by candle_date
),

hour_totals as (
    select candle_date,
           sum(minutes)      as minutes,
           sum(trades)       as trades,
           sum(volume)       as volume,
           sum(quote_volume) as quote_volume
    from {{ ref('fct_candle_1h') }}
    group by candle_date
)

select
    coalesce(m.candle_date, h.candle_date) as candle_date,
    m.minutes as minute_rows,  h.minutes as hour_minutes,
    m.trades  as minute_trades, h.trades as hour_trades,
    m.volume  as minute_volume, h.volume as hour_volume
from minute_totals m
full outer join hour_totals h on h.candle_date = m.candle_date
where m.candle_date is null
   or h.candle_date is null
   or m.minutes <> h.minutes
   or m.trades <> h.trades
   or abs(m.volume - h.volume) > 1e-9 * greatest(abs(m.volume), 1)
   or abs(m.quote_volume - h.quote_volume) > 1e-9 * greatest(abs(m.quote_volume), 1)
