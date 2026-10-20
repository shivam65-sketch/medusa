{{ config(materialized = 'table') }}

-- Gold: the whole market, one row per UTC day: how many coins rose and fell, how much traded,
-- and how Bitcoin and Ethereum did. Returns and shares are fractions (0.05 = 5%).
--
-- A plain table rebuilt on every run: coin_daily has only about 870 rows a day, so rebuilding
-- this from it is cheap and always consistent. Not everything needs to be incremental.

with days as (
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
    from {{ ref('coin_daily') }}
    group by trade_date
)

select
    trade_date,
    coins,
    coins_up,
    coins_down,
    coins_flat,
    -- Breadth: the share of coins that moved and went up (0.5 = as many up as down).
    coins_up / nullif(coins_up + coins_down, 0)                     as breadth,
    coins_moved_20pct,
    median_return_1d,
    volume_weighted_return_1d,
    median_realized_volatility_1d,
    quote_volume,
    btc_quote_volume / nullif(quote_volume, 0)                      as btc_volume_share,
    taker_buy_share,
    open_interest_usdt,
    btc_return_1d,
    eth_return_1d
from days
