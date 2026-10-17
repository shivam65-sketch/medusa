import numpy as np

from indicators import atr, crossed_above, crossed_below, highest, lowest, shift
from strategy import WILDER, WINDOW, Param, Strategy


class Ichimoku(Strategy):
    key = "ichimoku"
    order = 245
    group = "swing"
    label = "Ichimoku cloud (Hosoda)"
    description = ("Goichi Hosoda's Ichimoku Kinko Hyo, a crypto favourite: long when the conversion line (Tenkan) crosses "
                   "above the base line (Kijun) while the price is above the cloud; short in the mirror case. Exit when a "
                   "candle closes back across the base line. Standard settings 9 / 26 / 52.")
    params = [
        Param("tenkan", "Conversion line (candles)", 9, 2, 200, 1, unit="candles", warmup=WINDOW),
        Param("kijun", "Base line (candles)", 26, 2, 400, 1, unit="candles", warmup=WINDOW),
        Param("senkou", "Leading span B (candles)", 52, 2, 800, 1, unit="candles", warmup=WINDOW),
        Param("stop_atr", "Stop (x ATR, 0 = none)", 0.0, 0, 20, 0.1),
        Param("atr_len", "ATR length", 14, 2, 200, 1, unit="candles"),
    ]

    def warmup(self, interval_ms):
        p = self.p                                       # the cloud: span B (senkou) drawn kijun candles ahead
        return max(p.kijun + p.senkou, p.tenkan, WILDER * p.atr_len if p.stop_atr else 0) + 1

    def prepare(self, d):
        p = self.p
        self.c = d.c
        mid = lambda k: (highest(d.h, k) + lowest(d.l, k)) / 2
        self.tk, self.kj = mid(p.tenkan), mid(p.kijun)
        a, b = shift((self.tk + self.kj) / 2, p.kijun), shift(mid(p.senkou), p.kijun)   # the cloud plotted ahead: today's was set kijun candles ago
        self.top, self.bot = np.maximum(a, b), np.minimum(a, b)          # NaN until both spans exist
        self.up, self.dn = crossed_above(self.tk, self.kj), crossed_below(self.tk, self.kj)
        self.atr = atr(d.h, d.l, d.c, p.atr_len)

    def on_bar(self, i, pos, orders):
        p, c = self.p, self.c[i]
        if pos is not None:
            if (pos.side > 0 and c < self.kj[i]) or (pos.side < 0 and c > self.kj[i]):
                orders.exit("Closed across the base line")
            return
        if not (np.isfinite(self.top[i]) and np.isfinite(self.bot[i])):
            return
        side = 1 if self.up[i] and c > self.top[i] else -1 if self.dn[i] and c < self.bot[i] else 0
        if side and self.allows(side):
            kw = {"stop_dist": p.stop_atr * self.atr[i]} if p.stop_atr and np.isfinite(self.atr[i]) else {}
            (orders.buy if side > 0 else orders.sell)(tag="Cross above the cloud" if side > 0 else "Cross below the cloud", **kw)
