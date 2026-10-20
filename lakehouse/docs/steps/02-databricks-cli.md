# Step 2: Databricks CLI

[← Lakehouse home](../../README.md) · [← Step 1](01-ddl-scripts.md) · Next: [Step 3 →](03-setup-job.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | none (nothing in the repository changes) |
| **Tool** | Databricks CLI v1.21.0 |

## Goal

Connect the computer to the Databricks workspace, so jobs and pipelines can be deployed from code.

## Concepts

- **The CLI** reads project files and talks to Databricks' REST API over HTTPS. It's how
  deployments happen without clicking.
- **Authentication with a personal access token** (see [ADR-008](../decisions.md#adr-008-personal-access-tokens-for-authentication)):
  - A community report says OAuth sign-in isn't supported on Free Edition, so a token is the reliable route.
  - The token is a password: it lives in `~/.databrickscfg` in the home folder, outside the
    repository, so it can never be committed.
- **Storage and compute are separate.** Tables are files in cloud storage; a SQL warehouse is an
  engine that starts only to run queries and stops when idle. In SQL Server, the engine and the data
  files live together on one server.

## How to run

1. Install: `winget install Databricks.DatabricksCLI`, open a new terminal, check with `databricks -v`.
2. Create a token: Databricks → profile icon → **Settings → Developer → Access tokens → Generate new
   token**. Comment `medusa-cli`, lifetime 90 days.
3. Save the connection: `databricks configure`. It asks for the workspace address
   (`https://dbc-….cloud.databricks.com`) and the token.

## What each command does

| Command | What it does |
|---|---|
| `databricks configure` | Saves the workspace address and token in `~/.databrickscfg` as the `DEFAULT` profile. Every later command reads it. |
| `databricks current-user me` | Asks "who am I?": returns the account the token belongs to. The quickest proof that the address and token are right, like `SELECT SUSER_SNAME()` in SQL Server. |
| `databricks warehouses list` | Lists the SQL warehouses: name, size and state. |

## Result

| Warehouse | Size | State |
|---|---|---|
| Serverless Starter Warehouse | 2X-Small | STOPPED (normal: it starts by itself when a query or job needs it) |

The CLI also prints a hint about `databricks aitools install`. It's an optional add-on and can be
ignored.
