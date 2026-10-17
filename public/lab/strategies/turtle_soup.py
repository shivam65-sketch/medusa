import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from strategy import WINDOW, Param, Strategy


class TurtleSoup(Strategy):
    key = "turtle_soup"
    order = 225
    group = "swing"
    label = "Turtle Soup (Raschke & Connors)"
    description = ("Fade the false breakout, from Linda Raschke and Laurence Connors' 'Street Smarts' (1995): when a candle "
                   "makes a new 20-candle low but the previous 20-candle low is at least 4 candles old, buy as soon as the "
                   "price comes back above that old low (shorts mirror it at highs). Stop just beyond the new extreme; "
                   "target 2x the risk or out after 5 candles.")
    params = [
        Param("lookback", "Channel length (candles)", 20, 5, 500, 1, unit="candles", warmup=WINDOW),
        Param("min_age", "Old extreme at least (candles ago)", 4, 1, 100, 1),
        Param("target_r", "Target (x the risk, 0 = none)", 2.0, 0, 20, 0.1),
        Param("max_bars", "Time exit after candles (0 = none)", 5, 0, 5000, 1, unit="candles"),
    ]

    def prepare(self, d):
        p = self.p
        n, L = len(d.c), p.lookback
        self.l, self.h, self.c = d.l, d.h, d.c
        self.old_lo, self.old_hi = np.full(n, np.nan), np.full(n, np.nan)
        self.lo_age, self.hi_age = np.zeros(n), np.zeros(n)
        if n > L:
            wl, wh = sliding_window_view(d.l[:-1], L), sliding_window_view(d.h[:-1], L)   # the L candles before i
            # the most recent candle holding the extreme
            al = L - 1 - np.argmin(wl[:, ::-1], axis=1)
            ah = L - 1 - np.argmax(wh[:, ::-1], axis=1)
            self.old_lo[L:], self.old_hi[L:] = wl.min(axis=1), wh.max(axis=1)
            self.lo_age[L:], self.hi_age[L:] = L - al, L - ah          # candles between that extreme and i

    def on_bar(self, i, pos, orders):
        p = self.p
        if pos is not None or not np.isfinite(self.old_lo[i]):
            return
        kw = dict(max_bars=p.max_bars or None)
        if p.target_r:
            kw["target_r"] = p.target_r
        if self.l[i] < self.old_lo[i] and self.lo_age[i] >= p.min_age and self.allows(1):
            if self.c[i] > self.old_lo[i]:                         # already back above the old low inside this candle
                orders.buy(stop=self.l[i], tag="Back above the old low", **kw)
            else:
                orders.buy_stop(self.old_lo[i], valid=1, stop=self.l[i], tag="Back above the old low", **kw)
        elif self.h[i] > self.old_hi[i] and self.hi_age[i] >= p.min_age and self.allows(-1):
            if self.c[i] < self.old_hi[i]:
                orders.sell(stop=self.h[i], tag="Back below the old high", **kw)
            else:
                orders.sell_stop(self.old_hi[i], valid=1, stop=self.h[i], tag="Back below the old high", **kw)
