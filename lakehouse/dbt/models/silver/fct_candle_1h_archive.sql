{{
  config(
    materialized = 'incremental',
    incremental_strategy = 'merge',
    unique_key = ['symbol', 'hour_start'],
    liquid_clustered_by = ['symbol', 'candle_date'],
    on_schema_change = 'fail'
  )
}}

-- Hourly candles from Binance's monthly archive files (January 2020 onward, every USDT perpetual,
-- delisted ones included): the lakehouse's long history. Typed and de-duplicated like the
-- 1-minute candles; incremental on bronze load time.
--
-- The files are read without a header in bronze, so the header lines of the newer files arrive as
-- rows whose open_time is the text 'open_time'. try_cast turns that into NULL, and the row is
-- dropped with any other line whose time isn't a number.

with source as (
    select * from {{ source('bronze', 'klines_1h') }}
    {% if is_incremental() %}
    where loaded_at > (select max(bronze_loaded_at) from {{ this }})
    {% endif %}
),

typed as (
    select
        symbol,
        timestamp_millis(try_cast(open_time as bigint))  as hour_start,
        try_cast(open as double)                          as open,
        try_cast(high as double)                          as high,
        try_cast(low as double)                           as low,
        try_cast(close as double)                         as close,
        try_cast(volume as double)                        as volume,
        try_cast(quote_volume as double)                  as quote_volume,
        try_cast(`count` as bigint)                       as trades,
        try_cast(taker_buy_volume as double)              as taker_buy_volume,
        try_cast(taker_buy_quote_volume as double)        as taker_buy_quote_volume,
        source_file,
        loaded_at                                         as bronze_loaded_at
    from source
)

select
    symbol,
    hour_start,
    to_date(hour_start) as candle_date,
    open, high, low, close,
    volume, quote_volume, trades,
    taker_buy_volume, taker_buy_quote_volume,
    source_file,
    bronze_loaded_at
from typed
where hour_start is not null
qualify row_number() over (partition by symbol, hour_start order by bronze_loaded_at desc) = 1
