{{
  config(
    materialized = 'incremental',
    incremental_strategy = 'merge',
    unique_key = ['symbol', 'hour_start'],
    liquid_clustered_by = ['symbol', 'candle_date'],
    on_schema_change = 'fail'
  )
}}

-- Hourly candles, rolled up from the 1-minute candles: the base for hour-of-day patterns and the
-- daily gold tables. On an incremental run, every hour of each day that received new minutes is
-- rebuilt and merged in, so a day that arrives late or is reloaded is always complete.
--
-- Open, high and low come from the minutes that traded. Binance fills a minute without trades with
-- a flat candle at the previous price; counting those made the hour open at the previous hour's
-- close and widened its range. Built this way, every hour matches Binance's own hourly candle
-- (assert_hourly_sources_agree). An hour with no trades at all keeps its flat price.

with minutes as (
    select * from {{ ref('fct_candle_1m') }}
    {% if is_incremental() %}
    where candle_date in (
        select distinct candle_date
        from {{ ref('fct_candle_1m') }}
        where bronze_loaded_at > (select max(last_bronze_loaded_at) from {{ this }})
    )
    {% endif %}
)

select
    symbol,
    date_trunc('HOUR', open_time)                  as hour_start,
    candle_date,
    coalesce(min_by(open, open_time) filter (where volume > 0), min_by(open, open_time)) as open,  -- first trade
    coalesce(max(high) filter (where volume > 0), max(high))                           as high,
    coalesce(min(low) filter (where volume > 0), min(low))                             as low,
    max_by(close, open_time)                       as close,    -- the last minute's close
    sum(volume)                                    as volume,
    sum(quote_volume)                              as quote_volume,
    sum(trades)                                    as trades,
    sum(taker_buy_volume)                          as taker_buy_volume,
    sum(taker_buy_quote_volume)                    as taker_buy_quote_volume,
    -- Average price paid in the hour; NULL when nothing traded.
    sum(quote_volume) / nullif(sum(volume), 0)     as vwap,
    -- Share of the volume that was aggressive buying (the TAKER signal's input); NULL when nothing traded.
    sum(taker_buy_volume) / nullif(sum(volume), 0) as taker_buy_share,
    count(*)                                       as minutes,
    count_if(volume = 0)                           as zero_volume_minutes,
    max(bronze_loaded_at)                          as last_bronze_loaded_at
from minutes
group by symbol, date_trunc('HOUR', open_time), candle_date
