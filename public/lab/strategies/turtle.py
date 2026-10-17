from indicators import atr, highest, lowest, shift
from strategy import WILDER, WINDOW, Param, Strategy


class Turtle(Strategy):
    key = "turtle"
    order = 20
    group = "classic"
    label = "Turtle breakout (trend following)"
    description = ("Long when a candle closes above the highest high of the previous N candles, short below the lowest "
                   "low. Exit when the close breaks the opposite M-candle extreme, or at the ATR stop. No new trade on "
                   "the candle a trade closes. The only rule set in this project that passed a held-back test "
                   "(4h, 20/10, 2 ATR, on a wide basket of futures).")
    params = [
        Param("entry_len", "Breakout length (candles)", 20, 2, 500, 1, unit="candles", warmup=WINDOW),
        Param("exit_len", "Exit length (candles)", 10, 2, 500, 1, unit="candles", warmup=WINDOW),
        Param("atr_len", "ATR length", 20, 2, 200, 1, unit="candles", warmup=WILDER),
        Param("stop_atr", "Stop (x ATR)", 2.0, 0.1, 20, 0.1),
    ]

    def prepare(self, d):
        p = self.p
        self.c = d.c
        self.hi_in, self.lo_in = shift(highest(d.h, p.entry_len)), shift(lowest(d.l, p.entry_len))
        self.hi_out, self.lo_out = shift(highest(d.h, p.exit_len)), shift(lowest(d.l, p.exit_len))
        self.atr = atr(d.h, d.l, d.c, p.atr_len, smoothing="wilder")

    def on_bar(self, i, pos, orders):
        p, c = self.p, self.c[i]
        if i <= max(p.entry_len, p.atr_len):
            return
        if pos is not None:
            if (pos.side > 0 and c < self.lo_out[i]) or (pos.side < 0 and c > self.hi_out[i]):
                orders.exit("Channel exit")
            return
        if orders.last_exit_i == i:
            return
        side = 1 if c > self.hi_in[i] else -1 if c < self.lo_in[i] else 0
        if side and self.allows(side):
            (orders.buy if side > 0 else orders.sell)(stop_dist=p.stop_atr * self.atr[i], tag="Breakout up" if side > 0 else "Breakout down")
