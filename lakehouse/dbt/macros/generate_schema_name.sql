{#
  By default dbt glues the profile's schema onto a model's schema ("silver_gold").
  This keeps the exact name instead, so models land in market.silver and market.gold.
#}
{% macro generate_schema_name(custom_schema_name, node) -%}
    {%- if custom_schema_name is none -%}
        {{ target.schema }}
    {%- else -%}
        {{ custom_schema_name | trim }}
    {%- endif -%}
{%- endmacro %}