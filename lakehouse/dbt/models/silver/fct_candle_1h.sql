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
    min_by(open, open_time)                        as open,     -- the first minute's open
    max(high)                                      as high,
    min(low)                                       as low,
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
