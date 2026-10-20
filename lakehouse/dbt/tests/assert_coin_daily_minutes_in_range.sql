-- A day is built from 1 to 1,440 minutes. Anything else means the roll-up grouped wrongly.
select symbol, trade_date, minutes
from {{ ref('coin_daily') }}
where minutes < 1
   or minutes > 1440
