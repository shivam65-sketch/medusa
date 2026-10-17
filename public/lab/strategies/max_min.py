import numpy as np

from indicators import highest, lowest
from strategy import WINDOW, Param, Strategy


class MaxMin(Strategy):
    key = "max_min"
    order = 230
    group = "swing"
    label = "Bitcoin 10-day high / low (Quantpedia MAX/MIN)"
    description = ("Quantpedia's Bitcoin study (Padyšák & Vojtko 2022, re-checked in 2024): buy when the close is the "
                   "highest of the last 10 candles (trend) or the lowest (bounce), hold one candle, and stay in while the "
                   "signal repeats. Long only, as in the study. Built for daily candles.")
    directions = False
    params = [
        Param("lookback", "Lookback (candles)", 10, 2, 500, 1, unit="candles", warmup=WINDOW),
        Param("mode", "Buy at", "both", choices=[["both", "A new high or a new low (MAX + MIN)"], ["max", "A new high only (MAX, trend)"],
                                                 ["min", "A new low only (MIN, bounce)"]]),
        Param("hold", "Hold (candles after the last signal)", 1, 1, 100, 1, unit="candles"),
    ]

    def prepare(self, d):
        p = self.p
        self.at_max = d.c >= highest(d.c, p.lookback)
        self.at_min = d.c <= lowest(d.c, p.lookback)
        self.last_sig = None

    def on_bar(self, i, pos, orders):
        p = self.p
        top = self.at_max[i] and p.mode in ("both", "max")
        bottom = self.at_min[i] and p.mode in ("both", "min")
        if top or bottom:
            self.last_sig = i
            if pos is None:
                orders.buy(tag=f"Close at a {p.lookback}-candle {'high' if top else 'low'}")
        elif pos is not None and (self.last_sig is None or i - self.last_sig >= p.hold):
            orders.exit(f"Held {p.hold} candle{'s' if p.hold > 1 else ''}")
