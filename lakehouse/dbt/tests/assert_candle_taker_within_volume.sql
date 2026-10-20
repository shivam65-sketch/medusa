-- Aggressive buying is part of the volume, so it can never be larger than it.
{{ config(severity = 'warn') }}

select symbol, open_time, volume, taker_buy_volume
from {{ ref('fct_candle_1m') }}
where taker_buy_volume > volume