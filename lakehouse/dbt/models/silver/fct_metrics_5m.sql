{{
  config(
    materialized = 'incremental',
    incremental_strategy = 'merge',
    unique_key = ['symbol', 'metric_time'],
    liquid_clustered_by = ['symbol', 'metric_date'],
    on_schema_change = 'fail'
  )
}}

-- Binance's 5-minute market metrics with clearer names and real types.
-- The ratio columns are sometimes empty in Binance's files; they stay NULL here (not an error).

with source as (
    select * from {{ source('bronze', 'metrics') }}
    {% if is_incremental() %}
    where loaded_at > (select max(bronze_loaded_at) from {{ this }})
    {% endif %}
),

typed as (
    select
        symbol,
        try_to_timestamp(create_time, 'yyyy-MM-dd HH:mm:ss')     as metric_time,
        try_cast(sum_open_interest as double)                     as open_interest,
        try_cast(sum_open_interest_value as double)               as open_interest_usdt,
        try_cast(count_toptrader_long_short_ratio as double)      as top_trader_account_ratio,
        try_cast(sum_toptrader_long_short_ratio as double)        as top_trader_position_ratio,
        try_cast(count_long_short_ratio as double)                as account_long_short_ratio,
        try_cast(sum_taker_long_short_vol_ratio as double)        as taker_buy_sell_ratio,
        source_file,
        loaded_at                                                 as bronze_loaded_at
    from source
)

select
    symbol,
    metric_time,
    to_date(metric_time) as metric_date,
    open_interest,
    open_interest_usdt,
    top_trader_account_ratio,
    top_trader_position_ratio,
    account_long_short_ratio,
    taker_buy_sell_ratio,
    source_file,
    bronze_loaded_at
from typed
where metric_time is not null
qualify row_number() over (partition by symbol, metric_time order by bronze_loaded_at desc) = 1