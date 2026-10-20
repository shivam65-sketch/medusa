-- An hour is built from 1 to 60 minutes. Anything else means the roll-up grouped wrongly.
select symbol, hour_start, minutes
from {{ ref('fct_candle_1h') }}
where minutes < 1
   or minutes > 60
