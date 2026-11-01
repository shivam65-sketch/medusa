-- move_outcomes adds up to intraday_events:
--   - each type of market, kind of move, horizon and period appears once;
--   - in-sample plus held-back moves make up the 'all' row of each kind and horizon;
--   - the 'all' rows of each horizon count exactly the moves in intraday_events that have a forward
--     return at that horizon;
--   - no row has more days than moves or a hit rate outside 0 to 1, and the worst 5% each way sit
--     either side of the middle move.
-- Any row returned breaks one of those rules.
with outcomes as (
    select * from {{ ref('move_outcomes') }}
),

source_counts as (
    select h.horizon_hours,
           count(case h.horizon_hours when 1 then fwd_return_1h
                                      when 4 then fwd_return_4h
                                      else fwd_return_24h end) as moves
    from {{ ref('intraday_events') }}
    cross join (values (1), (4), (24)) as h(horizon_hours)
    group by all
),

periods as (
    select market_type, direction, z_band, liquidity, horizon_hours,
           sum(case when period = 'all' then moves else 0 end) as all_moves,
           sum(case when period <> 'all' then moves else 0 end) as period_moves
    from outcomes
    group by all
)

select market_type, direction, z_band, liquidity, horizon_hours, period, 'row appears more than once' as problem
from outcomes
group by all
having count(*) > 1

union all

select market_type, direction, z_band, liquidity, horizon_hours, 'all', 'periods do not add up'
from periods
where all_moves <> period_moves

union all

select 'all', 'all', 'all', 'all', s.horizon_hours, 'all', 'all rows do not match intraday_events'
from source_counts s
left join (select horizon_hours, sum(moves) as moves from outcomes where period = 'all' group by all) o
  on o.horizon_hours = s.horizon_hours
where coalesce(o.moves, -1) <> s.moves

union all

select market_type, direction, z_band, liquidity, horizon_hours, period, 'numbers out of range or out of order'
from outcomes
where days > moves
   or hit_rate not between 0 and 1
   or p05_continuation > median_continuation
   or median_continuation > p95_continuation
