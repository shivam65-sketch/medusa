# Risk research

The tests behind the Risk page, run in November 2026. The question: can a strategy that works only some of
the time be made profitable with risk management, such as Kelly, or size that follows a season?

**The short answer:** risk management changes how far an account falls. It doesn't create an edge. On crypto
nothing seasonal held up. One simple trend rule came close, and it is what the Risk page is built around.

## How everything was tested

- **Choose, then check.** A rule is chosen on the earlier years and checked on later years that played no
  part in choosing it. Crypto: 2020–2024, then 2025 on. Indian futures: 2008–2019, then 2020 on.
- **Pass mark.** t of 2 or more in both periods, the same way round, after costs. t measures how unlikely a
  result is to be luck.
- **Rules first.** Rules and costs were fixed before the results were seen.
- **Real costs.** Crypto pays 0.10% a round trip and each coin's real funding. Thinner coins pay 0.20%, and
  scalping pays 0.12%. Indian futures pay today's taxes and fees: 0.08% on the indices and 0.15% on stocks, and
  the same again at each monthly roll.
- **A luck check on wide searches.** Of the mixes good on the earlier years, about 1 in 44 would reach t 2
  afterwards by chance.
- **Nothing that uses the future.** Delisted coins and stocks are included, and every decision uses
  yesterday's data.

## Crypto

| Idea | 2020–2024 | From 2025 | Result |
|---|---|---|---|
| **Half BTC, half ETH, each above its 50-day average** | +57% a year, t 2.5 | +33% a year, t 1.4 | Closest; not proven |
| Holding half BTC, half ETH | +54% a year | −16% a year | Comparison |
| BTC funding collected: long spot, short perpetual | +14% a year | +4% a year | Passes, but small and shrinking |
| Holding BTC only in November to April | +50% a year, t 2.2 | −15% a year, t −0.6 | Fails |
| Holding BTC only at the turn of the month | +21% a year, t 1.8 | −6% a year, t −0.4 | Fails |
| Trading 21–23 UTC, BTC | −7% a year | −20% a year | Fails |
| 28-day momentum, top 30 coins, long only | +33% a year | −67% a year | Fails |
| Turtle breakout, 30 futures | +663R, t 3.2 | −109R, t −1.1 | Fails from 2025 |
| Memecoins above their 50-day average | +61% a year, t 1.3 | −4% a year, t 0.2 | Fails; cuts the losses of holding |

From July 2020 the trend rule grew money 12.6 times against 4.9 for holding, and its worst fall was 56%
against 77%. It trails holding in strong years and loses less in bad ones. It trades about 10 round trips a
year per coin. It hasn't passed, because from 2025 there are only 22 months.

**The memecoin list** is Binance's own Meme tag (55 coins, including some delisted) and three delisted
memecoins the tag misses. The trend rule cut holding's loss of 48% a year to 4%, but made no profit.

### Seasons and months

The months that were best to 2024 were not the best afterwards. On the trend rule, the months' order from one
period to the next has a correlation of −0.47. Every test of season gave the same result, and 12 season splits on
shorting after up moves all failed. Taking 3:1 trades in season and 1.5:1 at half size off season
didn't fix it: t −0.1, then 1.0. In one test the four best months of 2020–2024 made +5R from 2025, and the other
eight made +55R.

### Shorting after unusual up moves

A search of 3,360 mixes found 15 that passed, where luck would give about 1. They didn't survive reality:

- A short pays funding: −0.27% a trade on average over 24 hours, and up to −28.7% on one trade.
- Those results averaged each day's moves, which needs to know how many moves a day will bring. With every
  trade the same size, t is 0.0 and −0.1.
- Any stop kills the result, and the price once rose 436% in 24 hours.
- Skipping shorts that were already paying funding didn't rescue it.

This matters for the Patterns view: its verdicts count trading costs but not funding, and it now says so.

### Scalping

22 methods on 1-minute candles for BTC, ETH, SOL, XRP, BNB and DOGE, 2021 to September 2026: 132 tests.

| Costs a round trip | Good on 2021–2024 | Also from 2025 |
|---|---|---|
| Market orders, 0.12% | 0 | 0 |
| Limit orders, 0.04% | 1 | 0 |

Most methods made 0.00–0.02% a trade before costs. Order-book scalping wasn't tested.

## Risk methods on the trend rule

| Method | Money grew | Worst fall | A year, from 2025 |
|---|---|---|---|
| Full size | 12.6x | −56% | +33% |
| Volatility target of 40% | 9.5x | −50% | +30% |
| Quarter Kelly | 5.6x | −40% | +21% |
| Half size after a 15% fall | 4.8x | −43% | +18% |

Each one gave up return for a smaller fall. Half Kelly came out at the same size as full size here, because the
test uses no leverage. On an idea with no edge Kelly gives about zero: on the shorts above, 0.02% of the account.
The drawdown cut gave up the most for the least, so the Risk page leaves it out.

## Indian futures

Nifty, Bank Nifty and 543 stock futures, January 2007 to October 2026, from NSE's own files. Futures prices
already hold the premium, so these returns are on top of interest on cash, which isn't counted.

| Idea | 2008–2019 | From 2020 | Result |
|---|---|---|---|
| **Half trend, half turn of month** | +5.3% a year, t 1.9 | +6.1% a year, t 2.1 | Closest; just misses |
| Half Nifty, half Bank Nifty above their 50-day average | +5.1% a year, t 1.4 | +6.7% a year, t 1.7 | Somewhat works |
| Turn of month, 28th to 3rd | +4.9% a year, t 1.7 | +5.1% a year, t 1.7 | Somewhat works |
| Every stock future above its 50-day average | +3.0% a year, t 1.0 | +8.5% a year, t 2.3 | Weak early |
| Holding both indices | +3.5% a year | +2.8% a year | Comparison |
| Best 4 months | +10.1% a year, t 2.5 | −4.5% a year, t −0.6 | Fails |
| Turtle, top 30 stock futures, daily | −3R | −19R | Fails |
| Unusual moves, 2,160 mixes | 39 looked good | 0 held up | Fails |

Momentum, low volatility, reversal, skewness, basis momentum, open interest and the futures premium, as long
and short portfolios, all failed. The turn of the month made money in 14 of 19 years, and holding on every other
day lost money in both periods.

**The recent years are weaker than the table shows.** "From 2020" includes strong years. On its own, the turn of
the month lost money in both 2025 (−3.5%) and 2026 (−5.4%), and the index trend rule made +8.9%, then lost 5.8%.

**Held together.** Crypto trend, Indian index trend, turn of month and Indian stock trend barely move together
(correlation under 0.1 between crypto and India). Held at equal risk, Sharpe was 1.64 to 2024 and 1.27 on the
whole period, higher than any one of them. But from 2025 the mix made about nothing: t −0.1, with only crypto
trend still positive. The rules were picked after seeing their results, so this shows the size of the effect,
not proof. Doubling the size doubled the falls and added nothing from 2025.

**Size following a pattern** helped here, the only place it did in both periods. In an uptrend, half size
normally and full size at the turn of the month gave t 1.7 and 1.9 against 1.4 and 1.7 for plain trend, and worst
falls of 22% and 9% against 41% and 17%. It needs a pattern that repeats, and months don't: correlation −0.01.

## Other markets

| Market | Tested | Passed |
|---|---|---|
| S&P 500, Nasdaq, DAX, gold, 4 currency pairs, 2019–2026, 15-minute and daily | 21 methods, 163 tests | 0 |
| VIX futures, 2013–2026 | 5 rules | 0 |
| WTI and natural gas futures, to April 2024 | 16 rules | 0 |
| 9 major and 14 emerging currencies, 1999–2026 | 12 rules | 0 |

## Published strategies after publication

AQR's public monthly returns cover about 60 global futures and forward markets, before trading costs. Of 53
series, 45 were strong before 2013 and only 6 stayed strong after. Those 6 are mostly stock-picking or simply
owning stocks.

| Strategy | Sharpe before 2013 | Sharpe from 2013 |
|---|---|---|
| Time-series momentum | 1.28 | 0.41 |
| Macro multi-style | 0.92 | 0.26 |
| Macro carry | 0.61 | −0.13 |

## Limits

- 2025 on and 2020 on have now been looked at, so only new days can prove any of this.
- Taxes aren't counted, and CoinDCX's fees may differ from those used.
- MCX, Asian indices, and US grains, metals and bonds directly weren't tested: their data isn't free for
  scripts or doesn't reach the present. Hedging pressure wasn't tested either.
- Outside crypto, 15-minute candles were the finest data, so true scalping wasn't tested there.
- The memecoin list leans towards survivors: a delisted coin that was never tagged could be missing.

The first energy test showed WTI carry passing. That came from a contract-roll error: it found 28 rolls a year
instead of 12. Rebuilt on the exchange's expiry rules, carry is t 2.4 and 1.1 and doesn't pass.
