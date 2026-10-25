-- 001_table_tags.sql
-- Tags on the tables that dbt doesn't build (lakehouse step 30): the bronze streaming tables, made by
-- the Lakeflow pipeline, and the two semantic tables, made by the DDL files. dbt tags silver and gold
-- itself on every run (databricks_tags in dbt_project.yml).
--   domain         which catalog's kind of data
--   layer          landing, bronze, silver, gold or semantic
--   personal_data  true when a table holds anything about a person (an account number or a name)
--
-- Run by the job lakehouse-tag-tables, after setup_ddl and after the bronze pipeline has run at least
-- once (the bronze tables exist only then). Safe to run again: SET TAGS replaces a tag's value.

ALTER STREAMING TABLE market.bronze.klines_1m SET TAGS ('domain' = 'market', 'layer' = 'bronze', 'personal_data' = 'false');
ALTER STREAMING TABLE market.bronze.klines_1h SET TAGS ('domain' = 'market', 'layer' = 'bronze', 'personal_data' = 'false');
ALTER STREAMING TABLE market.bronze.metrics SET TAGS ('domain' = 'market', 'layer' = 'bronze', 'personal_data' = 'false');

-- The shared definitions name who made each version (MEDUSA display names, shown on the page).
ALTER TABLE market.semantic.metric_definitions SET TAGS ('domain' = 'market', 'layer' = 'semantic', 'personal_data' = 'false');
-- Each account's own versions: account numbers and names.
ALTER TABLE market.semantic.user_metric_definitions SET TAGS ('domain' = 'market', 'layer' = 'semantic', 'personal_data' = 'true');
