{{ config(materialized = 'table') }}

-- Gold: does the whole market tend to rise or fall in a given UTC hour, and is it the same every
-- year? One row per year, period, UTC hour and liquidity group (and 'all', every coin together),
-- from January 2020.
--
-- Judged by days, like the evidence: first the market's move in each hour of each day (the average
-- of every trading coin's return in that hour, each coin counted once), then statistics over those
-- days. A coin's hour is clipped to ±10%, so one listing spike can't decide an hour on its own.
--
-- days, sum_return and sum_sq_return let any group of rows be combined exactly (mean = sum / days,
-- variance from the sum of squares), so the Markets page's Insights graphs can pool all the years,
-- or 2020-2024 against 2025 on, from these few hundred rows (lakehouse step 32).
--
-- hour_profile answers the same question per coin, but only from the minute candles (since
-- September 2026). This reads the continuous hourly series (int_candle_1h_all), delisted coins
-- included, so it has every year. Rebuilt on every run (about 16 million hours, under a minute).

with hours as (
    select
        symbol,
        candle_date,
        hour(hour_start)                                    as utc_hour,
        least(greatest(close / open - 1, -0.1), 0.1)        as hour_return,
        quote_volume
    from {{ ref('int_candle_1h_all') }}
    where open > 0
      and trades > 0
),

-- Each coin's liquidity on each day, as in intraday_events: its average daily traded value over its
-- previous 30 days with trades, from at least 20 of them.
coin_days as (
    select symbol, candle_date, sum(quote_volume) as quote_volume
    from hours
    group by symbol, candle_date
),

liquidity as (
    select
        symbol,
        candle_date,
        count(*)            over w as history_days,
        avg(quote_volume)   over w as avg_quote_volume_30d
    from coin_days
    window w as (partition by symbol order by candle_date rows between 30 preceding and 1 preceding)
),

scored as (
    select
        h.candle_date,
        h.utc_hour,
        h.hour_return,
        case when l.avg_quote_volume_30d >= 100000000 then 'large'
             when l.avg_quote_volume_30d >= 10000000 then 'mid'
             else 'small' end                               as liquidity,
        case when h.candle_date < cast('{{ var("held_back_from") }}' as date)
             then 'in_sample' else 'held_back' end          as period
    from hours h
    join liquidity l
      on l.symbol = h.symbol
     and l.candle_date = h.candle_date
    where l.history_days >= 20
),

-- The market's move in each hour of each day: for each liquidity group, and for every coin together.
day_hours as (
    select
        candle_date,
        period,
        utc_hour,
        coalesce(liquidity, 'all')                          as liquidity,
        avg(hour_return)                                    as market_return,
        count(*)                                            as coins
    from scored
    group by grouping sets ((candle_date, period, utc_hour, liquidity), (candle_date, period, utc_hour))
)

select
    year(candle_date)                                       as year,
    period,
    utc_hour,
    liquidity,
    count(*)                                                as days,
    min(candle_date)                                        as first_date,
    max(candle_date)                                        as last_date,
    sum(coins)                                              as coin_hours,
    sum(market_return)                                      as sum_return,
    sum(market_return * market_return)                      as sum_sq_return,
    count_if(market_return > 0)                             as up_days,
    avg(market_return)                                      as avg_return,
    stddev(market_return)                                   as sd_return,
    -- How clearly the average differs from zero, given how much the days vary: beyond ±2 is
    -- unlikely to be chance (one test; with 24 hours tested, a few pass by luck).
    avg(market_return) / nullif(stddev(market_return) / sqrt(count(*)), 0)
                                                            as t_stat
from day_hours
group by year(candle_date), period, utc_hour, liquidity
