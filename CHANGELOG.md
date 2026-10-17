# Changelog

Every release of MEDUSA, newest first. The current version is in `public/version.json` (shown in the
app's menu and on the sign-in page); each release adds a section here with the same number.

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
