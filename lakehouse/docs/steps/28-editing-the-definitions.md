# Step 28: Editing the definitions from the Markets page

[← Lakehouse home](../../README.md) · [← Step 27](27-metric-definitions.md)

| | |
|---|---|
| **Built** | 2026-10-25 (not a release yet: it ships in MEDUSA 1.7.0) |
| **Commits** | `aa3197e` (28.1 windows) · `23121ee` (28.2 edit, preview, the filter in the SQL) · `b7f9ef4` (28.3 save) · `13263b8` (28.4 history, reuse, reload) |
| **Files** | [`public/markets.js`](../../../public/markets.js) (windows, editor, preview, save, history) · [`public/markets-window.html`](../../../public/markets-window.html) and [`public/markets-window.js`](../../../public/markets-window.js) (the window) · [`src/metrics.js`](../../../src/metrics.js) (the server side of saving) · [`src/market.js`](../../../src/market.js) and [`src/worker.js`](../../../src/worker.js) · [`migrations/005_user_metrics.sql`](../../../migrations/005_user_metrics.sql) (MEDUSA's copy of each account's versions) · [`sql/ddl/005_user_metrics.sql`](../../sql/ddl/005_user_metrics.sql) (the Databricks table) · [`dbt/models/sources.yml`](../../dbt/models/sources.yml) and [`dbt/tests/assert_user_metric_definitions_valid.sql`](../../dbt/tests/assert_user_metric_definitions_valid.sql) · [`serving/publish_to_medusa.py`](../../serving/publish_to_medusa.py) |
| **Decisions** | [ADR-030](../decisions.md#adr-030-each-numbers-calculation-runs-in-its-own-window-with-the-filters-values-in-the-sql) (the window, and the filter written into the SQL) · [ADR-031](../decisions.md#adr-031-edits-are-saved-to-databricks-by-medusas-server-as-shared-or-personal-versions) (how a save reaches Databricks) |

## Goal

After step 27 every number's SQL was a versioned row in Databricks, but changing one still meant
writing SQL in the Databricks editor by hand. This step makes the Markets page the place to change a
definition:

1. Each number's calculation opens in **its own window**, next to the page, and stays live.
2. In that window the SQL can be **edited and previewed** on that screen only, and the query on screen
   **follows the page's filter**.
3. **Save** writes the edited query to Databricks as a new version: the owner's account changes the
   shared definition everyone uses; any other account keeps a version of its own.
4. **History** shows every version with who changed it, when and why. **Use this version again**
   turns an old version into the next one, and the owner can **reload** a change made in Databricks
   itself.

## Concepts

| Concept | Here |
|---|---|
| **Preview before commit** | A change runs on the editor's screen only, next to the numbers in use, before anything is saved. Like running a query in a transaction you roll back, without touching anything shared. |
| **Validation at every layer** | The same three rules (one read-only statement, starting with `SELECT` or `WITH`, no `;`, only the page's parameters) are checked by the editor, by MEDUSA's server and by the dbt tests, so a bad query can't slip past one of them. |
| **A parameterized statement** | The server sends the SQL text to Databricks as a *value* (`:sql_text`), never as part of the statement. Databricks stores it as data and never runs it, so nothing typed in the editor can change what the save does: no SQL injection. In SQL Server terms: `sp_executesql` with parameters instead of building a string. |
| **One atomic change** | Closing the old version and adding the new one is a single `MERGE`, so a save can't half happen. |
| **Optimistic concurrency** | Each save says which version it edited (`:base`). If someone saved in between, the `MERGE` matches nothing and the server answers *409, it changed since this window loaded it*. No locks are held while someone types. In SQL Server terms: a `rowversion` check in the `WHERE` clause. |
| **A service principal** | A login for a program, not a person. MEDUSA's server signs in as `medusa-markets-writer`, which may only use the SQL warehouse and read and change the two definitions tables (least privilege). |
| **OAuth client credentials** | How a program signs in without a person: it trades its client id and secret for a one-hour token. Here the token is limited to the `sql` scope. |
| **Write-through** | After Databricks accepts a save, MEDUSA's own copy (D1, and for a shared version the scanner's answer in KV) is updated at once, so the page uses the new version without waiting for the daily publish. The publish later replaces the copy from Databricks, so the two always end up equal. |
| **Personal and shared versions** | The owner's saves change the shared definition (`metric_definitions`); any other account's saves go to `user_metric_definitions` and only its own page uses them. Like a user's own copy of a report in SSRS's *My Reports*, next to the published one. |
| **Undo by adding, never by deleting** | Going back to an old version saves it again as the next version, so the history keeps both the change and the undo. Nothing is updated in place or deleted. |
| **Rate limits** | Every save and every history read wakes the SQL warehouse, which uses Free Edition's daily quota, so each has a daily allowance per account and for MEDUSA as a whole. |

## How a save travels

```text
Markets window (your browser)
  │  1. Preview: your query runs here only, next to the numbers in use
  │  2. Save: every number the change touches is run once with it; nothing is sent if one breaks
  ▼
POST /api/market/metrics/save   {metric_id, sql_text, description, note, base}
MEDUSA's server (Cloudflare Worker, src/metrics.js)
  │  3. checks: signed in (and the CSRF header), the 3 SQL rules, a known metric_id, the daily limit
  │  4. signs in to Databricks as medusa-markets-writer (OAuth client credentials, scope sql)
  ▼
Databricks SQL Statement API → SQL warehouse
  │  5. one MERGE with every value as a parameter:
  │       the owner        → market.semantic.metric_definitions       (shared, everyone)
  │       any other account → market.semantic.user_metric_definitions (that account only)
  │     it closes the current version and adds version + 1, only if the current one is still :base
  ▼
MEDUSA's server again
  │  6. reads the new version back, writes it into D1
  │     (market_metrics and the scanner's answer in KV, or market_user_metrics)
  ▼
The window, the Markets page and every other open window of that browser use it at once
(a BroadcastChannel message); every page that loads afterwards gets it from MEDUSA.
The daily publish copies both tables from Databricks again, so MEDUSA always ends up matching it.
```

## Built in four parts

### 28.1 Each number in its own window

Every **‹›** button (on each summary card, each table and each market's details) opens
`/markets-window?panel=breadth&kind=all` (or `panel=market&symbol=BTCUSDT`) in a window of its own,
up to 1600 × 1000. The window runs the same code as the Markets page (`renderWindow()` in
`markets.js`) with its own copy of the data, its own SQL engine and its own live prices from Binance,
but it runs only the queries of the number it shows. So it stays live while the Markets page is
hidden, on another page or closed. Pressing ‹› again brings the open window to the front instead of
reloading it. The calculation panels inside the page are gone.

The window shows what the number looks like on the page now, where its definition comes from and which
version it is, the query exactly as it runs, its parameters, the live result, the tables behind it, the
copies for MEDUSA's D1 and for Databricks, and the CSV downloads. A market's window adds the Binance
message behind its price and the past moves behind its verdicts.

### 28.2 Edit, preview, and the filter in the SQL

**The editor.** On a wide window the editor sits on the left and stays in view while the results
scroll on the right; on a phone it comes first. The number's own query is open to edit, and the shared
steps it reads (`market_now`, `today`, `flagged`, `verdicts`) open with one click, each saying which
numbers read it.

**Preview** (or Ctrl+Enter) first checks each changed query:

| Check | Why |
|---|---|
| One statement, no `;` anywhere | The engine runs exactly one statement |
| Starts with `SELECT` or `WITH` | It can only read |
| Only `:kind`, `:yesterday`, `:symbol` | The only parameters the page fills in |
| No shared step that reads itself | A step that reads itself would never finish |
| The columns the page shows are still there | Otherwise the card or table can't draw it |

The first three are the rules of the dbt tests on the definitions tables. Then the window runs your
version about once a second, on that screen only, next to the numbers in use (**On the page now** and
**Your version**), with its whole query, its copies, its raw result and a CSV. A number your changes
don't touch says so. A preview that takes more than 5 seconds is stopped and the engine restarted, so a
query that never finishes (a self-join on every market, for example) can't freeze the window. Closing a
window with unsaved changes asks first.

**The query follows the filter.** Before a query runs, the page writes its parameters in as values, so
the SQL on screen, and in the copies, is exactly what runs for the type chosen:

```sql
-- stored in the definition (and shown in the editor)
WHERE :kind IN ('all', market_type)
-- what runs for Crypto
WHERE market_type = 'crypto'
-- what runs for All
WHERE TRUE
```

`:yesterday` becomes yesterday's date and `:symbol` the market. The definitions keep the parameters,
so one definition serves every choice.

### 28.3 Save, as the shared version or the account's own

**The decision.** Should every account be able to change what everyone sees? The owner chose
*each user saves their own*: the owner's account (set by the Cloudflare secret `MARKET_OWNER_ID`)
saves the shared definition; every other account saves a personal version that only its own page uses.

**A table for personal versions.** `market.semantic.user_metric_definitions`
([DDL](../../sql/ddl/005_user_metrics.sql), setup task `create_user_metrics`) holds each account's
versions with the same SCD Type 2 columns as `metric_definitions`, keyed by `account_id`, `metric_id`,
`version`, plus `based_on` (the shared version it started from). Closing the current version without
adding one sends the account back to the shared definition. It is a dbt source with 9 tests (7
`not_null`, a `relationships` test to `metric_definitions`, and
[`assert_user_metric_definitions_valid`](../../dbt/tests/assert_user_metric_definitions_valid.sql):
versions without gaps, at most one current and it is the newest, sensible dates, one read-only
statement). The project now has 131 tests.

**A login for MEDUSA.** The service principal `medusa-markets-writer` has **Can use** on the
warehouse, `USE CATALOG` on `market`, `USE SCHEMA` on `market.semantic`, and `SELECT, MODIFY` on the
two definitions tables, nothing else: reading `market.gold` is refused with `INSUFFICIENT_PERMISSIONS`.
It signs in with OAuth client credentials and the `sql` scope; Free Edition refuses the usual
`all-apis` scope. Its address, client id and secret are Cloudflare secrets; the setup is in
[operations](../operations.md#the-markets-save-login-service-principal).

**The save.** [`src/metrics.js`](../../../src/metrics.js) runs one `MERGE` per save. For a personal
version:

```sql
MERGE INTO market.semantic.user_metric_definitions AS t
USING (
  WITH cur AS (
    SELECT coalesce(max(version), 0) AS last_v,
           coalesce(max(CASE WHEN is_current THEN version END), 0) AS current_v
    FROM market.semantic.user_metric_definitions
    WHERE account_id = :account_id AND metric_id = :metric_id
  )
  SELECT :account_id AS account_id, :metric_id AS metric_id, current_v AS version, 'close' AS step FROM cur
  WHERE current_v > 0 AND current_v = :base          -- the version in use is closed ...
  UNION ALL
  SELECT :account_id, :metric_id, last_v + 1, 'add' FROM cur
  WHERE current_v = :base                            -- ... and the next one added, only if nobody saved in between
) AS s
ON t.account_id = s.account_id AND t.metric_id = s.metric_id AND t.version = s.version AND s.step = 'close'
WHEN MATCHED THEN UPDATE SET valid_to = current_timestamp(), is_current = false
WHEN NOT MATCHED AND s.step = 'add' THEN INSERT (...) VALUES (..., :sql_text, ...)
```

The shared version's `MERGE` is the same on `metric_definitions`, carrying the kind, name and display
over from the version in use. When `num_inserted_rows` isn't 1, someone saved first, and the window is
told to reload. Before sending anything, the window runs every number the change touches (not only its
own) once with it, and saves nothing if one would break.

**MEDUSA's copy.** A new D1 table, `market_user_metrics`
([migration 005](../../../migrations/005_user_metrics.sql)), holds each account's version in use; the
scanner's shared answer in KV never includes it. The save writes the new version there (or, for a
shared one, into `market_metrics` and the KV answer) as soon as Databricks has it. The daily publish
now copies a fourth table, the current personal versions, so MEDUSA's copy always ends up equal to
Databricks. `GET /api/market/metrics/mine` gives the page the account's own versions;
`POST /api/market/metrics/reset` (**Use the shared version again**) closes the account's version
without adding one. Deleting a MEDUSA account also deletes its versions from Databricks and D1.

**Limits.** Every save wakes the warehouse, which uses Free Edition's daily quota: 20 saves a day per
account and 300 for MEDUSA in all, counted in the existing `attempts` table.

### 28.4 History, use a version again, reload

**History.** Each definition's box in the editor has a **History** button. It reads every version from
Databricks (`GET /api/market/metrics/history?id=breadth`, one `UNION ALL` of the shared versions and
the account's own), newest first: who made it, when it was in use, its note, its SQL, and which one is
in use now. An account with its own versions sees them above the shared ones. Reads have their own
allowance (60 a day per account, 600 in all), and a name that isn't a definition is refused (404)
before Databricks is woken.

**Use this version again.** On any version that isn't in use: its SQL goes into the editor, is
previewed, and **Save** opens with the note filled in (*Back to shared version 1*). Saving it goes
through every check like any other change and becomes the **next** version, so the history shows both
the change and the undo, and nobody has to edit Databricks by hand to go back.

**Reload definitions from the lakehouse** (the owner's account only). A change made in Databricks
itself (in the SQL editor, a notebook or a job) normally reaches MEDUSA with the next publish. The
owner's button reads the current versions from both tables now (`POST /api/market/metrics/reload`),
replaces MEDUSA's two copies the same way the daily publish does, rebuilds the scanner's answer, and
the page uses them within seconds. Any other account gets *403, only the owner's account reloads the
definitions*.

**The browser's 5-minute copy.** Testing found that a window opened within 5 minutes of a shared save
or a reload still showed the old version: each browser keeps the scanner's answer for 5 minutes
(`cache-control: private, max-age=300`), and a save from that window would have failed with a 409.
After a shared save or a reload, the page now fetches the answer once past the browser's copy
(`fetch(..., { cache: 'reload' })`), which puts the new answer in its place.

## Result

| Check | Result |
|---|---|
| Statements | All 9 statements in `src/metrics.js` planned with `EXPLAIN` in the real workspace before any ran |
| The table | `setup_ddl` ran its 5 tasks; `dbt test --select source:semantic`: PASS=20 (11 + 9) |
| The login | A test script signed in as the service principal, found the warehouse, read `market.semantic` and was refused `market.gold`: 4 of 4 checks passed |
| Locally, against a stand-in Databricks | Personal versions 1 and 2, with the Markets page in another tab switching without a reload (31% to 39%); the checks (409 for an out-of-date window, 400 for a `DELETE`, a `;`, an unknown parameter or a missing base, 404 for an unknown definition, 403 without the CSRF header); **Use the shared version again**; the owner's shared versions 2 and 3 with the KV answer rebuilt and no personal rows in it; account deletion; the publish job with 4 tables |
| 28.4 locally | The owner: History, a save (shared version 2), **Use this version again** on version 1 (saved as version 3 with *Back to shared version 1*), a version 4 written straight into the stand-in Databricks picked up by **Reload** in the page and in D1. Another account: no Reload button (403 from the server), its own versions 1 and 2 listed above the shared ones, a shared version reused as its own version 2, then back to the shared one. The 5-minute copy: reproduced first (a new window showed version 4 while the server had 5), then fixed (a new window after **Reload** or a shared save showed versions 6 and 7) |
| Production | A real save by the owner became version 2 of `bitcoin`, written by the service principal (Delta history: `MERGE`, `numTargetRowsInserted` 1). **Reload** at 09:21 UTC republished `market_metrics` (14 rows) and `market_user_metrics` (0 rows) |

## Problems we hit

- **`all-apis` is refused on Free Edition.** The service principal's first token request failed with
  *Scopes 'all-apis' are not assigned to the client*. The SQL Statement API needs only the `sql` scope,
  which works, and is the smaller permission anyway.
- **A secret on screen.** The first OAuth secret was typed into a prompt that echoes what is typed, and
  appeared in a screenshot. It was deleted at once and a new one generated. Secrets are now typed only
  into hidden prompts (`Read-Host -AsSecureString`, or wrangler's own `secret put`), and the login is
  tested by a script that never prints them.
- **A version removed by hand.** After the first real save (`bitcoin` version 2), the version was
  deleted in the Databricks SQL editor and version 1 made current again by hand. MEDUSA kept running
  version 2 until **Lakehouse transform** republished the definitions. That led to two parts of 28.4:
  **Use this version again** (an undo that adds a version instead of deleting one), and the owner's
  **Reload** (a hand change reaches MEDUSA in seconds). Delta's history still shows the save and the
  hand undo: `MERGE` by the service principal, three `DELETE`s and an `UPDATE` by a person.
- **The preview's time limit didn't apply while tables loaded.** A run that also loads the day's
  tables gets 30 seconds, so a slow preview in that run wasn't stopped at 5. Previews now never run in a
  loading run.
- **`/markets-window.html` answered 307.** Cloudflare serves HTML files without their extension and
  redirects the long form; the buttons open `/markets-window`.
- **Pop-ups.** A browser that blocks pop-ups blocks the window; the page then says so instead of
  failing silently.
- **The browser's 5-minute copy** and **History waking Databricks for an unknown name** were found by
  the 28.4 tests and fixed (above).
