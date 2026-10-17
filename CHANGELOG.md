# Changelog

Every release of MEDUSA, newest first. The current version is in `public/version.json` (shown in the
app's menu and on the sign-in page); each release adds a section here with the same number.

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
