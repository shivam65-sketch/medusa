{{ config(materialized = 'table') }}

-- Gold: is each day's data complete? One row per UTC day, for the dashboard's Data health page.
-- Counts coins whose candles or metrics are incomplete, and coins that appeared or disappeared
-- compared with the day before. Rebuilt from coin_daily on every run (cheap: ~870 rows a day).

with coin_days as (
    select
        symbol,
        trade_date,
        minutes,
        metric_snapshots,
        last_bronze_loaded_at,
        lag(trade_date)  over (partition by symbol order by trade_date) as previous_date,
        lead(trade_date) over (partition by symbol order by trade_date) as next_date
    from {{ ref('coin_daily') }}
),

days as (
    select
        trade_date,
        count(*)                                                     as coins,
        count_if(minutes = 1440)                                     as coins_complete_candles,
        count(*) * 1440 - sum(minutes)                               as missing_minutes,
        count_if(metric_snapshots > 0)                               as coins_with_metrics,
        count_if(metric_snapshots = 288)                             as coins_complete_metrics,
        sum(case when metric_snapshots > 0 then 288 - metric_snapshots else 0 end)
                                                                     as missing_metric_snapshots,
        -- New: no row the day before. The very first day in the table counts every coin as new.
        count_if(previous_date is null or previous_date <> date_sub(trade_date, 1)) as coins_new,
        max(last_bronze_loaded_at)                                   as last_loaded_at
    from coin_days
    group by trade_date
),

-- Coins that traded on a day but have no row the next day.
dropped as (
    select date_add(trade_date, 1) as trade_date, count(*) as coins_dropped
    from coin_days
    where next_date is null or next_date <> date_add(trade_date, 1)
    group by date_add(trade_date, 1)
)

select
    d.trade_date,
    d.coins,
    d.coins_complete_candles,
    d.coins - d.coins_complete_candles                               as coins_incomplete_candles,
    d.missing_minutes,
    d.coins_with_metrics,
    d.coins_complete_metrics,
    d.coins_with_metrics - d.coins_complete_metrics                  as coins_incomplete_metrics,
    d.missing_metric_snapshots,
    d.coins_new,
    coalesce(x.coins_dropped, 0)                                     as coins_dropped,
    d.last_loaded_at,
    case when d.coins = d.coins_complete_candles and coalesce(x.coins_dropped, 0) = 0
         then 'complete' else 'check' end                            as candle_status
from days d
left join dropped x on x.trade_date = d.trade_date
