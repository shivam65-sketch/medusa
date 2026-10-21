-- Reconciliation between two sources at the same grain: Binance's monthly 1-hour files
-- (fct_candle_1h_archive) and the hours built from 1-minute candles (fct_candle_1h). On the days
-- both cover, every hour must be in both, with the same prices (to one part in a billion), volume
-- and number of trades. Any row returned disagrees.
with bounds as (
    select greatest(a.first_day, m.first_day) as first_day,
           least(a.last_day, m.last_day)       as last_day
    from (select min(candle_date) as first_day, max(candle_date) as last_day from {{ ref('fct_candle_1h_archive') }}) a
    cross join (select min(candle_date) as first_day, max(candle_date) as last_day from {{ ref('fct_candle_1h') }}) m
),

archive as (
    select x.*
    from {{ ref('fct_candle_1h_archive') }} x
    cross join bounds b
    where x.candle_date between b.first_day and b.last_day
),

minutes as (
    select x.*
    from {{ ref('fct_candle_1h') }} x
    cross join bounds b
    where x.candle_date between b.first_day and b.last_day
)

select
    coalesce(a.symbol, m.symbol)         as symbol,
    coalesce(a.hour_start, m.hour_start) as hour_start,
    case when a.symbol is null then 'only built from minutes'
         when m.symbol is null then 'only in the archive'
         else 'values differ' end        as problem,
    a.open, m.open as minute_open, a.close, m.close as minute_close, a.volume, m.volume as minute_volume
from archive a
full outer join minutes m
  on a.symbol = m.symbol
 and a.hour_start = m.hour_start
where a.symbol is null
   or m.symbol is null
   or abs(a.open - m.open)   > 1e-9 * abs(m.open)
   or abs(a.high - m.high)   > 1e-9 * abs(m.high)
   or abs(a.low - m.low)     > 1e-9 * abs(m.low)
   or abs(a.close - m.close) > 1e-9 * abs(m.close)
   or abs(a.volume - m.volume) > 1e-9 * greatest(abs(m.volume), 1)
   or a.trades <> m.trades
