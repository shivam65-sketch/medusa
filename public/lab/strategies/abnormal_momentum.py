import numpy as np

from indicators import shift, sma, stdev
from strategy import WINDOW, Param, Strategy


class AbnormalMomentum(Strategy):
    key = "abnormal_momentum"
    order = 235
    group = "swing"
    label = "Follow an abnormal day (Caporale & Plastun)"
    description = ("Caporale & Plastun (2020) found that after a day with an abnormally large move, Bitcoin, Ethereum and "
                   "Litecoin tend to keep moving the same way the next day. A day is abnormal when its return is beyond "
                   "the average ± k standard deviations of the previous 30 days; trade in its direction for one candle. "
                   "Built for daily candles.")
    params = [
        Param("lookback", "Average over (candles)", 30, 5, 500, 1, unit="candles", warmup=WINDOW),
        Param("k", "Abnormal beyond (standard deviations)", 2.0, 0.5, 6, 0.1),
        Param("hold", "Hold (candles)", 1, 1, 100, 1, unit="candles"),
    ]

    def prepare(self, d):
        p = self.p
        ret = d.c / shift(d.c) - 1
        self.ret = ret
        filled = np.nan_to_num(ret)                                # the first candle has no return
        self.mean = shift(sma(filled, p.lookback))                 # the previous days only
        self.sd = shift(stdev(filled, p.lookback))
        self.mean[:p.lookback + 1] = np.nan

    def on_bar(self, i, pos, orders):
        p, r, m, s = self.p, self.ret[i], self.mean[i], self.sd[i]
        if pos is not None or not (np.isfinite(r) and np.isfinite(m) and np.isfinite(s)) or s <= 0:
            return
        side = 1 if r > m + p.k * s else -1 if r < m - p.k * s else 0
        if side and self.allows(side):
            (orders.buy if side > 0 else orders.sell)(max_bars=p.hold, tag=f"Abnormal move {r * 100:+.1f}%")
