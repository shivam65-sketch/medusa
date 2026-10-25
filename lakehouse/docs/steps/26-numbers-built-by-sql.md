# Step 26: Every number on the Markets page built by SQL

[← Lakehouse home](../../README.md) · [← Step 25](25-scanner-page.md) · Next: [Step 27 →](27-metric-definitions.md)

| | |
|---|---|
| **Built** | 2026-10-24 to 2026-10-25 (not a release yet: it ships in MEDUSA 1.7.0) |
| **Files** | [`public/markets-metrics.js`](../../../public/markets-metrics.js) (every number as SQL) · [`public/markets-sql.js`](../../../public/markets-sql.js) (the SQL engine) · [`public/markets.js`](../../../public/markets.js) (feeds the engine, draws its results) · [`public/vendor/sqljs-1.14.2/`](../../../public/vendor/sqljs-1.14.2/) (SQLite for the browser) · [`src/market.js`](../../../src/market.js) (the ready-made answer in KV) · [`dbt/models/exposures.yml`](../../dbt/models/exposures.yml) · [`serving/publish_to_medusa.py`](../../serving/publish_to_medusa.py) |
| **Decisions** | [ADR-026](../decisions.md#adr-026-the-scanners-answer-is-kept-ready-made-in-workers-kv), [ADR-027](../decisions.md#adr-027-the-live-layer-runs-in-each-browser), [ADR-028](../decisions.md#adr-028-every-number-is-a-sql-query-run-in-the-browser) |

## Goal

In release 1.6.0 every number on the Markets page could show "how it is calculated" as a SQL query,
but JavaScript did the calculating and wrote the SQL afterwards, with the prices on screen pasted in.
The numbers made the SQL; editing the SQL would have changed nothing. This step turns that around:
**the SQL builds the numbers**. Change a query and the number on the page changes. It is the first
of three steps towards definitions that live in Databricks (step 27) and can be edited on the page
(step 28).

## Concepts

| Concept | Here |
|---|---|
| **A SQL engine in the browser** | SQLite compiled to WebAssembly ([sql.js](https://github.com/sql-js/sql.js) 1.14.2, MIT), running in a background worker. It holds four tables: the lakehouse's two, exactly as in MEDUSA's D1 (`market_baseline`, `market_evidence`), and two that exist only in the browser, `live_prices` and `binance_markets`. |
| **Push and pull** | Binance **pushes** prices to the browser over a WebSocket, about once a second (streaming). The page **pulls** the lakehouse's daily tables from MEDUSA when it opens and every 30 minutes (batch). Both land in the same SQL database, where the numbers are calculated. |
| **Upsert** | Binance only broadcasts; it doesn't know the table exists. The page writes each message into `live_prices` with `INSERT ... ON CONFLICT (symbol) DO UPDATE`, SQLite's version of `MERGE`: one row per market, always its latest price. |
| **A metrics layer** | Every number is defined once, as data: a name, a definition in words, the SQL and how its columns are shown. Shared steps (**models**) are written once and read by name, like views or dbt models; **metrics** are the cards and tables. Tools such as dbt's semantic layer, Looker and Metabase work the same way. |
| **Models as CTEs** | Before a query runs, the models it reads are put in front of it as `WITH model AS (...)`, in dependency order, so the query on the page is complete and is exactly what ran. dbt's ephemeral models work the same way. |
| **Query parameters** | `:kind` (the type filter), `:yesterday` (the day today's move is measured from) and `:symbol` (one market). They change what a query computes, like report parameters in SSRS. Search, sorting and pages in Every market only change what is displayed, so they stay in the page. |
| **Read-only queries** | The engine switches to read-only mode (`PRAGMA query_only`) while the queries run, so no query can change the tables. A run that takes longer than 15 seconds restarts the engine. |
| **Portable SQL** | The queries are written in SQLite's dialect but kept to SQL that Databricks runs too. Two differences needed care: `/` on two whole numbers divides without the remainder in SQLite but not in Databricks (hence `CAST(... AS INTEGER)` in the median), and dividing by zero gives NULL in SQLite but an error in Databricks (hence `NULLIF`). |
| **A dbt exposure** | A declaration in dbt that something outside dbt uses its tables. `markets_page` depends on `coin_baseline` and `event_evidence`, so the lineage graph runs from Binance's files to the page, and dbt can answer "what feeds the page?" and "does changing this model reach the page?". |
| **A write-through serving cache** | The read endpoint's answer is the same for every account, so it is built once when the data changes and kept in Workers KV. Page loads read one KV value instead of about 810 D1 rows. |

## How a number is built

Four shared steps feed every number on the Today view:

```text
market_baseline ─┐
live_prices ─────┼─► market_now ─► today ─► flagged ─┐
binance_markets ─┘                                    ├─► the metric's own SELECT ─► the card or table
market_evidence ───────────────────────► verdicts ───┘
```

| Model | What it does |
|---|---|
| `market_now` | Each trading market's live price, its type, its normal, and the close today's move is measured from: the lakehouse's own close, or Binance's daily candle when the lakehouse doesn't have yesterday yet (`as_of_date < :yesterday`) |
| `today` | The move (price ÷ close − 1), z (the move in usual daily moves, from 20 days of history), volume against a usual day, and liquidity |
| `flagged` | Only the markets with \|z\| ≥ 3, with their direction and size band. The 3σ line is written here and nowhere else |
| `verdicts` | `market_evidence` turned into one row per kind of move with a column per horizon: `fade 0.22%` when the pattern held up, otherwise its verdict |

| Metric | Shown as |
|---|---|
| `breadth`, `median_move`, `unusual_count`, `bitcoin` | The four summary cards; each card's text fills `{column:format}` from the query's first row |
| `unusual` | Unusual right now: `flagged` joined to `verdicts` twice, for the market's own kind of move and for every move in its direction |
| `gainers`, `losers` | Movers today |
| `markets` | Every market (search, sorting and pages work on its result) |
| `market` | One market's details (`:symbol`) |
| `unusual_all_types` | The Patterns view's **Now**, and when the page first saw each market unusual |

A worked example from the local test, ORDER on 24 October at about 22:15 UTC:

| Step | ORDER |
|---|---|
| `market_now` | price 0.05621; close 0.03301 (lakehouse, 23 Oct); average daily return −0.49%; σ 3.54%; 0.8 million USDT a day |
| `today` | move 0.05621 ÷ 0.03301 − 1 = +70.28%; z = (70.28% + 0.49%) ÷ 3.54% = +20.0; liquidity small |
| `flagged` | up, 6+, small |
| `verdicts` | own kind: no pattern (1 h, 4 h, 24 h); every up move: fade 0.22%, fade 0.65%, no pattern |
| On screen | ORDER · 0.05621 · +70.28% · +20.0σ · Small · no pattern (all up: fade +0.22%) · … |

## What runs every second

1. Binance's messages arrive; the page notes which markets changed (often 100 to 200 of 741).
2. Those rows are upserted into `live_prices` (about 1 ms).
3. The view's queries run: 9 on Today, 10 with a market's details open (about 50 ms in all).
4. The page redraws only the parts whose results changed.

A type filter or an opened market runs the queries at once (about 0.1 s); new prices wait for the
next second.

## The calculation panels

Each **‹›** panel shows:

- the query, exactly as it ran (it reads `FROM live_prices`; no prices are written into it)
- its parameters and their values
- the result as the engine returned it, before formatting
- what each table is and when it was last updated
- **Copy for MEDUSA (D1)** and **Copy for Databricks**: the browser-only tables are added as
  `VALUES` (as they were for the result on screen) and the parameters filled in, so the copy runs in
  either database and returns that result
- **Download the result (CSV)** and **Download the inputs (CSV)** (each market's row of `market_now`)

## The read endpoint's answer, ready-made in KV

Release 1.6.0 kept one copy of `GET /api/market/scanner`'s answer in Cloudflare's cache. In production
it always said `x-cache: MISS`: the Cache API only works for Workers on a custom domain, and MEDUSA
runs on a `workers.dev` address. Every page load read about 810 rows from D1, against a free
allowance of 5 million rows a day shared with the journal.

Now the ingest rebuilds the answer after every publish and saves it in Workers KV
(`market/scanner.json`, in the Lab's namespace). Page loads read that value, so they read no D1 rows,
and the answer changes the moment new data is published. If the value is missing (before the first
publish, or after a rebuild failed, which deletes the old value rather than leave it stale), the
endpoint reads D1 and keeps that answer for 10 minutes. `x-cache` says `KV` or `D1`, and the publish
job's summary shows a **Scanner answer** column (`kv` or `d1`).

Many users reading the same tables don't cause lock problems: the per-second queries run on each
user's own copy in their browser, page loads read KV, and D1 runs one query at a time, with the only
write being the daily publish (one transaction per table).

## The dbt exposure

```bash
cd lakehouse/dbt
../.venv/Scripts/dbt ls --select +exposure:markets_page --resource-type exposure model source --output name
../.venv/Scripts/dbt ls --select fct_candle_1m+ --resource-type exposure --output name   # markets_page: a change reaches the page
../.venv/Scripts/dbt ls --select hour_profile+ --resource-type exposure --output name    # nothing: the page doesn't use it
```

The first lists 14 names: the page, 10 models (`coin_baseline`, `event_evidence`, `coin_daily`,
`intraday_events` and the 6 silver models under them) and the 3 bronze sources.
`dbt build --select +exposure:markets_page` rebuilds and tests only what the page needs.
`dbt docs generate` and `dbt docs serve` draw the chain ending at the page.

## Result

| Check | Result |
|---|---|
| Queries against the previous JavaScript rule (SQLite, real Binance prices, local D1 data) | Breadth, median, unusual count and table, gainers, losers and every market identical, for All, Crypto and Stocks; markets whose close came from Binance too |
| Copies in SQLite and in Databricks | 34 of 34 identical (two close sources × All and Crypto × every query). The only difference found, SQLite writing `-0.0` where Databricks writes `0.0`, is the same number |
| A copy taken from the live page | For all 8 panels and a market's details, the copy run on D1's tables alone returned exactly the result the panel showed |
| Speed | 34 to 72 ms for 9 or 10 queries; a filter click shows the new numbers in about 115 ms |
| sql.js files | Sizes and SHA-256 fingerprints match the ones jsDelivr publishes |
| Security policy | Only `/markets-sql.js` may run WebAssembly, and it can reach only MEDUSA; the page's own policy is unchanged |
| Layout | Phone width (375 px) with panels and details open: no sideways scrolling |
| KV answer, locally | Signed out 401; first read from D1, then KV; a publish rebuilt the answer (`served: kv`) and the next read had the new publish time |
| Production | Deployed and checked by the owner on 2026-10-25: numbers calculated by SQL, `x-cache: KV` |

## Problems we hit

- **The cache that wasn't.** ADR-025 described one cached copy for everyone. Checking `x-cache` in
  production showed `MISS` on every load: Cloudflare's Cache API does nothing on a `workers.dev`
  address. The answer moved to KV (ADR-026).
- **"It still says D1" after deploying.** Two other caches: the browser keeps the answer for 5
  minutes (headers included), and KV remembers a missing key for up to a minute. With **Disable
  cache** ticked in DevTools and a minute's wait, it said `KV`.
- **A slow, restarted engine was the test's fault.** A test watcher that re-read the whole page's
  text on every change kept the page busy; runs took up to a second and one passed the 5-second
  guard. Without it, runs take 34 to 72 ms. The guard is now 15 seconds, so a briefly busy phone
  doesn't restart the engine.
- **A filter click took a second to show.** The click waited for the next once-a-second run. Clicks
  now run the queries at once.
- **Copies need types for empty columns.** In Databricks, a `VALUES` column that is empty in its
  first row has no type, so the copies write `CAST(NULL AS DOUBLE)` or `CAST(NULL AS STRING)` there.
- **One unexplained message.** Once, in a test harness that started a fresh engine for each check,
  SQLite returned "not an error" for one query. It didn't happen again in 12 retries or in the page;
  if it did, the next second's run would replace it.
