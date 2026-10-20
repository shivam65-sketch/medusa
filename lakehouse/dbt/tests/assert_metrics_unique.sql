-- Every coin has at most one snapshot per 5-minute time. Any row returned is a duplicate.
select symbol, metric_time, count(*) as copies
from {{ ref('fct_metrics_5m') }}
group by symbol, metric_time
having count(*) > 1