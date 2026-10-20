{{ config(materialized = 'table') }}

-- Gold: the whole market, one row per UTC day: how many coins rose and fell, how much traded,
-- and how Bitcoin and Ethereum did. Returns and shares are fractions (0.05 = 5%).
--
-- Only coins that traded that day are counted. Binance keeps publishing flat, zero-volume candles
-- for contracts it has delisted ("settling", about 130 a day); counting them added that many
-- "unchanged" coins and pulled the median return to exactly 0. They are counted separately in
-- coins_inactive.
--
-- A plain table rebuilt on every run: coin_daily has only about 870 rows a day, so rebuilding
-- this from it is cheap and always consistent. Not everything needs to be incremental.

with active as (
    select *
    from {{ ref('coin_daily') }}
    where trades > 0
),

inactive as (
    select trade_date, count(*) as coins_inactive
    from {{ ref('coin_daily') }}
    where trades = 0
    group by trade_date
),

days as (
    select
        trade_date,
        count(*)                                                    as coins,
        count_if(return_1d > 0)                                     as coins_up,
        count_if(return_1d < 0)                                     as coins_down,
        count_if(return_1d = 0)                                     as coins_flat,
        count_if(abs(return_1d) >= 0.2)                             as coins_moved_20pct,
        percentile(return_1d, 0.5)                                  as median_return_1d,
        -- Each coin's return weighted by how much of it traded.
        sum(return_1d * quote_volume) / nullif(sum(case when return_1d is not null then quote_volume end), 0)
                                                                    as volume_weighted_return_1d,
        percentile(realized_volatility_1d, 0.5)                     as median_realized_volatility_1d,
        sum(quote_volume)                                           as quote_volume,
        sum(taker_buy_share * quote_volume) / nullif(sum(case when taker_buy_share is not null then quote_volume end), 0)
                                                                    as taker_buy_share,
        sum(open_interest_close_usdt)                               as open_interest_usdt,
        sum(case when symbol = 'BTCUSDT' then quote_volume end)     as btc_quote_volume,
        max(case when symbol = 'BTCUSDT' then return_1d end)        as btc_return_1d,
        max(case when symbol = 'ETHUSDT' then return_1d end)        as eth_return_1d
    from active
    group by trade_date
)

select
    d.trade_date,
    d.coins,
    coalesce(i.coins_inactive, 0)                                   as coins_inactive,
    d.coins_up,
    d.coins_down,
    d.coins_flat,
    -- Breadth: the share of coins that moved and went up (0.5 = as many up as down).
    d.coins_up / nullif(d.coins_up + d.coins_down, 0)               as breadth,
    d.coins_moved_20pct,
    d.median_return_1d,
    d.volume_weighted_return_1d,
    d.median_realized_volatility_1d,
    d.quote_volume,
    d.btc_quote_volume / nullif(d.quote_volume, 0)                  as btc_volume_share,
    d.taker_buy_share,
    d.open_interest_usdt,
    d.btc_return_1d,
    d.eth_return_1d
from days d
left join inactive i on i.trade_date = d.trade_date
