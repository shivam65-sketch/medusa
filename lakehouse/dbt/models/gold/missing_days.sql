{{ config(materialized = 'table') }}

-- Gold: the days that should be in the lakehouse and aren't. One row per day; no rows is the good
-- answer. Every other test checks the rows that exist, so a day that never arrived passes them all
-- (2026-10-28 did): this compares the calendar with the days in coin_daily. Rebuilt every run, so a
-- day leaves the table by itself when its data arrives.
--
-- status says who is dealing with the day:
--   waiting    yesterday: the daily load hasn't had its turn yet, which is normal until it runs
--   retrying   2 to 8 days old: the daily load tries it again every day (lakehouse-daily.yml)
--   manual     older than that: nothing tries it any more, so it has to be loaded by hand

with loaded as (
    select distinct trade_date
    from {{ ref('coin_daily') }}
),

calendar as (
    select explode(sequence(min(trade_date), date_sub(current_date(), 1))) as trade_date
    from loaded
)

select
    c.trade_date,
    case when datediff(current_date(), c.trade_date) = 1  then 'waiting'
         when datediff(current_date(), c.trade_date) <= 8 then 'retrying'
         else 'manual' end                                               as status,
    datediff(current_date(), c.trade_date)                               as days_old
from calendar c
left join loaded l on l.trade_date = c.trade_date
where l.trade_date is null
