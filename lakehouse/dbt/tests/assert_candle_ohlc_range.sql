-- A candle's open and close must lie between its low and high.
-- Warn rather than fail: a bad candle from Binance shouldn't stop the whole build.
{{ config(severity = 'warn') }}

select symbol, open_time, open, high, low, close
from {{ ref('fct_candle_1m') }}
where low > least(open, close)
   or high < greatest(open, close)