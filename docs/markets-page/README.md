# The Markets page, explained

[← MEDUSA](../../README.md)

Every card, table, graph and window on MEDUSA's **Markets** page, in plain words: what it shows, how its
numbers are worked out, an example with simple numbers, and what happens when you click. You don't need to
know any maths, trading or code to follow it: every idea is explained on this page before it is used.

| Page | What's on it |
|---|---|
| [1. Today](1-today.md) | The live view: the four cards at the top, the unusual markets, the breakout lists, the biggest movers and every market |
| [2. Patterns](2-patterns.md) | What happened after moves like these in the past, and which patterns passed the test |
| [3. Insights](3-insights.md) | The graphs, and the playbook for each unusual market |
| [4. The windows](4-windows.md) | What opens when you press **‹›** or click a number, a bar or a dot |
| [5. The building blocks](5-shared-steps.md) | The ten calculations the numbers are built on, for anyone who wants to look underneath |

Each entry ends with a short **Behind the scenes** note: the name of the calculation, its version and the
formula, for anyone who wants to check it. You can skip those notes and still understand everything. The
tables the numbers come from are described column by column in
[Lineage and transformations](../../lakehouse/docs/lineage/README.md).

## What the page is for

The page watches every futures market on Binance (Bitcoin, Ether, hundreds of smaller coins, and a few
stocks and commodities) and answers three questions:

1. **Is anything moving unusually today?** Not just "up a lot", but up a lot *for that market*.
2. **When moves like this happened before, what came next?** Did the price keep going, or turn back?
3. **Was that pattern real, or luck?** Every pattern is tested on years it wasn't found on.

It is research, not advice. Nothing on it tells you to buy or sell.

## Where the numbers come from

Think of each market as having two kinds of information:

- **Its normal**, worked out once a day from its last 30 days: how much it usually moves, how much it usually
  trades, and yesterday's closing price. This comes from MEDUSA's data store (the *lakehouse*), which builds
  it every day from Binance's official files, usually by 20:00 UTC (01:30 India time).
- **Its price right now**, sent by Binance straight to your browser about once a second.

The page compares the two. Every number is a small calculation (written in SQL, a language for working with
tables) that your browser runs about once a second. Nothing is sent to MEDUSA's server.

## The ideas behind every number

Read these once; every page uses them.

### Today's move

**In one line:** how much the price has gone up or down since yesterday.

A day here runs from midnight to midnight UTC, which is 05:30 to 05:30 India time. "Yesterday's close" is the
price at the end of yesterday.

*Example:* Ether closed yesterday at 3,000 and costs 3,180 now. It has gone up 180, and 180 out of 3,000 is
6%. Today's move is **+6%**.

> **Behind the scenes:** today's move = price now ÷ yesterday's close − 1. Until the lakehouse has
> yesterday's close (it publishes in the evening UTC), the page takes it from Binance's own daily candle.

### A normal day (σ)

**In one line:** how much this market usually moves in a day.

Every market has its own normal. Bitcoin might move about 2% on an ordinary day; a small new coin might move
10%. So a 6% move is huge for Bitcoin and nothing special for the small coin. The page works out each
market's normal from its last 30 days of trading: roughly, the size of a typical day's move, up or down.

The page writes it with the Greek letter **σ** (say "sigma"), and calls it **Usual day** in the big table.

*Example:* over the last 30 days Ether's daily moves were typically about 1.8% either way. Its σ is **1.8%**.

> **Behind the scenes:** σ is the *standard deviation* of the market's daily moves over its last 30 days with
> trades: a standard way of measuring how far values usually are from their average.

### z: how unusual today's move is

**In one line:** how many normal days' worth the price has moved today.

z compares today's move with the market's normal day. z = 1 is an ordinary day. z = 3 means the price has
moved three normal days' worth in one day. A plus sign means up, a minus sign means down.

*Example:* Ether is up 6% and its normal day is 1.8%. 6 ÷ 1.8 is about 3.3, so its z is roughly **+3.2σ**
(the exact figure takes off Ether's tiny average daily rise first; see below).

The same 6% on the small coin whose normal day is 10% is z = 0.6: nothing unusual.

A market needs at least 20 days of history before it gets a z, so brand-new markets have none.

> **Behind the scenes:** z = (today's move − average daily move) ÷ σ. Ether's average daily move over 30 days
> was +0.2%, so z = (6.0 − 0.2) ÷ 1.8 = 3.2.

### Unusual

**In one line:** a market is **unusual** when it has moved 3 normal days' worth or more today, up or down.

In plain numbers: z of +3 or more, or −3 or less. Most markets on most days are nowhere near it; the *Unusual
now* card shows how many are there right now.

### Grouping moves so like is compared with like

To ask "what happened after moves like this one?", past moves are sorted into groups by three things:

| Sorted by | Groups | Why |
|---|---|---|
| **Direction** | up or down | A jump and a crash may behave differently |
| **Size band** | 3 to 4σ, 4 to 6σ, 6σ or more | A huge move may behave differently from a merely big one |
| **Liquidity** | large, mid, small | How much the market trades on an average day: large is 100 million USDT or more, mid 10 million or more, small less. Busy markets and quiet ones behave differently |

One group from each makes a **kind of move**, for example *"up, 4 to 6σ, on a large market"*. There are 18
such kinds, plus two wide ones: *every up move* and *every down move*.

### What happened next: kept going or turned back

**In one line:** after a past move, did the price carry on in the same direction, or go back the other way?

The page looks at the price 1, 4 and 24 hours after the move and writes the change so that **+ always means
"kept going"** and **− always means "turned back"**, whichever way the move was.

*Example:* a coin jumped up, and when the jump became unusual its price was 1.00. Four hours later it was
0.97: it fell 3%, so the jump **turned back 3%**, written **−3%**. If the coin had *crashed* and then fallen
another 3%, the crash **kept going**: **+3%**.

The clock starts at the end of the hour in which the move became unusual, a little after a quick trader could
have acted. That makes the results slightly cautious.

### The middle one (median) and the average

**In one line:** the median is the middle result; the average can be pulled far away by a few extreme ones.

*Example:* five moves turned out −2%, −1%, +0.5%, +1% and +20%. Line them up: the one in the middle is
**+0.5%**, the median. The average is (−2 − 1 + 0.5 + 1 + 20) ÷ 5 = **+3.7%**, pulled up by the single +20%.

When the median and the average are far apart, a few moves ran very far. That matters: it is those few that
hurt someone betting the other way.

### Kept going (share)

**In one line:** out of every past move in a group, how many kept going, as a percentage.

50% is a coin toss. 70% means 7 moves in 10 kept going.

### Counting days, not moves

When the whole market crashes, hundreds of coins become unusual on the same day. Counting them as hundreds of
separate examples would be like asking 300 people in one room whether it's raining: you only learn about one
day. So wherever the page *tests* something, it first takes the average of each day's moves, then judges the
days.

### t: could it be luck?

**In one line:** a score for how sure we can be that a pattern isn't just luck. Above 2 (or below −2) passes.

Think of tossing a coin. 6 heads out of 10 could easily be luck. 600 out of 1,000 almost certainly isn't. t
works the same way: it gets bigger when the result is bigger, when the days agree with each other, and when
there are more days. A plus means the moves tended to keep going; a minus means they tended to turn back.

> **Behind the scenes:** t = average of the days ÷ (how much the days vary ÷ √number of days). *Example:* days
> averaging +0.30%, varying by 2.0%, over 400 days: 0.30 ÷ (2.0 ÷ 20) = **3.0**.

### The fair test: 2020–2024, then 2025 onwards

Look at enough groups and some will show a "pattern" by pure luck. So every test works in two steps, like
studying with one set of exam papers and being graded on a different set:

1. **2020–2024:** find which way the moves tended to go (keep going or turn back). This picks the bet.
2. **2025 onwards:** check whether the same bet still worked on years that played no part in picking it.

### The verdicts

Each kind of move gets a verdict for each of the next 1, 4 and 24 hours:

| Verdict | In plain words |
|---|---|
| **fade 0.22%** | Moves like this tended to **turn back**, and betting on that still worked from 2025: on average 0.22% a trade, after paying 0.10% in trading fees |
| **follow 0.22%** | Moves like this tended to **keep going**, and betting on that still worked from 2025 |
| **did not hold** | There was a pattern in 2020–2024, but it didn't repeat from 2025, or it didn't earn enough to pay the fees |
| **no pattern** | Nothing clear in 2020–2024, so there was nothing to bet on |
| **too few** | Fewer than 30 days of examples in one of the two periods: too little to judge |
| **not tested** | A stock or commodity market. Binance only started them in December 2025, so they have no 2020–2024 years to learn from |

The fees counted are 0.10% for buying and selling once. **Funding** is **not** counted: a fee that traders on
one side pay the other every few hours. After sharp rises, people betting on a fall often have to pay it, and
it can be large. So read a *fade* figure after an up move as the most it could have made.

### Other words on the page

| Word | In plain words |
|---|---|
| **Volume ×** | How busy the market is today compared with a normal day. ×3 means three times as much trading as usual |
| **Bad day** | How far this market fell on its worst 1 day in 20 lately. A guide to how much a position could lose in a day, not a limit: when a day was worse, it was typically 1.3 times this |
| **Range** | The highest and lowest price of the market's last 3 trading days |
| **bp** (basis point) | One hundredth of a percent. 10 bp is 0.10% |
| **Worst 5%** | A line, not an average: 1 past move in 20 went at least this far |
| **Type** | crypto, stock, commodity, or other (stock indices, a currency, companies not yet listed on a stock exchange), from Binance's list |
| **USDT** | A digital dollar: 1 USDT is about 1 US dollar. Prices and volumes are in it |
| **Perpetual** | The kind of futures contract the page watches. Its price follows the coin (or stock) closely |

## Around the page

### The buttons at the top

| Button | What it does |
|---|---|
| **Today**, **Patterns**, **Insights** | Switch between the three views |
| **All**, **Crypto**, **Stocks**, **Commodities**, **Other** | Which type of market the numbers count. The *Bitcoin* card ignores it |
| **All moves**, **Up moves**, **Down moves** (Insights only) | Which past moves the graphs show |
| **Next 1 h**, **Next 4 h**, **Next 24 h** (Insights only) | How long after a move its result is measured |

Clicking a chosen button again clears it: the type goes back to *All*, the moves to *All moves*, and the time to
none (the graphs then measure at 4 hours, and the grid of every kind of move shows all three). The page remembers
your choices on this device.

### The market hours strip

**In one line:** which of the stock markets that move crypto most are open right now, and when the others open,
in your own time.

A row of nine names under the page's header: **US stocks**, **CME futures** (Bitcoin futures in Chicago),
**London**, **Frankfurt**, **India**, **Shanghai**, **Hong Kong**, **Seoul** and **Tokyo**. A lit dot means open;
each says *open · closes 21:30* or *opens tomorrow 13:30*. Pointing at one shows the exchange's full name and its
hours. Lunch breaks (Shanghai, Hong Kong, Tokyo) and summer time are taken into account; public holidays aren't.

It's there because crypto often moves when big stock markets open or close.

> **Behind the scenes:** worked out in your browser from each exchange's regular hours in its own time zone
> (`public/app.js`); no data is fetched.

### The status lines

A few grey lines under the buttons say how fresh everything is:

| Line | What it tells you |
|---|---|
| A **yellow warning** | A day of data is missing, or the daily data is two days or more late. Each market's normal is a little out of date until it's fixed |
| **Live from Binance · updated 1 s ago** | Live prices are arriving. If it says *reconnecting* or that Binance can't be reached, prices are paused; the daily numbers are unaffected |
| ***n* markets priced** | How many markets have both a live price and a normal |
| **Each market's normal: lakehouse day …** | The newest day of daily data, and when it arrived |
| **Today's move is measured from yesterday's close, from …** | Where yesterday's closing prices came from, and how many markets don't have one yet |
| **Numbers calculated by SQL in this browser …** | When the numbers were last worked out and how long it took |

### The ‹› button

Every number has a small **‹›** button. It opens a window that shows exactly how that number is worked out,
with the inputs and the result, and lets you change the calculation for yourself. See
[4. The windows](4-windows.md).
