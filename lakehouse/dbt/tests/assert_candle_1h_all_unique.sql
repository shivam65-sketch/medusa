-- The continuous series has at most one candle per coin per hour: the archive and the minute-built
-- hours never overlap in it. Any row returned is a duplicate (the test fails).
select symbol, hour_start, count(*) as copies
from {{ ref('int_candle_1h_all') }}
group by symbol, hour_start
having count(*) > 1
