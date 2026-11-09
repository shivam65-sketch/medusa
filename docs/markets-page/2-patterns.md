# 2. Patterns

[← 1. Today](1-today.md) · [The Markets page, explained](README.md) · Next: [3. Insights →](3-insights.md)

**In one line:** the scoreboard of the history. For every kind of unusual move since January 2020: did such
moves tend to keep going or turn back, and did that pattern survive a fair test?

The verdicts come from the lakehouse, which recalculates them every day from every unusual move since 2020.
They don't change during the day; only the **Now** and **Right now** columns use live prices. Words like
*kind of move*, *kept going*, *t* and the verdicts are explained on
[the first page](README.md#the-ideas-behind-every-number).

If **Stocks** or **Commodities** is chosen at the top, a note says they are *not tested*: Binance only started
them in December 2025, so there are no 2020–2024 years to learn from. The verdicts on this view are for crypto
and other markets.

## What similar moves did next

**In one line:** how many unusual moves the history holds, and how many groups got each verdict.

It reads like: *"about n moves (n up, n down), almost all of them crypto"*, then a row of counts:
***n* held up · *n* did not hold · *n* no pattern · *n* too few, of 60 kinds of move and horizons.** Most of
the 60 don't hold up: an unusual move, on its own, usually tells you little about what comes next.

**Where 60 comes from:** 20 kinds of move (18 groups plus *every up move* and *every down move*) × 3 time
spans (the next 1, 4 and 24 hours) = 60 verdicts.

**What you can click:** each count, for example *"4 held up"*, opens a window listing those groups
([kinds with this verdict](4-windows.md#kinds-of-move-with-this-verdict)).

> **Behind the scenes:** calculation `patterns_summary`, version 1, on `market_evidence` (the lakehouse's
> verdicts). The up and down totals count each move once (from the *every up move* and *every down move*
> groups at 1 hour). The counts are the 60 rows by verdict.

## Patterns that held up

**In one line:** the few groups whose pattern passed the fair test, each written as a sentence.

Each line reads like this (made-up numbers):

> **Fade up moves of 4 to 6σ on large markets, over the next 4 hours:** +0.25% a trade from 2025 after 0.10%
> costs (t −2.4 over 45 days), chosen on 2020–2024 (t −3.1 over 120 days). 300 moves on 150 days in all. Right
> now: ETH.

Piece by piece:

| Part | In plain words |
|---|---|
| **Fade** (or **Follow**) | The bet: *fade* = bet the move turns back; *follow* = bet it keeps going |
| **up moves of 4 to 6σ on large markets** | The kind of move |
| **over the next 4 hours** | How long the bet is held |
| **+0.25% a trade from 2025 after 0.10% costs** | On the years kept back for the test, the bet made 0.25% per trade on average, after paying fees |
| **t −2.4 over 45 days** | How sure we can be that this wasn't luck, from 2025, and how many days of examples. Beyond ±2 passes; the minus means the moves turned back, which is what a fade needs |
| **chosen on 2020–2024 (t −3.1 over 120 days)** | The bet was picked on these years: the moves turned back clearly (a minus t means "turned back") |
| **300 moves on 150 days in all** | How many examples there are, and on how many different days |
| **Right now** | Which markets are in this group at this moment (of the type chosen at the top) |

Before trusting a *fade* line, read the warning about funding [below](#how-a-verdict-is-decided).

**What you can click:** the bold start of a line opens every past move in that group
([the moves window](4-windows.md#the-moves-window)).

> **Behind the scenes:** calculation `patterns_held`, version 6: the rows of `market_evidence` whose verdict
> is *held up*, best result from 2025 first, joined to [flagged](5-shared-steps.md#flagged-unusual-moves) for
> **Right now** (only tested markets: crypto and other). For *every up move* or *every down move*, every
> unusual market in that direction counts.

## Every kind of move

**In one line:** a table of all 20 kinds of move, with how many markets are in each right now and the three
verdicts.

| Column | In plain words |
|---|---|
| **Direction**, **Size band**, **Liquidity** | Which kind of move the row is. A row with *all* is every move in that direction |
| **Now** | How many markets (of the type chosen) are in this group at this moment |
| **Next 1 h**, **Next 4 h**, **Next 24 h** | The verdict for each time span: *fade …%*, *follow …%*, *did not hold*, *no pattern* or *too few* |

**What you can click:**

- **A number under Now** opens the list of those markets
  ([markets in this group right now](4-windows.md#markets-in-this-group-right-now)).
- **A verdict** opens every past move in that group, with the verdict explained
  ([the moves window](4-windows.md#the-moves-window)).

> **Behind the scenes:** calculation `patterns_grid`, version 5, built on
> [verdicts](5-shared-steps.md#verdicts-verdicts-in-words) and [flagged](5-shared-steps.md#flagged-unusual-moves).
> **Now** counts only tested markets (crypto and other) of the type chosen.

## How a verdict is decided

The box at the bottom of the view sets out the rules. Here they are as steps, with one worked example: *up
moves of 4 to 6σ on large markets, over the next 4 hours* (made-up numbers).

**Step 1. Collect the moves.** Every time since 2020 that a large market's move during a day reached 4 to 6
normal days upwards, write down where the price was 4 hours later, as *kept going* (+) or *turned back* (−).

**Step 2. Count days, not moves.** Average the moves of each day first, so a crash day with 200 coins counts
once, not 200 times.

**Step 3. Is there enough?** At least 30 days in 2020–2024 **and** at least 30 days from 2025. If not:
**too few**. *Example:* 120 days and 45 days: enough.

**Step 4. Pick the bet, on 2020–2024 only.** If the days kept going clearly (t of 2 or more), the bet is
**follow**. If they turned back clearly (t of −2 or less), it's **fade**. Otherwise: **no pattern**, and it
stops here. *Example:* the days turned back 0.40% on average, t −3.1: the bet is **fade**.

**Step 5. Test it on 2025 onwards.** The bet passes (**held up**) only if all three are true:

1. From 2025 the moves went the same way, clearly: t of 2 or more for the bet;
2. the bet earned more than the 0.10% fees in 2020–2024;
3. and it earned more than the 0.10% fees from 2025.

Otherwise: **did not hold**.

*Example:* from 2025 the days turned back 0.35% on average, t −2.4. For a fade that is +2.4: clear enough.
Fading earned 0.40% then and 0.35% now, both above 0.10%. **Held up**. The page shows **fade 0.25%**: the
0.35% from 2025, minus the 0.10% fees.

**Two warnings on the page:**

- **Funding isn't counted.** Betting on a fall (a *short*) pays a fee called funding when many people bet the
  same way, which often happens after sharp rises. After up moves on large and mid markets it averaged 0.27% a
  trade over 24 hours, more than the fee counted here, and a few squeezes cost much more. When funding was
  counted and every trade was the same size, betting on falls after up moves **stopped passing** (the Risk page
  has the test). So read a *fade* figure after an up move as the most it could have made.
- **Some will pass by luck.** With 60 groups tested, a few can pass by chance. That is why the test uses years
  kept back, and why the rules were fixed before looking at them and are never adjusted afterwards.

> **Behind the scenes:** the verdicts are built in the lakehouse by `intraday_events.sql` and
> `event_evidence.sql`; every step is described in
> [Lineage 4: moves and evidence](../../lakehouse/docs/lineage/4-gold-moves-and-evidence.md). For a fade, "t of 2
> or more for the bet" means the t from 2025 is −2 or less.
