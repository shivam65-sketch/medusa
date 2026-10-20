-- Cross-layer check: every coin dim_coin calls trading now must have traded in its last 3 days in
-- coin_daily, and every coin it calls not trading must not have. Any row returned disagrees.
with recent as (
    select symbol, trades,
           row_number() over (partition by symbol order by trade_date desc) as days_back,
           trade_date
    from {{ ref('coin_daily') }}
),

latest as (
    select max(trade_date) as latest_date from {{ ref('coin_daily') }}
),

activity as (
    select r.symbol, sum(r.trades) as trades_last_3_days
    from recent r
    cross join latest l
    where r.trade_date >= date_sub(l.latest_date, 2)
    group by r.symbol
)

select c.symbol, c.status, coalesce(a.trades_last_3_days, 0) as trades_last_3_days
from {{ ref('dim_coin') }} c
left join activity a on a.symbol = c.symbol
where c.dbt_valid_to = cast('9999-12-31' as timestamp)
  and (   (c.status = 'trading' and coalesce(a.trades_last_3_days, 0) = 0)
       or (c.status = 'not trading' and coalesce(a.trades_last_3_days, 0) > 0))
