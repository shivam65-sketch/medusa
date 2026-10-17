import numpy as np

from indicators import supertrend
from strategy import WILDER, Param, Strategy


class Supertrend(Strategy):
    key = "supertrend"
    order = 145
    group = "intraday"
    label = "Supertrend (Seban)"
    description = ("Olivier Seban's Supertrend: an ATR band that trails the price and flips side when a candle closes "
                   "through it. Long when it flips under the price, short when it flips above; always in the market (as "
                   "TradingView's built-in Supertrend strategy). One of the most used crypto indicators, on any timeframe.")
    params = [
        Param("atr_len", "ATR length", 10, 2, 200, 1, unit="candles", warmup=WILDER),
        Param("mult", "Band (x ATR)", 3.0, 0.5, 20, 0.1),
        Param("line_stop", "Also use the line as a stop inside the candle", False,
              help="Off = exit only when a candle closes through the line (the classic rule)"),
    ]

    def prepare(self, d):
        p = self.p
        self.line, self.trend = supertrend(d.h, d.l, d.c, p.atr_len, p.mult)

    def on_bar(self, i, pos, orders):
        if i < 1 or not self.trend[i] or not self.trend[i - 1]:
            return
        side = int(self.trend[i])
        if pos is not None:
            if pos.side == side:
                if self.p.line_stop:
                    orders.set_stop(self.line[i])
                return
            orders.exit("Supertrend flipped")
        elif self.trend[i - 1] == side:                    # flat (one direction only): wait for the next flip
            return
        if self.allows(side):
            kw = {"stop": self.line[i]} if self.p.line_stop and np.isfinite(self.line[i]) else {}
            (orders.buy if side > 0 else orders.sell)(tag="Flipped up" if side > 0 else "Flipped down", **kw)
