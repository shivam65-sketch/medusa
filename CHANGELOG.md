# Changelog

Every release of MEDUSA, newest first. The current version is in `public/version.json` (shown in the
app's menu and on the sign-in page); each release adds a section here with the same number.

## Unreleased

Live, not yet a numbered release; planned as 1.7.0 with editable definitions.

- Markets: **every number on Today is calculated by SQL**. The queries run in a small SQLite database inside the browser (sql.js 1.14.2, SQLite compiled to WebAssembly, in a background worker): it holds MEDUSA's copies of the lakehouse tables (`market_baseline`, `market_evidence`), the live prices (`live_prices`, kept up to date from Binance's stream) and each market's type with Binance's close for yesterday (`binance_markets`). About once a second the page writes the prices that changed and runs the queries (about 50 ms in all); the cards and tables show what they return. Every number is defined once, in `public/markets-metrics.js`: four shared steps (`market_now`, `today`, `flagged`, `verdicts`) and a query for each card and table, with its name, its definition in words and how its columns are shown.
- Markets, how each number is calculated: the panel shows the query exactly as it ran (it reads `FROM live_prices`; no prices are written into it), its parameters (the type filter and yesterday's date), the raw result, and where each table comes from. **Copy for MEDUSA (D1)** and **Copy for Databricks** add the browser-only tables as values, as they were for the result on screen, and fill in the parameters, so the copy returns that result. **Download the result (CSV)** and **Download the inputs (CSV)** (each market's price, yesterday's close and its normal).
- Markets: choosing a type or opening a market recalculates at once (about 0.1 s instead of up to 1 s).
- Server: `GET /api/market/scanner` answers from Workers KV instead of D1. The ingest saves the answer ready-made after every publish, so a page load no longer reads about 810 D1 rows and the answer is never older than the last publish. Cloudflare's cache, used before, does nothing on a `workers.dev` address. `x-cache` says `KV` or `D1`.
- Security policy: `/markets-sql.js` may run WebAssembly (`'wasm-unsafe-eval'`) and reach only MEDUSA, like the Lab's Python worker; files under `/vendor/` are cached for a year (the version is in the path).
- Market data lakehouse: a dbt exposure, `markets_page`, ties the Markets page to the gold models it reads; the publish job's summary shows whether MEDUSA rebuilt the scanner's answer.

## 1.6.0 (2026-10-24)

- **Markets**, a new page in the menu (under Journal): a live scanner of every Binance USDⓈ-M perpetual quoted in USDT, from crypto coins and tokens to the TradFi perpetuals on stocks, commodities, a currency and indices. Each market's move today (from yesterday's close, UTC) is compared with its own normal from the market data lakehouse; live prices stream from Binance straight to the browser, about once a second and only while the page is open. Like every page, it needs a signed-in account.
- Markets, **Today**: a summary (breadth, median move, how many markets are unusual, Bitcoin); **Unusual right now**, every market that has moved at least 3 of its usual daily moves (|z| ≥ 3), with what similar moves (direction, size, liquidity) did over the next 1, 4 and 24 hours since 2020, judged on years held back from the choice and after costs (tap a market for the evidence in words, compared with every up or down move together); **Movers today**; and **Every market**, with search (by name or type) and sorting by most unusual, gainers, losers or volume against normal. A key explains z, σ and the evidence cells, and a market's details warn when it is a stock, commodity or currency, since almost all the evidence is crypto.
- Markets, **Patterns**: all 60 kinds of move and horizons with their verdicts, the patterns that held up with the markets in each group right now, a table of every kind of move (tap a cell for the evidence in words), and how a verdict is decided.
- Markets, **types and a filter**: each market's type from Binance's contract list next to its name (Crypto with its sector, such as Meme or DeFi; US, Hong Kong, Korean or Chinese stock; Commodity; Currency; Index; Pre-IPO), and a filter (All, Crypto, Stocks, Commodities, Other) for the summary and every table. The contract list is fetched once a day per browser.
- Markets, **how each number is calculated**: a button on every summary card and table, and a section in every market's details, show the number as one SQL query with a comment on each column. It reads three inputs: `live_prices` (Binance's live prices, written into the query as values, so it runs as it is), `market_baseline` and `market_evidence` (MEDUSA's daily copies of the lakehouse's `gold.coin_baseline` and `gold.event_evidence`). A small table says what each input is and when it was last updated, a line gives the result on screen, and **Copy for MEDUSA (D1)** and **Copy for Databricks** copy the full query; run in either, it returns the same numbers as the page. A market's details also keep the Binance message behind its price and the query for every past move behind its verdicts. **Download the inputs (CSV)** saves every market behind a number, with each input exactly as used at that moment.
- Before the lakehouse publishes yesterday (about 13:30 UTC), yesterday's closes come from Binance's daily candles, once a day per browser. The page's rule reproduces the lakehouse's own events exactly (300 of 300 checked).
- Security policy: the page may also connect to Binance's live futures stream (`wss://fstream.binance.com`).
- Server: a daily copy of the lakehouse's tables for the scanner: each market's normal (`market_baseline`) and what similar moves did next (`market_evidence`), with `market_publish` recording each copy. They arrive through `POST /api/market/ingest`, which needs its own token (`MARKET_INGEST_TOKEN`), checks every row, can only replace these tables, and swaps a table in one transaction (migration `003_market.sql`).
- Server: `GET /api/market/scanner` gives the page that copy, read-only and only for signed-in accounts: both tables read in one transaction with when each was published, rows sent as lists in a fixed column order (about 160 KB, 67 KB compressed). The answer is the same for every account, so Cloudflare's cache keeps one copy for 5 minutes (and each browser its own).

## 1.5.0 (2026-10-20)

- Chart: **Long position** and **Short position** drawing tools. Click the entry, then the stop loss, then the take profit (clicking it 3 or more candles to the right sets where the box ends; otherwise the box is 30 candles long). The box shows the take profit (green) and stop loss (red) zones, the risk/reward, and what the candles after it did: the entry filled (a market entry when it is the close of its candle, else a limit or a stop order at the entry price), then the take profit, the stop loss or the box's end. Click a position to choose it: drag its handles (entry, stop loss, take profit, the box's end) or the whole box, or type its prices in its panel, which also shows the risk, reward and size in money. **To short** / **To long** turns it around; **Delete** removes it (Ctrl+Z brings it back). Positions are kept with the coin's other drawings.
- Chart: **Simulate**, a trading simulation. One account, with an optional starting amount (empty: the Dashboard's), leverage, a size per trade (% of the balance as margin, % risked at the stop loss, or $) and a fee and slippage per fill (empty: the Dashboard's), trades every long and short position on the chart, candle by candle. Entries, stop losses, take profits, trailing stops, liquidation and a box's end trigger on each candle's high and low; when one candle reaches both the stop loss and the take profit, the stop loss counts (what came first inside a candle isn't known). It shows the balance, equity, open and net P&L, trades, win rate, profit factor, worst drawdown and fees, with lists of the open positions, the orders waiting for their price, the closed trades and every trigger (click a row to see it on the chart), and **CSV** downloads the closed trades.
- Chart replay: an **order ticket** in the simulation: market, limit and stop orders with a take profit, stop loss and trailing stop, placed at the newest candle and filled as the replay moves on; open trades can be closed and waiting orders cancelled. Your orders are drawn on the chart (lines for the waiting entry, the entry, stop loss, take profit and trailing stop, and markers for the fills). The replay bar's **Buy**, **Sell** and **Close** now trade the simulation's account (its size, fees and slippage) instead of adding up percentages, and leaving the replay shows how the account did.
- Chart: after picking a file in the chart's file picker, Log, Show all, Save PNG, Full screen and Replay stayed greyed out until something else redrew the toolbar; they work at once now.
- Get data: a month whose Binance archive file is missing candles is downloaded from Binance's API instead (the PEOPLEUSDT futures 4h archive lacks 30 candles in February and April 2022).

## 1.4.0 (2026-10-20)

- Python tab: the caret no longer drifts further from the code on every line (the editor's text box and its coloured copy had different line heights).
- Python tab: charts are interactive. Hover for the values under the mouse (each line's nearest point, a bar's value, a histogram bin's count, a dot's x and y). Drag across a chart to zoom in: Python redraws it, and zooming in on the dates fits the y-axis to what's left. Double-click or **Reset zoom** to zoom out.
- Python tab: **Full screen** (or Ctrl+Shift+F; Esc leaves it): the code and the output fill the screen, side by side or one above the other, with a bar between them you can drag.
- Editor keys (Python tab and Strategies): **Ctrl+/** comments the selected lines out or back in; **Tab** and **Shift+Tab** indent and outdent them (Esc, then Tab, moves on to the next field). The keyboard button lists every shortcut.
- Python tab: running your code keeps your place in the editor (cursor, scrolling and undo).

## 1.3.0 (2026-10-18)

- Phone: the menu on the left is a slim bar of icons (more room for the page); the button at its bottom slides the full menu over the page, and picking a page or tapping outside closes it.
- About MEDUSA, in the ⋯ menu (or tap the version under the menu): the version, its release date, what's new in it, and the security measures that protect your data.
- **Dev tools**, a new page in the menu, with the **Logs** moved into it as a tab:
  - App version: this page's version and the newest on the server, *Check now*, and *Reload to update*.
  - Speed: the time to the server and back (and which Cloudflare data centre answered), this visit's load times and download size, memory, your connection, and a live speed meter (frames a second, the slowest frame, memory).
  - Speed-ups: get the Lab ready in the background once the journal is idle; download the Python engine or the Python tab's libraries ahead of time, with progress.
  - Storage on this device: temporary data, settings and your own work (drawings, Python code), and asking the browser to keep it.
  - Clean up: clear the cache (the browser's copies of MEDUSA's files, through a new `/api/clear-site-data` answer with the Clear-Site-Data header), clear temporary data, reset settings, delete chart drawings, or clear everything on this device. You stay signed in and nothing in your account is touched; anything that removes something asks for a second tap.
  - Diagnostics: errors in this visit (also written to the Logs) and a report to copy or download, without email, trades, notes or keys.
- A newer release is noticed while MEDUSA is open (every 30 minutes, and when you come back to it) and a small bar offers to reload; it can be switched off in Dev tools.
- Chart: the chosen trade's label now sits above the candles it spans (below them when there is no room), smaller and see-through, instead of on the candles.
- Chart: the legend (prices and indicator values in a chart's corner) folds to one line with its arrow button; it starts folded on phones and remembers your choice.
- New tiny API answer `/api/ping` (time to the server, Cloudflare data centre) for Dev tools.

## 1.2.1 (2026-10-18)

- Chart: in a replay, the End line of the picked portion was drawn at the left edge, and so were drawings in the empty area right of the last candle; they now sit where they belong.
- Chart: a replay always keeps its newest candle on screen, also when several steps come at once (a held arrow key).
- README: the logo, screenshots of the app (a demo account) and a diagram of how MEDUSA fits together; the pictures are in `docs/images/`.

## 1.2.0 (2026-10-18)

- Chart: **My trades** draws your journal trades on the chart's coin, like a backtest's trades, with a list under the chart; in a replay they appear as their time comes.
- Journal: **Show on chart** in each trade's window opens it on a downloaded file of that coin.
- Chart: the stop loss and take profit you set on CoinDCX for each of your trades (red and green lines, the zones of the chosen trade, and the trade's R), loaded with one request per coin.
- Chart: faster replay, also with four charts: a step only updates the charts it changes, markers are rebuilt only when a trade starts or ends, and the screen is updated once per frame (about 5× less work per step with four charts).

## 1.1.0 (2026-10-18)

- Chart: replay a portion picked on the chart (click the first and last candle, or pick From/To dates); the replay stops at its end.
- Chart: 1, 2, 3 or 4 charts side by side, with one timeframe and one replay; **Sync** links their crosshair and scrolling.
- Chart: the × next to an indicator removes it; **Delete** removes every drawing and indicator on the chart, **Ctrl+Z** brings them back.
- Chart: full screen on phones too (on an iPhone the charts fill the window).
- The release version is shown in the menu and on the sign-in page.

## 1.0.0 (2026-10-17)

- First release: the trading journal (CoinDCX import, statistics, calendar, notes, accounts with two-step login) and MEDUSA Lab (Binance data, Python backtests and reports, strategies, the Python tab, the Strategy guide, the Chart tab), on Cloudflare's free plan.
- Strict-Transport-Security (HSTS) on every response.
