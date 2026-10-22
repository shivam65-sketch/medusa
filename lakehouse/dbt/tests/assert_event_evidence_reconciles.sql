-- event_evidence adds up to intraday_events:
--   - each kind of move and horizon appears once;
--   - in-sample plus held-back events make up all events, and no row has more days than events;
--   - for each direction and horizon, the kinds of move add up to the 'all' row, and the 'all' row
--     counts exactly the events in intraday_events that have a forward return at that horizon.
-- Any row returned breaks one of those rules.
with evidence as (
    select * from {{ ref('event_evidence') }}
),

source_counts as (
    select direction, h.horizon_hours,
           count(case h.horizon_hours when 1 then fwd_return_1h
                                      when 4 then fwd_return_4h
                                      else fwd_return_24h end) as events
    from {{ ref('intraday_events') }}
    cross join (values (1), (4), (24)) as h(horizon_hours)
    group by all
),

kinds as (
    select direction, horizon_hours, sum(events) as events
    from evidence
    where z_band <> 'all'
    group by all
)

select direction, z_band, liquidity, horizon_hours, 'row appears more than once' as problem
from evidence
group by all
having count(*) > 1

union all

select direction, z_band, liquidity, horizon_hours, 'periods do not add up, or more days than events'
from evidence
where coalesce(in_sample_events, 0) + coalesce(held_back_events, 0) <> events
   or days > events
   or hit_rate not between 0 and 1

union all

select a.direction, 'all', 'all', a.horizon_hours, 'kinds of move do not add up to the all row'
from evidence a
left join kinds k on k.direction = a.direction and k.horizon_hours = a.horizon_hours
where a.z_band = 'all' and coalesce(k.events, -1) <> a.events

union all

select s.direction, 'all', 'all', s.horizon_hours, 'all row does not match intraday_events'
from source_counts s
left join evidence a
  on a.direction = s.direction and a.horizon_hours = s.horizon_hours and a.z_band = 'all'
where coalesce(a.events, -1) <> s.events
