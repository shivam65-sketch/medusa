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
| [42](#issue-42) | 2026-11-02 | Markets | A window's editor showed code that isn't in the query beside it | Bug | Fixed |
| [41](#issue-41) | 2026-11-02 | Docs | GitHub's main page said nothing about the scanner | Bug | Fixed |
| [40](#issue-40) | 2026-11-02 | Markets | The sentence under a clicked number was cut off | Bug | Fixed |
| [39](#issue-39) | 2026-11-01 | Markets | The SQL showed direction = 'up' with Down moves chosen | Explained | Answered |
| [38](#issue-38) | 2026-11-01 | Markets | A window led with a different number from the one clicked | Bug | Fixed |
| [37](#issue-37) | 2026-11-01 | Markets | An outage wrote the same errors to the Logs on every retry | Bug | Fixed |
| [36](#issue-36) | 2026-11-01 | Markets | Next 1 h and Next 24 h in the playbook opened 4 hours | Bug | Fixed |
| [35](#issue-35) | 2026-11-01 | Markets | A click on POWR's row in the playbook showed other coins | Bug | Fixed |
| [34](#issue-34) | 2026-11-01 | Markets | The playbook's column names couldn't be understood | Request | Fixed |
| [33](#issue-33) | 2026-11-01 | Markets | The ‹› window's code was the same for Next 1 h and Next 4 h | Bug | Fixed |
| [32](#issue-32) | 2026-11-01 | Markets | *Down moves* and *Next 24 h* didn't change *Every market right now* | Bug | Fixed |
| [31](#issue-31) | 2026-11-01 | Markets | Dots drawn outside the graph on *Every market right now* | Bug | Fixed |
| [30](#issue-30) | 2026-11-01 | Markets | The market filter did nothing on Insights | Bug | Fixed |
| [29](#issue-29) | 2026-11-01 | Lakehouse | The transform failed: *dim_market_type was not found* | Bug | Fixed |
| [28](#issue-28) | 2026-11-01 | Markets | Stocks and commodities showed verdicts tested on crypto | Bug | Fixed |
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
| [17](#issue-17) | 2026-10-29 | Journal | The CoinDCX key expired, and a new one asks for an IP | Limit | **Open**, parked by the owner |
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

<a id="issue-42"></a>
### 42. A window's editor showed code that isn't in the query beside it

- **Seen:** after clicking a bar on *By the hour of the move*, the right side showed the query behind *The middle move*, and the left
  side showed *Spread of outcomes*, *Year by year* and *The moves themselves* as well, while the CTEs the query really uses sat closed.
- **Why:** the left side opened every number in the window at once, whichever one was being read, and left the CTEs closed. A window
  with one number looked right. A window with several, like a click on a graph, didn't.
- **Change:** the left side now shows one number's code: the CTEs in its query, in the order the query on the right runs them, then
  its final query, and nothing else. It follows the number being read on the right. It doesn't move while text is being typed in it, and
  changes in a box it leaves are kept. Below 1,100 pixels the editor sits above the results, so moving it would shift the page: there, an
  **Edit this query** button on each number does it instead. Every window shares this code.
- **Checked:** all 34 numbers in 23 windows, from Today's cards to the windows a click opens: the left side against the CTEs at the
  top of the query on the right, in order. 33 matched by name; the other, *Every kind of move at a glance*, writes its three CTEs
  inside its own query, so they are in its box. Typing held the left side still, and a change survived moving away and back.
- **State:** fixed and live on 2026-11-02.

<a id="issue-41"></a>
### 41. GitHub's main page said nothing about the scanner

- **Seen:** the repository's main page still described a journal and a backtesting lab, with no sign of the Markets page.
- **Why:** the README's opening, its diagram and its screenshots were written before Markets and the lakehouse existed. New
  features were added lower down, in one long bullet of *What it does* and in the install notes, so the page was correct line by
  line while its first screen was out of date. The same thing had happened elsewhere: each change updated the pages it touched,
  and nothing checked the pages that summarise the whole product. The repository's description on GitHub, and Confluence's
  Product overview (still on 1.6.0) and other overview pages, had fallen behind the same way.
- **Change:** the README now opens with all four parts, has sections of its own for Markets and the lakehouse, eight real Markets
  screenshots, and a diagram with the scanner, the lakehouse and the live stream. Stale facts corrected: how long a browser keeps
  the scanner's answer, the migrations for an older install, and the file list. The lakehouse's README shows steps 32 and 32a as
  they stand. On Confluence, the nine pages that describe the whole product or Markets were read and brought up to date. Step and
  release pages are history and stay as they are. Pages about one other part (the Lab's, the journal's, accounts, the import, Dev
  tools) were listed but not re-read, because this work didn't change them.
  From now on a change that adds a feature also updates those summaries.
- **Checked:** the diagram drawn with the real Mermaid library; every link and image path in the README resolved; the screenshots
  looked at one by one for personal data; all 67 Confluence pages older than 1 November listed by their last edit.
- **State:** fixed and live on 2026-11-02.

<a id="issue-40"></a>
### 40. The sentence under a clicked number was cut off

- **Seen:** found while taking the screenshots for the README, in a window opened from *Kept going*: *2,008 of these 4,762 moves
  continued over t…*
- **Why:** a window's leading number uses the same card as the page's small cards, whose second line stays on one line and ends
  in dots when it doesn't fit. On those cards the line is a few words; here it is the sentence that says what the number means.
- **Change:** that card is wider, up to 560 pixels, and its sentence wraps. The page's own cards are unchanged.
- **Checked:** the same window at 1,440 pixels shows the whole sentence.
- **State:** fixed and live on 2026-11-02.

<a id="issue-39"></a>
### 39. The SQL showed direction = 'up' with Down moves chosen

- **Seen:** with *Down moves* chosen, a window's query still had `CASE WHEN direction = 'up' THEN 1 ELSE -1 END`.
- **Why:** that line isn't a filter. It turns each result into *continued* or *reversed*: an up move continues when the price
  rises and a down move when it falls, so a down move's return is multiplied by −1. The filter is further down the same
  query, `WHERE direction = 'down'`, so every row takes the −1.
- **Change:** none.
- **Checked:** the query in the owner's screenshot has `WHERE direction = 'down'`, and its title and verdict are for down moves.
- **State:** answered.

<a id="issue-38"></a>
### 38. A window led with a different number from the one clicked

- **Seen:** clicking −22.23% under *Worst 5%: turned back* opened a window headed −27.65%, and a cell in *Every kind of move at
  a glance* opened a different number and title. Also: everything in the playbook had been made clickable, which wasn't wanted.
- **Why:** every window led with the same card, the middle move. −22.23% is a line, and −27.65% was the middle of the 17 moves
  past it: both right, neither explained. A verdict isn't a median at all. And *any column value* had been taken literally,
  against the earlier request for no unnecessary clicks, without asking.
- **Change:** a click says which number it came from, and the window opens with that number under its column's name, says what
  it means, and lists the moves. Only aggregates are clickable: the cards, plain facts, the *from 2025* lines and the tables
  under the graphs aren't. Details in
  [step 32](../lakehouse/docs/steps/32-insights-graphs.md#plain-words-and-a-click-only-on-an-aggregate).
- **Checked:** on a local MEDUSA with the real rows: −22.23% opens on −22.23%, 17 of 336; 32% opens on 32%, 107 of 336; a verdict
  opens on that verdict. Today has 4 clickable columns and no cards, and a playbook row 8 values. 0 console and server errors.
- **State:** fixed and live since transform run 15.

<a id="issue-37"></a>
### 37. An outage wrote the same errors to the Logs on every retry

- **Seen:** the owner asked for proof that no errors were left. The browser console and the server were clean, but the Logs
  of the local test account held 656 error lines for the day.
- **Why:** they were 4 messages, 164 times each, all *no connection*, from when the local server was stopped with a page
  open. None were real failures of the app, but they showed a real fault: once a page can't reach MEDUSA it retries every
  10 seconds, and each retry wrote 4 lines. On the live site a dropped connection would have filled the Logs, and then
  `ops.logs.app_events`.
- **Change:** an outage writes its errors once, and the next one writes them again. The app's calls keep a flag for the
  connection, and the Markets page uses its own load error.
- **Checked:** the server was stopped with a page open: 7 retries wrote 3 lines where the old code would have written 28,
  and the page reconnected by itself. Then, on the final code in a new tab, every view, filter and kind of window: 0 console
  errors, 0 server errors, 0 failed queries and no new lines in the Logs. On the live site, `ops.logs.recent_failures` shows
  no failed Markets query, and transform runs 10 to 13 succeeded. That table gets the page's errors with the daily load, so
  today's aren't in it yet.
- **State:** fixed and live since transform run 15.

<a id="issue-36"></a>
### 36. Next 1 h and Next 24 h in the playbook opened 4 hours

- **Seen:** a click on the 1-hour or 24-hour column opened the next 4 hours, like the 4-hour one. Also asked for: any column
  or aggregate value should open its own window with its drill-down, charts included, keeping the app simple and fast.
- **Why:** the click was on the whole row, and a row knows only the page's **Over** choice. A column's own hours never
  reached the window.
- **Change:** no table row opens anything, and a column carries its own hours. Which cells are clickable changed again in
  [issue 38](#issue-38). The Journal and the Lab are still to do, because they are built differently.
- **Checked:** on a local MEDUSA with the real rows, the windows show the cells' numbers: −1.04%, −2.88% and −5.71%, on 929, 929
  and 924 moves.
- **State:** fixed and live since transform run 15.

<a id="issue-35"></a>
### 35. A click on POWR's row in the playbook showed other coins

- **Seen:** a click on POWR opened HOT, ALPINE, SANTOS, SOPH and EVAA, with the question of whether the 929 moves were
  POWR's, and why POWR and G showed the same numbers.
- **Why:** the numbers were right, and the design was at fault. Most of a row describes the group the market belongs to, and
  a click on the row opened that group. Nothing on the page said so, and the window's title didn't name the market.
- **Change:** a row opens nothing now ([issue 36](#issue-36)). **Its own past** opens that market's own moves, and **Past moves**
  opens the group, so each number opens what it counts. Each window's title says whose moves they are (*POWR's own
  up moves*, *Up crypto moves of 4–6σ, on small markets*), and the note under the table says most of a row describes the
  group.
- **Checked:** on a local MEDUSA with the real rows, **Its own past** opens POWR's 18 moves and **Past moves** the 929, and
  each matches its row: −0.52% and −2.88%.
- **State:** fixed and live since transform run 15.

<a id="issue-34"></a>
### 34. The playbook's column names couldn't be understood

- **Seen:** the table was explained three times and still wasn't clear: *why those column names?*
- **Why:** the names described the data, not the trade. *Worst 5%: kept going* needed knowing that one table holds up and
  down moves, and which side it is the worst for. The words also came from the rest of Insights, so the problem was wider
  than one table.
- **Change:** sentences, graph legends and tooltips say *continued* and *reversed*, the note under the table is a third of
  its length, and the raw `held_back` in the moves list reads *From 2025*. New column names went live too, and the owner,
  seeing them, asked for the old ones back: every column has its original name again, on every view. See
  [step 32](../lakehouse/docs/steps/32-insights-graphs.md#plain-words-and-a-click-only-on-an-aggregate).
- **Checked:** Today, Patterns, Insights and the windows read on a local MEDUSA: every column has its first name, and every
  number is the same. All 36 live definitions matched the last commit before each seed, so nothing edited was overwritten.
- **State:** fixed and live since transform run 15.

<a id="issue-33"></a>
### 33. The ‹› window's code was the same for Next 1 h and Next 4 h

- **Seen:** choosing *Next 1 h* and then *Next 4 h*, the code in the ‹› window was the same line by line, which suggested
  the filters weren't being applied. Also asked for: a second click on a choice should remove it.
- **Why:** two things, and the first was on the page all along. Each graph had one window under a fixed name, and an open
  window was brought to the front with the query it opened with, so the filter never reached it. The live site was also
  mid-way through a deploy: the new definitions were in Databricks, but only **Lakehouse transform** copies them to MEDUSA.
- **Change:** each combination of choices gets its own window, and the SQL writes each choice out as a plain condition
  or column. A second click removes a choice. With no hours chosen, past moves use the next 4 hours and the page says so.
- **Checked:** reproduced first: both clicks went to `medusa-calc-ins_year`, and the second never loaded. After the fix,
  each combination gets its own window, and in two real windows 3 of 34 lines differ, exactly the three choices. A second
  click on each choice clears it, with no query failing.
- **State:** fixed and live since transform run 11.

<a id="issue-32"></a>
### 32. *Down moves* and *Next 24 h* didn't change *Every market right now*

- **Seen:** with *Down moves* and *Next 24 h* chosen, the graph still showed markets going both ways. Its axis also read
  0, 1, 1, 2, 2.
- **Why:** only the four graphs of past moves used those two choices, and nothing on the page said so. A separate cause
  affected other graphs: **Lakehouse transform** hadn't been run since the filter work, so the market by hour and *Every
  kind of move* were still on their old definitions. The axis wrote ticks 0.5 apart with no decimals.
- **Change:** *Every market right now* and *Every kind of move at a glance* follow both choices, and **All moves** is a new
  choice and the default. The market by hour doesn't apply, and a line under every graph says what it follows, read from
  its own query. Ticks get the decimals their spacing needs. *Every kind of move* was also rewritten, because the first
  version took about 3.5 seconds on every click.
- **Checked:** locally with real data, three combinations match Databricks exactly. With *Down* chosen, 0 rising markets
  are shown. *Every kind of move* takes 0.13 to 0.35 seconds.
- **State:** fixed and live since transform run 11.

<a id="issue-31"></a>
### 31. Dots drawn outside the graph on *Every market right now*

- **Seen:** some dots sat below the graph, on top of the axis labels.
- **Why:** the graph's vertical axis is logarithmic and was set never to go below ×0.1, a tenth of a market's usual
  volume, but nothing kept a dot above that line. A market trading less than that was drawn below the axis. Stock
  perpetuals do that when their market is closed, such as at a weekend.
- **Change:** the axis now reaches down to the lowest market, as far as ×0.01. Anything lower sits on the bottom of the
  graph, and its hover still shows the real value. A small margin keeps whole dots inside.
- **Checked:** locally on real data, for each market type: every dot's position against the bottom of the graph.
- **State:** fixed and live since transform run 11.

<a id="issue-30"></a>
### 30. The market filter did nothing on Insights

- **Seen:** on Insights with *Stocks* chosen, *Year by year* still showed 227 moves for 2020, every market's number,
  right after the filter went live.
- **Why:** two things. First, the page was out of date. Everything published was right, but a browser kept the daily
  answer for 5 minutes and an open page only asked again every 30, so a page opened before the 23:16 UTC publish was
  still running version 1 of the definitions, which ignore the filter. Second, a real gap: the market by hour, *Every kind
  of move at a glance* and the live counts on Patterns read tables with no market type, so they ignored it whatever
  the timing.
- **Change:** an open page asks every 5 minutes and reloads only if the publish records changed, and a browser keeps the
  answer for 1 minute. `gold.hour_drift` gained `market_type`, *Every kind of move at a glance* is built from the moves
  of the type chosen, Patterns counts that type, and the filter shows on all three views. Only the Bitcoin card ignores
  it, on purpose ([ADR-037](../lakehouse/docs/decisions.md#adr-037-market-type-comes-from-a-reference-list-and-only-tested-markets-get-a-verdict)).
- **Checked:** the live answer and Insights file were read directly: both were right, which confirmed the cause. Locally
  with real data, all seven Insights graphs change with each of the 5 types, with no failures, and the Stocks figures match
  Databricks. A page left open picked up a publish by itself at the 5-minute mark. `hour_drift`'s `all` rows match the
  old table on all 672 rows.
- **State:** fixed and live since transform run 11.

<a id="issue-29"></a>
### 29. The transform failed: *dim_market_type was not found*

- **Seen:** **Lakehouse transform** stopped at *Check bronze is fresh* with a compilation error: `intraday_events`
  depends on a node named `dim_market_type` which was not found, and a warning that the patch in `seeds/_seeds.yml`
  had no matching node.
- **Why:** `lakehouse/.gitignore` has `*.csv`, to keep downloaded market data out of the repository, and it also
  caught the new reference list, `dbt/seeds/dim_market_type.csv`. `git add -A` left it out and said nothing, so the
  commit had the file's description but not the file. `dbt parse` had passed because the file was on the computer
  it ran on.
- **Change:** `lakehouse/.gitignore` now makes an exception for `dbt/seeds/*.csv`.
- **Checked:** `git add -A -n` now lists the file. `dbt parse` passes on a copy of only the files Git would send,
  with the seed found and 153 tests. The failed run built and published nothing, so the live site was unaffected,
  and the definitions' version 2 had already gone in correctly. Before a commit that adds files, the same two checks
  now run.
- **State:** fixed. **Lakehouse transform** run 10 succeeded with the seed loaded.

<a id="issue-28"></a>
### 28. Stocks and commodities showed verdicts tested on crypto

- **Seen:** found while building step 32.2. The Today table showed a verdict such as *fade* on a stock, though every
  verdict is chosen on 2020 to 2024 and stock perpetuals only began in December 2025.
- **Why:** the moves had no market type, so `unusual` joined the verdicts on direction, size and liquidity alone. The
  evidence also mixed 652 stock and commodity moves into its held-back years. On real data they differ: from December
  2025, up moves over the next 4 hours had a median of −0.87% on crypto and +0.04% on stocks.
- **Change:** a list of what each market is, `silver.dim_market_type`, and `market_type` on every move. The evidence
  covers crypto and other markets, and stocks and commodities show *not tested*
  ([ADR-037](../lakehouse/docs/decisions.md#adr-037-market-type-comes-from-a-reference-list-and-only-tested-markets-get-a-verdict)).
- **Checked:** on the real tables, 0 of 60 verdicts and 0 sides changed, and no in-sample number moved. Locally with the
  real moves, the Stocks graphs match Databricks, and a stock and a commodity show *not tested* while crypto rows keep
  their verdicts.
- **State:** fixed and live since transform run 10.

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
- **State:** **open, parked by the owner on 2026-11-01** to be picked up later. Reading the journal is
  unaffected, on any device. Only new imports are. The first thing to check is whether CoinDCX still allows
  a key with no IP, even one that expires.

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
  November. The daily load can now cut a day out of a monthly file, tested against September's daily files.
  See [19](#issue-19) for what changed around it.

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
