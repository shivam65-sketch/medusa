"""My strategy: a moving-average trend follower, as a starting point.

Buys when the close is above the long moving average AND the short average has just crossed above
it; sells short in the mirror case. The stop is a multiple of ATR (the coin's normal candle range),
the target is a multiple of that stop, and a trade is closed after `max_bars` candles at the latest.

This text (the file's first string) is shown in Lab -> Strategy guide for your strategy. Describe the idea,
the rules and why you expect them to work.

HOW A STRATEGY WORKS
  prepare(d)                  runs once. Compute every indicator for the whole history here, from
                              d.o d.h d.l d.c d.v (open, high, low, close, volume arrays) and d.t (times, ms).
  on_bar(i, pos, orders)      runs at the CLOSE of every candle i. Look only at index i and earlier
                              (never i + 1): "Check" tests this. pos is the open position or None.
  orders.buy(...) / orders.sell(...)     enter long / short at the next candle's open
  orders.exit("why")                     close the open position at the next open
  orders.buy_stop(price, valid=n) ...    enter if the price trades through `price` in the next n candles
  orders.buy_limit / sell_stop / sell_limit work the same way
  orders.set_stop(price) / orders.set_target(price)    move the open position's stop or target
  Entry options: stop=price or stop_dist=distance, target=price or target_r=multiple of the stop
  distance, max_bars=n (time exit), tag="text" (shown in the trade list).
  pos.side (1 long, -1 short), pos.entry_px, pos.entry_i, pos.stop, pos.target; orders.last_exit_i.
  self.p.<key> holds each setting's value; self.allows(side) respects the "Trade direction" setting.

INDICATORS (from indicators import ...): ema sma rma stdev highest lowest shift true_range atr rsi
macd bollinger crossed_above crossed_below linreg keltner supertrend, and for intraday ideas
session_ids session_clock session_vwap (a "session" is a 24-hour day from a chosen UTC hour). Each
returns an array as long as the candles, NaN where it can't be computed yet. numpy is available as np.
Futures data downloaded with funding rates also has d.extra["funding_t"] and d.extra["funding_r"].
print() output shows under the report.
"""
import numpy as np

from indicators import atr, crossed_above, crossed_below, sma
from strategy import Param, Strategy


class MyStrategy(Strategy):
    key = "my_trend"                      # unique within this file; letters, digits, _
    label = "My trend follower"           # the name shown in the Lab
    description = "Short SMA crosses the long SMA in the direction of the trend; ATR stop, target and time exit."
    params = [                            # key, label, default, min, max, step (the form is built from these)
        Param("fast", "Short average (candles)", 20, 2, 500, 1),
        Param("slow", "Long average (candles)", 100, 5, 2000, 1),
        Param("atr_len", "ATR length", 14, 2, 200, 1),
        Param("stop_atr", "Stop (x ATR)", 2.0, 0.1, 20, 0.1),
        Param("target_r", "Target (x the stop, 0 = none)", 3.0, 0, 50, 0.1),
        Param("max_bars", "Time exit after candles (0 = none)", 100, 0, 5000, 1),
    ]

    def prepare(self, d):
        p = self.p
        self.c = d.c
        self.fast = sma(d.c, p.fast)
        self.slow = sma(d.c, p.slow)
        self.up = crossed_above(self.fast, self.slow)
        self.down = crossed_below(self.fast, self.slow)
        self.atr = atr(d.h, d.l, d.c, p.atr_len)

    def on_bar(self, i, pos, orders):
        p = self.p
        if i < p.slow or not np.isfinite(self.atr[i]):
            return                                         # indicators not ready yet
        if pos is not None:
            # Already in a trade: leave on the opposite cross (the stop, target and time exit run by themselves).
            if (pos.side > 0 and self.down[i]) or (pos.side < 0 and self.up[i]):
                orders.exit("Opposite cross")
            return
        kw = dict(stop_dist=p.stop_atr * self.atr[i], max_bars=p.max_bars or None)
        if p.target_r:
            kw["target_r"] = p.target_r
        if self.up[i] and self.allows(1):
            orders.buy(tag="Cross up", **kw)
        elif self.down[i] and self.allows(-1):
            orders.sell(tag="Cross down", **kw)
