-- Every coin has at most one candle per hour. Any row returned is a duplicate (the test fails).
select symbol, hour_start, count(*) as copies
from {{ ref('fct_candle_1h') }}
group by symbol, hour_start
having count(*) > 1
