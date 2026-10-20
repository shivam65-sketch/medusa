-- Snapshots are taken every 5 minutes, on the minute: 00:00, 00:05, ... 23:55.
{{ config(severity = 'warn') }}

select symbol, metric_time
from {{ ref('fct_metrics_5m') }}
where minute(metric_time) % 5 <> 0
   or second(metric_time) <> 0