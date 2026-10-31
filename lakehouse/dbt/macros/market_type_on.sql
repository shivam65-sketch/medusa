{#
  What kind of market a symbol was on a given day, from dim_market_type (joined as `list`).
  A stock or commodity contract can take over an old crypto ticker: MDTUSDT was a token until 2024 and
  has been Medtronic since 2026. Before its listing day, the moves were the old market's.
  A symbol not in the list is 'unknown'; assert_market_types_known warns about those.
#}
{% macro market_type_on(list, day) -%}
    case when {{ list }}.symbol is null then 'unknown'
         when {{ list }}.market_type in ('stock', 'commodity') and {{ day }} < {{ list }}.onboard_date then 'crypto'
         else {{ list }}.market_type end
{%- endmacro %}
