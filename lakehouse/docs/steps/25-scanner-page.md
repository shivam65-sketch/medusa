# Step 25: The live scanner: MEDUSA's Markets page

[← Lakehouse home](../../README.md) · [← Step 24](24-publish-job.md) · Next: [Step 26 →](26-numbers-built-by-sql.md)

| | |
|---|---|
| **Built** | 2026-10-23 to 2026-10-24, released with MEDUSA 1.6.0 |
| **Commits** | `62e4697` read endpoint (25.1) · `58c66a8` the page with Today (25.2) · `260261c` the 1.6.0 release: types, clearer evidence, Patterns, where each number comes from (25.3) |
| **Files** | [`public/markets.js`](../../../public/markets.js) · [`src/market.js`](../../../src/market.js) (`GET /api/market/scanner`) · [`public/app.js`](../../../public/app.js) and [`public/index.html`](../../../public/index.html) (menu, page) · [`public/_headers`](../../../public/_headers) (security policy) |
| **Decisions** | [ADR-013](../decisions.md#adr-013-serve-the-public-dashboard-from-a-daily-copy), [ADR-022](../decisions.md#adr-022-judge-the-evidence-by-days-and-on-held-back-years), [ADR-024](../decisions.md#adr-024-a-write-only-endpoint-for-the-serving-copy), [ADR-025](../decisions.md#adr-025-the-scanner-is-for-signed-in-accounts) |

## Goal

Use the lakehouse where a day trader needs it: while the market is open. MEDUSA's **Markets** page
compares every market's move today with its own normal, flags the moves that are unusual for it, and
shows what similar moves did next, after costs, with the source of every number one click away.

## Concepts

| Concept | Here |
|---|---|
| **Lambda architecture** | The **batch layer** is the lakehouse's daily, tested copy in MEDUSA (each market's normal, the evidence). The **live layer** is Binance's price stream. The page combines them; the next daily run replaces live numbers with checked ones. |
| **Client-side streaming (WebSocket)** | The browser holds one WebSocket to Binance's public stream `wss://fstream.binance.com/market/ws/!miniTicker@arr` and receives every market that changed, about once a second. No server, Kafka or webhook sits in the live path: each browser is its own single consumer, so it costs nothing and scales with users. Nothing live is stored. |
| **Snapshot plus changes** | Stream messages carry only the markets that changed, so the page first takes one snapshot of every price (`GET /fapi/v1/ticker/price`) and applies the stream on top. |
| **One rule, two places, proved equal** | The page applies `intraday_events.sql`'s rule in JavaScript. A parity check recomputed 300 recent lakehouse events with the page's own code: 300 of 300 identical (z difference 0). |
| **Late reference data** | Today's move needs yesterday's close, which the lakehouse publishes only at about 13:30 UTC. Before that, the page takes yesterday's daily candle from Binance, once a day per browser, and says so on the page. |
| **Caching behind a sign-in** | The read endpoint answers only signed-in accounts (ADR-025), but its answer is the same for all of them: Cloudflare keeps one copy for 5 minutes, handed out after the session check; browsers get `Cache-Control: private`. (In production this cache turned out to do nothing on a `workers.dev` address; [step 26](26-numbers-built-by-sql.md) keeps the answer ready-made in Workers KV instead, ADR-026.) |
| **Data lineage per number** | (Here the page still calculated in JavaScript and wrote the query to match; [step 26](26-numbers-built-by-sql.md) made the queries do the calculating.) Every summary card and table, and every market's details, show how the number is calculated as **one SQL query** with a comment on each column, over three inputs: `live_prices` (Binance's live prices as on screen, written in as `VALUES`), `market_baseline` and `market_evidence` (MEDUSA's copies of the lakehouse's gold tables). Live prices have no table, so the query carries them; that makes it run as it is, in MEDUSA's D1 or, with the lakehouse's table names, in Databricks, and return the numbers on screen. A table of the inputs, the result on screen and a CSV of the inputs go with it. |
| **Honest evidence** | Every row is a market (a USDT perpetual on crypto, a stock, a commodity, a currency or an index). Only about 650 of the evidence's 21,137 moves are non-crypto and 19 of those are in 2020–2024, the years that choose each verdict, so a non-crypto market's details say the evidence is almost all crypto. |

## Code

| Part | What it does |
|---|---|
| `GET /api/market/scanner` (`src/market.js`) | Both market tables and their publish records in one D1 transaction; rows as lists in a fixed column order (about 160 KB, 67 KB compressed); `x-cache: HIT/MISS` |
| `public/markets.js` | Loaded when Markets is first opened. The rule (`score`, `zBand`, `liquidity`, `evidenceFor`, `marketType`, exported so they can be tested alone), the stream with reconnects (1, 2, 5, 10, 30 seconds; restarted after 30 silent seconds), yesterday's closes, the contract list for types, the two views, the source panels and the CSV |
| `public/app.js`, `public/index.html` | The **Markets** menu item and `#markets` page; the stream is closed when another page is chosen |
| `public/_headers` | `connect-src` adds `wss://fstream.binance.com` |

The rule, as the page applies it:

```text
move today = live price ÷ yesterday's close − 1
z          = (move today − avg_return_30d) ÷ sd_return_30d      (needs history_days ≥ 20)
unusual    = |z| ≥ 3;  band 3–4, 4–6 or 6+;  liquidity: avg_quote_volume_30d ≥ 100 M large, ≥ 10 M mid
```

## How to check a number

1. Open **Markets** and press the **‹›** button on a card or table, or tap a market.
2. The panel shows the query that produces the number, with a comment on each column, the result on
   screen now, and what each input is and when it was updated. A market's query, shortened:

```sql
WITH live_prices(symbol, price, quote_volume_24h) AS (VALUES   -- Binance's live prices at 12:19:08 AM
  ('ORDERUSDT', 0.06024, 682662232.119)
),
today AS (
  SELECT b.symbol,
         p.price / b.last_close - 1 AS move,  -- Today: the move since yesterday's close
         CASE WHEN b.history_days >= 20 AND b.sd_return_30d > 0
              THEN (p.price / b.last_close - 1 - b.avg_return_30d) / b.sd_return_30d
         END AS z                             -- z: the move in usual daily moves (σ)
  FROM market_baseline b                      -- each market's normal (lakehouse)
  JOIN live_prices p ON p.symbol = b.symbol   -- its live price (Binance)
)
SELECT symbol AS market, ROUND(100 * move, 2) AS today_pct, ROUND(z, 1) AS z
FROM today;
```

3. **Copy for MEDUSA (D1)** or **Copy for Databricks** and run it: it returns the numbers on screen.
4. **Download the inputs (CSV)** saves every market behind a number with each input and its source.

## Result

| Check | Result |
|---|---|
| Read endpoint, locally | 23 of 23: signed out 401, ingest token refused, values identical to what was published, second answer from cache |
| Read endpoint, production | Signed out: `Sign in first.`; signed in: the data |
| Rule parity | 300 of 300 lakehouse events reproduced exactly, 12 kinds of move; 8 edge cases (no price, no close, short history, the 3σ line, band and liquidity edges, the UTC day) |
| Stream | The `/market/ws/` path delivered up to 223 markets a message; leaving the page closes it and returning opens exactly one new connection |
| Yesterday's closes from Binance | 744 of 744 fetched, reused after a reload; ORDER's move and z matched a separate calculation from Binance (+118.0%, +36.2 against +117.3%, +36.0 a moment earlier) |
| Calculation panels | The queries copied from the page returned exactly the numbers on screen in both MEDUSA's D1 and Databricks (ORDER: +82.49%, z 23.5, usual day 3.54%, volume ×825.8; Bitcoin: −1.00%, z −0.7); the breadth, median, unusual and movers queries with all 743 markets in `live_prices` gave identical answers in both; copy and CSV work |
| Layout | Desktop and phone (375 px) with no sideways scrolling, panels open or closed |
| Production (Today view) | Live prices flowing, checked by the owner on 2026-10-24 |

## Problems we hit

- **Binance's old stream address connects but sends nothing.** `wss://fstream.binance.com/ws/!miniTicker@arr`
  opened and stayed silent; the documented `/market/ws/` path works. Tested both before building on one.
- **A class-name clash squashed every table to one row.** `.mkt` was already the market-hours chip
  (30 px tall, inline-flex); the tables became `.mkt-table`.
- **The journal's five-card layout leaked in.** Its `.kpi:nth-child(n+4)` spans had to be overridden for
  four cards.
- **Details text ran off the screen** inside a table wider than the phone; the details moved under the table.
- **Public or not.** ADR-013 planned a public page; the owner chose signed-in accounts only (ADR-025),
  so the endpoint moved behind the session check and the docs were corrected.
- **"No pattern" looked empty** in faint grey, and next to the wider group's "fade" it seemed to
  contradict it. Cells now show both, labelled, with a key.
- **"Coin" was wrong**: about 225 of the 744 markets are stocks, commodities, a currency, indices and
  pre-IPO listings. Rows are now markets, with their type.
- **Bitcoin didn't match TradingView**: TradingView's `BINANCE:BTCUSDT` is spot; the page shows the
  perpetual (`BTCUSDT.P`), about 0.03% apart. The Bitcoin card's source panel now says so.
- **The first source panels were hard to read**: a list of inputs, raw messages and separate lookups. The owner asked
  for the calculation as a query, like a report's SQL; each panel is now one query that produces the
  number, and it runs in both databases with the same result.
- **A fade that held up shows a negative t**, because t measures whether moves kept going; the rules
  now explain the sign.
