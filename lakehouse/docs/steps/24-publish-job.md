# Step 24: Publish job: gold into MEDUSA after every transform

[← Lakehouse home](../../README.md) · [← Step 23](23-serving-tables.md) · Next: [Step 25 →](25-scanner-page.md)

| | |
|---|---|
| **Built** | 2026-10-23 |
| **Commit** | `f2a4f2f` Lakehouse: publish coin_baseline and event_evidence to MEDUSA after each transform, with a row-count reconciliation (step 24) |
| **Files** | [`serving/publish_to_medusa.py`](../../serving/publish_to_medusa.py) · [`.github/workflows/lakehouse-transform.yml`](../../../.github/workflows/lakehouse-transform.yml) |
| **Decisions** | [ADR-024](../decisions.md#adr-024-a-write-only-endpoint-for-the-serving-copy) |

## Goal

Keep MEDUSA's copy current without anyone touching it: after each daily transform, copy the scanner's
two gold tables through the step 23 endpoint and prove the copy is complete.

## Concepts

| Concept | Here |
|---|---|
| **Publish only tested data** | The step runs after `dbt build`. If any of the 111 tests fails, the job stops first and MEDUSA keeps the last checked copy. |
| **Reconciliation across systems** | A copy isn't done until both sides are counted: MEDUSA must report exactly as many rows as gold, or the step fails (failure email). |
| **Idempotent, safe to retry** | Each table is replaced as a whole, so re-running the transform republishes the same data. Network and server errors are retried twice. |
| **Secrets stay secrets** | The app's address and the token are GitHub repository secrets, masked in logs; without `MEDUSA_URL` the step is skipped instead of failing. |
| **One tool for both places** | The script reaches Databricks through the Databricks CLI, which is signed in by environment variables in GitHub Actions and by the CLI profile on a developer's computer, so the script holds no credentials itself. |

## Code walkthrough

```python
warehouse = warehouse_id()                         # found by name, never stored
as_of = query(warehouse, AS_OF)[0]["as_of"]        # newest day in gold.coin_daily
for table, sql in TABLES.items():                  # market_baseline, market_evidence
    rows = query(warehouse, sql)                   # SQL Statement API, typed from the result schema
    answer = send(f"{url}/api/market/ingest", token, {"table": table, "as_of": as_of, "rows": rows})
    ok = answer.get("ok") is True and answer.get("rows") == len(rows)
```

The run's summary page gets a table of gold rows against MEDUSA rows. The workflow step:

```yaml
- name: Publish to MEDUSA
  if: ${{ env.MEDUSA_URL != '' }}
  env:
    MEDUSA_INGEST_TOKEN: ${{ secrets.MEDUSA_INGEST_TOKEN }}
  run: python serving/publish_to_medusa.py
```

## How to run

It runs at the end of every transform: daily, after a backfill, or by hand (Actions → **Lakehouse
transform** → **Run workflow**). To see what MEDUSA holds:

```
npx wrangler@4 d1 execute medusa --remote --command "SELECT * FROM market_publish"
```

## Result

| Run | Result |
|---|---|
| Local test, real gold into a local MEDUSA | 748 of 748 and 60 of 60 rows; a wrong token fails both tables (exit 1); no settings stops with a message |
| Production, 2026-10-22 23:46 UTC | **Publish to MEDUSA** took 5 seconds: `market_baseline` 748 rows and `market_evidence` 60 rows, lakehouse day 2026-10-21; Bitcoin's and Ether's values identical to gold |

## Problems we hit

The first production run skipped the step: `MEDUSA_URL` hadn't reached the job, because the secret
wasn't saved as a repository secret. Saved under **Secrets → Repository secrets**, the next run
published. Variables would not have worked either: they are not masked in logs and are not
`secrets.*`.
