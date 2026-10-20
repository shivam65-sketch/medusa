{{ config(materialized = 'table') }}

-- Gold: coin-days that were unusual for that coin. Each day is measured against the coin's own
-- previous 30 trading days (the day itself is left out), as z-scores: how many standard
-- deviations away from its normal the day was.
-- A day counts as unusual when its return, its volume or its volatility is 3 or more standard
-- deviations from normal. A coin needs at least 20 days of history to be scored.
-- Rebuilt on every run from coin_daily (cheap: about 870 rows a day).

with history as (
    select
        symbol,
        trade_date,
        return_1d,
        quote_volume,
        realized_volatility_1d,
        taker_buy_share,
        -- The previous 30 rows of the same coin, not including today.
        count(return_1d)             over w as history_days,
        avg(return_1d)               over w as avg_return_30d,
        stddev(return_1d)            over w as sd_return_30d,
        avg(ln(quote_volume))        over w as avg_log_volume_30d,
        stddev(ln(quote_volume))     over w as sd_log_volume_30d,
        avg(realized_volatility_1d)  over w as avg_volatility_30d,
        stddev(realized_volatility_1d) over w as sd_volatility_30d
    from {{ ref('coin_daily') }}
    window w as (partition by symbol order by trade_date rows between 30 preceding and 1 preceding)
),

scored as (
    select
        *,
        (return_1d - avg_return_30d) / nullif(sd_return_30d, 0)                         as return_z,
        -- Volume is compared on a log scale: volumes are skewed, and a doubling is a doubling
        -- whether a coin trades 1 million or 1 billion.
        (ln(quote_volume) - avg_log_volume_30d) / nullif(sd_log_volume_30d, 0)          as volume_z,
        (realized_volatility_1d - avg_volatility_30d) / nullif(sd_volatility_30d, 0)    as volatility_z
    from history
    where history_days >= 20
      and quote_volume > 0
)

select
    symbol,
    trade_date,
    return_1d,
    return_z,
    quote_volume,
    volume_z,
    realized_volatility_1d,
    volatility_z,
    taker_buy_share,
    history_days,
    concat_ws(', ',
        case when abs(return_z) >= 3 then case when return_z > 0 then 'big rise' else 'big fall' end end,
        case when volume_z >= 3 then 'volume surge' end,
        case when volatility_z >= 3 then 'volatility spike' end
    ) as reasons
from scored
where abs(return_z) >= 3
   or volume_z >= 3
   or volatility_z >= 3
