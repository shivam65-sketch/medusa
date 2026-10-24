# Operations

[← Lakehouse home](../README.md)

How the platform runs day to day, and what to do when something goes wrong.

## The daily run

| What | When | Where to look |
|---|---|---|
| Download + upload (`Lakehouse daily load`, job `load`) | 13:23 UTC (18:53 India time), after Binance has published the previous day ([ADR-021](decisions.md#adr-021-load-a-day-only-after-binance-has-finished-publishing-it)). GitHub can start scheduled runs late, by minutes or even hours; the odd minute avoids the busiest start of the hour. | GitHub → **Actions** → Lakehouse daily load |
| Re-check the previous 7 days (job `recheck`) | Right after the load | The same run's `recheck` job: one line per day ("1814 files checked, 0 changed, 0 new, 0 removed"); a yellow warning on the run's page when Binance changed a file ([ADR-023](decisions.md#adr-023-re-check-loaded-days-against-binance-for-a-week)) |
| Bronze, freshness check, `dbt build` (job `transform`) | Right after a successful upload, in the same run | The same run's `transform` job; Databricks → **Jobs & Pipelines** → lakehouse-bronze for the pipeline |
| Publish to MEDUSA (last step of `transform`) | Only after every dbt test passed | The run's summary page: a table of gold rows against MEDUSA rows per table, all "OK" ([ADR-024](decisions.md#adr-024-a-write-only-endpoint-for-the-serving-copy)) |
| Check the result | After the run | The last line of `dbt build` in the log; `market.gold.data_health` for the new day |

A failed scheduled run sends GitHub's failure email.

## Common tasks

All `databricks` commands run from the `lakehouse/` folder.

| Task | How |
|---|---|
| Load a range of past days | GitHub → Actions → **Lakehouse backfill** → Run workflow, first and last day (up to 60 days; 4 days at a time). Bronze and `dbt build` run at the end. |
| Run only bronze and dbt (and publish to MEDUSA) | GitHub → Actions → **Lakehouse transform** → Run workflow |
| See what MEDUSA holds | From the `medusa` folder: `npx wrangler@4 d1 execute medusa --remote --command "SELECT * FROM market_publish"` (one row per table: lakehouse day, rows, publish time) |
| Load the hourly history | GitHub → Actions → **Lakehouse history** → Run workflow, first and last year (2020 to 2026 was loaded on 2026-10-20; one job per year, two at a time). Bronze and `dbt build` run at the end. Needed again only if the history must be rebuilt. |
| Load a particular day | GitHub → Actions → Lakehouse daily load → **Run workflow**, type the date (`YYYY-MM-DD`). Safe to repeat: files are re-uploaded identically. |
| Load new files into bronze | `databricks bundle run bronze` (only files not loaded before are read) |
| Rebuild bronze from every file | `databricks bundle run bronze --full-refresh-all`. Use only after changing a bronze definition: it reloads everything. |
| See what's in the landing volume | `databricks fs ls dbfs:/Volumes/market/landing/binance/klines_1m` |
| Deploy a change to a job or pipeline | `databricks bundle validate`, then `databricks bundle deploy` |
| Re-create the catalog, schemas and volume | `databricks bundle run setup_ddl` (harmless if they already exist) |
| Check the dbt connection | From `lakehouse/dbt/`: `../.venv/Scripts/dbt debug` |
| Check bronze is fresh | From `lakehouse/dbt/`: `../.venv/Scripts/dbt source freshness` (warns after 36 h, errors after 72 h) |
| Build silver and run its tests | From `lakehouse/dbt/`: `../.venv/Scripts/dbt build` (incremental: only new bronze rows) |
| Rebuild a silver table from scratch | `../.venv/Scripts/dbt build --select <model> --full-refresh` |
| Rebuild the scanner's evidence | From `lakehouse/dbt/`: `../.venv/Scripts/dbt build --select intraday_events+` (about 1.5 minutes). Its settings (the 3σ line, the 0.10% cost, the held-back date, the thresholds) are `vars` in `dbt_project.yml`. Don't tune them after looking at the held-back results ([ADR-022](decisions.md#adr-022-judge-the-evidence-by-days-and-on-held-back-years)). |
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
| Download step: `NOT READY ... no files yet` or `NOT READY ... coins have metrics but no candles yet` | Binance hasn't finished publishing the day. Nothing was uploaded. | Later the same day: open the run → **Re-run failed jobs**. The whole load runs again from the start. |
| Download step: `FAILED ... Connection reset by peer` or a timeout | The network dropped 4 times in a row for one file (each file is tried 4 times) | **Re-run failed jobs** |
| Download step: `FAILED ... checksum mismatch` | A file was damaged in transfer | Re-run; if it repeats, the file on Binance's side is broken: report and skip the day |
| Warning "Binance changed files" on the run's page | Binance rewrote or added files after their day was loaded | Nothing to do: the recheck job loaded them and the transform rebuilt those days. The `recheck` log lists the files. |
| `recheck` job failed (`FAILED ...` or an upload error); the transform still ran | A network problem while re-checking | **Re-run failed jobs**, or wait: the next day's run checks the same days again |
| Step **Publish to MEDUSA** skipped | The `MEDUSA_URL` secret doesn't reach the job | Settings → Secrets and variables → Actions → **Secrets** tab → *Repository secrets* must list `MEDUSA_URL` and `MEDUSA_INGEST_TOKEN` (not under Variables, not an environment secret) |
| Publish: `MEDUSA answered 401` | The GitHub secret `MEDUSA_INGEST_TOKEN` differs from the app's `MARKET_INGEST_TOKEN` | Make a new token and save it in both places (see Secrets below), then re-run the transform |
| Publish: `MEDUSA answered 503` | The app has no `MARKET_INGEST_TOKEN` secret | `npx wrangler@4 secret put MARKET_INGEST_TOKEN` (the same value as the GitHub secret) |
| Publish: `MISMATCH` | MEDUSA stored a different number of rows than gold sent | Re-run the transform; if it repeats, compare `market_publish` with the gold table |
| The workflow doesn't appear under Actions | The workflow file isn't in `.github/workflows/` at the repository root | Move it there (`git mv`) |
| Scheduled runs stopped | GitHub pauses schedules in public repositories after 60 days without commits | Actions → the workflow → **Enable workflow** |

## When a number on MEDUSA's Markets page looks wrong

Every summary card and table on the Markets page has a **‹›** button, and every market's details have a
section, showing the number as one SQL query with the live prices written in. Copy it for MEDUSA's D1 or
for Databricks and run it: if the database returns the same numbers, the page calculated correctly and
any surprise is in the data. Start there.

| Symptom | Check | Likely cause and fix |
|---|---|---|
| A market's move or z looks wrong | Its details: run its query in D1 and in Databricks; the Binance message behind its price is under the query | A wrong close: compare it with `SELECT last_close, as_of_date FROM market.gold.coin_baseline WHERE symbol = '…'` (Databricks) and the same in D1 (`market_baseline`). If gold is right and D1 isn't, re-run **Lakehouse transform** (it republishes) |
| Its normal (σ, average) looks wrong | The details' first query, run in the Databricks SQL editor | A bad day in `coin_daily`: check `data_health` for that day, reload the day if incomplete, then `dbt build` |
| A verdict looks wrong | The details' verdict and past-move queries | Run `SELECT * FROM market.gold.intraday_events WHERE …` and check the moves behind it; the rules are `vars` in `dbt_project.yml` (don't tune them after looking at held-back years, ADR-022) |
| "Lakehouse day" is two days old after 14:00 UTC | `SELECT * FROM market_publish` in D1 (see Common tasks) | The daily run or its publish step failed or is late: see the run on GitHub |
| "Binance's live prices can't be reached from here" | The status line | Binance refuses some regions and networks; the daily numbers still show |
| A price differs from TradingView | The Bitcoin card's panel | TradingView's `BINANCE:BTCUSDT` is spot; the page shows the perpetual, `BTCUSDT.P` |
| A total (breadth, unusual count) needs checking | **Download the inputs (CSV)** in its panel | One line per market with every input and its source, exactly as used at that moment |

## Incidents

| Date | What happened | Cause | Fix |
|---|---|---|---|
| 2026-10-21 | The first scheduled daily load (for 2026-10-20) failed in the download step: `FAILED metrics ATHUSDT 2026-10-20: [Errno 104] Connection reset by peer` (1,527 saved, 280 missing, 1 failed). Re-run at 21:51 UTC: all 872 coins loaded and every test passed; no data was lost. | 1. The downloader retried a connection that failed to open, but not one that dropped mid-download. 2. GitHub started the 06:00 schedule at 11:19, before Binance had finished publishing: 88 coins' candle files appeared only at 11:55. Without the network error, the day would have loaded without those coins. | Mid-download errors are retried; the schedule moved to 13:00 UTC; the download step refuses a day that isn't fully published ([ADR-021](decisions.md#adr-021-load-a-day-only-after-binance-has-finished-publishing-it)). |

## Secrets and renewals

| Credential | Where it lives | Expires | Renew by |
|---|---|---|---|
| CLI token (your computer) | `~/.databrickscfg` (outside the repository) | 90 days after creation | Generate a new token in Databricks, then run `databricks configure` |
| dbt token (`medusa-dbt-local`) | Windows user environment variable `DBT_ENV_SECRET_DATABRICKS_TOKEN` | 90 days after creation | Generate a new token, edit the variable, open a new terminal |
| GitHub Actions token (`github-actions-medusa`) | GitHub secret `DATABRICKS_TOKEN` | ~18 January 2027 | Generate a new token in Databricks → GitHub Settings → Secrets → `DATABRICKS_TOKEN` → update → revoke the old token |
| Workspace address | GitHub secret `DATABRICKS_HOST` | Never | Only if the workspace changes |
| MEDUSA ingest token | Cloudflare secret `MARKET_INGEST_TOKEN` and GitHub secret `MEDUSA_INGEST_TOKEN` (the same value) | Never | If it may have leaked: generate a new one (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), `npx wrangler@4 secret put MARKET_INGEST_TOKEN`, update the GitHub secret |
| MEDUSA's address | GitHub secret `MEDUSA_URL` | Never | Only if the app's address changes |

Tokens are never pasted into chat, files or commits. A secret's value is never shown again after
saving; it can only be replaced.

## Costs and limits

Everything runs on free plans: GitHub Actions (public repository), Databricks Free Edition and
Binance's public archive. If Databricks' daily fair-use quota is exceeded, compute stops for the
rest of the day; data is kept and work continues the next day.
