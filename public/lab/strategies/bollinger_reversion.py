import numpy as np

from indicators import atr, bollinger
from strategy import WILDER, WINDOW, Param, Strategy


class BollingerReversion(Strategy):
    key = "bollinger_reversion"
    order = 50
    group = "classic"
    label = "Bollinger band reversion"
    description = ("Long when a candle closes back inside the lower band after closing below it, short when it closes "
                   "back inside the upper band. Exit at the middle band (the average), at the ATR stop, or after a set "
                   "number of candles.")
    params = [
        Param("length", "Band length", 20, 2, 500, 1, unit="candles", warmup=WINDOW),
        Param("width", "Band width (standard deviations)", 2.0, 0.5, 5, 0.1),
        Param("atr_len", "ATR length", 14, 2, 200, 1, unit="candles", warmup=WILDER),
        Param("stop_atr", "Stop (x ATR)", 2.0, 0.1, 20, 0.1),
        Param("max_bars", "Time exit after candles (0 = none)", 0, 0, 5000, 1, unit="candles"),
    ]

    def prepare(self, d):
        p = self.p
        self.mid, self.up, self.lo = bollinger(d.c, p.length, p.width)
        self.c = d.c
        self.atr = atr(d.h, d.l, d.c, p.atr_len)

    def on_bar(self, i, pos, orders):
        p, c = self.p, self.c
        if i < max(p.length, p.atr_len) + 1 or not np.isfinite(self.lo[i - 1]):
            return
        if pos is not None:
            if (pos.side > 0 and c[i] >= self.mid[i]) or (pos.side < 0 and c[i] <= self.mid[i]):
                orders.exit("Back to the average")
            return
        side = 0
        if c[i - 1] < self.lo[i - 1] and c[i] > self.lo[i]:
            side = 1
        elif c[i - 1] > self.up[i - 1] and c[i] < self.up[i]:
            side = -1
        if side and self.allows(side):
            (orders.buy if side > 0 else orders.sell)(stop_dist=p.stop_atr * self.atr[i], max_bars=p.max_bars or None,
                                                     tag="Back inside lower band" if side > 0 else "Back inside upper band")
