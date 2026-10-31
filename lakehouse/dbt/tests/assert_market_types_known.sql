-- A trading market that dim_market_type doesn't list yet: Binance has added it since the file was last
-- refreshed. A warning, not an error: until it is listed its moves are 'unknown', which keeps them out
-- of the evidence and shows it as not tested. To clear it, run ingest/refresh_market_types.py and commit
-- the file.
{{ config(severity = 'warn') }}

select b.symbol
from {{ ref('coin_baseline') }} b
left join {{ ref('dim_market_type') }} t on t.symbol = b.symbol
where t.symbol is null
  and b.status = 'trading'
