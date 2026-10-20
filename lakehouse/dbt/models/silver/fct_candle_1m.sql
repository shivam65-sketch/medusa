{{
  config(
    materialized = 'incremental',
    incremental_strategy = 'merge',
    unique_key = ['symbol', 'open_time'],
    liquid_clustered_by = ['symbol', 'candle_date'],
    on_schema_change = 'fail'
  )
}}

with source as (
    select * from {{ source('bronze', 'klines_1m') }}
    {% if is_incremental() %}
    where loaded_at > (select max(bronze_loaded_at) from {{ this }})
    {% endif %}
),

typed as (
    select
        symbol,
        timestamp_millis(try_cast(open_time as bigint))  as open_time,
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
    open_time,
    to_date(open_time) as candle_date,
    open, high, low, close,
    volume, quote_volume, trades,
    taker_buy_volume, taker_buy_quote_volume,
    source_file,
    bronze_loaded_at
from typed
where open_time is not null
qualify row_number() over (partition by symbol, open_time order by bronze_loaded_at desc) = 1