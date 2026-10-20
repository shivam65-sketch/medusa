# Operations

[← Lakehouse home](../README.md)

How the platform runs day to day, and what to do when something goes wrong.

## The daily run

| What | When | Where to look |
|---|---|---|
| Download + upload (`Lakehouse daily load`) | 06:00 UTC (11:30 India time). GitHub may start it a few minutes late. | GitHub → **Actions** → Lakehouse daily load |
| Bronze pipeline (`lakehouse-bronze`) | By hand for now: `databricks bundle run bronze` | Databricks → **Jobs & Pipelines** → lakehouse-bronze |

A failed scheduled run sends GitHub's failure email.

## Common tasks

All `databricks` commands run from the `lakehouse/` folder.

| Task | How |
|---|---|
| Load a particular day | GitHub → Actions → Lakehouse daily load → **Run workflow**, type the date (`YYYY-MM-DD`). Safe to repeat: files are re-uploaded identically. |
| Load new files into bronze | `databricks bundle run bronze` (only files not loaded before are read) |
| Rebuild bronze from every file | `databricks bundle run bronze --full-refresh-all`. Use only after changing a bronze definition: it reloads everything. |
| See what's in the landing volume | `databricks fs ls dbfs:/Volumes/market/landing/binance/klines_1m` |
| Deploy a change to a job or pipeline | `databricks bundle validate`, then `databricks bundle deploy` |
| Re-create the catalog, schemas and volume | `databricks bundle run setup_ddl` (harmless if they already exist) |
| Test the downloader locally | `cd lakehouse/ingest` then `python download_binance.py --symbols BTCUSDT --date 2026-10-19` |

## Checking a day is complete

```sql
SELECT date, COUNT(*) AS rows, COUNT(DISTINCT symbol) AS coins
FROM market.bronze.klines_1m
GROUP BY date
ORDER BY date DESC;
```

A complete day has about 872 coins × 1,440 rows. A data-health table will automate this check later.

## When the daily run fails

| Symptom in the GitHub log | Cause | Fix |
|---|---|---|
| `default auth: cannot configure default credentials`, and the `env:` section shows `DATABRICKS_HOST:` with nothing after it | The secrets are missing or saved in the wrong place | Settings → Secrets and variables → **Actions** → **Secrets** tab → *Repository secrets* must list `DATABRICKS_HOST` and `DATABRICKS_TOKEN` |
| `403` / invalid access token on upload | The GitHub token expired or was revoked | Create a new token, update the `DATABRICKS_TOKEN` secret (see below), re-run |
| Download step: every file `missing` | Binance hasn't published the day yet | Re-run later with **Run workflow** |
| Download step: `FAILED ... checksum mismatch` | A file was damaged in transfer | Re-run; if it repeats, the file on Binance's side is broken: report and skip the day |
| The workflow doesn't appear under Actions | The workflow file isn't in `.github/workflows/` at the repository root | Move it there (`git mv`) |
| Scheduled runs stopped | GitHub pauses schedules in public repositories after 60 days without commits | Actions → the workflow → **Enable workflow** |

## Secrets and renewals

| Credential | Where it lives | Expires | Renew by |
|---|---|---|---|
| CLI token (your computer) | `~/.databrickscfg` (outside the repository) | 90 days after creation | Generate a new token in Databricks, then run `databricks configure` |
| GitHub Actions token (`github-actions-medusa`) | GitHub secret `DATABRICKS_TOKEN` | ~18 January 2027 | Generate a new token in Databricks → GitHub Settings → Secrets → `DATABRICKS_TOKEN` → update → revoke the old token |
| Workspace address | GitHub secret `DATABRICKS_HOST` | Never | Only if the workspace changes |

Tokens are never pasted into chat, files or commits. A secret's value is never shown again after
saving; it can only be replaced.

## Costs and limits

Everything runs on free plans: GitHub Actions (public repository), Databricks Free Edition and
Binance's public archive. If Databricks' daily fair-use quota is exceeded, compute stops for the
rest of the day; data is kept and work continues the next day.
