# Step 30: Catalog layout

[← Lakehouse home](../../README.md) · [← Step 29](29-patterns-on-sql-and-release.md)

| | |
|---|---|
| **Built** | 2026-10-25 |
| **Commit** | the step 30 commit |
| **Files** | [`sql/ddl/006_layout.sql`](../../sql/ddl/006_layout.sql) (catalogs, schema descriptions and tags) · [`sql/governance/001_table_tags.sql`](../../sql/governance/001_table_tags.sql) (tags on the tables dbt doesn't build) · [`databricks.yml`](../../databricks.yml) (task `create_layout`, job `tag_tables`) · [`dbt/dbt_project.yml`](../../dbt/dbt_project.yml) (`persist_docs`, `databricks_tags`) · the dbt YAML files (the missing descriptions) · [`pipelines/bronze/`](../../pipelines/bronze/) (each column declared with its description) |
| **Decisions** | [ADR-032](../decisions.md#adr-032-one-catalog-per-kind-of-data-described-and-tagged-in-place-no-renames) |

## Goal

The owner's note: the order and grouping of schemas and tables in Databricks should make sense. Two
more things made this the moment to settle it. Step 31 adds logs and step 32 adds each account's
private trades, two kinds of data that don't belong in `market`. And Catalog Explorer, the first thing
an interviewer or a new colleague opens, explained very little: most tables had no description at all.

This step decides where every kind of data lives before the new kinds arrive, and makes Databricks
explain itself. Every schema now shows its place in the flow, and every table and column has a
description. Every table is also labelled with what kind of data it holds and whether it holds anything
about a person.

## What it looked like before

| What | Before | Why it was a problem |
|---|---|---|
| Schema order | Catalog Explorer lists schemas alphabetically: `bronze`, `default`, `gold`, `landing`, `semantic`, `silver` | The flow (landing → bronze → silver → gold → semantic) can't be read from the list |
| `market.default` | Created by Databricks with the catalog, never used, empty | A schema that means nothing, first in the middle of the list |
| Schema descriptions | Written in step 1; gold's said *Daily tables the dashboard reads* | Out of date: gold now feeds the live scanner, its evidence and analysis |
| Silver and gold tables | 7 silver and 8 gold objects: no table description, no column descriptions. dbt's YAML described almost all of them, but only dbt's own docs showed it | Databricks showed column names and types only |
| Bronze tables | A table description each, no column descriptions | `count`, `ignore` or `_rescued_data` explained nowhere in Databricks |
| Semantic tables | Fully described (written by their DDL in steps 27 and 28) | Nothing |
| Tags | None | Nothing said which tables hold personal data (`user_metric_definitions` holds account numbers and names) |
| Logs and private trades | No place for either | Steps 31 and 32 would have had to choose under pressure |

## Concepts

| Concept | Here | In SQL Server terms |
|---|---|---|
| **Catalog per domain** | Unity Catalog's top level is the natural permission and ownership boundary: `GRANT USE CATALOG` opens one domain's data and nothing else. So each kind of data gets its own catalog: public market data, private trades, operational logs | A database per application, with logins mapped to the databases they need |
| **Layers as schemas** | Inside `market`, each medallion layer is a schema; the schema says how processed a table is | Schemas such as `stg`, `dw`, `mart` inside one database |
| **Comments as documentation** | `COMMENT ON` a catalog, schema, table or column; Catalog Explorer, `information_schema` and `DESCRIBE TABLE` show it | The `MS_Description` extended property, shown by SSMS |
| **`persist_docs` (dbt)** | dbt writes the descriptions from its YAML files into Databricks as table and column comments on every build, so one text is kept in Git and shown in both places | Generating `sp_addextendedproperty` calls from a data model tool |
| **Tags** | `key = value` labels on catalogs, schemas, tables and columns. They can be searched in Catalog Explorer and queried in `information_schema.*_tags`, and they are what governance rules and audits select on | Data classification (`ADD SENSITIVITY CLASSIFICATION`) or extended properties used as labels |
| **A pipeline owns its tables** | The bronze streaming tables belong to the Lakeflow pipeline, which rebuilds their definition on each update. A comment must therefore come from the pipeline's own definition (each column declared with `COMMENT`); a separate `COMMENT ON` would be refused or overwritten | A table owned by a replication or CDC process: change its definition there, not by hand |
| **Naming convention** | Written rules for names (below), so a name says what a table is without opening it | The same, e.g. `dim_`/`fact_` prefixes in a warehouse |

## The layout

```
market        Public crypto market data: Binance USD-M futures, from the raw files to the numbers MEDUSA shows
│             tags: domain=market, personal_data=false
├─ landing    1 of 5 · Landing    volume binance (Binance's files, checksum-verified)
├─ bronze     2 of 5 · Bronze     klines_1m · klines_1h · metrics (+ the pipeline's internal tables)
├─ silver     3 of 5 · Silver     fct_candle_1m · fct_candle_1h · fct_candle_1h_archive · fct_metrics_5m
│                                 dim_coin · int_candle_1h_all · int_coin_status
├─ gold       4 of 5 · Gold       coin_daily · market_daily · data_health · unusual_moves · hour_profile
│                                 coin_baseline · intraday_events · event_evidence
└─ semantic   5 of 5 · Semantic   metric_definitions · user_metric_definitions

journal       Private: the trades of each MEDUSA account (step 32); schemas created when step 32 needs them
              tags: domain=journal, personal_data=true

ops           Operations: logs of the lakehouse pipelines and of MEDUSA
│             tags: domain=ops, personal_data=false
└─ logs       pipeline_events · app_events (step 31)
```

The other catalogs in the workspace are not part of MEDUSA and are left alone: `prod` (another
project), `workspace` (Databricks' default catalog for practice), `samples` and `system` (Databricks').

Schemas are still listed alphabetically, since Databricks offers no other order, but each description
now starts with its place in the flow, so the list reads in order at a glance.

The bronze schema also shows the pipeline's own tables (`__materialization_…` and `event_log_…`). They
belong to the pipeline and are never touched by hand; step 31 decides where the pipeline's event log
should be published.

## Naming rules

| Level | Rule | Examples |
|---|---|---|
| Catalog | One per kind of data and permission boundary; a short lowercase noun | `market`, `journal`, `ops` |
| Schema | In `market` and later `journal`: the layer. In `ops`: what it holds | `bronze`, `gold`, `logs` |
| Bronze table | The source dataset's own name, so it can be traced back to the source | `klines_1m`, `metrics` |
| Silver table | `fct_` for facts (one row per measurement), `dim_` for dimensions (what is measured), `int_` for building blocks other models read (views); then the subject and its grain | `fct_candle_1m`, `dim_coin`, `int_candle_1h_all` |
| Gold table | The business name a reader would ask for, with its grain where it helps | `coin_daily`, `event_evidence` |
| Column | `snake_case`; the unit or meaning in the name where it isn't obvious: `_at` for a timestamp, `_date` for a date, `_usdt` for a USDT amount, `_30d` for a 30-day window | `loaded_at`, `candle_date`, `open_interest_usdt`, `sd_return_30d` |
| Tags | The same three keys everywhere: `domain`, `layer`, `personal_data` | below |

The existing names already follow these rules, which is one reason nothing is renamed.

## Tags

| Tag | On | Values | Meaning |
|---|---|---|---|
| `domain` | Catalogs and tables | `market`, `journal`, `ops` | Which kind of data, the same as the catalog it lives in |
| `layer` | Schemas and tables | `landing`, `bronze`, `silver`, `gold`, `semantic`, `logs` | How processed the data is |
| `personal_data` | Catalogs and tables | `true`, `false` | `true` when the table holds anything about a person: an account number or a name. Only `market.semantic.user_metric_definitions` today, and everything in `journal` |

Who sets them:

| Objects | Set by | When |
|---|---|---|
| Catalogs and schemas | [`006_layout.sql`](../../sql/ddl/006_layout.sql), task `create_layout` of job `setup_ddl` | Once, and again whenever setup_ddl runs |
| Silver and gold tables, the `dim_coin` snapshot | dbt (`+databricks_tags` in `dbt_project.yml`: `domain` and `personal_data` for the whole project, `layer` per folder; the two are merged) | Every `dbt build` |
| Bronze streaming tables, the two semantic tables | [`001_table_tags.sql`](../../sql/governance/001_table_tags.sql), job `tag_tables` | Once, after setup_ddl and the first bronze run, and again whenever a table is re-created |

## Built in three parts

### 30.1 A description for every table and column

- **dbt (silver and gold).** The YAML files were compared with the real columns in
  `market.information_schema.columns`. 17 columns had no description: the 9 columns of
  `int_candle_1h_all`, `dbt_scd_id` and `dbt_updated_at` in `dim_coin`, and `int_coin_status`, which
  had no entry at all (6 columns). All 223 columns of the 15 silver and gold objects are now described,
  and no YAML column is missing from its table (`persist_docs` would fail on one). `persist_docs`
  (relation and columns) writes them into Databricks on every build.
- **Bronze.** Each pipeline file now declares its columns, each with a `COMMENT`, in the order and
  with the types the table already has, so only the descriptions change. No apostrophes: in Databricks
  `''` inside a string joins two strings instead of meaning one apostrophe.
- **Schemas and catalog.** `006_layout.sql` replaces the step 1 descriptions with the layer-numbered
  ones above. The file that wrote the old ones, `002_schemas.sql`, is not edited: a DDL file that has
  run never is ([ADR-006](../decisions.md#adr-006-ddl-as-numbered-re-runnable-files)).

### 30.2 Tags

`006_layout.sql` tags the catalogs and schemas; `dbt_project.yml` gives dbt the tags for every model
and the snapshot (dbt-databricks applies them with `ALTER … SET TAGS` after each build);
`001_table_tags.sql` tags the five tables dbt doesn't build. It is a separate job because it can only
run once the bronze pipeline has created its tables.

### 30.3 The new catalogs, and the empty schema

`006_layout.sql` creates `ops` with the schema `logs` for step 31, and `journal` for step 32 (its
schemas wait until step 32 designs them). Databricks creates a `default` schema in every new catalog;
the file drops it in `market`, `ops` and `journal`. `DROP SCHEMA` without `CASCADE` refuses to drop a
schema that holds anything, so nothing can be lost.

The file runs as the last task of `setup_ddl`, after the semantic tables and the volume, so a new
workspace gets the whole layout from one job.

## Why nothing is renamed

Renaming `market` to something like `market_data`, or the layers to `01_landing` … `05_semantic`,
was considered and rejected. The current names are referred to by:

- dbt's sources and every model;
- the bronze pipeline's volume paths;
- the publish job;
- the service principal's grants;
- the Markets page's **Copy for Databricks** queries;
- the published metric definitions;
- every page of these docs.

A rename would break all of them at once for a gain a description gives for free, and the numbered
schema names would look odd in every query. The descriptions carry the order; the names stay what
they are.

## How it is applied

From `lakehouse/`, in this order:

| # | Command | What it does |
|---|---|---|
| 1 | `databricks bundle deploy` | Uploads the new files, the `create_layout` task and the `tag_tables` job |
| 2 | `databricks bundle run setup_ddl` | Six tasks; the last, `create_layout`, writes the descriptions and tags and creates `ops`, `ops.logs` and `journal` |
| 3 | `databricks bundle run bronze --validate-only` | Checks the new column declarations against the existing tables without loading anything |
| 4 | From `lakehouse/dbt/`: `../.venv/Scripts/dbt build` | Builds silver and gold as every day, and writes their descriptions and tags. GitHub's **Lakehouse transform** would do the same, but it runs the code that is committed, so this runs from the computer before the commit |
| 5 | `databricks bundle run tag_tables` | Tags the bronze and semantic tables |

## Checks before the run

| Check | Result |
|---|---|
| dbt descriptions against the real columns | 223 of 223 columns described; no YAML column missing from its table |
| dbt | `dbt parse` OK with `persist_docs` and `databricks_tags` |
| The bundle | `databricks bundle validate` OK (task `create_layout`, job `tag_tables`) |
| The SQL | Every statement of `006_layout.sql` and `001_table_tags.sql` planned with `EXPLAIN` in Databricks without running it. The only refusal was `CREATE SCHEMA ops.logs` (*catalog `ops` was not found*): the check runs each statement alone, and in the file the catalog is created two lines earlier |
| dbt and apostrophes | dbt-databricks 1.12.7 escapes `'` in table and column comments itself (`\'`), and no description contains a backslash |

## Result

Applied on 2026-10-25 and checked in `information_schema`:

| Check | Result |
|---|---|
| Catalogs and schemas | `market`, `ops` (with `logs`) and `journal`, each with its description; the five `market` schemas read "1 of 5 · Landing" to "5 of 5 · Semantic"; no `default` schema in any of the three; the catalog tags and each schema's `layer` tag in place |
| Bronze | The validate-only update completed without touching a table. The next real update wrote the descriptions of all 49 bronze columns, with no full refresh |
| Silver and gold | `dbt build`: all 15 tables and all 223 columns described (gold 8 and 138, silver 7 and 85); all 15 tagged `domain=market`, `layer`, `personal_data=false` |
| Bronze and semantic tags | `tag_tables`: 5 tables with 3 tags each; `personal_data=true` only on `user_metric_definitions` |
| Data | Unchanged. The daily run, which happened to start during the step, loaded 24 October as usual (1,261,440 candle rows, 202,015 metrics rows) |

## Problems we hit

- **Deployed versus committed.** GitHub started the daily run late, in the middle of this step. Its
  bronze update used the pipeline definitions deployed from the computer an hour earlier, so it wrote
  the bronze descriptions; its `dbt build` ran the code committed on GitHub, so it wrote none.
  `databricks bundle run` uses whatever was last deployed, while GitHub Actions always runs what is
  committed. The dbt part was therefore run from the computer, checked, and committed afterwards.

- **Comments on streaming tables.** A bronze table's description can't be set with `COMMENT ON` or
  `ALTER TABLE`: the pipeline owns the table and its definition. The descriptions had to go into the
  pipeline's SQL as declared columns, which also meant repeating each column's type exactly, so that
  only the descriptions change.
- **Gaps only a comparison finds.** dbt's docs looked complete, but comparing the YAML with the real
  columns found 17 without a description, mostly columns added after their model was first documented.
  The comparison is the check to repeat whenever a model gains a column.
- **The `default` schema comes back.** Every new catalog gets one, so the file drops it right after each
  `CREATE CATALOG`, not once at the end.
