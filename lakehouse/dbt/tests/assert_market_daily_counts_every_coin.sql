-- Reconciliation: market_daily must count every coin in coin_daily, day by day, and its up, down
-- and flat coins must add up to the coins that have a return. Any row returned doesn't add up.
with coin_counts as (
    select trade_date,
           count(*)          as coins,
           count(return_1d)  as coins_with_return
    from {{ ref('coin_daily') }}
    group by trade_date
)

select c.trade_date, c.coins, m.coins as market_coins,
       c.coins_with_return, m.coins_up + m.coins_down + m.coins_flat as market_coins_with_return
from coin_counts c
left join {{ ref('market_daily') }} m on m.trade_date = c.trade_date
where m.trade_date is null
   or m.coins <> c.coins
   or m.coins_up + m.coins_down + m.coins_flat <> c.coins_with_return
