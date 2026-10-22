{{ config(materialized = 'table') }}

-- Gold: what moves like today's did next. One row per kind of move (direction, size of z,
-- coin liquidity) and horizon (1, 4 or 24 hours), plus an 'all' row per direction and horizon.
-- The live scanner shows the row that matches each unusual move it flags.
--
-- Continuation = the forward return in the direction of the move: positive means the move kept
-- going, negative means it turned back.
--
-- Two things keep the evidence honest:
--   1. Days, not events, are the unit. Coins move together: one crash day can give hundreds of
--      events, and they are not hundreds of independent proofs. Each day's events are averaged
--      first; the average, spread and t-statistic are taken over days.
--   2. A held-back period. The side (follow the move or fade it) is chosen on the in-sample years
--      only, then checked on the held-back years, which played no part in choosing it. 'held up'
--      needs a clear pattern in-sample (|t| >= evidence_min_t), the same side working in the
--      held-back years (t >= evidence_min_t), and a profit after round_trip_cost in both.
--
-- Rebuilt on every run from intraday_events (cheap).

with by_horizon as (
    select
        e.event_date,
        e.direction,
        e.z_band,
        e.liquidity,
        e.period,
        h.horizon_hours,
        case when e.direction = 'up' then 1 else -1 end
          * case h.horizon_hours when 1 then e.fwd_return_1h
                                 when 4 then e.fwd_return_4h
                                 else e.fwd_return_24h end        as continuation
    from {{ ref('intraday_events') }} e
    cross join (values (1), (4), (24)) as h(horizon_hours)
),

-- Each event counts in its own kind of move and in the 'all' row of its direction, in its own
-- period and in 'all' (every year together).
bucketed as (
    select direction, z_band, liquidity, period, horizon_hours, event_date, continuation
    from by_horizon
    where continuation is not null

    union all

    select direction, 'all', 'all', period, horizon_hours, event_date, continuation
    from by_horizon
    where continuation is not null
),

with_all_years as (
    select * from bucketed
    union all
    select direction, z_band, liquidity, 'all', horizon_hours, event_date, continuation from bucketed
),

per_day as (
    select
        direction, z_band, liquidity, period, horizon_hours, event_date,
        avg(continuation)               as day_continuation,
        count(*)                        as events,
        count_if(continuation > 0)      as wins
    from with_all_years
    group by all
),

stats as (
    select
        direction, z_band, liquidity, period, horizon_hours,
        sum(events)                                         as events,
        count(*)                                            as days,
        sum(wins) / sum(events)                             as hit_rate,
        avg(day_continuation)                               as avg_continuation,
        avg(day_continuation)
          / nullif(stddev(day_continuation) / sqrt(count(*)), 0) as t_stat
    from per_day
    group by all
),

medians as (
    select
        direction, z_band, liquidity, horizon_hours,
        percentile(continuation, 0.5)   as median_continuation
    from with_all_years
    where period = 'all'
    group by all
),

joined as (
    select
        a.direction,
        a.z_band,
        a.liquidity,
        a.horizon_hours,
        a.events,
        a.days,
        a.avg_continuation,
        m.median_continuation,
        a.hit_rate,
        i.events            as in_sample_events,
        i.days              as in_sample_days,
        i.avg_continuation  as in_sample_avg_continuation,
        i.t_stat            as in_sample_t,
        i.hit_rate          as in_sample_hit_rate,
        h.events            as held_back_events,
        h.days              as held_back_days,
        h.avg_continuation  as held_back_avg_continuation,
        h.t_stat            as held_back_t,
        h.hit_rate          as held_back_hit_rate,
        -- The side is chosen on the in-sample years only.
        case when i.avg_continuation >= 0 then 1 when i.avg_continuation < 0 then -1 end as side_sign
    from stats a
    left join stats i
      on i.period = 'in_sample'
     and i.direction = a.direction and i.z_band = a.z_band
     and i.liquidity = a.liquidity and i.horizon_hours = a.horizon_hours
    left join stats h
      on h.period = 'held_back'
     and h.direction = a.direction and h.z_band = a.z_band
     and h.liquidity = a.liquidity and h.horizon_hours = a.horizon_hours
    left join medians m
      on m.direction = a.direction and m.z_band = a.z_band
     and m.liquidity = a.liquidity and m.horizon_hours = a.horizon_hours
    where a.period = 'all'
)

select
    direction,
    z_band,
    liquidity,
    horizon_hours,
    events,
    days,
    avg_continuation,
    median_continuation,
    hit_rate,
    in_sample_events,
    in_sample_days,
    in_sample_avg_continuation,
    in_sample_t,
    in_sample_hit_rate,
    held_back_events,
    held_back_days,
    held_back_avg_continuation,
    held_back_t,
    held_back_hit_rate,
    case side_sign when 1 then 'follow' when -1 then 'fade' end                as side,
    side_sign * in_sample_avg_continuation - {{ var('round_trip_cost') }}    as in_sample_net_after_cost,
    side_sign * held_back_avg_continuation - {{ var('round_trip_cost') }}    as held_back_net_after_cost,
    case
        when coalesce(in_sample_days, 0) < {{ var('evidence_min_days') }}
          or coalesce(held_back_days, 0) < {{ var('evidence_min_days') }}      then 'too few'
        when abs(in_sample_t) < {{ var('evidence_min_t') }}
          or in_sample_t is null                                               then 'no pattern'
        when side_sign * held_back_t >= {{ var('evidence_min_t') }}
         and side_sign * in_sample_avg_continuation > {{ var('round_trip_cost') }}
         and side_sign * held_back_avg_continuation > {{ var('round_trip_cost') }} then 'held up'
        else 'did not hold'
    end                                                                        as verdict,
    {{ var('round_trip_cost') }}                                               as round_trip_cost
from joined
