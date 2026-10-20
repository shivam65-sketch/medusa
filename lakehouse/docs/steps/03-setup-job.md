# Step 3: Setup job (Asset Bundle)

[← Lakehouse home](../../README.md) · [← Step 2](02-databricks-cli.md) · Next: [Step 4 →](04-downloader.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `d76c089` Lakehouse: deploy config with the setup job |
| **Files** | [`databricks.yml`](../../databricks.yml) |

## Goal

Declare a job that runs the three DDL files in order on the SQL warehouse, deploy it from code and
run it.

## Concepts

- **Asset Bundle** (see [ADR-007](../decisions.md#adr-007-deploy-with-a-databricks-asset-bundle)):
  Databricks' infrastructure as code. The file says what should exist; `deploy` makes the workspace
  match it. Remove something from the file and deploy, and it's removed from Databricks too.
- **Variables with lookup:** the warehouse is found by its name at deploy time, so no IDs or
  workspace address are stored in the public repository.
- **Targets** are environments. There's one, `prod`, because Free Edition has a single workspace; a
  company would also have `dev` and `staging`.
- **Task dependencies** (`depends_on`) make the job a small DAG: if `001` fails, `002` never runs.
- **Deploy vs run:** `deploy` creates or updates definitions; `run` executes them.

## Code walkthrough

```yaml
bundle:
  name: medusa-lakehouse        # the bundle's name; deployed under .bundle/medusa-lakehouse/

variables:
  warehouse_id:
    lookup:
      warehouse: Serverless Starter Warehouse   # found by name when deploying

targets:
  prod:
    default: true               # the workspace address comes from the CLI profile

resources:
  jobs:
    setup_ddl:                  # the key used on the command line
      name: lakehouse-setup-ddl # the name shown in Databricks
      tasks:
        - task_key: create_catalog
          sql_task:
            warehouse_id: ${var.warehouse_id}
            file:
              path: ./sql/ddl/001_catalog.sql
        - task_key: create_schemas
          depends_on:
            - task_key: create_catalog
          # … sql_task for 002, then create_volumes for 003 the same way
```

## How to run

From `lakehouse/`:

| Command | What it does |
|---|---|
| `databricks bundle validate` | Checks the file without changing anything: well-formed YAML, known field names, the SQL files exist, and the warehouse lookup resolves to an ID. Like the Parse button in SQL Server Management Studio. |
| `databricks bundle deploy` | 1. Uploads the files to `/Workspace/Users/<your email>/.bundle/medusa-lakehouse/prod/files/`; the job runs this copy, so edits only count after the next deploy. 2. Creates or updates the job. 3. Saves a record of what it created in `…/prod/state`, so the next deploy knows what to change. |
| `databricks bundle run setup_ddl` | Starts the job and waits. Databricks starts the warehouse, runs 001, then 002, then 003. |

## Result

| Task | Result | Time |
|---|---|---|
| `create_catalog` | Success | 16 s (most of it starting the warehouse) |
| `create_schemas` | Success | 5 s |
| `create_volumes` | Success | 3 s |

Catalog `market` now holds `landing`, `bronze`, `silver`, `gold` (plus `default` and
`information_schema`, which Databricks adds to every catalog), and the managed volume
`market.landing.binance`. Running the job again succeeds and changes nothing.

## Problems we hit

| Problem | Cause | Fix |
|---|---|---|
| Couldn't find `/Workspace/Users/<you>/.bundle/…` | `<you>` stands for the account email; files are under **Workspace**, not **Catalog**; the dot-folder sorts to the top | Workspace → Users → your email → `.bundle`, or open the task's SQL file from the job page, or `databricks workspace list …` |
