# Step 27: Metric definitions kept in Databricks

[← Lakehouse home](../../README.md) · [← Step 26](26-numbers-built-by-sql.md)

| | |
|---|---|
| **Built** | 2026-10-25 (not a release yet: it ships in MEDUSA 1.7.0) |
| **Commit** | `0395a68` |
| **Files** | [`sql/ddl/004_semantic.sql`](../../sql/ddl/004_semantic.sql) (the table) · [`sql/seed/001_metric_definitions_v1.sql`](../../sql/seed/001_metric_definitions_v1.sql) (version 1 of every definition) · [`databricks.yml`](../../databricks.yml) (task `create_semantic`, job `seed_metric_definitions`) · [`dbt/models/sources.yml`](../../dbt/models/sources.yml) and [`dbt/tests/`](../../dbt/tests/) (the rules) · [`dbt/models/exposures.yml`](../../dbt/models/exposures.yml) · [`serving/publish_to_medusa.py`](../../serving/publish_to_medusa.py) · [`migrations/004_metrics.sql`](../../../migrations/004_metrics.sql) and [`src/market.js`](../../../src/market.js) (MEDUSA's copy) · [`public/markets.js`](../../../public/markets.js) (runs them) · [`public/markets-metrics.js`](../../../public/markets-metrics.js) (now the built-in copy) |
| **Decisions** | [ADR-029](../decisions.md#adr-029-metric-definitions-are-kept-in-databricks-and-published-with-the-data) |

## Goal

After step 26 the SQL built every number on the Markets page, but the SQL lived in a JavaScript file
inside the app: changing a definition meant changing code and deploying MEDUSA. This step makes the
lakehouse the master copy. Every definition, with its name, its meaning in words, its SQL and how its
result is shown, is a row in a versioned Databricks table. dbt checks the rows, the daily publish
copies the current version of each to MEDUSA with the data, and the page runs what arrives. Step 28
adds editing on the page; this step builds the place an edit is saved to.

## Concepts

| Concept | Here |
|---|---|
| **A semantic layer kept as data** | The definitions are rows in a table, not code. Anything that can read a table (the page, a dashboard, a notebook, an auditor) gets the same definition, and changing one is a data change, not a release. dbt's semantic layer, Looker's LookML and Cube keep metrics outside the reports for the same reason. |
| **Versions instead of updates (SCD Type 2)** | A change never overwrites a row. It closes the current version (`valid_to`, `is_current = false`) and adds the next one (`version + 1`, `valid_from`, `is_current = true`), the way `dim_coin` keeps a coin's history. Any past number can be explained by the version that was current at the time. In SQL Server terms: a system-versioned temporal table, kept by hand. |
| **An informational primary key** | `PRIMARY KEY (metric_id, version)` is declared, but Unity Catalog doesn't enforce it: it tells readers and tools what a row means. The dbt tests enforce it. In SQL Server terms: a constraint that is `NOT ENFORCED`. |
| **An idempotent seed** | Version 1 was loaded with `MERGE ... WHEN NOT MATCHED THEN INSERT`: running it again adds nothing, so the seed job can be re-run safely. |
| **A data contract** | The rules every definition follows before it can reach the page, written as dbt tests (below). The publish runs only after `dbt build` passes, so a definition that breaks a rule stops the publish and MEDUSA keeps the last checked copy. |
| **One master copy, with a fallback** | The page uses the published definitions. Until they arrive (a new install, or before the first publish) it uses the built-in copy in `public/markets-metrics.js`, and says which one it is using. |
| **Delta's own history** | Delta records every change to a table (`DESCRIBE HISTORY`), and any earlier state can be read back (`VERSION AS OF`). The version columns say *what* each definition was; Delta's history says *when the table changed and how*. |

## The table: `market.semantic.metric_definitions`

A new schema, `market.semantic`, next to the medallion layers. It isn't built from Binance's data: it
holds definitions about the data. The full column list is in the
[data dictionary](../data-dictionary.md#semantic-marketsemanticmetric_definitions).

| Column | Holds |
|---|---|
| `metric_id`, `version` | The key: a stable id the page uses (`breadth`) and 1, 2, 3 ... one per change |
| `kind` | `model` (a shared step other queries read by name, like a view) or `metric` (a card or table on the page) |
| `name`, `description` | What the page shows as its title and its meaning in words |
| `sql_text` | The query, in SQLite's dialect, kept portable to Databricks ([ADR-028](../decisions.md#adr-028-every-number-is-a-sql-query-run-in-the-browser)) |
| `display` | How the result is shown, as JSON: a card's text, or each column's label and format |
| `valid_from`, `valid_to`, `is_current` | When the version came into use and was replaced; exactly one current version per id |
| `changed_by`, `change_note` | Who made the version (a name, never an email) and why |

Version 1 holds 14 rows: the 4 models (`market_now`, `today`, `flagged`, `verdicts`) and the 10
metrics (`breadth`, `median_move`, `unusual_count`, `bitcoin`, `unusual`, `gainers`, `losers`,
`markets`, `market`, `unusual_all_types`), copied from `public/markets-metrics.js`.

## From the table to the page

```text
market.semantic.metric_definitions   every version of every definition
        │   dbt build: 11 tests, the rules every definition follows
        ▼
publish job ── the current version of each (14 rows) ──► MEDUSA D1: market_metrics
                                                              │  rebuilt with the scanner's answer in KV
                                                              ▼
                                         Markets page: the published definitions, over the built-in copy
                                                              │
                                                              ▼
                                         SQLite in the browser runs them about once a second
```

Only the current versions are published; the history stays in the lakehouse. MEDUSA's
`market_metrics` has one row per id and is replaced as a whole, like the other two tables
([ADR-024](../decisions.md#adr-024-a-write-only-endpoint-for-the-serving-copy)).

## Built in four parts

### 27.1 The table

`sql/ddl/004_semantic.sql` creates the schema and the table, with a comment on every column. The
setup job, `databricks bundle run setup_ddl`, runs it as a fourth task (`create_semantic`, after
`create_schemas`). Before it ran, each statement was checked with `EXPLAIN`, which plans a statement
without running it.

### 27.2 Version 1

`sql/seed/001_metric_definitions_v1.sql` is a single `MERGE` with the 14 definitions as `VALUES`. It
was generated from `public/markets-metrics.js`, so the SQL is character for character what the page
had run since step 26. Job `seed_metric_definitions` runs it.

### 27.3 The rules (dbt)

`market.semantic.metric_definitions` is a dbt source with 11 tests. `dbt build` runs them every day
before the publish, and `dbt test --select source:semantic` runs them alone.

| Test | Rule |
|---|---|
| `not_null` on 8 columns | `metric_id`, `version`, `kind`, `name`, `sql_text`, `valid_from`, `is_current`, `changed_by` |
| `accepted_values` on `kind` | `model` or `metric` |
| [`assert_metric_definitions_one_current_version`](../../dbt/tests/assert_metric_definitions_one_current_version.sql) | Exactly one current version per id, and it is the newest |
| [`assert_metric_definitions_valid`](../../dbt/tests/assert_metric_definitions_valid.sql) | Versions run 1, 2, 3 ... with no gaps or repeats; only old versions have `valid_to`, and not before `valid_from`; the id is a plain lowercase name (queries read models by name); the SQL is one read-only statement (it starts with `SELECT` or `WITH` and has no `;`); every metric has a display, and every display is valid JSON |

Each test returns the rows that break its rule, so 0 rows means it passed. Each rule was also checked
the other way: a copy of the table with one broken row of each kind made each test fail with that row.
The project now has 122 tests.

The `markets_page` exposure now also depends on `source('semantic', 'metric_definitions')`, so the
lineage shows the definitions reaching the page, and
`dbt ls --select +exposure:markets_page --resource-type exposure model source` lists 15 names.

### 27.4 Published to MEDUSA, run by the page

| Where | What changed |
|---|---|
| D1 | A new table, `market_metrics` ([`migrations/004_metrics.sql`](../../../migrations/004_metrics.sql), also in `schema.sql`), keyed by `metric_id` |
| `POST /api/market/ingest` | Accepts `market_metrics` (at most 200 rows). Every row is checked like the others: the 5 required columns, types, a unique `metric_id`, text up to 20,000 characters for the SQL and display, and `valid_from` as a date and time |
| `GET /api/market/scanner` | The answer, kept in KV, also holds `market_metrics`. Before migration 004 it answers without it |
| Publish job | A third query: the current version of each definition, `valid_from` as text |
| Markets page | Builds its definitions from the published rows, each over the built-in one with the same id. A display that isn't valid JSON, or lacks what the page needs, keeps the built-in display |

Each **‹›** panel says where its definition came from:

> **Definition:** version 1 of `unusual` in the lakehouse's `market.semantic.metric_definitions`,
> in use since *valid_from* UTC (Shivam); its shared steps: `market_now` v1, `today` v1, `flagged` v1,
> `verdicts` v1.

or, without published definitions, *"the built-in copy in `markets-metrics.js`, because the
lakehouse's definitions haven't been published to MEDUSA yet."* The status line ends with *"defined in
the lakehouse"* or *"defined by the built-in copy"*.

## Changing a definition

Step 28 does this from the page. Underneath, a change is two writes in one statement: the current row
gets `valid_to` and `is_current = false`, and a new row gets `version + 1` with `is_current = true`.
The next publish sends it to MEDUSA, and every page that loads afterwards calculates with it.

This was tried on a local copy of MEDUSA: a version 2 of `breadth` that counted only the markets that
had moved more than 1% either way, published to the local ingest, changed the card on the next load,
from 286 of 395 up to 14 of 29, with the panel showing version 2. Version 1 was then restored.

## Result

| Check | Result |
|---|---|
| The table | `EXPLAIN` planned every statement; the bundle validated; `setup_ddl` ran its 4 tasks; `DESCRIBE` shows the 12 columns and their comments |
| Version 1 | 14 rows, each identical to the file in every column, apostrophes and backslashes included. Delta's history: `CREATE TABLE`, `CHANGE COLUMN` twice (the two comments fixed), `MERGE` |
| The rules | `dbt test --select source:semantic`: PASS=11. Each rule failed on a row that breaks it |
| Locally | Before migration 004 the page used the built-in copy and said so. After it, the real publish job sent 748, 60 and 14 rows (all OK, answer `kv`), and every panel showed version 1 from the lakehouse with the same numbers as before |
| Production | Published on 2026-10-25 at 00:30 UTC: `market_metrics` 14 rows next to `market_baseline` 748 and `market_evidence` 60. Checked by the owner: the page says *defined in the lakehouse* |

## Problems we hit

- **The apostrophes disappeared.** In Databricks, `'it''s'` is not *it's*: two string literals side by
  side are joined, so `''` drops the apostrophe (SQLite, D1 and SQL Server read `''` as one `'`).
  Databricks writes it `\'`. The seed escapes `\'` and `\\`, and two column comments created with `''`
  are set again with `ALTER TABLE ... ALTER COLUMN ... COMMENT`.
- **Semicolons inside comments.** The check that ran each DDL statement through `EXPLAIN` split the
  file on `;`, and a `;` inside a comment cut a statement in two. The DDL's comments don't use `;`.
- **`\s` and `\b` didn't match in the SQL rule.** The test now turns tabs and line breaks into spaces
  (`translate`) and checks `^(SELECT|WITH)[^A-Z0-9_]`, which needs no backslashes.
- **"SQL Task Output: {}" after a successful run.** DDL and `MERGE` return no rows, so a SQL file task
  has nothing to show; the green status is the result, and `DESCRIBE` or a `SELECT` shows the effect.
- **The page still said "built-in copy" after the deploy.** The definitions arrive with the publish,
  which hadn't run since the push. Running **Lakehouse transform** published them; the fallback did
  what it should until then.
