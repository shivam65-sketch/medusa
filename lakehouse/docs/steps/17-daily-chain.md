# Step 17: Daily chain (load, bronze, dbt)

[← Lakehouse home](../../README.md) · [← Step 16](16-gold-unusual-moves-and-hours.md) · Next: [Step 18 →](18-active-coins.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `5245c92` Lakehouse: transform workflow (bronze, freshness, dbt build) chained after the daily load and the backfill |
| **Files** | [`.github/workflows/lakehouse-transform.yml`](../../../.github/workflows/lakehouse-transform.yml) (new) · [`lakehouse-daily.yml`](../../../.github/workflows/lakehouse-daily.yml) · [`lakehouse-backfill.yml`](../../../.github/workflows/lakehouse-backfill.yml) |
| **Decision** | [ADR-017](../decisions.md#adr-017-orchestrate-the-daily-chain-in-github-actions) |

## Goal

Every morning, with nobody at a computer: download → landing → bronze → dbt (silver and gold) →
tests, all from GitHub Actions. Until now bronze and dbt were run by hand.

## Concepts

| Concept | Here |
|---|---|
| **Reusable workflow** | `lakehouse-transform.yml` is called by the daily load and the backfill (`workflow_call`) and can also be run by hand (`workflow_dispatch`). |
| **Job dependencies** | `transform` has `needs: load`, so it runs only after the upload succeeded. |
| **No ids in the repository** | The warehouse's HTTP path is looked up by its name with the CLI on every run. |
| **Masking** | `::add-mask::` hides the derived host and path in the public log. |
| **Fail on stale data** | `dbt source freshness` errors after 72 hours without new bronze rows, which stops the run and sends GitHub's failure email. |
| **Dependency caching** | `actions/setup-python` caches pip downloads, keyed on `dbt/requirements.txt`. |

## The workflow

```yaml
# lakehouse-transform.yml (steps)
- name: Load new landing files into bronze
  run: databricks bundle run bronze

- name: Connection details for dbt
  run: |
    host="${DATABRICKS_HOST#https://}"
    host="${host%/}"
    path=$(databricks warehouses list -o json | python -c "import json, sys; print(next(w['odbc_params']['path'] for w in json.load(sys.stdin) if w['name'] == 'Serverless Starter Warehouse'))")
    echo "::add-mask::$host"
    echo "::add-mask::$path"
    echo "DBT_DATABRICKS_HOST=$host" >> "$GITHUB_ENV"
    echo "DBT_DATABRICKS_HTTP_PATH=$path" >> "$GITHUB_ENV"

- name: Check bronze is fresh
  run: dbt source freshness        # in lakehouse/dbt, token from the DATABRICKS_TOKEN secret

- name: Build and test silver and gold
  run: dbt build
```

```yaml
# lakehouse-daily.yml and lakehouse-backfill.yml (new last job)
transform:
  needs: load
  uses: ./.github/workflows/lakehouse-transform.yml
  secrets: inherit
```

## How to run

- Automatically: every daily load and backfill ends with the transform.
- By hand: GitHub → Actions → **Lakehouse transform** → Run workflow.

## Result

| Check | Result |
|---|---|
| First manual run of **Lakehouse transform** | Green end to end: bronze pipeline, source freshness and `dbt build` |
| Data afterwards | `gold.data_health` unchanged and consistent: newest day 2026-10-19, 872 coins, `complete` (no new files had arrived since the backfill) |
| First scheduled chained run | 2026-10-21 06:00 UTC; it should add 2026-10-20 to `data_health` |

## Problems we hit

None.
