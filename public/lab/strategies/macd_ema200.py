import numpy as np

from indicators import crossed_above, crossed_below, ema, lowest, highest, macd
from strategy import EMA, WINDOW, Param, Strategy


class MacdEma200(Strategy):
    key = "macd_ema200"
    order = 150
    group = "intraday"
    label = "MACD + 200 EMA (Trading Rush)"
    description = ("The famous YouTube test ('MACD strategy tested 100 times', Trading Rush): long when the price is above "
                   "the 200 EMA and the MACD line crosses up through its signal line below zero; short in the mirror case. "
                   "Stop at the 200 EMA (or the recent swing), target 1.5x the risk. Shown on 15m and 30m charts.")
    params = [
        Param("fast", "MACD fast EMA", 12, 2, 200, 1, unit="candles", warmup=EMA),
        Param("slow", "MACD slow EMA", 26, 3, 400, 1, unit="candles", warmup=EMA),
        Param("signal", "MACD signal EMA", 9, 2, 200, 1, unit="candles", warmup=EMA),
        Param("trend", "Trend EMA", 200, 10, 1000, 1, unit="candles", warmup=EMA),
        Param("stop_at", "Stop", "ema", choices=[["ema", "At the trend EMA"], ["swing", "Beyond the recent swing (lowest low / highest high)"]]),
        Param("swing_len", "Swing length (candles)", 10, 2, 200, 1, unit="candles", warmup=WINDOW),
        Param("target_r", "Target (x the risk)", 1.5, 0.1, 20, 0.1),
    ]

    def warmup(self, interval_ms):
        p = self.p
        return max(EMA * (p.slow + p.signal), EMA * p.trend, p.swing_len) + 1

    def prepare(self, d):
        p = self.p
        self.c = d.c
        self.trend = ema(d.c, p.trend)
        self.m, self.s, _ = macd(d.c, p.fast, p.slow, p.signal)
        self.up, self.dn = crossed_above(self.m, self.s), crossed_below(self.m, self.s)
        self.lo, self.hi = lowest(d.l, p.swing_len), highest(d.h, p.swing_len)

    def on_bar(self, i, pos, orders):
        p, c = self.p, self.c[i]
        if pos is not None or i < max(p.trend, p.slow + p.signal):
            return
        side = 0
        if self.up[i] and self.m[i] < 0 and self.s[i] < 0 and c > self.trend[i]:
            side = 1
        elif self.dn[i] and self.m[i] > 0 and self.s[i] > 0 and c < self.trend[i]:
            side = -1
        if not side or not self.allows(side):
            return
        stop = self.trend[i] if p.stop_at == "ema" else (self.lo[i] if side > 0 else self.hi[i])
        if np.isfinite(stop) and (c - stop) * side > 0:
            (orders.buy if side > 0 else orders.sell)(stop=stop, target_r=p.target_r,
                                                     tag="MACD up, above the EMA" if side > 0 else "MACD down, below the EMA")
