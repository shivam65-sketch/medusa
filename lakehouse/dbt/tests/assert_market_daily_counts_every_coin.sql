-- Reconciliation: market_daily must account for every coin in coin_daily, day by day: the coins
-- that traded plus the inactive ones make up all of them, and the traded coins' up, down and flat
-- counts must add up to the traded coins that have a return. Any row returned doesn't add up.
with coin_counts as (
    select trade_date,
           count(*)                                       as coins,
           count_if(trades > 0)                           as active_coins,
           count_if(trades > 0 and return_1d is not null) as active_coins_with_return
    from {{ ref('coin_daily') }}
    group by trade_date
)

select c.trade_date, c.coins, m.coins + m.coins_inactive as market_coins,
       c.active_coins, m.coins as market_active_coins,
       c.active_coins_with_return, m.coins_up + m.coins_down + m.coins_flat as market_coins_with_return
from coin_counts c
left join {{ ref('market_daily') }} m on m.trade_date = c.trade_date
where m.trade_date is null
   or m.coins + m.coins_inactive <> c.coins
   or m.coins <> c.active_coins
   or m.coins_up + m.coins_down + m.coins_flat <> c.active_coins_with_return
