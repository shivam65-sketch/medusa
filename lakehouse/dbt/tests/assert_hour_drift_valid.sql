-- One row per year, period, hour and liquidity group; hours 0 to 23; at least one day behind each
-- row and no more up days than days; sums that can be pooled (a sum of squares is never negative);
-- and every group's days within all's (a day-hour counted for a group is counted for all too).
-- Any row returned breaks one of those rules.
with rows_ as (
    select *, count(*) over (partition by year, period, utc_hour, liquidity) as copies
    from {{ ref('hour_drift') }}
),

everyone as (
    select year, period, utc_hour, days as all_days
    from {{ ref('hour_drift') }}
    where liquidity = 'all'
)

select r.year, r.period, r.utc_hour, r.liquidity, r.days, r.up_days, r.copies, e.all_days
from rows_ r
left join everyone e
  on e.year = r.year and e.period = r.period and e.utc_hour = r.utc_hour
where r.copies > 1
   or r.utc_hour not between 0 and 23
   or r.days < 1
   or r.up_days > r.days
   or r.sum_sq_return < 0
   or e.all_days is null
   or r.days > e.all_days
