-- Open interest and the long/short ratios can be 0 (a quiet coin) but never negative.
{{ config(severity = 'warn') }}

select symbol, metric_time, open_interest, open_interest_usdt,
       top_trader_account_ratio, top_trader_position_ratio,
       account_long_short_ratio, taker_buy_sell_ratio
from {{ ref('fct_metrics_5m') }}
where open_interest < 0
   or open_interest_usdt < 0
   or top_trader_account_ratio < 0
   or top_trader_position_ratio < 0
   or account_long_short_ratio < 0
   or taker_buy_sell_ratio < 0