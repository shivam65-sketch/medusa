{{ config(materialized = 'table') }}

-- Gold: each coin's "normal" as of its latest day: the numbers MEDUSA's live scanner compares
-- today's market with. One row per coin, rebuilt on every run.
--
--   today's move    = live price / last_close - 1   (the same formula as coin_daily.return_1d)
--   today's z-score = (today's move - avg_return_30d) / sd_return_30d, unusual at 3 or more,
--                     the same rule unusual_moves uses for a finished day
--
-- The window is the coin's last 30 trading days up to and including as_of_date: for "today" that is
-- the 30 days before today, the same baseline unusual_moves uses. Only days with trades count, so
-- contracts Binance has delisted (flat, zero-volume candles) get no baseline.

with traded_days as (
    select
        *,
        row_number() over (partition by symbol order by trade_date desc) as days_back
    from {{ ref('coin_daily') }}
    where trades > 0
),

last_30 as (
    select *
    from traded_days
    where days_back <= 30
),

daily as (
    select
        symbol,
        max(trade_date)                    as as_of_date,
        max_by(close, trade_date)          as last_close,
        count(return_1d)                   as history_days,
        avg(return_1d)                     as avg_return_30d,
        stddev(return_1d)                  as sd_return_30d,
        avg(abs(return_1d))                as avg_abs_return_30d,
        avg(range_1d)                      as avg_range_30d,
        avg(realized_volatility_1d)        as avg_volatility_30d,
        stddev(realized_volatility_1d)     as sd_volatility_30d,
        avg(quote_volume)                  as avg_quote_volume_30d,
        -- Volume on a log scale, as in unusual_moves: a doubling counts the same for every coin.
        avg(ln(quote_volume))              as avg_log_volume_30d,
        stddev(ln(quote_volume))           as sd_log_volume_30d
    from last_30
    group by symbol
),

-- The typical size of a one-hour move on the same days: does the coin move enough within an hour
-- to pay for a round trip's fees?
hourly as (
    select
        h.symbol,
        avg(abs(h.close / h.open - 1))     as avg_abs_hour_return_30d
    from {{ ref('fct_candle_1h') }} h
    join last_30 d
      on d.symbol = h.symbol
     and d.trade_date = h.candle_date
    where h.open > 0
    group by h.symbol
),

coins as (
    select symbol, base_asset, multiplier, status
    from {{ ref('dim_coin') }}
    where dbt_valid_to = cast('9999-12-31' as timestamp)
)

select
    d.symbol,
    c.base_asset,
    c.multiplier,
    c.status,
    d.as_of_date,
    d.last_close,
    d.history_days,
    d.avg_return_30d,
    d.sd_return_30d,
    d.avg_abs_return_30d,
    d.avg_range_30d,
    d.avg_volatility_30d,
    d.sd_volatility_30d,
    d.avg_quote_volume_30d,
    d.avg_log_volume_30d,
    d.sd_log_volume_30d,
    h.avg_abs_hour_return_30d
from daily d
left join coins c on c.symbol = d.symbol
left join hourly h on h.symbol = d.symbol
