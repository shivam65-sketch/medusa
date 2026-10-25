# Operations

[← Lakehouse home](../README.md)

How the platform runs day to day, and what to do when something goes wrong.

## The daily run

| What | When | Where to look |
|---|---|---|
| Download + upload (`Lakehouse daily load`, job `load`) | 13:23 UTC (18:53 India time), after Binance has published the previous day ([ADR-021](decisions.md#adr-021-load-a-day-only-after-binance-has-finished-publishing-it)). GitHub can start scheduled runs late, by minutes or even hours; the odd minute avoids the busiest start of the hour. | GitHub → **Actions** → Lakehouse daily load |
| Re-check the previous 7 days (job `recheck`) | Right after the load | The same run's `recheck` job: one line per day ("1814 files checked, 0 changed, 0 new, 0 removed"); a yellow warning on the run's page when Binance changed a file ([ADR-023](decisions.md#adr-023-re-check-loaded-days-against-binance-for-a-week)) |
| Bronze, freshness check, `dbt build` (job `transform`) | Right after a successful upload, in the same run | The same run's `transform` job; Databricks → **Jobs & Pipelines** → lakehouse-bronze for the pipeline |
| Publish to MEDUSA (last step of `transform`) | Only after every dbt test passed | The run's summary page: a table of lakehouse rows against MEDUSA rows for `market_baseline`, `market_evidence` and `market_metrics`, all "OK" ([ADR-024](decisions.md#adr-024-a-write-only-endpoint-for-the-serving-copy)), and **Scanner answer** `kv` (MEDUSA rebuilt the Markets page's ready-made answer, [ADR-026](decisions.md#adr-026-the-scanners-answer-is-kept-ready-made-in-workers-kv)) |
| Check the result | After the run | The last line of `dbt build` in the log; `market.gold.data_health` for the new day |

A failed scheduled run sends GitHub's failure email.

## Common tasks

All `databricks` commands run from the `lakehouse/` folder.

| Task | How |
|---|---|
| Load a range of past days | GitHub → Actions → **Lakehouse backfill** → Run workflow, first and last day (up to 60 days; 4 days at a time). Bronze and `dbt build` run at the end. |
| Run only bronze and dbt (and publish to MEDUSA) | GitHub → Actions → **Lakehouse transform** → Run workflow |
| See what MEDUSA holds | From the `medusa` folder: `npx wrangler@4 d1 execute medusa --remote --command "SELECT * FROM market_publish"` (one row per table: lakehouse day, rows, publish time) |
| See the Markets page's metric definitions | Databricks SQL editor: `SELECT metric_id, version, kind, name, valid_from, changed_by FROM market.semantic.metric_definitions WHERE is_current ORDER BY kind, metric_id` (17 rows); every version: leave out `WHERE is_current`; every change to the table: `DESCRIBE HISTORY market.semantic.metric_definitions`. What MEDUSA runs: `npx wrangler@4 d1 execute medusa --remote --command "SELECT metric_id, version, valid_from FROM market_metrics"` |
| Check the metric definitions | From `lakehouse/dbt/`: `../.venv/Scripts/dbt test --select source:semantic` (20 tests: 11 on the shared definitions, 9 on the accounts' own; `dbt build` runs them every day before the publish) |
| Re-load version 1 of the definitions | `databricks bundle run seed_metric_definitions` (two tasks: `seed_v1` for Today's 14 definitions, then `seed_patterns` for the Patterns view's 3; each a `MERGE` that adds only versions that aren't in the table, so it is harmless to repeat) |
| Change a metric definition | On the Markets page: press ‹› on the number, edit its SQL in the window, **Preview**, then **Save** with a note ([step 28](steps/28-editing-the-definitions.md)). The owner's account saves the shared version; any other account its own. A save adds a version (`version + 1`, `is_current = true`) and closes the old one (`valid_to`, `is_current = false`), and MEDUSA uses it at once. Never `UPDATE` or `DELETE` a version by hand |
| See a definition's history | In its window: **History** (every version, who, when, why, its SQL). In Databricks: `SELECT version, is_current, valid_from, valid_to, changed_by, change_note FROM market.semantic.metric_definitions WHERE metric_id = 'breadth' ORDER BY version DESC`; every change to the table: `DESCRIBE HISTORY market.semantic.metric_definitions` (a save shows as a `MERGE` by the service principal) |
| Undo a change to a definition | In its window: **History** → **Use this version again** on the version wanted → **Save**. The old SQL becomes the next version, with the note *Back to … version N*; nothing is deleted |
| See the accounts' own versions | Databricks: `SELECT account_id, metric_id, version, is_current, valid_from, changed_by, change_note FROM market.semantic.user_metric_definitions ORDER BY account_id, metric_id, version`. What MEDUSA runs: `npx wrangler@4 d1 execute medusa --remote --command "SELECT user_id, metric_id, version, valid_from FROM market_user_metrics"` |
| Bring a change made in Databricks to MEDUSA now | The owner's account, in any calculation window: **Reload definitions from the lakehouse** (both tables replaced from Databricks within seconds). Otherwise the next publish does it, or re-run **Lakehouse transform** |
| See the Markets page's ready-made answer | From the `medusa` folder: `npx wrangler@4 kv key get "market/scanner.json" --binding LAB --remote` (the JSON the page loads; its `published` part should match `market_publish`) |
| Make MEDUSA rebuild that answer | Re-run **Lakehouse transform** (the publish rebuilds it), or delete it: `npx wrangler@4 kv key delete "market/scanner.json" --binding LAB --remote` (the next page load reads D1 and keeps that answer for 10 minutes) |
| Check what feeds the Markets page | From `lakehouse/dbt/`: `../.venv/Scripts/dbt ls --select +exposure:markets_page --output name`; before changing a model, `../.venv/Scripts/dbt ls --select <model>+ --resource-type exposure` says whether the change reaches the page |
| Load the hourly history | GitHub → Actions → **Lakehouse history** → Run workflow, first and last year (2020 to 2026 was loaded on 2026-10-20; one job per year, two at a time). Bronze and `dbt build` run at the end. Needed again only if the history must be rebuilt. |
| Load a particular day | GitHub → Actions → Lakehouse daily load → **Run workflow**, type the date (`YYYY-MM-DD`). Safe to repeat: files are re-uploaded identically. |
| Load new files into bronze | `databricks bundle run bronze` (only files not loaded before are read) |
| Rebuild bronze from every file | `databricks bundle run bronze --full-refresh-all`. Use only after changing a bronze definition: it reloads everything. |
| See what's in the landing volume | `databricks fs ls dbfs:/Volumes/market/landing/binance/klines_1m` |
| Deploy a change to a job or pipeline | `databricks bundle validate`, then `databricks bundle deploy` |
| Re-create the catalog, schemas, volume and semantic tables | `databricks bundle run setup_ddl` (5 tasks, harmless if they already exist) |
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
| `dbt build` fails on `assert_metric_definitions_*` or a `source_..._semantic_metric_definitions_...` test | A metric definition breaks a rule: two current versions, a gap in the versions, a second statement in its SQL, display that isn't JSON. The publish doesn't run, so MEDUSA keeps the last checked definitions (and yesterday's data) | Run the failing test's SQL from `lakehouse/dbt/target/compiled/` in the SQL editor to see the rows, fix them with a new version (or by closing the extra current one), then re-run **Lakehouse transform** |
| Publish: `market_metrics` failed with `MEDUSA answered 400` or `500` | MEDUSA's D1 doesn't have `market_metrics` (migration 004 not applied), or the app wasn't redeployed after step 27 | From the `medusa` folder: `npx wrangler@4 d1 execute medusa --remote --file=migrations/004_metrics.sql`, then `npx wrangler@4 deploy`, then re-run the transform |
| Publish: `market_user_metrics` failed with `MEDUSA answered 400` or `500` | Migration 005 not applied, or the app wasn't redeployed after step 28 | `npx wrangler@4 d1 execute medusa --remote --file=migrations/005_user_metrics.sql`, then `npx wrangler@4 deploy`, then re-run the transform |
| `dbt build` fails on `assert_user_metric_definitions_valid` or a `source_..._user_metric_definitions_...` test | An account's own version breaks a rule (usually after a hand change in Databricks); the publish doesn't run | Run the failing test's SQL from `lakehouse/dbt/target/compiled/` to see the rows; close the extra current version (or fix the gap) in the SQL editor and note why, then re-run **Lakehouse transform** |
| Publish summary: **Scanner answer** `d1` | The tables were replaced, but saving the Markets page's ready-made answer in KV failed (for example KV's 1,000 writes a day were used up), so MEDUSA removed the old answer | Nothing is wrong with the data: page loads read D1 until the next publish rebuilds the answer. If it repeats, check KV's usage in Cloudflare's dashboard |
| The workflow doesn't appear under Actions | The workflow file isn't in `.github/workflows/` at the repository root | Move it there (`git mv`) |
| Scheduled runs stopped | GitHub pauses schedules in public repositories after 60 days without commits | Actions → the workflow → **Enable workflow** |

## When a number on MEDUSA's Markets page looks wrong

Every number on the Markets page is calculated by a SQL query that runs in the browser
([ADR-028](decisions.md#adr-028-every-number-is-a-sql-query-run-in-the-browser)). Every summary card and
table, and every market's details, have a **‹›** button that opens that query in its own window, live,
exactly as it runs, with its parameters and its raw result. **Copy for MEDUSA (D1)** or **Copy for Databricks** adds the
live prices as values and fills in the parameters; run it, and if the database returns the same result,
the page calculated correctly and any surprise is in the data. Start there.

| Symptom | Check | Likely cause and fix |
|---|---|---|
| A market's move or z looks wrong | Its details: run its query in D1 and in Databricks; the Binance message behind its price is under the query | A wrong close: compare it with `SELECT last_close, as_of_date FROM market.gold.coin_baseline WHERE symbol = '…'` (Databricks) and the same in D1 (`market_baseline`). If gold is right and D1 isn't, re-run **Lakehouse transform** (it republishes) |
| Its normal (σ, average) looks wrong | `SELECT avg_return_30d, sd_return_30d, history_days FROM market.gold.coin_baseline WHERE symbol = '…'` in the Databricks SQL editor | A bad day in `coin_daily`: check `data_health` for that day, reload the day if incomplete, then `dbt build` |
| A verdict looks wrong | The details' verdict and past-move queries | Run `SELECT * FROM market.gold.intraday_events WHERE …` and check the moves behind it; the rules are `vars` in `dbt_project.yml` (don't tune them after looking at held-back years, ADR-022) |
| "Lakehouse day" is two days old after 14:00 UTC | `SELECT * FROM market_publish` in D1 (see Common tasks) | The daily run or its publish step failed or is late: see the run on GitHub |
| "Binance's live prices can't be reached from here" | The status line | Binance refuses some regions and networks; the daily numbers still show |
| A price differs from TradingView | The Bitcoin card's panel | TradingView's `BINANCE:BTCUSDT` is spot; the page shows the perpetual, `BTCUSDT.P` |
| A total (breadth, unusual count) needs checking | **Download the result (CSV)** and **Download the inputs (CSV)** in its panel | The result as the query returned it, and one line per market with its price, yesterday's close and its normal (`market_now`), as used at that moment |
| The status line says **The SQL engine couldn't start** | Its message, and the browser's console | The browser can't run WebAssembly in a worker (very old browsers), or `/markets-sql.js` lost its own security policy: its response headers must show `script-src 'self' 'wasm-unsafe-eval'` (`public/_headers`). **Try again** restarts it |
| The status line says **The queries took too long** | How busy the device is | A run took over 15 seconds, so the engine was restarted and reloaded; it normally takes about 50 ms |
| A card shows **!** or a table says **The query failed** | Its ‹› panel shows the error and which version of the definition ran | A definition that doesn't run on the current data, usually a new version: run its copy in D1 to see the same error, then fix it with another version |
| A panel says **Definition: the built-in copy** (and the status line *defined by the built-in copy*) | `SELECT * FROM market_publish` in D1 (see Common tasks): is there a `market_metrics` row? | No row: the definitions haven't been published since the table was added; re-run **Lakehouse transform**. A row: the browser still has an older answer for up to 5 minutes; reload with **Disable cache** ticked |
| `x-cache: D1` on every load (DevTools → Network → `scanner`) | Tick **Disable cache** and wait a minute: the browser keeps its copy for 5 minutes, and KV remembers a missing key for up to a minute | Still `D1`: the ready-made answer is missing; see the publish summary's **Scanner answer**, or re-run **Lakehouse transform** |

## When saving a definition fails

A calculation window shows the server's message in its save form. Nothing is half saved: either the
`MERGE` added the version or it changed nothing.

| Message (HTTP status) | Cause | Fix |
|---|---|---|
| *Saving isn't set up on this MEDUSA* (503); no **Save** button | `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID` or `DATABRICKS_CLIENT_SECRET` is missing in Cloudflare | Save the three secrets (README, "Saving the Markets definitions") and deploy |
| *A query must start with SELECT or WITH*, *Only one statement*, *… isn't a parameter the page fills in* (400) | The query breaks one of the three rules (the window checks them first, so this means an old window) | Fix the query; a comment can go after `SELECT`, not before it |
| *There is no definition with that name* (404) | The window was opened for a definition MEDUSA doesn't have | Reload the Markets page |
| *… changed since this window loaded it* (409) | Someone (or another window) saved a newer version first | Reload the window: it shows the version now in use. Your text stays in the editor until the window closes, so copy it first |
| *The lakehouse's definitions haven't been published to MEDUSA yet* (409) | D1 has no `market_metrics` | Apply migration 004 and re-run **Lakehouse transform** |
| *You've saved 20 times today* or *MEDUSA has saved as many times today …* (429) | The daily allowance (20 per account, 300 in all; history reads and reloads: 60 and 600) | Wait until the next day; the counts are kept in D1's `attempts` table (`kind` `metricSave` or `metricRead`) |
| *Databricks refused MEDUSA's sign-in* (502) | The service principal's OAuth secret was deleted or expired, or the client id is wrong | Generate a new secret on the service principal's **Secrets** tab, then `npx wrangler@4 secret put DATABRICKS_CLIENT_SECRET` |
| *MEDUSA's Databricks login can't use the Serverless Starter Warehouse* (502) | The service principal lost **Can use** on the warehouse, or the warehouse was renamed | Give it **Can use** again, or set `DATABRICKS_WAREHOUSE_ID` |
| *Databricks couldn't run it (… INSUFFICIENT_PERMISSIONS …)* (502) | A grant on `market.semantic` or a definitions table is missing | Run the `GRANT`s in "The Markets save login" below |
| *Databricks took too long to answer* (502) | The warehouse took more than about a minute and a half to wake | Try again; if Databricks saved it after all, it appears with the next publish or **Reload** |
| *Saved … (MEDUSA's copy catches up with the next daily publish)* | Databricks has the version, but writing MEDUSA's copy failed | Nothing to fix: the next publish, or the owner's **Reload**, copies it |
| *Only the owner's account reloads the definitions* (403) | **Reload** was called by another account | Expected: other accounts get changes made in Databricks with the daily publish |

## Incidents

| Date | What happened | Cause | Fix |
|---|---|---|---|
| 2026-10-25 | The first real save, version 2 of `bitcoin`, was removed by hand in the Databricks SQL editor (a `DELETE` of version 2 and an `UPDATE` making version 1 current again). MEDUSA kept running version 2 until **Lakehouse transform** republished the definitions at 05:46 UTC. | MEDUSA's copy changes only with a save from the page or a publish, so a hand change in Databricks waited for the next publish. | Undo now means **Use this version again**, which saves the old SQL as the next version; the owner's **Reload** brings any hand change to MEDUSA in seconds ([step 28](steps/28-editing-the-definitions.md)). |
| 2026-10-21 | The first scheduled daily load (for 2026-10-20) failed in the download step: `FAILED metrics ATHUSDT 2026-10-20: [Errno 104] Connection reset by peer` (1,527 saved, 280 missing, 1 failed). Re-run at 21:51 UTC: all 872 coins loaded and every test passed; no data was lost. | 1. The downloader retried a connection that failed to open, but not one that dropped mid-download. 2. GitHub started the 06:00 schedule at 11:19, before Binance had finished publishing: 88 coins' candle files appeared only at 11:55. Without the network error, the day would have loaded without those coins. | Mid-download errors are retried; the schedule moved to 13:00 UTC; the download step refuses a day that isn't fully published ([ADR-021](decisions.md#adr-021-load-a-day-only-after-binance-has-finished-publishing-it)). |

## The Markets save login (service principal)

Saving a definition from a Markets window (step 28), reading its history and the owner's **Reload**
make MEDUSA's server work in Databricks. It signs
in as its own service principal, `medusa-markets-writer`, never with a person's token, and that login
can do nothing else:

| Permission | Why |
|---|---|
| **Can use** on the Serverless Starter Warehouse | To run its statements |
| `USE CATALOG` on `market`, `USE SCHEMA` on `market.semantic` | To reach the two tables |
| `SELECT, MODIFY` on `market.semantic.metric_definitions` and `market.semantic.user_metric_definitions` | To add and close versions; nothing else in the lakehouse is readable (`market.gold` is refused: `INSUFFICIENT_PERMISSIONS`) |

It signs in with an OAuth secret (client credentials) and asks for the **`sql`** scope: on Free Edition
the usual `all-apis` scope is refused (`Scopes 'all-apis' are not assigned to the client`), and the
SQL Statement API needs only `sql`. Each save gets a new one-hour token.

To set it up again: Settings → Identity and access → Service principals → Add new; on its page,
Secrets → Generate secret; the warehouse's Permissions → Can use; then, in the SQL editor (the
Application ID in backticks):

```sql
GRANT USE CATALOG ON CATALOG market TO `APPLICATION-ID`;
GRANT USE SCHEMA ON SCHEMA market.semantic TO `APPLICATION-ID`;
GRANT SELECT, MODIFY ON TABLE market.semantic.metric_definitions TO `APPLICATION-ID`;
GRANT SELECT, MODIFY ON TABLE market.semantic.user_metric_definitions TO `APPLICATION-ID`;
```

Then save the secrets in Cloudflare (README, "Saving the Markets definitions"). Never type the secret
where it shows on screen or stays in a command's history.

If a deleted account's versions are still in Databricks (its deletion couldn't reach Databricks), remove
them in the SQL editor: `DELETE FROM market.semantic.user_metric_definitions WHERE account_id = <number>`.

## Secrets and renewals

| Credential | Where it lives | Expires | Renew by |
|---|---|---|---|
| CLI token (your computer) | `~/.databrickscfg` (outside the repository) | 90 days after creation | Generate a new token in Databricks, then run `databricks configure` |
| dbt token (`medusa-dbt-local`) | Windows user environment variable `DBT_ENV_SECRET_DATABRICKS_TOKEN` | 90 days after creation | Generate a new token, edit the variable, open a new terminal |
| GitHub Actions token (`github-actions-medusa`) | GitHub secret `DATABRICKS_TOKEN` | ~18 January 2027 | Generate a new token in Databricks → GitHub Settings → Secrets → `DATABRICKS_TOKEN` → update → revoke the old token |
| Workspace address | GitHub secret `DATABRICKS_HOST` | Never | Only if the workspace changes |
| MEDUSA ingest token | Cloudflare secret `MARKET_INGEST_TOKEN` and GitHub secret `MEDUSA_INGEST_TOKEN` (the same value) | Never | If it may have leaked: generate a new one (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), `npx wrangler@4 secret put MARKET_INGEST_TOKEN`, update the GitHub secret |
| MEDUSA's address | GitHub secret `MEDUSA_URL` | Never | Only if the app's address changes |
| Markets save login (service principal `medusa-markets-writer`) | Cloudflare secrets `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET` | The OAuth secret's own expiry (shown on its Secrets tab) | Databricks: the service principal → **Secrets** → **Generate secret**, then `npx wrangler@4 secret put DATABRICKS_CLIENT_SECRET`, then delete the old secret |
| Whose saves are shared | Cloudflare secret `MARKET_OWNER_ID` (an account number) | Never | Only if the owner's account changes |

Tokens are never pasted into chat, files or commits. A secret's value is never shown again after
saving; it can only be replaced.

## Costs and limits

Everything runs on free plans: GitHub Actions (public repository), Databricks Free Edition and
Binance's public archive. If Databricks' daily fair-use quota is exceeded, compute stops for the
rest of the day; data is kept and work continues the next day.
