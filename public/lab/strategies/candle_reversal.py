from strategy import Param, Strategy


class CandleReversal(Strategy):
    key = "candle_reversal"
    order = 140
    group = "intraday"
    label = "Fade the last candle (15-minute reversal)"
    description = ("Bet against the previous candle: after a green candle be short for the next one, after a red candle be "
                   "long; stay in while the signal repeats. Kitron & Wengrowicz (2026) found this reversal in 90% of 183 "
                   "Binance pairs on 15-minute candles, but only about 0.013% per trade before costs. Use 1m to 1h candles.")
    params = [
        Param("min_move_pct", "Only fade candles that moved at least (%)", 0.0, 0, 20, 0.01,
              help="Smaller candles: no position"),
    ]

    def prepare(self, d):
        self.o, self.c = d.o, d.c

    def on_bar(self, i, pos, orders):
        move = (self.c[i] / self.o[i] - 1) * 100
        want = -1 if move > 0 else 1 if move < 0 else 0
        if abs(move) < self.p.min_move_pct or not self.allows(want):
            want = 0
        if pos is not None:
            if pos.side == want:
                return
            orders.exit("Signal changed")
        if want:
            (orders.buy if want > 0 else orders.sell)(tag="After a red candle" if want > 0 else "After a green candle")
