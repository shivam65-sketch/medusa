import math

import numpy as np

from strategy import Param, Strategy


class FundingFade(Strategy):
    key = "funding_fade"
    order = 240
    group = "swing"
    label = "Fade extreme funding (BitMEX research)"
    description = ("A crypto-only signal: when the futures funding rate is unusually high (longs crowded and paying), go "
                   "short until the next funding; unusually low, go long. BitMEX's research found the best results between "
                   "1 and 2 standard deviations from the recent average, and warned that the most extreme readings keep "
                   "trending. Needs futures data downloaded with funding rates; use 1h or shorter candles.")
    params = [
        Param("lookback", "Compare with the last (funding payments)", 90, 10, 2000, 1, help="90 = 30 days of 8-hour funding", unit="payments"),
        Param("z_min", "Trade from (standard deviations)", 1.0, 0.1, 10, 0.1),
        Param("z_max", "Skip beyond (standard deviations, 0 = never)", 2.0, 0, 20, 0.1),
        Param("hold_h", "Hold (hours)", 8, 1, 168, 1, unit="hours"),
    ]

    def warmup(self, interval_ms):
        return -(-self.p.lookback * 8 * 3_600_000 // interval_ms) + 1     # the previous funding payments (8-hourly)

    def prepare(self, d):
        p = self.p
        n = len(d.c)
        self.go = np.zeros(n, bool)
        self.z = np.full(n, np.nan)
        self.bars = max(1, int(math.ceil(p.hold_h * 3_600_000 / d.interval_ms)))
        ft, fr = d.extra.get("funding_t"), d.extra.get("funding_r")
        if ft is None or fr is None or not len(ft):
            if n:
                print("This data has no funding rates, so Fade extreme funding can't trade. Download futures data with "
                      "\"Include funding rates\".")
            return
        ft, fr = np.asarray(ft, dtype=np.int64), np.asarray(fr, dtype=float)
        # z-score of each payment against the `lookback` payments before it
        z = np.full(len(fr), np.nan)
        L = p.lookback
        if len(fr) > L:
            c1 = np.r_[0.0, np.cumsum(fr)]
            c2 = np.r_[0.0, np.cumsum(fr * fr)]
            j = np.arange(L, len(fr))
            mean = (c1[j] - c1[j - L]) / L
            var = (c2[j] - c2[j - L]) / L - mean * mean
            sd = np.sqrt(np.maximum(var, 0.0))
            z[L:] = np.where(sd > 0, (fr[L:] - mean) / np.where(sd > 0, sd, 1.0), np.nan)
        # the newest payment settled by each candle's close, and whether it arrived during this candle
        idx = np.searchsorted(ft, np.asarray(d.t, dtype=np.int64) + int(d.interval_ms), side="right") - 1
        new = np.r_[idx[:1] >= 0, idx[1:] != idx[:-1]] & (idx >= 0)
        self.z = np.where(idx >= 0, z[np.maximum(idx, 0)], np.nan)
        self.go = new & np.isfinite(self.z)

    def on_bar(self, i, pos, orders):
        p, z = self.p, self.z[i]
        if pos is not None or not self.go[i] or abs(z) < p.z_min or (p.z_max and abs(z) > p.z_max):
            return
        side = -1 if z > 0 else 1
        if self.allows(side):
            (orders.buy if side > 0 else orders.sell)(max_bars=self.bars, tag=f"Funding {z:+.1f} sd")
