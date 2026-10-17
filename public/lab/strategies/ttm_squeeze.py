import numpy as np

from indicators import atr, bollinger, highest, keltner, linreg, lowest, sma
from strategy import WILDER, Param, Strategy


class TtmSqueeze(Strategy):
    key = "ttm_squeeze"
    order = 220
    group = "swing"
    label = "TTM Squeeze (John Carter)"
    description = ("John Carter's squeeze: when the Bollinger Bands contract inside the Keltner Channels the market is "
                   "coiling. When they expand back out ('the squeeze fires'), trade in the direction of the momentum "
                   "histogram; exit after two candles of fading momentum or at the ATR stop.")
    params = [
        Param("length", "Length (candles)", 20, 5, 200, 1, unit="candles", warmup=2),
        Param("bb_mult", "Bollinger width (standard deviations)", 2.0, 0.5, 5, 0.1),
        Param("kc_mult", "Keltner width (x average range)", 1.5, 0.5, 5, 0.1),
        Param("min_squeeze", "Squeeze must last at least (candles)", 1, 1, 200, 1),
        Param("atr_len", "ATR length", 20, 2, 200, 1, unit="candles", warmup=WILDER),
        Param("stop_atr", "Stop (x ATR, 0 = none)", 2.0, 0, 20, 0.1),
    ]

    def prepare(self, d):
        p = self.p
        n = len(d.c)
        _, bu, bl = bollinger(d.c, p.length, p.bb_mult)
        _, ku, kl = keltner(d.h, d.l, d.c, p.length, p.kc_mult)
        on = (bu < ku) & (bl > kl)                                  # Bollinger inside Keltner: squeeze
        run = np.zeros(n)
        for i in range(n):                                          # how many candles in a row it has been on
            run[i] = run[i - 1] + 1 if on[i] and i else (1 if on[i] else 0)
        self.fired = np.zeros(n, bool)
        self.fired[1:] = ~on[1:] & (run[:-1] >= p.min_squeeze)
        mid = ((highest(d.h, p.length) + lowest(d.l, p.length)) / 2 + sma(d.c, p.length)) / 2
        self.mom = linreg(d.c - mid, p.length)                      # LazyBear's squeeze momentum histogram
        self.atr = atr(d.h, d.l, d.c, p.atr_len)

    def on_bar(self, i, pos, orders):
        p, m = self.p, self.mom
        if i < 2 or not np.isfinite(m[i - 2]):
            return
        if pos is not None:
            if (pos.side > 0 and m[i] < m[i - 1] < m[i - 2]) or (pos.side < 0 and m[i] > m[i - 1] > m[i - 2]):
                orders.exit("Momentum fading")
            return
        if not self.fired[i]:
            return
        side = 1 if m[i] > 0 else -1 if m[i] < 0 else 0
        if side and self.allows(side):
            kw = {"stop_dist": p.stop_atr * self.atr[i]} if p.stop_atr and np.isfinite(self.atr[i]) else {}
            (orders.buy if side > 0 else orders.sell)(tag="Squeeze fired up" if side > 0 else "Squeeze fired down", **kw)
