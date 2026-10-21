{{ config(materialized = 'view') }}

-- One continuous hourly series per coin from January 2020 to yesterday: Binance's monthly hourly
-- files before the first day built from 1-minute candles, and the minute-built hours from then on.
-- Where both exist they agree exactly (assert_hourly_sources_agree), so the switch-over leaves no
-- seam. The history for evidence and patterns reads this.

with cutoff as (
    select min(candle_date) as first_minute_day
    from {{ ref('fct_candle_1h') }}
)

select
    a.symbol, a.hour_start, a.candle_date,
    a.open, a.high, a.low, a.close,
    a.volume, a.quote_volume, a.trades,
    a.taker_buy_volume, a.taker_buy_quote_volume,
    'monthly_archive' as source
from {{ ref('fct_candle_1h_archive') }} a
cross join cutoff c
where a.candle_date < c.first_minute_day

union all

select
    m.symbol, m.hour_start, m.candle_date,
    m.open, m.high, m.low, m.close,
    m.volume, m.quote_volume, m.trades,
    m.taker_buy_volume, m.taker_buy_quote_volume,
    'minute_candles' as source
from {{ ref('fct_candle_1h') }} m
