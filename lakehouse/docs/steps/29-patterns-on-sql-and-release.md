# Step 29: Patterns on SQL, and release 1.7.0

[← Lakehouse home](../../README.md) · [← Step 28](28-editing-the-definitions.md)

| | |
|---|---|
| **Built** | 2026-10-25, released as MEDUSA **1.7.0** |
| **Commits** | `34924bb` (29.1 definitions and seed) · `9f729d9` (29.2 the view on SQL) · the release commit (29.3) |
| **Files** | [`public/markets-metrics.js`](../../../public/markets-metrics.js) (the three definitions, built-in copy) · [`sql/seed/002_metric_definitions_patterns.sql`](../../sql/seed/002_metric_definitions_patterns.sql) (version 1 in Databricks) · [`databricks.yml`](../../databricks.yml) (task `seed_patterns`) · [`public/markets.js`](../../../public/markets.js) (the view and its window) · [`public/version.json`](../../../public/version.json) and [`CHANGELOG.md`](../../../CHANGELOG.md) (the release) |
| **Decisions** | No new decision: the Patterns view follows [ADR-028](../decisions.md#adr-028-every-number-is-a-sql-query-run-in-the-browser) to [ADR-031](../decisions.md#adr-031-edits-are-saved-to-databricks-by-medusas-server-as-shared-or-personal-versions), like Today |

## Goal

After step 28 every number on the Markets page's **Today** view was a versioned SQL definition that
could be opened, edited and saved. The **Patterns** view was not: apart from its **Now** column, it was
JavaScript counting and filtering the evidence table. This step moves Patterns onto the same SQL engine
and definitions, so the whole page follows one rule (the SQL builds the numbers), and closes the work
of steps 26 to 29 as release **1.7.0**.

## Concepts

| Concept | Here |
|---|---|
| **Characterization (parity) test** | Before replacing working code, record exactly what it produces and require the replacement to produce the same on the same inputs. Here the old JavaScript rules were rewritten in a test script and compared with the new SQL, number by number. |
| **Portable SQL** | The same query must run in the browser's SQLite and in Databricks, so the copies on the page return the same result in both. Functions whose syntax differs between the two (joining text from many rows: `group_concat` in SQLite, `string_agg ... WITHIN GROUP` in Databricks) are avoided; the held-up list returns one row per market instead. |
| **An incremental, idempotent seed** | New definitions arrive as a second seed file, not by editing the first: a `MERGE ... WHEN NOT MATCHED` that adds only what is missing, run as a second task of the same job. Seed files that have run are never edited, like the numbered DDL files ([ADR-006](../decisions.md#adr-006-ddl-as-numbered-re-runnable-files)). |
| **Semantic versioning** | `MAJOR.MINOR.PATCH`: 1.7.0 raises the minor number because it adds features without breaking anything that worked before. |

## The three definitions

| Definition | What it returns | Replaces |
|---|---|---|
| `patterns_summary` | One row: the moves recorded since 2020 (up and down, from the `all` rows at 1 hour), how many kinds of move and horizons got each verdict, how many there are, and the round-trip cost | The JavaScript counts over the evidence rows |
| `patterns_held` | Each pattern that held up (`verdict = 'held up'`), best result first, with its side, results and t on both periods, and one row for each market in that group right now (`LEFT JOIN flagged`) | The JavaScript sort and the live filter for **Right now** |
| `patterns_grid` | Each kind of move (direction × size band × liquidity, plus every up or down move together) in the page's order, the markets in it now (`COUNT` over `flagged`), and its verdict over the next 1, 4 and 24 hours (the shared step `verdicts`) | The JavaScript grid and the **Now** counts |

`patterns_grid` reuses `verdicts`, the shared step that already gives the **Unusual right now** table its
verdicts, so a change to how a verdict is written changes both views. All three read
`market_evidence`, MEDUSA's copy of the lakehouse's `gold.event_evidence`; the held list and the grid
also read `flagged`, the markets unusual right now (any type).

## Built in three parts

### 29.1 The definitions, and version 1 in Databricks

The three queries were written into the built-in copy (`public/markets-metrics.js`) and generated into
[`002_metric_definitions_patterns.sql`](../../sql/seed/002_metric_definitions_patterns.sql), escaped the
Databricks way (`\'`). The seed runs as task `seed_patterns` after `seed_v1` in job
`seed_metric_definitions`; running the job again adds nothing.

### 29.2 The view on SQL

On the Patterns view the page now runs the three queries with the rest (under 1 ms to about 45 ms each) and draws
from their results. Tapping a cell still puts that kind of move's evidence row into words: that turns a
row into sentences, it doesn't calculate. The view's ‹› window (a ‹› on each of its three sections)
shows the three queries and the unusual markets query, each with its version, live result, copies and
editor, so Patterns can be previewed, saved, reloaded and undone like Today.

### 29.3 Release 1.7.0

`public/version.json` says 1.7.0 with five short lines that open tabs show as *what's new*, and the
CHANGELOG's *Unreleased* section became **1.7.0 (2026-10-25)**: every change of steps 26 to 29.

## Result

| Check | Result |
|---|---|
| Parity with the old JavaScript | On MEDUSA's local copy with 261 simulated unusual markets in every size band: the summary's 8 numbers, the 4 held-up patterns (order, numbers and the markets in each), all 20 grid rows (order and every **Now**, 522 in all) and all 60 verdict cells identical |
| Databricks | All three ran on `gold.event_evidence` with made-up unusual markets: the same totals as MEDUSA's copy (13,556 up and 7,649 down moves; 4 held up, 6 did not hold, 35 no pattern, 15 too few, of 60) |
| The seed | `EXPLAIN` planned the `MERGE`; its strings read back from Databricks identical to the built-in copy; `databricks bundle validate` OK. In production: 3 rows, version 1, at 10:38 UTC |
| Locally | With live prices: the view as before (4 / 6 / 35 / 15 of 60, 21,205 moves, the held-up list with the markets in it now); **Now** totalled 22 for 11 unusual markets (each counts in its group and in its direction's "every move"); after a local publish from Databricks every Patterns query showed version 1 from the lakehouse; a preview changed only the query edited; no new errors |
| Production | Deployed; the owner's **Reload** at 11:01 UTC brought the three definitions into MEDUSA (`market_metrics` 17 rows) |

## Problems we hit

- **No unusual markets in the first test.** The simulated prices produced no unusual markets, so the
  **Now** parts weren't tested at all although everything "matched". The local copy's last lakehouse
  day was 23 October, so `market_now` measured today's move from Binance's close for 24 October, which
  the simulation didn't supply. Measuring from the lakehouse's own day gave 261 unusual markets, and
  the comparison then covered every part. A test that passes with no data in it proves little.
- **Text from many rows.** The first idea for **Right now** was one row per pattern with its markets
  joined into one text, but SQLite and Databricks write that differently. One row per market is
  portable, and the page groups the rows.
- **"Haven't been published yet".** Before the three definitions reached MEDUSA, their window said that
  the lakehouse's definitions hadn't been published at all, which wasn't true for the other fourteen.
  It now says the lakehouse hasn't published *this* definition yet.
