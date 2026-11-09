# 1. Today

[← The Markets page, explained](README.md) · Next: [2. Patterns →](2-patterns.md)

The live view. It answers: how is the whole market doing today, which markets are moving unusually, and what
happened after moves like these before? Everything here uses live prices, so it changes about once a second.

Words like *today's move*, *normal day (σ)*, *z* and the verdicts are explained on
[the first page](README.md#the-ideas-behind-every-number). Every number here counts only the type of market
chosen at the top (*All*, *Crypto*, *Stocks* and so on), except the *Bitcoin* card.

## The four cards at the top

### Breadth

**In one line:** out of all the markets, what share are up today.

**How it's worked out:** count the markets that are up since yesterday, and divide by all the markets that
have a price today. Underneath it shows how many are up and how many are down.

*Example:* 430 markets are up, 290 are down and 6 haven't moved. 430 out of 726 is **59% up**. Above 50%, more
markets are rising than falling.

> **Behind the scenes:** calculation `breadth`, version 1. Breadth = markets up ÷ markets with a move. Markets
> that haven't moved count in the total. Built on [today](5-shared-steps.md#today-todays-moves).

### Median move

**In one line:** the move of a typical market today, the one in the middle.

**How it's worked out:** line up every market's move today from the worst to the best and take the one in the
middle. With an even number of markets, it takes the two in the middle and goes halfway between them.

*Example:* four markets moved −1%, +0.5%, +2% and +3%. The two in the middle are +0.5% and +2%; halfway is
**+1.25%**. One coin that jumped 80% wouldn't change it much; an average would jump.

> **Behind the scenes:** calculation `median_move`, version 1. The browser's database has no median function,
> so the calculation numbers the moves in order and keeps the middle one or two. Built on
> [today](5-shared-steps.md#today-todays-moves).

### Unusual now

**In one line:** how many markets have moved unusually today (3 normal days' worth or more), and how many of
those went up or down.

> **Behind the scenes:** calculation `unusual_count`, version 1: a count of
> [flagged](5-shared-steps.md#flagged-unusual-moves), split by direction.

### Bitcoin

**In one line:** Bitcoin's price now, how much it has moved today, and how unusual that is (its z).

It is the Bitcoin *futures* market (BTCUSDT perpetual; on TradingView, BINANCE:BTCUSDT.P), so its price can be
a little different from the Bitcoin price on a normal exchange. It always shows Bitcoin, whatever type is
chosen at the top.

> **Behind the scenes:** calculation `bitcoin`, version 1: BTCUSDT's row of
> [today](5-shared-steps.md#today-todays-moves).

## Unusual right now

**In one line:** every market moving unusually today, the most unusual first, and what happened after similar
moves in the past.

| Column | In plain words |
|---|---|
| **Market** | Its name, with its type (crypto, stock and so on) |
| **Price** | Its price now |
| **Today** | How much it has moved since yesterday |
| **z (σ)** | How many normal days' worth it has moved. +3 or more, or −3 or less, is unusual |
| **Liquidity** | How busy the market usually is: large, mid or small |
| **Next 1 h**, **Next 4 h**, **Next 24 h** | The verdict for moves of the **same kind** (same direction, similar size, similarly busy market) over the next 1, 4 and 24 hours. *fade 0.22%*: such moves tended to turn back, and that bet still worked from 2025. *no pattern*, *did not hold*, *too few* or *not tested*: no tested edge. See [the verdicts](README.md#the-verdicts) |
| The small grey line under each verdict | The same, for **every** move in that direction (every up move, or every down move), a much bigger group |
| **Since** | When this page first noticed the market was unusual. It starts again if the market calms down and then becomes unusual again |

*Example:* Ether is up 6% with a z of +3.2 on a large market. Its kind of move is *"up, 3 to 4σ, large"*. If
that kind's *Next 4 h* says **fade 0.22%**, it means: in the past, moves like this tended to fall back over the
next 4 hours, and betting on that made 0.22% a trade on average from 2025, after fees and before funding. It
doesn't mean Ether will fall this time.

**What you can click:**

- **A market** opens [its details](#one-markets-details) under the table.
- **A verdict** opens a window with every past move of that kind and what it did
  ([the moves window](4-windows.md#the-moves-window)).

> **Behind the scenes:** calculation `unusual`, version 5. Built on
> [flagged](5-shared-steps.md#flagged-unusual-moves) (the unusual markets) and
> [verdicts](5-shared-steps.md#verdicts-verdicts-in-words) (the verdicts in words). *Since* is kept by the page
> itself, not by a calculation.

## One market's details

**In one line:** everything about one market, opened by clicking it in *Unusual right now* or *Every market*.

It shows the numbers from its row, plus:

| Item | In plain words |
|---|---|
| **Usual day** | Its normal day's move (σ) |
| **Bad day** | How far it fell on its worst 1 day in 20 lately (see [Every market](#every-market)) |
| **Volume** | How busy it is today compared with a normal day: ×2 is twice as busy |
| **Direction**, **Size band** | When it's unusual: up or down, and how big (3–4, 4–6 or 6+ normal days) |
| **Next 1 h / 4 h / 24 h** | The verdicts for its kind of move, with a sentence saying what each one means |

> **Behind the scenes:** calculation `market`, version 6. Built on [today](5-shared-steps.md#today-todays-moves),
> [flagged](5-shared-steps.md#flagged-unusual-moves) and [verdicts](5-shared-steps.md#verdicts-verdicts-in-words).

## Breakout watch

Two lists about each market's **range**: the highest and the lowest price of its last 3 trading days. Picture
a price moving sideways between a ceiling and a floor; these lists look for prices near the ceiling, or just
through it. They describe what the chart looks like; they are **not** a tested signal.

The page also knows each market's **usual range**: how wide its 3-day range normally is, averaged over its
last 30 days.

### Setting up

**In one line:** markets that have been unusually calm, with the price just under the ceiling.

**A market is listed when all three are true:**

1. It has at least 20 days of history.
2. Its range is **narrow**: at most half as wide as usual.
3. The price is **just under the ceiling**: within 3% below the top of the range.

| Column | In plain words |
|---|---|
| **Range top** | The ceiling: the highest price of the last 3 days |
| **Below top** | How far the price is under the ceiling, in % |
| **Range vs usual** | How wide the range is compared with usual. ×0.4 means 40% as wide as normal: calm |
| **Volume** | How busy the market is today compared with a normal day |

*Example:* a coin traded between 101 and 105 over the last 3 days. That range is about 4% wide (105 is about
4% above 101). Its usual 3-day range is 10%, so it is **×0.40**: calm. The price is 103, which is **1.9%** under
the ceiling of 105, within 3%. So it's listed. Closest to the ceiling comes first.

> **Behind the scenes:** calculation `setting_up`, version 1, built on
> [ranges](5-shared-steps.md#ranges-each-markets-range). range = top ÷ bottom − 1; listed when
> range ≤ 0.5 × usual range and 0.97 × top ≤ price ≤ top. Below top = (1 − price ÷ top) × 100.

### Breaking out

**In one line:** markets whose price has gone **above** the ceiling of their last 3 days, those just above it
first.

Unlike *Setting up*, the range doesn't have to have been calm.

| Column | In plain words |
|---|---|
| **Above top** | How far the price is above the ceiling, in % |
| **Range top**, **Range vs usual**, **Volume** | As in *Setting up* |

*Example:* the same coin now costs 106.05, which is **1%** above the ceiling of 105.

> **Behind the scenes:** calculation `breaking_out`, version 1, built on
> [ranges](5-shared-steps.md#ranges-each-markets-range). Listed when price > top, with 20 days of history.
> Above top = (price ÷ top − 1) × 100.

## Movers today

**In one line:** the 8 markets up the most today (**Up the most**) and the 8 down the most (**Down the most**).

Each one shows its z too. A market that moves a lot every day can top this list with a small z, which is why
it isn't the same as *Unusual right now*.

> **Behind the scenes:** calculations `gainers` and `losers`, version 3, built on
> [today](5-shared-steps.md#today-todays-moves).

## Every market

**In one line:** one row for every market, showing today against its normal. Unusual markets are highlighted.

| Column | In plain words |
|---|---|
| **Market**, **Price**, **Today**, **z (σ)**, **Liquidity** | As in *Unusual right now* |
| **Usual day** | Its normal day's move (σ): how much it usually moves, up or down |
| **Bad day** | How far it fell on its worst 1 day in 20 over its last 30 days |
| **Volume** | How busy it is today compared with a normal day |

**About Bad day.** It helps you think about how much a position in this market could lose in one day.

*Example:* Ether's usual day is 1.8%. Its bad day comes out at **−2.76%**: about 1 day in 20, it fell further
than that. Two warnings come with it:

- When a day was worse than the bad day, it was typically **1.3 times** as bad (so about −3.6% for Ether).
- Bad days come together. On about 1 day in 15, a fifth of all markets had their bad day at once, so owning
  several markets doesn't protect you from it.

**The controls above the table:**

| Control | What it does |
|---|---|
| **Find a market or type** | Type a name (like *ETH*) or a type (like *stock*) to show only matching rows |
| **Most unusual** | Biggest z first, up or down |
| **Gainers** / **Losers** | Biggest rise first / biggest fall first |
| **Volume** | Busiest compared with its normal day first |
| **Show more** | The table shows 50 rows at a time |

Clicking a row opens [its details](#one-markets-details) under the table.

> **Behind the scenes:** calculation `markets`, version 4, built on [today](5-shared-steps.md#today-todays-moves)
> and [flagged](5-shared-steps.md#flagged-unusual-moves). Usual day = σ. Bad day = average daily move −
> 1.645 × σ; 1.645 is the point on a bell curve beyond which the worst 5% (1 in 20) lies. For Ether:
> 0.20% − 1.645 × 1.80% = −2.76%. The 1.3 times and the 1 day in 15 (6.6% of days) come from the test in
> lakehouse step 32.

## How the scanner works

A box at the bottom of the view sums up, in a few lines, what the first page of this guide explains: where
the markets, their normal and the live prices come from, how today's move and the breakout lists are measured,
what the evidence is, and why stocks and commodities aren't tested.
