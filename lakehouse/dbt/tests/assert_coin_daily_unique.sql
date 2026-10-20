-- Every coin has at most one row per day. Any row returned is a duplicate (the test fails).
select symbol, trade_date, count(*) as copies
from {{ ref('coin_daily') }}
group by symbol, trade_date
having count(*) > 1
