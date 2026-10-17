import numpy as np

from indicators import atr, rsi, sma
from strategy import WILDER, WINDOW, Param, Strategy


class ConnorsRsi2(Strategy):
    key = "connors_rsi2"
    order = 215
    group = "swing"
    label = "RSI(2) pullback (Larry Connors)"
    description = ("Larry Connors' short-term mean reversion: in an uptrend (close above the 200-candle average) buy when "
                   "the 2-candle RSI drops below 10, and sell when the close gets back above the 5-candle average. Shorts "
                   "mirror it (RSI above 90 below the 200 average). No stop in the original rules. Built for daily candles.")
    params = [
        Param("rsi_len", "RSI length", 2, 2, 50, 1, unit="candles", warmup=WILDER),
        Param("lower", "Buy below RSI", 10.0, 1, 50, 1),
        Param("upper", "Short above RSI", 90.0, 50, 99, 1),
        Param("trend_len", "Trend filter average (0 = off)", 200, 0, 1000, 1, unit="candles", warmup=WINDOW),
        Param("exit_len", "Exit average", 5, 2, 200, 1, unit="candles", warmup=WINDOW),
        Param("stop_atr", "Stop (x ATR, 0 = none)", 0.0, 0, 20, 0.1),
        Param("atr_len", "ATR length", 14, 2, 200, 1, unit="candles"),
        Param("max_bars", "Time exit after candles (0 = none)", 0, 0, 5000, 1, unit="candles"),
    ]

    def warmup(self, interval_ms):
        p = self.p
        return max(WILDER * p.rsi_len, p.trend_len, p.exit_len, WILDER * p.atr_len if p.stop_atr else 0) + 1

    def prepare(self, d):
        p = self.p
        self.c = d.c
        self.r = rsi(d.c, p.rsi_len)
        self.trend = sma(d.c, p.trend_len) if p.trend_len else None
        self.exit_ma = sma(d.c, p.exit_len)
        self.atr = atr(d.h, d.l, d.c, p.atr_len)

    def on_bar(self, i, pos, orders):
        p, c, r = self.p, self.c[i], self.r[i]
        if pos is not None:
            if (pos.side > 0 and c > self.exit_ma[i]) or (pos.side < 0 and c < self.exit_ma[i]):
                orders.exit("Back across the 5 average")
            return
        if not np.isfinite(r):
            return
        tr = self.trend[i] if self.trend is not None else None
        if tr is not None and not np.isfinite(tr):
            return
        side = 1 if r < p.lower and (tr is None or c > tr) else -1 if r > p.upper and (tr is None or c < tr) else 0
        if side and self.allows(side):
            kw = {"stop_dist": p.stop_atr * self.atr[i]} if p.stop_atr and np.isfinite(self.atr[i]) else {}
            (orders.buy if side > 0 else orders.sell)(max_bars=p.max_bars or None, tag=f"RSI(2) {r:.0f}", **kw)
