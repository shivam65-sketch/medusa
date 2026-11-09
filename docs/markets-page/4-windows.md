# 4. The windows

[← 3. Insights](3-insights.md) · [The Markets page, explained](README.md) · Next: [5. The building blocks →](5-shared-steps.md)

Two kinds of window open from the page, each in its own browser window:

- **A ‹› window**, opened by the small **‹›** button next to any number: *how is this number worked out?*
- **A drill-down window**, opened by clicking a number, a bar, a square or a dot: *which past moves (or which
  markets) are behind this?*

Only numbers that sum something up can be clicked, and the window opens with the number you clicked at the top.

## The ‹› window: how a number is worked out

**In one line:** the calculation behind one number, shown exactly as it runs, with its result, and a way to
change it for yourself.

| Part | In plain words |
|---|---|
| **The name and a sentence** | What the number means |
| **How it is calculated** | The calculation (a SQL query) exactly as it runs, with comments in plain words. The building blocks it uses ([page 5](5-shared-steps.md)) are written out in front of it, so it is complete |
| Which version | The version number, who made it and when. Every change makes a new version; the old ones are kept |
| **On the page now** | The current result, the same as on the page |
| **Download the result (CSV)** | The result as a spreadsheet file |
| **Download the inputs (CSV)** | For a live number: the live prices and other inputs it used at that moment, so the result can be checked by hand |
| **Copy**, **Copy for Databricks** | The calculation, ready to run in MEDUSA's database or in the lakehouse |
| **History** | Every earlier version, with **Use this version again** |

### Changing a calculation

Every ‹› window has an editor, **Edit, preview and save**, with one box for each building block the number uses
and one for its own final step. **Open to edit** lists them; click one to open its box.

| Button | What it does |
|---|---|
| **Edit this query** | In a window with several numbers: points the editor at that number |
| **Preview** (or Ctrl+Enter) | Runs your version on this screen only, under **Your version**, next to the current result. Nothing is saved; nobody else sees it |
| **Stop preview**, **Undo my changes** | Go back to the current version |
| **Save…** | Saves your version with a note saying why. From the owner's account it becomes the new shared version that everyone sees; from any other account it is that account's own version, used only on its own page |
| **Use the shared version again** | Drops your own version and goes back to the shared one |
| **Reload definitions from the lakehouse** | The owner's button: fetch every current calculation from the lakehouse again |

*Example:* you think a move should count as unusual from 2.5 normal days instead of 3. Open **‹›** on *Unusual
now*, edit the building block *flagged* (change `ABS(z) >= 3` to `ABS(z) >= 2.5`), press **Preview** and compare
the two counts side by side. Saving it changes it only for your account, unless you are the owner.

## The moves window

**In one line:** the past unusual moves behind whatever you clicked, and what they did next.

It opens from a verdict, a *Past moves* count, a *Kept going* share, a *Worst 5%* figure, an *Its own past* figure,
a square on a grid, a year, a 1% step or an hour. The title says what was picked, for example *"Up moves of 4 to
6σ on large markets, over the next 4 hours"*.

It counts the past moves that match **everything** picked (type, direction, size band, liquidity, and the year,
hour, 1% step or market clicked), with their result over the hours chosen.

### The card at the top

What you clicked comes first, in the same words as the table:

| You clicked | The card says |
|---|---|
| A **verdict** | The verdict, and a sentence explaining it: the bet, what it made from 2025 after fees, its t, and how it was chosen on 2020–2024. The verdict counts crypto and other markets together, so its number of moves can differ a little from the list below |
| A **Past moves** count | How many moves, on how many days. Each is in the list below, newest first |
| A **Kept going** share | e.g. *46%: 552 of these 1,200 moves continued over the hours chosen, and the rest reversed* |
| A **Worst 5%** figure | That the figure is a line, not an average: 1 past move in 20 went at least that far. The window lists the moves past that line |
| Anything else | **The middle move**: the median result, with how many moves, on how many days, the average and the share that kept going |

> **Behind the scenes:** the middle move is calculation `moves_summary`, version 4, on
> [moves picked](5-shared-steps.md#moves_picked-the-moves-picked).

### Spread of outcomes

The same picture as on Insights ([spread of outcomes](3-insights.md#spread-of-outcomes)), for only the moves picked.
Click a bar to narrow down to it.

> **Behind the scenes:** calculation `moves_spread`, version 3.

### Year by year

The same as on Insights ([year by year](3-insights.md#year-by-year)), for only the moves picked. Left out when a year
was clicked.

> **Behind the scenes:** calculation `moves_by_year`, version 3.

### The moves themselves

**In one line:** the newest 300 of the moves picked, one per row (100 shown at first).

| Column | In plain words |
|---|---|
| **Market** | Which market moved. Click it to see only its moves |
| **When (UTC)** | The hour the move became unusual |
| **z (σ)**, **Size band**, **Liquidity** | How unusual it was, its band, and how busy the market was |
| **Then** | What it did over the hours chosen: + kept going, − turned back |
| **Period** | *in_sample* (2020–2024) or *held_back* (2025 on) |

When the window opened from a *count*, a *share*, a *worst 5%* or a *verdict*, only the card and this list are
shown.

> **Behind the scenes:** calculation `moves_list`, version 3.

## The hour window

**In one line:** one hour of the day (opened from *The market by hour of the day* on Insights), year by year and by
liquidity.

### This hour, year by year

One bar per year: the average move of the markets chosen in that hour, in basis points (1 bp = 0.01%). Pointing at a
year shows its t, how many days it had, and the share of days the hour went up.

*How to read it:* a real pattern leans the same way most years.

> **Behind the scenes:** calculation `drift_by_year`, version 2. The lakehouse keeps sums for each year, so the years
> can be added up exactly: average = sum ÷ days; t from the sum of squares.

### This hour, by liquidity

One row each for all markets, large, mid and small: the average in 2020–2024 and from 2025, each with its t, and the
verdict (*held up*, *did not hold*, *no pattern* or *not tested*), as on
[the market by hour of the day](3-insights.md#the-market-by-hour-of-the-day).

> **Behind the scenes:** calculation `drift_by_liquidity`, version 4, built on
> [hour stats](5-shared-steps.md#hour_stats-the-market-by-hour).

## One market

**In one line:** a market's numbers (opened by clicking a dot on *Every market right now*): the same as
[one market's details](1-today.md#one-markets-details) on Today. It also shows the last message Binance sent for its
price, and, when it is unusual, how to look up every past move of its kind in the lakehouse.

> **Behind the scenes:** calculation `market`, version 6.

## Markets in this group right now

**In one line:** which markets are in a group at this moment (opened from a number under **Now** on Patterns).

Columns: market, price, today's move, z and liquidity, the most unusual first. Only tested markets (crypto and other)
of the type chosen.

> **Behind the scenes:** calculation `now_in_group`, version 1, on [flagged](5-shared-steps.md#flagged-unusual-moves).

## Kinds of move with this verdict

**In one line:** every group that got the verdict clicked (opened from a count on Patterns, such as *"4 held up"*).

| Column | In plain words |
|---|---|
| **Kind of move** | e.g. *Up 4–6σ, large*, or *Every down move* |
| **Over** | Next 1 h, 4 h or 24 h |
| **Verdict** | The verdict; click it for the moves behind it |
| **Moves**, **Days** | How many moves stand behind it, and on how many days |

> **Behind the scenes:** calculation `kinds_with_verdict`, version 2, on `market_evidence`.

## Patterns: where the verdicts come from

The **‹›** button on the Patterns view opens a window with its three calculations and a fourth, *Unusual markets
by kind of move* (every unusual market of any type, with its group), plus a note on where the verdicts are built
in the lakehouse and when they were last copied to MEDUSA.

> **Behind the scenes:** calculation `unusual_all_types`, version 3, on
> [flagged](5-shared-steps.md#flagged-unusual-moves). The page also uses it to keep the *Since* times on Today.
