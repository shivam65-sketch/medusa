# Issue log

Every problem reported on MEDUSA: what was seen, why it happened, what was changed and how the change
was checked. The newest are first, and the summary links to each one's details. Bigger pipeline
incidents also have a row in the
[runbook](../lakehouse/docs/operations.md#incidents), and each release's changes are in the
[changelog](../CHANGELOG.md).

**Kinds:** *Bug* (MEDUSA did the wrong thing) · *Source data* (the data arrived wrong or late) · *Limit*
(a limit on purpose, or of a service) · *Setup* (a command or setting, not the app) · *Explained* (it
works as designed, and the question led to an answer) · *Request* (a missing feature).

The entries before 2026-10-31 were written afterwards, from the records of the work on them.

## Summary

| Id | Reported | Area | What was seen | Kind | State |
|---|---|---|---|---|---|
| [27](#issue-27) | 2026-10-31 | Lab | The Python engine takes a long time to start | Limit | Known, unchanged |
| [26](#issue-26) | 2026-10-31 | Lab Chart | Pages slow and getting stuck | Bug | Fixed |
| [25](#issue-25) | 2026-10-31 | Lab Chart | Zigzag lines across the chart | Bug | Fixed |
| [24](#issue-24) | 2026-10-31 | Deploy | Creating the D1 table failed: *Authentication error* | Setup | Worked around |
| [23](#issue-23) | 2026-10-31 | Tables | A drag across a row opened the row | Bug | Fixed |
| [22](#issue-22) | 2026-10-31 | Markets | Nothing could be copied | Bug | Fixed |
| [21](#issue-21) | 2026-10-31 | Markets | A table's scrollbar bounced back to the left | Bug | Fixed |
| [20](#issue-20) | 2026-10-31 | Lakehouse | A check for missing days also listed yesterday | Explained | Closed |
| [19](#issue-19) | 2026-10-31 | Lakehouse | A missing day showed nowhere | Bug | Fixed |
| [18](#issue-18) | 2026-10-30 | Lab data | *Download to this computer* refused | Limit | Closed |
| [17](#issue-17) | 2026-10-29 | Journal | The CoinDCX key expired, and a new one asks for an IP | Limit | **Open** |
| [16](#issue-16) | 2026-10-29 | Markets | Insights graphs were empty | Explained | Closed |
| [15](#issue-15) | 2026-10-29 | Lakehouse | The daily load failed twice | Source data | Waiting for Binance |
| [14](#issue-14) | 2026-10-25 | Lakehouse | A Databricks login test failed | Setup | Closed |
| [13](#issue-13) | 2026-10-25 | Markets | A definition deleted in Databricks stayed on the page | Bug | Fixed |
| [12](#issue-12) | 2026-10-25 | Markets | A query couldn't be edited | Request | Built |
| [11](#issue-11) | 2026-10-24 | Markets | *Next 1 h* and *Next 4 h* looked empty | Bug | Fixed |
| [10](#issue-10) | 2026-10-24 | Markets | *Coin* used for markets that aren't coins | Bug | Fixed |
| [9](#issue-9) | 2026-10-24 | Markets | Bitcoin didn't match TradingView | Explained | Closed |
| [8](#issue-8) | 2026-10-21 | Lakehouse | The first scheduled daily load failed | Bug | Fixed |
| [7](#issue-7) | 2026-10-20 | Git | `git add lakehouse` gave an error | Setup | Closed |
| [6](#issue-6) | 2026-10-20 | Lab data | Candles missing from a downloaded month | Bug | Fixed |
| [5](#issue-5) | 2026-10-20 | Lab Chart | Toolbar buttons greyed out after picking a file | Bug | Fixed |
| [4](#issue-4) | 2026-10-20 | Lab Python | The caret drifted away from the code | Bug | Fixed |
| [3](#issue-3) | 2026-10-17 | Deploy | *Could not detect a directory containing static files* | Setup | Closed |
| [2](#issue-2) | 2026-10-17 | Lab Chart | Replay slow with four charts | Bug | Fixed |
| [1](#issue-1) | 2026-09-27 | Local copy | The app kept loading and never opened | Setup | Closed |

## Details

<a id="issue-27"></a>
### 27. The Python engine takes a long time to start

- **Seen:** *Python engine starting…* for a long while when the Lab opens.
- **Why:** MEDUSA runs Python inside the browser. Measured on 2026-10-31: 14 to 18 seconds after a page
  load, of which about 9 seconds is Python itself starting, about 2 numpy and about 3 the engine's own
  files. The files were already in the browser's cache, so it isn't a download. It happens once per page
  load.
- **Change:** none to the start itself. It runs on a background thread, so the page stays usable
  meanwhile. Its time per step now goes to the Lab's log, so a slowdown can be measured.
- **State:** known. Starting Python from a saved snapshot could shorten it, but that feature of the
  browser's Python is experimental.

<a id="issue-26"></a>
### 26. Pages slow and getting stuck

- **Seen:** pages working slowly and getting stuck often, while using the Lab's Chart with a backtest.
- **Why:** with SOLUSDT 5m (644,681 candles) the Chart gave the chart library every candle for every
  line, and rebuilt the whole chart on most clicks. Measured: one checkbox froze the page for 23 seconds,
  a backtest's result for 32 seconds in all, and the page held 1.6 GB. Because MEDUSA keeps pages alive
  when you move between them, that memory stayed in use while on other pages. Markets, the Journal and
  Dev tools were measured too and had no real freezes.
- **Change** (`public/lab/chart.js`, commit `0f8c41b`): the library gets 50,000 candles around what is
  on the screen (5,000 in a replay), and the window moves when you scroll near its edge, jump to a date
  or choose a trade. Candles, indicators and trades still count the whole file. The Trades box no
  longer rebuilds the chart, a backtest rebuilds it once instead of twice, and choosing a trade marks it
  in the list without drawing 3,000 rows again.
- **Checked** on the same file and backtest, with a real mouse:

  | | Before | After |
  |---|---|---|
  | The Trades box | 23 s frozen | 0.05 s |
  | A backtest's result | 32 s frozen in all | 9 s in all |
  | Memory | 1.6 GB | about 190 MB |
  | A replay step | not measured with every candle | about 0.1 s |

  Also: a hovered candle matched the file exactly, an old trade sat on the right candles, and date
  jumps, replay, two linked charts and scrolling past the window's edge all worked. Confirmed by the owner
  on the live site.
- **Trade-off:** **Show all** now shows up to 50,000 candles and says so. A bigger timeframe shows the whole
  history.

<a id="issue-25"></a>
### 25. Zigzag lines across the chart

- **Seen:** tall lime sawtooth lines after a VWAP backtest on SOLUSDT 5m, squeezing the price axis to
  0–320.
- **Why:** the lines are `k`, a number the strategy uses to count candles through the day: 0 to 287 on
  5m candles, then back to 0. The Chart draws what a strategy keeps, and put a line on the candles when
  its middle value was within 0.5 to 2 times the price. The middle of `k` is about 144, close to SOL's
  price by coincidence, so on SOL it was drawn over the candles. It only ever affected the picture:
  backtest results were right.
- **Change** (`public/lab/py/labrun.py`, commit `0f8c41b`): the strategy is prepared again with every
  price 10 times bigger. A line goes on the candles only if it grew 10 times too, which means it is
  measured in price. Anything else is an option under the chart, in a pane of its own and off until
  ticked.
- **Checked:** all 24 strategies give the same answer at 8 price levels, from 0.002 to 90,000. On the
  VWAP strategy `vwap`, `up` and `lo` stay on the candles and `k` and `atr` don't. Confirmed by the owner.

<a id="issue-24"></a>
### 24. Creating the D1 table failed

- **Seen:** `wrangler d1 execute --remote --file=…` stopped with *A request to the Cloudflare API
  (…/import) failed*.
- **Why:** the log shows `Authentication error [code: 10000]`, a 401 on the file-import route only. The
  same login could read the database, and has D1 write permission. Why that route refused it wasn't
  found. Wrangler was also warning that the login lacked some newer permissions, which may be the reason.
- **Change:** the statement was run with `--command`, which uses a different route, and it worked. No
  fresh login was needed. Now in the [runbook](../lakehouse/docs/operations.md#when-the-daily-run-fails).
- **Also that day:** the steps left out `git add -A`, and `git save` only commits what is staged, so the
  first attempt committed nothing. The steps now include it.

<a id="issue-23"></a>
### 23. A drag across a row opened the row

- **Seen:** part of *I can't copy anything*. Text in a clickable row couldn't be selected.
- **Why:** a drag that starts and ends in one row also counts as a click, so selecting text opened the
  trade, market or run.
- **Change** (`public/app.js`, `public/markets.js`, commit `75bd8d4`): a click that ends a text selection
  is ignored on table rows, on every page.
- **Checked:** text selected in a row stayed selected and the row didn't open, and an ordinary click still
  opens it.

<a id="issue-22"></a>
### 22. Nothing could be copied

- **Seen:** selected text disappeared on Markets before it could be copied.
- **Why:** the same as [21](#issue-21): each second's redraw replaced the elements holding the selection.
- **Change** (`public/markets.js`, commit `75bd8d4`): the redraw keeps the elements, and a part of the page
  holds still while text in it is selected. Clicking elsewhere lets it catch up.
- **Checked:** the selection survived several redraws. Ctrl+C was confirmed by the owner on the live
  site; it couldn't be tested automatically.

<a id="issue-21"></a>
### 21. A table's scrollbar bounced back to the left

- **Seen:** on Markets and its ‹› windows, a table scrolled to the right jumped back by itself.
- **Why:** every second, a table whose numbers had changed was drawn as new HTML and replaced the old one.
  The box that scrolls is part of it, so each new box started at the left, and a scrollbar being dragged
  lost its element. Holding a part still while the pointer is over it couldn't fix this: when the pointer
  left, the table was replaced and jumped back.
- **Change** (`put()` in `public/markets.js`, commit `75bd8d4`): the new HTML is compared with what is on
  the page, and only the text and attributes that differ change. The elements stay, so the scroll stays
  and the numbers go on updating. The market hours strip keeps its scroll too.
- **Checked:** with a real mouse on the table from the owner's screenshot, the scrollbar held at the far
  right for 5 seconds while prices updated. Patterns and all seven Insights graphs still draw. Confirmed by
  the owner.

<a id="issue-20"></a>
### 20. A check for missing days also listed yesterday

- **Seen:** a query for missing days returned 2026-10-28 and 2026-10-30.
- **Why:** the 30th was yesterday, and its load hadn't run yet (GitHub starts it hours late). The first
  try at the query also failed, because `explode` needs `sequence` around the two dates.
- **Change:** none needed. `gold.missing_days` ([19](#issue-19)) marks that case `waiting`.

<a id="issue-19"></a>
### 19. A missing day showed nowhere

- **Seen:** Binance left out the candles of 2026-10-28, and nothing showed it: every test passed, the next
  run succeeded and the page looked normal. It was found by a person's query.
- **Why:** tests look at rows that exist, and a day that never arrived has none. A daily load only fetches
  its own day, and the recheck only covers days with a manifest.
- **Change** ([step 32a](../lakehouse/docs/steps/32a-missing-days.md),
  [ADR-036](../lakehouse/docs/decisions.md#adr-036-a-missing-day-is-found-against-the-calendar-shown-on-the-page-and-tried-again-for-a-week),
  commit `75bd8d4`): `gold.missing_days` compares the calendar with the days loaded, dbt warns, the top of
  Markets says which days are missing, and the daily run tries the last 7 days again. The page also warns
  when the lakehouse falls two days behind, and says the data arrives by 20:00 UTC instead of the *about
  13:30 UTC* it wrongly claimed.
- **Checked:** the query finds exactly the 28th. The catch-up, run against real Binance, cleaned up the
  incomplete 28th and fully loaded a complete day. Transform run 8 succeeded with the expected warning, and
  the owner saw the warning on the live page.

<a id="issue-18"></a>
### 18. *Download to this computer* refused

- **Seen:** the button was blocked for SOLUSDT 1m, all time.
- **Why:** a limit on purpose. That is about 3.2 million candles, and the browser builds the whole file
  in memory, which can crash a tab. The limits are 2,000,000 candles to the computer and 1,000,000 to
  MEDUSA.
- **Change:** none. Split the history with **Custom dates**, or use a bigger timeframe.

<a id="issue-17"></a>
### 17. The CoinDCX key expired, and a new one asks for an IP

- **Seen:** the API key expired, and CoinDCX asked for an IP address to bind a new key to.
- **Why:** MEDUSA imports from Cloudflare, which has no fixed outgoing address, so a key bound to one IP
  can't be used by the import.
- **State:** **open, a decision for the owner.** Reading the journal is unaffected, on any device. Only new
  imports are. The first thing to check is whether CoinDCX still allows a key with no IP, even one that
  expires.

<a id="issue-16"></a>
### 16. Insights graphs were empty

- **Seen:** *hasn't published the history yet* on Insights, and the question of whether the failed load of
  28 October caused it.
- **Why:** partly. Only the transform publishes the Insights file, and it hadn't run since Insights was
  deployed, because the failed load had stopped that day's chain. The sentence *Live numbers are unchecked…*
  is fixed text and had nothing to do with it.
- **Change:** a transform by hand published the file. It has been published daily since.

<a id="issue-15"></a>
### 15. The daily load failed twice

- **Seen:** the runs of 29 October failed, the second one by hand.
- **Why:** Binance's archive has no 1-minute candles for 2026-10-28, on any coin, and its download check
  stops a day that isn't complete, as designed.
- **State:** waiting for Binance. The live API has the candles, and October's monthly file is due around 2
  November. See [19](#issue-19) for what changed around it.

<a id="issue-14"></a>
### 14. A Databricks login test failed

- **Seen:** `databricks current-user me` failed while setting up the login for saving definitions.
- **Why:** the CLI wanted a settings file with a profile, and later steps hit two more things: the address
  needs `https://`, and Free Edition refuses the `all-apis` scope for this kind of login.
- **Change:** tested the way the server signs in, directly with a token request, with the narrower `sql`
  scope, which also gives the login less access. See the [runbook](../lakehouse/docs/operations.md).

<a id="issue-13"></a>
### 13. A definition deleted in Databricks stayed on the page

- **Seen:** a test version of `bitcoin`, removed by hand in Databricks, was still in use on Markets.
- **Why:** the page reads MEDUSA's copy, not Databricks. That copy changes on a save or a publish, so a
  change by hand waited for the next publish.
- **Change** (step 28): **Use this version again**, and a **Reload** for the owner that brings a change in
  Databricks to MEDUSA in seconds. In the [runbook's incidents](../lakehouse/docs/operations.md#incidents).

<a id="issue-12"></a>
### 12. A query couldn't be edited

- **Seen:** the query behind a number showed but couldn't be changed.
- **Why:** it wasn't built yet: step 27 only stored the definitions.
- **Change:** [step 28](../lakehouse/docs/steps/28-editing-the-definitions.md): each number's calculation
  opens in its own window, where its SQL can be edited, previewed and saved as a new version.

<a id="issue-11"></a>
### 11. *Next 1 h* and *Next 4 h* looked empty

- **Seen:** the cells looked blank, while the line below the table had values.
- **Why:** they said *no pattern* in a grey too faint to read, and the line below is a wider group of moves.
- **Change** (release 1.6.0): *no pattern* is readable, and each cell has a second line for the wider group.

<a id="issue-10"></a>
### 10. *Coin* used for markets that aren't coins

- **Seen:** *coin* everywhere on Markets, though it includes futures on stocks, commodities and more.
- **Change** (release 1.6.0): *market* throughout, a type on every row, a filter by type, and a key
  explaining z and σ under the table.

<a id="issue-9"></a>
### 9. Bitcoin didn't match TradingView

- **Seen:** MEDUSA's Bitcoin price differed from TradingView's.
- **Why:** they were two markets. TradingView's `BINANCE:BTCUSDT` is spot, and MEDUSA shows the perpetual
  future, `BINANCE:BTCUSDT.P`, which sits a little above or below spot (25 dollars that day).
- **Change:** none. Compare with `BTCUSDT.P`.

<a id="issue-8"></a>
### 8. The first scheduled daily load failed

- **Seen:** the run for 2026-10-20 failed, and a re-run succeeded.
- **Why:** the connection dropped during a download, and the retry only covered a failed connect. Behind it
  was a bigger risk: GitHub started the 06:00 run at 11:19, before Binance had finished publishing, so 88
  coins' candles weren't there yet.
- **Change** (commit `53378ed`,
  [ADR-021](../lakehouse/docs/decisions.md#adr-021-load-a-day-only-after-binance-has-finished-publishing-it)):
  dropped downloads are retried, the schedule moved later, and a day that isn't fully published is refused.

<a id="issue-7"></a>
### 7. `git add lakehouse` gave an error

- **Why:** the work was in a separate folder, `market_lakehouse`, so `medusa` had no `lakehouse` to add.
- **Change:** the files moved into `medusa/lakehouse`.

<a id="issue-6"></a>
### 6. Candles missing from a downloaded month

- **Why:** Binance's monthly file for February 2022 had 150 of its 168 candles, and the download accepted any
  file with at least one.
- **Change** (`public/lab/data.js`, commit `423210d`): a month must have every candle it should, or it comes
  from Binance's REST API instead.

<a id="issue-5"></a>
### 5. Toolbar buttons greyed out after picking a file

- **Seen:** Log, Show all, Save PNG, Full screen and Replay stayed grey after choosing a file.
- **Why:** the toolbar was drawn before the chart that enables them existed.
- **Change** (release 1.5.0): the toolbar is drawn again once the candles are there.

<a id="issue-4"></a>
### 4. The caret drifted away from the code

- **Seen:** on the Python tab the caret moved further from the code on every line.
- **Why:** the editor's text box and the coloured copy under it had different line heights.
- **Change** (release 1.4.0): they share one line height.

<a id="issue-3"></a>
### 3. *Could not detect a directory containing static files*

- **Why:** the deploy was run outside the `medusa` folder, so it found no `wrangler.toml`.
- **Change:** none. Run it from `medusa`.

<a id="issue-2"></a>
### 2. Replay slow with four charts

- **Seen:** four charts in a replay slowed everything down.
- **Change** (release 1.2.0, commit `ae7b127`): replay time was measured. A step now updates only the
  charts it changes, markers are rebuilt only when a trade starts or ends, and the screen is updated once
  per frame.

<a id="issue-1"></a>
### 1. The app kept loading and never opened

- **Seen:** the local test copy never finished loading.
- **Why:** the local server had been stopped only in part, and restarted in a broken state: it took requests
  and never answered.
- **Change:** a clean restart. It only affected the local copy.
