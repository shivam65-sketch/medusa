-- Every coin dim_coin calls trading has a baseline, its baseline is from the latest few days, and
-- its numbers are possible (a positive price, 0 to 30 days of history, no negative spreads).
-- Any row returned breaks one of those rules.
with latest as (
    select max(trade_date) as latest_date from {{ ref('coin_daily') }}
),

trading as (
    select symbol
    from {{ ref('dim_coin') }}
    where dbt_valid_to = cast('9999-12-31' as timestamp)
      and status = 'trading'
)

select t.symbol, b.as_of_date, b.last_close, b.history_days, b.sd_return_30d, 'trading coin without a baseline' as problem
from trading t
left join {{ ref('coin_baseline') }} b on b.symbol = t.symbol
where b.symbol is null

union all

select b.symbol, b.as_of_date, b.last_close, b.history_days, b.sd_return_30d, 'impossible or stale baseline' as problem
from {{ ref('coin_baseline') }} b
cross join latest l
where b.last_close <= 0
   or b.history_days not between 0 and 30
   or b.sd_return_30d < 0
   or b.sd_log_volume_30d < 0
   or (b.status = 'trading' and b.as_of_date < date_sub(l.latest_date, 2))
