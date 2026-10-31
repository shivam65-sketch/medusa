-- A day that should be in the lakehouse and isn't (yesterday can still be on its way). A warning, not
-- an error: stopping the run would hold back the days that did arrive. It shows in the run's dbt
-- output and in ops.logs.etl_errors, and the Markets page says so too.
{{ config(severity = 'warn') }}

select trade_date, status, days_old
from {{ ref('missing_days') }}
where status <> 'waiting'
