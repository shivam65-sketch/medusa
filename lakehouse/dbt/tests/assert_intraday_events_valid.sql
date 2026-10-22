-- Each coin-day has at most one event, and every event follows its own rule: |z| at or above the
-- line, direction and z_band agree with z, at least 20 days of history, the event hour falls on
-- the event day, a positive entry price, and the period matches the date.
-- Any row returned breaks one of those rules.
select symbol, event_date, event_hour, z, direction, z_band, history_days, entry_price, period,
       count(*) over (partition by symbol, event_date) as copies
from {{ ref('intraday_events') }}
qualify count(*) over (partition by symbol, event_date) > 1
     or abs(z) < {{ var('event_z') }}
     or direction <> case when z > 0 then 'up' else 'down' end
     or z_band <> case when abs(z) < 4 then '3-4' when abs(z) < 6 then '4-6' else '6+' end
     or history_days < 20
     or cast(event_hour as date) <> event_date
     or entry_price <= 0
     or period <> case when event_date < cast('{{ var("held_back_from") }}' as date)
                       then 'in_sample' else 'held_back' end
