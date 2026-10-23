# Step 23: Serving tables in MEDUSA, behind a write-only endpoint

[← Lakehouse home](../../README.md) · [← Step 22](22-evidence.md) · Next: [Step 24 →](24-publish-job.md)

| | |
|---|---|
| **Built** | 2026-10-23 |
| **Commit** | `82f5084` App: market tables in D1 and a write-only ingest endpoint for the lakehouse (serving layer) |
| **Files** | [`migrations/003_market.sql`](../../../migrations/003_market.sql) · [`schema.sql`](../../../schema.sql) · [`src/market.js`](../../../src/market.js) · [`src/worker.js`](../../../src/worker.js) |
| **Decisions** | [ADR-013](../decisions.md#adr-013-serve-the-public-dashboard-from-a-daily-copy) · [ADR-024](../decisions.md#adr-024-a-write-only-endpoint-for-the-serving-copy) |

## Goal

The live scanner runs in MEDUSA on Cloudflare, but each coin's normal and the evidence live in
Databricks, where visitors can't sign in. MEDUSA keeps its own small copy of those two tables in its
database (D1), and gets a single, narrow way in for the daily copy.

## Concepts

| Concept | Here |
|---|---|
| **Serving layer (reverse ETL)** | Finished warehouse tables are copied to where an application reads them fast and for free; the warehouse stays private. |
| **Least privilege** | The publish job could have had a Cloudflare database token, but that would open every table, including accounts and encrypted exchange keys. Instead one endpoint, with its own token, can only replace two public market tables. A leaked token could overwrite market numbers, nothing more (ADR-024). |
| **A contract at the boundary** | Every row is checked before anything is written: a known table, known columns, the right type for each, required values present, no key twice, at most 2 MB. A bad request is refused with the row and column. |
| **Atomic replace** | Deleting the old rows, inserting the new ones and recording the publish run as one D1 batch, which is a single transaction: a reader sees yesterday's copy or today's, never half of each. |
| **Idempotent** | Sending the same table twice leaves the same table. |
| **Working inside 10 ms of CPU** | Cloudflare's free plan allows about 10 ms of CPU per request. SQLite unpacks the rows itself (`json_each`) from the request's text, so the Worker doesn't build a statement per row. |
| **Constant-time token check** | Both tokens are hashed (SHA-256) and compared with `crypto.subtle.timingSafeEqual`, so response times don't reveal how much of a guess was right. |

## Code walkthrough

The tables ([`migrations/003_market.sql`](../../../migrations/003_market.sql)) have no `user_id`:
they are shared market data, like `logos`.

| Table | Rows | From |
|---|---|---|
| `market_baseline` | One per coin (key `symbol`) | `gold.coin_baseline` |
| `market_evidence` | One per kind of move and horizon (key `direction, z_band, liquidity, horizon_hours`) | `gold.event_evidence` |
| `market_publish` | One per table: lakehouse day, rows, time of the publish | Written by the endpoint |

The endpoint ([`src/market.js`](../../../src/market.js)) is routed before the browser-only checks,
because its caller is a server with a token, not a browser with a cookie:

```js
// POST /api/market/ingest  {"table": "market_baseline", "as_of": "2026-10-21", "rows": [...]}
await db.batch([
  db.prepare(`DELETE FROM ${body.table}`),
  db.prepare(`INSERT INTO ${body.table} (${cols.join(', ')})
              SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?1, '$.rows')`)
    .bind(text),
  db.prepare(`INSERT INTO market_publish ... ON CONFLICT(tbl) DO UPDATE ...`),
  db.prepare(`SELECT COUNT(*) AS n FROM ${body.table}`),
]);
```

Table and column names come from the endpoint's own list, never from the request.

## How to run

```
npx wrangler@4 d1 execute medusa --remote --file=migrations/003_market.sql
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler@4 secret put MARKET_INGEST_TOKEN        (paste the token)
npx wrangler@4 deploy
```

The same token is saved as the GitHub Actions secret `MEDUSA_INGEST_TOKEN`, and the app's address as
`MEDUSA_URL`, for step 24. A request without the token is answered `401 Wrong or missing token.`

## Result

On a local copy of the app with a test token, 16 of 16 checks passed:

| Check | Answer |
|---|---|
| No token, wrong token | 401 |
| Not JSON, unknown table, bad date, unknown column, wrong type, same key twice, required value empty, no rows | 400, naming the row and column |
| A 3 MB body | 413 |
| The real `coin_baseline` (748 coins) and `event_evidence` (60 rows) | Stored; Bitcoin's row identical to gold |
| Publishing 10 rows, then 60 | The table held exactly 10, then 60 |
| The app's other POST routes | Still refuse requests from outside the app (403) |

In production the three tables were created and the secret saved; the endpoint answered `401` without
the token and accepted the real token.

## Problems we hit

A test that announced a 3 MB body but sent a small one hung: the local server waited for bytes that
never came. The test now sends a real 3 MB body.
