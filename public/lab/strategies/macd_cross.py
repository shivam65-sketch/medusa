from indicators import atr, crossed_above, crossed_below, macd
from strategy import EMA, WILDER, Param, Strategy


class MacdCross(Strategy):
    key = "macd_cross"
    order = 40
    group = "classic"
    label = "MACD crossover"
    description = ("Long when the MACD line crosses above its signal line, short when it crosses below; the trade is "
                   "reversed on the opposite cross. Optional zero-line filter: longs only when MACD is below zero "
                   "(buying a dip), shorts only above. ATR stop.")
    params = [
        Param("fast", "Fast EMA", 12, 2, 200, 1, unit="candles", warmup=EMA),
        Param("slow", "Slow EMA", 26, 3, 400, 1, unit="candles", warmup=EMA),
        Param("signal", "Signal EMA", 9, 2, 200, 1, unit="candles", warmup=EMA),
        Param("zero_filter", "Zero-line filter", False),
        Param("atr_len", "ATR length", 14, 2, 200, 1, unit="candles", warmup=WILDER),
        Param("stop_atr", "Stop (x ATR, 0 = none)", 3.0, 0, 20, 0.1),
    ]

    def warmup(self, interval_ms):
        p = self.p                                       # the signal line is an EMA of the MACD line: both must settle
        return max(EMA * (p.slow + p.signal), WILDER * p.atr_len if p.stop_atr else 0) + 1

    def prepare(self, d):
        p = self.p
        self.m, self.s, _ = macd(d.c, p.fast, p.slow, p.signal)
        self.up, self.dn = crossed_above(self.m, self.s), crossed_below(self.m, self.s)
        self.atr = atr(d.h, d.l, d.c, p.atr_len)

    def on_bar(self, i, pos, orders):
        p = self.p
        if i < p.slow + p.signal:
            return
        side = 1 if self.up[i] else -1 if self.dn[i] else 0
        if p.zero_filter and side and ((side > 0 and self.m[i] > 0) or (side < 0 and self.m[i] < 0)):
            side = 0
        if not side:
            return
        if pos is not None:
            if pos.side == side:
                return
            orders.exit("Opposite cross")
        if self.allows(side):
            kw = {"tag": "MACD up" if side > 0 else "MACD down"}
            if p.stop_atr:
                kw["stop_dist"] = p.stop_atr * self.atr[i]
            (orders.buy if side > 0 else orders.sell)(**kw)
