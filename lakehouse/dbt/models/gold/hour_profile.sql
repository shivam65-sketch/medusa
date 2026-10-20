{{ config(materialized = 'table') }}

-- Gold: each coin's hour-of-day pattern over its whole history, one row per coin per UTC hour.
-- Does the price tend to rise or fall in this hour? How busy is it? How much is aggressive buying?
--
-- t_stat_return tells whether an hour's average return is more than noise: as a rough guide,
-- below 2 (either way) it could easily be chance. With only a few weeks of data most hours will
-- be noise; the table gets more telling every day.
-- Rebuilt on every run from fct_candle_1h (24 rows per coin per day).

with hours as (
    select
        symbol,
        candle_date,
        hour(hour_start)                                        as utc_hour,
        close / open - 1                                        as hour_return,
        quote_volume,
        taker_buy_share,
        -- The hour's share of the coin's volume that day.
        quote_volume / nullif(sum(quote_volume) over (partition by symbol, candle_date), 0)
                                                                as volume_share
    from {{ ref('fct_candle_1h') }}
    where open > 0
)

select
    symbol,
    utc_hour,
    count(*)                                                    as days,
    min(candle_date)                                            as first_date,
    max(candle_date)                                            as last_date,
    avg(hour_return)                                            as avg_return,
    stddev(hour_return)                                         as sd_return,
    avg(hour_return) / nullif(stddev(hour_return) / sqrt(count(*)), 0)
                                                                as t_stat_return,
    avg(abs(hour_return))                                       as avg_abs_return,
    avg(volume_share)                                           as avg_volume_share,
    avg(quote_volume)                                           as avg_quote_volume,
    avg(taker_buy_share)                                        as avg_taker_buy_share
from hours
group by symbol, utc_hour
