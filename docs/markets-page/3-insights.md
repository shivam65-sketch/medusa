# 3. Insights

[← 2. Patterns](2-patterns.md) · [The Markets page, explained](README.md) · Next: [4. The windows →](4-windows.md)

**In one line:** pictures of the history. Every unusual move since January 2020 (about 21,000 of them) and what
happened next, shown in different ways, plus a playbook for the markets that are unusual right now.

When you open Insights, the page downloads the history once (a single file, about 0.7 MB); a line at the top
says when it's loading.

## The two extra buttons

Insights adds two choices at the top, and every graph follows them:

| Button | What it does |
|---|---|
| **All moves**, **Up moves**, **Down moves** | Which past moves to count: all of them, only the jumps, or only the drops |
| **Next 1 h**, **Next 4 h**, **Next 24 h** | How long after each move to measure what happened. Starts at 4 hours |

So with *Up moves* and *Next 4 h* chosen, a graph counts every past unusual jump of the type chosen at the top,
and shows whether, 4 hours later, it had **kept going (+)** or **turned back (−)**. These words, and *median*,
*average* and *kept going share*, are explained on [the first page](README.md#the-ideas-behind-every-number).

Click a chosen button again to clear it. With no time chosen, the graphs measure at 4 hours and the grid of every
kind of move shows all three. A line under each graph, **Follows: …**, says which of the choices it uses.

## Every market right now

**In one line:** a dot for every market, showing how far it has moved today against how busy it is.

| Part | In plain words |
|---|---|
| **Left to right** | Today's move in normal days (z). The middle is no move; right is up, left is down. Dots beyond 12 are drawn at the edge |
| **Bottom to top** | How busy the market is today compared with a normal day (×1 is normal, ×10 is ten times as busy). The scale is stretched so ×1, ×10 and ×100 are equal steps apart |
| **Grey dot** | Normal today |
| **Blue dot** | Unusual, **and** its kind of move has a pattern that held up over the hours chosen (see Patterns) |
| **Orange dot** | Unusual, with no tested pattern |

**How to read it:** a dot far to one side **and** high up has made a big move on heavy trading: often news. A big
move on thin trading (far to one side but low) turns back more easily.

*With* **Up moves** *or* **Down moves** *chosen*, only markets moving that way today are shown.

**What you can click:** a dot opens that market's numbers ([one market](4-windows.md#one-market)).

> **Behind the scenes:** calculation `insight_live_map`, version 6. Built on
> [today](5-shared-steps.md#today-todays-moves) and [flagged](5-shared-steps.md#flagged-unusual-moves), and the
> lakehouse's verdicts. Live: it changes every second.

## Playbook for the unusual markets

**In one line:** for each market that is unusual right now, what similar moves did in the past: the typical
result, how often they kept going, and how bad it got.

Most of a row describes the **group** the move belongs to (same type of market, same kind of move), so markets
in the same group show the same numbers. Only **Its own past** is about that one market.

| Column | In plain words |
|---|---|
| **Market**, **z (σ)** | The market and how unusual its move is |
| **Kind of move** | The group, for example *Up 4–6σ, large* |
| **Verdict** | The group's verdict over the hours chosen (the only column that is a test). *not tested* for stocks and commodities |
| **Past moves** (*on n days*) | How many times a market of this type made a move of this kind since 2020, and on how many different days. More days is stronger evidence |
| **Next 1 h**, **Next 4 h**, **Next 24 h** | The middle result (median) after 1, 4 and 24 hours: + kept going, − turned back. Underneath: the same, from 2025 only |
| **Kept going** | How often such moves kept going over the hours chosen. Underneath: from 2025 |
| **Worst 5%: kept going** | If you bet the move would turn back: 1 time in 20, it kept going **at least** this far instead |
| **Worst 5%: turned back** | If you joined the move: 1 time in 20, it turned back **at least** this far |
| **Its own past** (*n moves*) | This market's own past unusual moves in the same direction: the middle result over the hours chosen. Shown from 5 moves on |

All results are **before fees**. A number stays empty when fewer than 20 days stand behind it.

*Example row (made-up numbers):* **SOL**, z **+4.8**, *Up 4–6σ, large*, verdict *no pattern*. **Past moves:
1,200 on 640 days.** **Next 4 h: −0.3%** (from 2025: −0.1%): the middle move turned back a little. **Kept going:
46%**. **Worst 5%: kept going +7.5%**: anyone betting SOL would fall back should expect, about 1 time in 20, to
see it climb another 7.5% or more first. **Its own past: −0.8%, 9 moves.**

**What you can click:** a number under *Past moves*, *Next*, *Kept going*, *Worst 5%* or *Its own past* opens the
past moves behind it ([the moves window](4-windows.md#the-moves-window)).

> **Behind the scenes:** calculation `playbook`, version 4. Built on
> [flagged](5-shared-steps.md#flagged-unusual-moves), [past kinds](5-shared-steps.md#past_kinds-past-moves-by-kind)
> (from the lakehouse's `move_outcomes`, where the median and the worst 5% are worked out once a day),
> [past own](5-shared-steps.md#past_own-each-markets-own-past-moves) and
> [verdicts](5-shared-steps.md#verdicts-verdicts-in-words). *Worst 5% kept going* is the 95th percentile of
> continuation; *turned back* is the 5th.

## Every kind of move at a glance

**In one line:** a coloured grid of every kind of move: did such moves tend to keep going (blue) or turn back
(red), and what is the verdict?

| Part | In plain words |
|---|---|
| **Rows** | The kinds of move: *every up move*, then up moves by size and liquidity, then the same for down moves |
| **Columns** | Next 1 h, 4 h and 24 h (or just the one chosen at the top) |
| **Colour** | The average result, judged by days: **blue** kept going, **red** turned back; the stronger the colour, the bigger |
| **Words in a square** | The verdict: *fade …%* or *follow …%* when it held up, otherwise the verdict word |
| **Grey square** | Fewer than 20 days behind it, or *too few*: too thin to judge |

With **Stocks** or **Commodities** chosen, the colours show how their moves went, and the words say *not tested*.

**What you can click:** a square opens the past moves behind it, with the verdict explained
([the moves window](4-windows.md#the-moves-window)).

> **Behind the scenes:** calculation `insight_patterns_map`, version 7. The colour is recalculated for the type
> and moves chosen at the top: each day's moves are averaged, then the days are averaged. The words come from
> the lakehouse's verdicts, which count crypto and other markets together, so the two can differ a little.

## Year by year

**In one line:** for the moves chosen, what happened next in each year since 2020.

Two bars per year: the **median** (the middle move) and the **average** (pulled by a few big moves). Pointing at
a year shows how many moves it had and how often they kept going.

**How to read it:** trust a pattern only if it shows up year after year, not in one lucky year. When the median
and the average are far apart, a few moves ran very far, so a stop-loss matters.

**What you can click:** a year opens its moves.

> **Behind the scenes:** calculation `insight_by_year`, version 3, built on
> [moves](5-shared-steps.md#moves-past-moves).

## Spread of outcomes

**In one line:** how the moves chosen ended, sorted into 1% steps, from "turned back more than 10%" to "kept
going 10% or more".

Each bar is one step. The bar marked **−3** holds the moves that ended between −3% and −2% (turned back 2 to 3%);
the bar marked **2** holds those that ended between +2% and +3%. The two end bars hold everything beyond 10%
either way. Pointing at a bar shows its share of all moves.

**How to read it:** most moves end near zero. The **end bars are the danger**: the share that kept going 10% or
more is what a bet on a reversal has to survive, so size a position for it.

**What you can click:** a bar opens the moves in it.

> **Behind the scenes:** calculation `insight_spread`, version 3, built on [moves](5-shared-steps.md#moves-past-moves):
> a count of moves per `bucket` (the result rounded down to a whole percent; −11 and 10 collect the ends).

## By the hour of the move

**In one line:** does it matter what time of day the move happened? One bar per hour (UTC) the move became
unusual: the middle result.

India is UTC + 5:30, so the bar at 14 is 19:30 India time.

**How to read it:** with 24 hours compared, a few will look different by luck. An hour that stands out is an idea
to test, not a pattern.

**What you can click:** an hour opens its moves.

> **Behind the scenes:** calculation `insight_by_hour`, version 3, built on [moves](5-shared-steps.md#moves-past-moves).

## By size and liquidity

**In one line:** a 3 × 3 grid: how big the move was (3–4, 4–6, 6+ normal days) against how busy the market is
(large, mid, small), coloured by the middle result.

**How to read it:** small markets cost more to trade than the 0.10% fee the verdicts assume, so a pattern there
has to be bigger to be worth anything.

**What you can click:** a square opens its moves.

> **Behind the scenes:** calculation `insight_by_group`, version 3, built on [moves](5-shared-steps.md#moves-past-moves).

## The market by hour of the day

**In one line:** a different question. Not "what happens after an unusual move", but: **does the whole market
tend to rise or fall at a certain hour of the day?**

For each hour (UTC), two bars: the average move of all the markets chosen in that hour, in **basis points**
(1 bp = 0.01%), in **2020–2024 (blue)** and **from 2025 (orange)**.

**How to read it:** a real hour pattern has both bars on the same side. An hour that leaned one way in
2020–2024 and not after was luck, or has gone. The amounts are tiny (a few bp), far too small to trade on their
own after fees: at most a hint for timing.

Pointing at an hour shows its t for each period and a verdict:

| Verdict | In plain words |
|---|---|
| **held up** | Clear in 2020–2024 (t beyond ±2) and clear the same way from 2025 |
| **did not hold** | Clear in 2020–2024, not repeated from 2025 |
| **no pattern** | Nothing clear in 2020–2024 |
| **not tested** | Stocks or commodities: no 2020–2024 years |

Unlike the verdicts on Patterns, this one doesn't take off fees.

**What you can click:** an hour opens it year by year and by liquidity ([the hour window](4-windows.md#the-hour-window)).

> **Behind the scenes:** calculation `insight_hour_drift`, version 4, built on
> [hour stats](5-shared-steps.md#hour_stats-the-market-by-hour). In the lakehouse, each market's move in an hour
> is capped at ±10% (so one wild new listing can't decide an hour), the markets' moves in each hour of each day
> are averaged, and then the days are averaged.
