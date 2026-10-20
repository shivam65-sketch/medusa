-- One row per coin per hour, hours 0 to 23, at least one day behind each row, and a taker-buy share
-- between 0 and 1. Any row returned breaks one of those rules.
select symbol, utc_hour, days, avg_taker_buy_share, count(*) over (partition by symbol, utc_hour) as copies
from {{ ref('hour_profile') }}
qualify count(*) over (partition by symbol, utc_hour) > 1
     or utc_hour not between 0 and 23
     or days < 1
     or avg_taker_buy_share not between 0 and 1
