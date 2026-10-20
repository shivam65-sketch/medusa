-- Each coin has exactly one current version (dbt_valid_to = 9999-12-31).
select symbol, count(*) as current_versions
from {{ ref('dim_coin') }}
where dbt_valid_to = cast('9999-12-31' as timestamp)
group by symbol
having count(*) <> 1