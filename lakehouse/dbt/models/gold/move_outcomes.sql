{{ config(materialized = 'table') }}

-- Gold: how past unusual moves turned out, for the playbook on the Markets page. One row per type of
-- market, kind of move (direction, size of z, liquidity), horizon (1, 4 or 24 hours) and period
-- (in_sample, held_back, or all).
--
-- event_evidence decides whether a kind of move has an edge. This table describes what happened, so
-- it differs in three ways:
--   1. Every type of market is here, each on its own: a stock's move is compared with stocks'. The
--      page shows the verdict separately, and only for the markets event_evidence can judge.
--   2. The unit is the move, not the day: how far one trade can go is a question about moves. days
--      says how many separate days stand behind them, because moves bunch on crash days.
--   3. It keeps the tails: where the worst 5% of moves ended, either way.
--
-- Continuation is as in event_evidence: positive kept going, negative turned back, in the price at
-- the end of the horizon. The worst point along the way isn't known.
--
-- The percentiles are calculated here, not on the page, because each one sorts about 21,000 moves:
-- 1.6 seconds in the browser, which runs its queries every second (ADR-038).
--
-- Rebuilt on every run from intraday_events (cheap).

with by_horizon as (
    select
        e.market_type,
        e.direction,
        e.z_band,
        e.liquidity,
        e.period,
        e.event_date,
        h.horizon_hours,
        case when e.direction = 'up' then 1 else -1 end
          * case h.horizon_hours when 1 then e.fwd_return_1h
                                 when 4 then e.fwd_return_4h
                                 else e.fwd_return_24h end        as continuation
    from {{ ref('intraday_events') }} e
    cross join (values (1), (4), (24)) as h(horizon_hours)
),

-- Each move counts in its own period and in 'all' (every year together).
with_all_years as (
    select market_type, direction, z_band, liquidity, period, horizon_hours, event_date, continuation
    from by_horizon
    where continuation is not null

    union all

    select market_type, direction, z_band, liquidity, 'all', horizon_hours, event_date, continuation
    from by_horizon
    where continuation is not null
)

select
    market_type,
    direction,
    z_band,
    liquidity,
    horizon_hours,
    period,
    count(*)                            as moves,
    count(distinct event_date)          as days,
    percentile(continuation, 0.5)       as median_continuation,
    count_if(continuation > 0) / count(*) as hit_rate,
    percentile(continuation, 0.05)      as p05_continuation,
    percentile(continuation, 0.95)      as p95_continuation
from with_all_years
group by all
