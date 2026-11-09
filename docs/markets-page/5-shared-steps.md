# 5. The building blocks

[← 4. The windows](4-windows.md) · [The Markets page, explained](README.md)

**In one line:** ten calculations that many numbers reuse, like the shared steps of a recipe. Work out *today's
move* once, and every card, table and graph that needs it reads the same answer.

You don't need this page to read the Markets page. It is here for anyone who opens a **‹›** window and wants to
know what *today* or *flagged* means at the top of a calculation.

## What they are built from

The building blocks read tables kept in your browser while the page is open:

| Table | In plain words | Comes from |
|---|---|---|
| `market_baseline` | Each market's normal: its average daily move, σ, last close, usual volume and recent range | The lakehouse, once a day (`gold.coin_baseline`) |
| `market_evidence` | The verdict of every kind of move, for 1, 4 and 24 hours | The lakehouse, once a day (`gold.event_evidence`) |
| `live_prices` | Each market's price now and its USDT traded in the last 24 hours | Binance, about once a second |
| `binance_markets` | Each market's type, and yesterday's close, high and low from Binance's daily candle while the lakehouse doesn't have yesterday yet | Binance |
| `market_events` | Every unusual move since 2020 and the price 1, 4 and 24 hours later | The lakehouse's history file, loaded when Insights opens |
| `market_hours` | The whole market's average move in each hour, by year | The same file |
| `market_outcomes` | How past moves of each kind turned out, with the worst 5% each way | The same file |

How each of these is made, column by column, is in
[Lineage 5](../../lakehouse/docs/lineage/5-definitions-logs-and-serving.md).

## For today's numbers

### `market_now`: each market now

**In one line:** one row per market that is still trading, putting its live price next to its normal.

| It gives | In plain words |
|---|---|
| `market_type` | crypto, stock, commodity or other |
| `price`, `quote_volume_24h` | The price now, and the USDT traded in the last 24 hours |
| `prev_close` | Yesterday's close: the lakehouse's, or Binance's until the lakehouse has published yesterday |
| `avg_return_30d`, `sd_return_30d` | Its average daily move and its normal day (σ) over its last 30 days with trades |
| `history_days` | How many days stand behind those two |
| `avg_quote_volume_30d` | The USDT it trades on an average day |

Markets the lakehouse marks *not trading* (delisted) are left out.

> **Behind the scenes:** version 1. Reads `market_baseline`, `live_prices` and `binance_markets`.

### `today`: today's moves

**In one line:** for every market, today's move, its z, its bad day, how busy it is and its liquidity group.

| It gives | How |
|---|---|
| `move` | price ÷ yesterday's close − 1 |
| `z` | (move − average daily move) ÷ σ. Only with 20 or more days of history and σ above 0; otherwise empty |
| `sd_return_30d` | σ, passed on |
| `bad_day` | average daily move − 1.645 × σ, with the same 20-day rule |
| `volume_x` | USDT traded in the last 24 hours ÷ USDT on an average day |
| `liquidity` | `large` from 100,000,000 USDT a day, `mid` from 10,000,000, else `small` |

> **Behind the scenes:** version 2. Reads `market_now`.

### `flagged`: unusual moves

**In one line:** only the markets that are unusual right now, with their kind of move.

| It gives | How |
|---|---|
| Everything in `today` | For the markets with \|z\| ≥ 3 |
| `direction` | `up` when z is above 0, else `down` |
| `z_band` | \|z\| under 4 → `3-4`; under 6 → `4-6`; else `6+` |
| `tested` | 1 for crypto and other markets, 0 for stocks and commodities (no 2020–2024 years) |

> **Behind the scenes:** version 2. Reads `today`. This is the one place the "3σ" rule lives on the page; change it
> here (in a preview) and every number that reads `flagged` follows.

### `ranges`: each market's range

**In one line:** each market's 3-day ceiling and floor, its usual range, and its price now.

| It gives | How |
|---|---|
| `range_top` | The highest price of its last 3 trading days. If the lakehouse already has yesterday: from its last 3 days. If not: the higher of its last 2 days' high and yesterday's high from Binance |
| `range_bottom` | The lowest price, the same way |
| `usual_range` | Its average 3-day range over its last 30 days (top ÷ bottom − 1) |
| `volume_x`, `history_days`, `price` | As in `today` and `market_now` |

> **Behind the scenes:** version 1. Reads `market_now`, `market_baseline` and `binance_markets`.

### `verdicts`: verdicts in words

**In one line:** one row per kind of move, with its verdict for the next 1, 4 and 24 hours written as words.

A verdict that **held up** is written as its bet and what it made from 2025 after fees, for example
`fade 0.22%`. Any other verdict is written as it is: `did not hold`, `no pattern` or `too few`.

> **Behind the scenes:** version 1. Reads `market_evidence`. For a held-up verdict:
> side || ' ' || ROUND(100 × held_back_net_after_cost, 2) || '%'.

## For the history (Insights and the windows)

### `moves`: past moves

**In one line:** every past unusual move since 2020 of the type and direction chosen at the top, with what it did
over the hours chosen.

| It gives | How |
|---|---|
| `kept_going_pct` | The price change over the next 1, 4 or 24 hours (4 when none is chosen), in %, turned to the move's direction: + kept going, − turned back |
| `bucket` | The 1% step it falls in: `kept_going_pct` rounded down to a whole number. Everything below −10 goes in −11, everything from 10 up in 10 |
| `year`, `hour_of_day` | The year and the UTC hour the move became unusual |
| `z`, `z_band`, `liquidity`, `period`, `symbol`, `market_type`, `event_date`, `event_hour` | As recorded by the lakehouse |

Moves without a result (the market stopped trading, or the data ends) are left out.

> **Behind the scenes:** version 5. Reads `market_events`. kept_going_pct = 100 × (+1 for up, −1 for down) ×
> the forward return over the hours chosen.

### `moves_picked`: the moves picked

**In one line:** `moves`, narrowed down to what was clicked.

It keeps the moves that match every choice that was made: a year, an hour, a 1% step, a size band, a liquidity
group, one market, or the worst-5% line (at least so far, or at most so far). A choice that wasn't made doesn't
narrow anything.

> **Behind the scenes:** version 3. Reads `moves`.

### `hour_stats`: the market by hour

**In one line:** for each hour of the day, each liquidity group and each period (2020–2024, from 2025), the whole
market's average move in that hour, with how much it varies.

The lakehouse keeps, for each year, the number of days, the sum of the moves and the sum of the squared moves. That
lets the years be added together exactly:

```
days     = the days added up
average  = the sums of the moves added up ÷ days
spread   = √( (sum of squares − sum × sum ÷ days) ÷ (days − 1) )
```

*Example:* in one year the 10:00 hour rose by 1 bp on average over 366 days, so its moves add up to +366 bp. The
next year, over 365 days, they add up to −183 bp. Together: 731 days, and an average of (366 − 183) ÷ 731 =
**+0.25 bp**, a quarter of a hundredth of a percent. Averaging the two yearly averages (+1 and −0.5) would give the
same answer here only because the years have nearly the same number of days; the sums are always exact.

> **Behind the scenes:** version 2. Reads `market_hours` for the type chosen (`all` when *All* is chosen).

### `past_kinds`: past moves by kind

**In one line:** for each type of market and kind of move: how many moves there were, on how many days, and what
they did next, over all years and from 2025 only.

| It gives | In plain words |
|---|---|
| `moves`, `days` | How many moves of this kind, and on how many days (for the hours chosen) |
| `next_1h`, `next_4h`, `next_24h` | The middle result after 1, 4 and 24 hours, in % |
| `kept_going_share` | How often they kept going over the hours chosen, in % |
| `worst_kept_going` | 1 move in 20 kept going at least this far (the 95th percentile) |
| `worst_turned_back` | 1 move in 20 turned back at least this far (the 5th percentile) |
| `period` | `all` (every year) or `held_back` (from 2025) |

Each result stays empty with fewer than 20 days behind it. The lakehouse works out the middle results and the worst
5% once a day, because sorting about 21,000 moves every second would slow the page down.

> **Behind the scenes:** version 2. Reads `market_outcomes`.

### `past_own`: each market's own past moves

**In one line:** for each market that is unusual right now, how many unusual moves it has had before, in each
direction, and what the middle one did over the hours chosen.

The middle result is shown from 5 moves on. The type is kept with each move because a ticker can change hands: a
symbol that was a coin can later become a stock.

> **Behind the scenes:** version 1. Reads `market_events` and `flagged`. Only the markets unusual now are looked up,
> because this runs every second.
