import numpy as np

from indicators import atr, crossed_above, crossed_below, ema
from strategy import EMA, Param, Strategy


class EmaCross(Strategy):
    key = "ema_cross"
    order = 10
    group = "classic"
    label = "EMA crossover"
    description = ("Long when the fast EMA crosses above the slow EMA, short when it crosses below. Stop and target are "
                   "multiples of ATR; the trade is closed after a set number of candles if neither is hit. Defaults are "
                   "the demo bot's rules (9/21, 2 ATR stop, 4 ATR target, 24 candles).")
    params = [
        Param("fast", "Fast EMA", 9, 2, 400, 1, unit="candles", warmup=EMA),
        Param("slow", "Slow EMA", 21, 3, 800, 1, unit="candles", warmup=EMA),
        Param("atr_len", "ATR length", 14, 2, 200, 1, unit="candles", warmup=EMA),
        Param("stop_atr", "Stop (x ATR)", 2.0, 0.1, 20, 0.1),
        Param("target_atr", "Target (x ATR, 0 = none)", 4.0, 0, 50, 0.1),
        Param("max_bars", "Time exit after candles (0 = none)", 24, 0, 5000, 1, unit="candles"),
        Param("exit_on_cross", "Also exit on the opposite cross", False),
    ]

    def prepare(self, d):
        p = self.p
        f, s = ema(d.c, p.fast), ema(d.c, p.slow)
        self.fast_ema, self.slow_ema = f, s                             # kept for the Chart tab
        self.up, self.dn = crossed_above(f, s), crossed_below(f, s)
        self.atr = atr(d.h, d.l, d.c, p.atr_len, smoothing="ema")      # the bot smooths ATR with an EMA

    def on_bar(self, i, pos, orders):
        p = self.p
        if i < max(p.slow, p.atr_len):
            return
        side = 1 if self.up[i] else -1 if self.dn[i] else 0
        if pos is not None:
            if p.exit_on_cross and side == -pos.side:
                orders.exit("Opposite cross")
            else:
                return
        if side and self.allows(side) and np.isfinite(self.atr[i]):
            a = self.atr[i]
            kw = dict(stop_dist=p.stop_atr * a, max_bars=p.max_bars or None, tag="Cross up" if side > 0 else "Cross down")
            if p.target_atr:
                kw["target_r"] = p.target_atr / p.stop_atr
            (orders.buy if side > 0 else orders.sell)(**kw)
