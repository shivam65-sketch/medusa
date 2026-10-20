-- Every coin has at most one candle per minute. Any row returned is a duplicate (the test fails).
select symbol, open_time, count(*) as copies
from {{ ref('fct_candle_1m') }}
group by symbol, open_time
having count(*) > 1