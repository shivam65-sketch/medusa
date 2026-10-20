{{
  config(
    materialized = 'incremental',
    incremental_strategy = 'merge',
    unique_key = ['symbol', 'trade_date'],
    liquid_clustered_by = ['trade_date', 'symbol'],
    on_schema_change = 'fail'
  )
}}

-- Gold: one row per coin per UTC day. The main table the dashboards read.
-- Returns and changes are fractions: 0.05 means +5%.
--
-- Incremental: a run rebuilds every day that got new candles, and the day after each of them,
-- because a day's return depends on the previous day's close.

with
{% if is_incremental() %}
new_days as (
    select distinct candle_date as d
    from {{ ref('fct_candle_1h') }}
    where last_bronze_loaded_at > (select max(last_bronze_loaded_at) from {{ this }})
),

target_days as (
    select d from new_days
    union
    select date_add(d, 1) from new_days
),
{% endif %}

-- Hourly candles for the days being built, plus the day before each (for the previous close).
hours as (
    select * from {{ ref('fct_candle_1h') }}
    {% if is_incremental() %}
    where candle_date in (select d from target_days union select date_sub(d, 1) from target_days)
    {% endif %}
),

daily as (
    select
        symbol,
        candle_date                     as trade_date,
        min_by(open, hour_start)        as open,
        max(high)                       as high,
        min(low)                        as low,
        max_by(close, hour_start)       as close,
        sum(volume)                     as volume,
        sum(quote_volume)               as quote_volume,
        sum(trades)                     as trades,
        sum(taker_buy_volume)           as taker_buy_volume,
        sum(minutes)                    as minutes,
        sum(zero_volume_minutes)        as zero_volume_minutes,
        max(last_bronze_loaded_at)      as last_bronze_loaded_at
    from hours
    group by symbol, candle_date
),

with_previous as (
    select
        *,
        lag(close)      over (partition by symbol order by trade_date) as previous_close,
        lag(trade_date) over (partition by symbol order by trade_date) as previous_date
    from daily
),

-- From the 1-minute candles: how much the price moved within the day.
minute_returns as (
    select
        symbol,
        candle_date,
        close,
        lag(close) over (partition by symbol, candle_date order by open_time) as previous_minute_close
    from {{ ref('fct_candle_1m') }}
    {% if is_incremental() %}
    where candle_date in (select d from target_days)
    {% endif %}
),

minute_moves as (
    select
        symbol,
        candle_date                                                     as trade_date,
        -- Realised volatility: the square root of the sum of squared 1-minute log returns.
        sqrt(sum(power(ln(close / previous_minute_close), 2)))         as realized_volatility_1d,
        -- The biggest single 1-minute move, up or down.
        max(abs(close / previous_minute_close - 1))                     as max_move_1m
    from minute_returns
    where previous_minute_close > 0
      and close > 0
    group by symbol, candle_date
),

-- From the 5-minute metrics: open interest and the long/short ratios.
metrics as (
    select
        symbol,
        metric_date                                    as trade_date,
        min_by(open_interest_usdt, metric_time)        as open_interest_open_usdt,
        max_by(open_interest_usdt, metric_time)        as open_interest_close_usdt,
        avg(taker_buy_sell_ratio)                      as avg_taker_buy_sell_ratio,
        avg(top_trader_position_ratio)                 as avg_top_trader_position_ratio,
        avg(account_long_short_ratio)                  as avg_account_long_short_ratio,
        count(*)                                       as metric_snapshots
    from {{ ref('fct_metrics_5m') }}
    {% if is_incremental() %}
    where metric_date in (select d from target_days)
    {% endif %}
    group by symbol, metric_date
)

select
    p.symbol,
    p.trade_date,
    p.open,
    p.high,
    p.low,
    p.close,
    -- Only against the day before: after a gap in the data the return stays empty.
    case when p.previous_date = date_sub(p.trade_date, 1)
         then p.close / p.previous_close - 1 end                         as return_1d,
    (p.high - p.low) / p.open                                            as range_1d,
    p.volume,
    p.quote_volume,
    p.trades,
    p.taker_buy_volume / nullif(p.volume, 0)                             as taker_buy_share,
    m.realized_volatility_1d,
    m.max_move_1m,
    x.open_interest_open_usdt,
    x.open_interest_close_usdt,
    x.open_interest_close_usdt / nullif(x.open_interest_open_usdt, 0) - 1 as open_interest_change_1d,
    x.avg_taker_buy_sell_ratio,
    x.avg_top_trader_position_ratio,
    x.avg_account_long_short_ratio,
    p.minutes,
    p.zero_volume_minutes,
    coalesce(x.metric_snapshots, 0)                                      as metric_snapshots,
    p.last_bronze_loaded_at
from with_previous p
left join minute_moves m on m.symbol = p.symbol and m.trade_date = p.trade_date
left join metrics      x on x.symbol = p.symbol and x.trade_date = p.trade_date
{% if is_incremental() %}
where p.trade_date in (select d from target_days)
{% endif %}
