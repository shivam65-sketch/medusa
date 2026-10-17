import numpy as np

from indicators import atr, crossed_above, crossed_below, ema, rsi
from strategy import EMA, WILDER, Param, Strategy


class RsiReversal(Strategy):
    key = "rsi_reversal"
    order = 30
    group = "classic"
    label = "RSI reversal"
    description = ("Long when RSI comes back up through the oversold level, short when it comes back down through the "
                   "overbought level. Exit when RSI reaches the middle (or the other level), at the ATR stop, or after "
                   "a set number of candles. Optional trend filter: longs only above the EMA, shorts only below.")
    params = [
        Param("rsi_len", "RSI length", 14, 2, 200, 1, unit="candles", warmup=WILDER),
        Param("lower", "Oversold level", 30.0, 1, 50, 1),
        Param("upper", "Overbought level", 70.0, 50, 99, 1),
        Param("exit_at", "Exit when RSI reaches", "middle", choices=[["middle", "50"], ["other", "The opposite level"]]),
        Param("atr_len", "ATR length", 14, 2, 200, 1, unit="candles", warmup=WILDER),
        Param("stop_atr", "Stop (x ATR)", 2.0, 0.1, 20, 0.1),
        Param("max_bars", "Time exit after candles (0 = none)", 0, 0, 5000, 1, unit="candles"),
        Param("trend_ema", "Trend filter EMA (0 = off)", 0, 0, 1000, 1, unit="candles", warmup=EMA),
    ]

    def prepare(self, d):
        p = self.p
        self.r = rsi(d.c, p.rsi_len)
        self.up, self.dn = crossed_above(self.r, p.lower), crossed_below(self.r, p.upper)
        self.atr = atr(d.h, d.l, d.c, p.atr_len)
        self.c = d.c
        self.trend = ema(d.c, p.trend_ema) if p.trend_ema else None

    def on_bar(self, i, pos, orders):
        p, r = self.p, self.r[i]
        if not np.isfinite(r) or i < p.atr_len or (p.trend_ema and i < p.trend_ema):
            return
        if pos is not None:
            done = (50 if p.exit_at == "middle" else p.upper) if pos.side > 0 else (50 if p.exit_at == "middle" else p.lower)
            if (pos.side > 0 and r >= done) or (pos.side < 0 and r <= done):
                orders.exit("RSI target")
            return
        side = 1 if self.up[i] else -1 if self.dn[i] else 0
        if self.trend is not None and side:
            if (side > 0 and self.c[i] < self.trend[i]) or (side < 0 and self.c[i] > self.trend[i]):
                side = 0
        if side and self.allows(side):
            (orders.buy if side > 0 else orders.sell)(stop_dist=p.stop_atr * self.atr[i], max_bars=p.max_bars or None,
                                                     tag="RSI up" if side > 0 else "RSI down")
