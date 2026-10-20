{{ config(materialized = 'view') }}

-- Each coin's current description, worked out from the candles: what it is (base asset and the
-- multiplier in names like 1000PEPEUSDT), when it first traded, and whether it trades now.
-- The dim_coin snapshot records every change to this, so coin history is never lost.
--
-- Read from the hourly candles: the same days as the 1-minute table, at a fraction of the rows.

with days as (
    select
        symbol,
        min(candle_date)                               as first_candle_date,
        -- Binance keeps publishing flat, zero-volume candles for contracts it has delisted
        -- ("settling"), so having candles doesn't prove a coin trades. Having trades does.
        max(case when trades > 0 then candle_date end) as last_trade_date
    from {{ ref('fct_candle_1h') }}
    group by symbol
),

latest as (
    select max(candle_date) as latest_date
    from {{ ref('fct_candle_1h') }}
),

parsed as (
    select
        days.*,
        latest.latest_date,
        -- Names like 1000PEPEUSDT or 1MBABYDOGEUSDT quote 1,000 or 1,000,000 coins per contract.
        regexp_extract(symbol, '^(1000000|100000|10000|1000|1M)(?=[A-Z])', 1) as prefix
    from days
    cross join latest
)

select
    symbol,
    regexp_replace(regexp_replace(symbol, '^(1000000|100000|10000|1000|1M)(?=[A-Z])', ''), 'USDT$', '') as base_asset,
    'USDT' as quote_asset,
    case prefix when '' then 1 when '1M' then 1000000 else cast(prefix as int) end as multiplier,
    first_candle_date,
    -- A coin counts as no longer trading after 3 days without a single trade, so one late file
    -- doesn't create a false "delisted" version in the history.
    case when last_trade_date >= date_sub(latest_date, 2) then 'trading' else 'not trading' end as status
from parsed
