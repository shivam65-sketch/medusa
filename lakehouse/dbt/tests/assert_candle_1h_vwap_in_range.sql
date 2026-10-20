-- The hour's average price must lie between its low and high.
-- Floating-point division can land a hair outside (12.810000000000002 for a high of 12.81), so a
-- difference of up to one part in a billion is allowed. Warn rather than fail.
{{ config(severity = 'warn') }}

select symbol, hour_start, low, high, vwap
from {{ ref('fct_candle_1h') }}
where vwap < low * (1 - 1e-9)
   or vwap > high * (1 + 1e-9)
