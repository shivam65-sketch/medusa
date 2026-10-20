# Step 1: DDL scripts

[← Lakehouse home](../../README.md) · Next: [Step 2 →](02-databricks-cli.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `8c1678d` Lakehouse: DDL for the catalog, layer schemas and landing volume |
| **Files** | [`sql/ddl/001_catalog.sql`](../../sql/ddl/001_catalog.sql) · [`002_schemas.sql`](../../sql/ddl/002_schemas.sql) · [`003_volumes.sql`](../../sql/ddl/003_volumes.sql) · [`.gitignore`](../../.gitignore) |

## Goal

Create the empty structure of the lakehouse (a catalog, one schema per layer and a volume for raw
files) from SQL files kept in Git, not by typing into the SQL editor.

## Concepts

- **Unity Catalog names:** `catalog.schema.object`. In SQL Server terms the catalog is roughly a
  database and the schema is a schema.
- **One schema per layer** (`landing`, `bronze`, `silver`, `gold`) gives clear boundaries: every table
  name says which layer it belongs to.
- **Volume:** a governed folder for files. Tables hold rows; volumes hold files.
- **DDL as code** (see [ADR-006](../decisions.md#adr-006-ddl-as-numbered-re-runnable-files)):
  - In Git, so every change has history.
  - `IF NOT EXISTS`, so running again is harmless (idempotent).
  - Numbered, so the order is explicit.
  - Never edited after running: a change gets a new numbered file, as migration tools like Flyway do.
  - Every object has a `COMMENT`, which shows in Catalog Explorer as documentation.

## Code walkthrough

**`001_catalog.sql`**: the container for the whole platform. Free Edition stores it in Databricks'
default storage, so no storage location is needed.

```sql
CREATE CATALOG IF NOT EXISTS market
  COMMENT 'Crypto market lakehouse: Binance USD-M futures public data';
```

**`002_schemas.sql`**: one schema per medallion layer, each with a comment saying what belongs there.

```sql
CREATE SCHEMA IF NOT EXISTS market.landing COMMENT 'Raw files exactly as downloaded from data.binance.vision';
CREATE SCHEMA IF NOT EXISTS market.bronze  COMMENT 'Rows loaded from the landing files, nothing changed';
-- … silver and gold the same way
```

**`003_volumes.sql`**: the managed volume the daily upload writes to. "Managed" means Databricks owns
the storage, so dropping the volume also deletes its files.

```sql
CREATE VOLUME IF NOT EXISTS market.landing.binance
  COMMENT 'Daily Binance files, uploaded only after their checksum matched';
```

**`.gitignore`**: keeps downloaded data (`data/`, `*.zip`, `*.csv`), secrets (`.env`) and the bundle's
working folder (`.databricks/`) out of Git. It sits inside `lakehouse/` so its rules don't affect the
rest of MEDUSA, which does track a `.zip` file.

## How to run

These files are not run by hand: [Step 3](03-setup-job.md) runs them through a deployed job.

## Problems we hit

| Problem | Cause | Fix |
|---|---|---|
| `git add lakehouse` failed ("pathspec did not match any files") | The files had first been created in a separate `market_lakehouse` repository, before the decision to keep the lakehouse inside MEDUSA | Copied `sql/` and `.gitignore` (not the old `.git`) into `medusa/lakehouse/`, committed there, deleted the old folder |

## Result

Four files in Git, ready to deploy.
