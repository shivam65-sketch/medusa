# Step 6: Daily automation with GitHub Actions

[← Lakehouse home](../../README.md) · [← Step 5](05-every-coin-and-upload.md) · Next: [Step 7 →](07-bronze-pipeline.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commits** | `c46d65a` Lakehouse: daily GitHub Actions load into the Databricks landing volume · `34be1e4` Lakehouse: move the daily workflow into .github/workflows |
| **Files** | [`.github/workflows/lakehouse-daily.yml`](../../../.github/workflows/lakehouse-daily.yml) |

## Goal

Run the downloader and the upload every day at 06:00 UTC on GitHub's servers, with no computer
needed, plus a button to load any chosen day.

## Concepts

| Concept | Why |
|---|---|
| **Fresh machine per run** | GitHub creates a temporary Linux machine for each run and deletes it afterwards. Nothing carries over, so every run downloads the day from scratch. |
| **`--overwrite` on upload** | Re-running a day replaces files with identical, checksum-verified copies instead of failing on "already exists", so re-runs are safe. |
| **Secrets** | The Databricks address and token are stored encrypted in GitHub and shown as `***` in the logs, which are public for a public repository. Forks can't read them; only people with write access can start a run. |
| **One token per consumer** | GitHub has its own token (`github-actions-medusa`), separate from the CLI's, so either can be revoked alone. |
| **Pinned versions** | `actions/checkout@v7`, `actions/setup-python@v7` and `databricks/setup-cli@v1.21.0`, the same CLI version as on the computer, so runs are reproducible. |
| **Least privilege** | `permissions: contents: read`: the job can read the repository but never write to it. |
| **No overlapping runs** | A `concurrency` group allows one load at a time; `timeout-minutes: 30` stops a stuck run. |

## Code walkthrough

```yaml
on:
  schedule:
    - cron: "0 6 * * *"       # 06:00 UTC every day
  workflow_dispatch:           # the "Run workflow" button
    inputs:
      date:                    # optional; empty means yesterday
```

The date typed into the button goes through an environment variable, never straight into the
command, so whatever is typed can't run as a command (protection against script injection):

```yaml
      - name: Download and check Binance files
        env:
          DAY: ${{ inputs.date }}
        run: python download_binance.py --symbols ALL ${DAY:+--date "$DAY"}
```

`${DAY:+--date "$DAY"}` is shell syntax for: add `--date "<value>"` only if `DAY` isn't empty.

The upload reads the two secrets as environment variables, which the CLI uses to log in:

```yaml
      - name: Upload to the landing volume
        env:
          DATABRICKS_HOST: ${{ secrets.DATABRICKS_HOST }}
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN }}
        run: databricks fs cp -r ../data/landing dbfs:/Volumes/market/landing/binance --overwrite --concurrency 16
```

## Setup

1. Databricks: create the token `github-actions-medusa`, 90 days.
2. GitHub → repository **Settings → Secrets and variables → Actions → Secrets** tab → **New
   repository secret**: `DATABRICKS_HOST` (the workspace address) and `DATABRICKS_TOKEN`.

## Result

The manual test run for 2026-10-18 succeeded in about 2.5 minutes; the download step alone took 58
seconds. The volume then held `date=2026-10-18` and `date=2026-10-19`, each with 872 candle files and
744 metrics files. It also answered an open question: GitHub's servers can reach Binance's archive.

## Problems we hit

| Problem | How it showed | Cause | Fix |
|---|---|---|---|
| Workflow ignored | GitHub offered to create a new `main.yml` | The file had been saved at the repository root; GitHub only reads `.github/workflows/` | `git mv lakehouse-daily.yml .github/workflows/lakehouse-daily.yml`, commit, push |
| Upload failed instantly | `Error: default auth: cannot configure default credentials`, and the step's `env:` showed `DATABRICKS_HOST:` and `DATABRICKS_TOKEN:` empty | The secrets weren't saved as **repository Actions secrets** | Added both under Settings → Secrets and variables → Actions → Secrets → Repository secrets, then re-ran |

The notice "The ubuntu-latest label will migrate to Ubuntu 26" is informational; nothing in this
workflow depends on the Ubuntu version.
