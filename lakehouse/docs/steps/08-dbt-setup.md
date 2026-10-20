# Step 8: dbt installed and connected

[← Lakehouse home](../../README.md) · [← Step 7](07-bronze-pipeline.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Files** | [`dbt/requirements.txt`](../../dbt/requirements.txt) · [`dbt/dbt_project.yml`](../../dbt/dbt_project.yml) · [`dbt/profiles.yml`](../../dbt/profiles.yml) · [`dbt/macros/generate_schema_name.sql`](../../dbt/macros/generate_schema_name.sql) · [`.gitignore`](../../.gitignore) |

## Goal

Install dbt, connect it to the SQL warehouse, and set up an empty project that builds into
`market.silver` and `market.gold`.

## Concepts

| Concept | Here |
|---|---|
| **dbt** | Each table is written as a plain `SELECT`. dbt turns it into DDL (`CREATE TABLE … AS`, or `MERGE` for incremental tables), runs models in dependency order, tests the results and generates documentation with lineage. |
| **Virtual environment** | dbt is installed only inside `lakehouse/.venv`, not into the system Python; deleting the folder removes it. |
| **Pinned versions** | `requirements.txt` fixes `dbt-databricks==1.12.7` (which brings dbt-core 1.12.5), so every machine and the daily job use the same versions. |
| **`profiles.yml` from environment variables** | The connection file is committed with no secrets in it: host, HTTP path and token come from environment variables. |
| **`DBT_ENV_SECRET_…`** | dbt hides variables with this prefix from its logs, so the token's variable uses it. |
| **HTTP path** | The address of the SQL warehouse (`/sql/1.0/warehouses/<id>`); dbt runs its SQL there. |
| **Schema name override** | By default dbt would build into `silver_gold`-style schemas; `generate_schema_name` keeps the exact names. |

## Code walkthrough

`profiles.yml`: the connection, with every value from the environment:

```yaml
medusa_lakehouse:
  target: prod
  outputs:
    prod:
      type: databricks
      catalog: market
      schema: silver
      host: "{{ env_var('DBT_DATABRICKS_HOST') }}"
      http_path: "{{ env_var('DBT_DATABRICKS_HTTP_PATH') }}"
      token: "{{ env_var('DBT_ENV_SECRET_DATABRICKS_TOKEN') }}"
      threads: 4
```

`dbt_project.yml` maps the `models/silver/` and `models/gold/` folders to their schemas, and
`macros/generate_schema_name.sql` makes dbt use those names exactly.

## How to run

From `lakehouse/`:

```
python -m venv .venv
.venv/Scripts/python -m pip install -r dbt/requirements.txt
```

Set three user environment variables (Start → *Edit environment variables for your account*), then
open a new terminal:

| Variable | Value |
|---|---|
| `DBT_DATABRICKS_HOST` | Workspace address without `https://` |
| `DBT_DATABRICKS_HTTP_PATH` | `/sql/1.0/warehouses/<warehouse id>` |
| `DBT_ENV_SECRET_DATABRICKS_TOKEN` | A personal access token (`medusa-dbt-local`, 90 days) |

From `lakehouse/dbt/`: `../.venv/Scripts/dbt debug`

## Result

`dbt debug`: `Connection test: [OK connection ok]`, `All checks passed!`. The venv takes about
650 MB and 3–4 minutes to install (dbt brings pandas and pyarrow with it, inside the venv).

## Problems we hit

| Problem | How it showed | Fix |
|---|---|---|
| Copied HTTP path had the workspace number on the end | `http_path contains ?o=…`, then `http-code=404, method=OpenSession` | The value must be exactly `/sql/1.0/warehouses/<id>`, with nothing after it |
| HTTP path typed without `1.0` | `http_path: /sql/warehouses/…`, again 404 | `/sql/1.0/warehouses/<id>`, copied rather than typed |
| (While testing) a venv in a very deep folder failed to install | `OSError … does not have Windows Long Path support enabled` | Keep the venv's path short; `lakehouse/.venv` is fine (the deepest file is about 230 characters, under Windows' 260 limit) |
