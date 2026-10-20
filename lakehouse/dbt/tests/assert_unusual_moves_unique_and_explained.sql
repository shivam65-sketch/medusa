-- Each coin-day appears at most once, has at least 20 days of history behind its scores, and says
-- why it is unusual. Any row returned breaks one of those rules.
select symbol, trade_date, history_days, reasons, count(*) over (partition by symbol, trade_date) as copies
from {{ ref('unusual_moves') }}
qualify count(*) over (partition by symbol, trade_date) > 1
     or history_days < 20
     or reasons = ''
