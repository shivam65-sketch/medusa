import numpy as np

from indicators import atr, session_clock, session_ids, session_vwap
from strategy import WILDER, Param, Strategy


class VwapReversion(Strategy):
    key = "vwap_reversion"
    order = 115
    group = "intraday"
    label = "VWAP band reversion (scalping)"
    description = ("The scalper's fade: when the price stretches beyond a VWAP band (the session VWAP ± 2 volume-weighted "
                   "standard deviations) and closes back inside it, trade back towards the VWAP. Exit at the VWAP, at the "
                   "ATR stop, or at the end of the session. Use 1m to 15m candles.")
    params = [
        Param("session_start", "Session start (UTC hour)", 0.0, 0, 23.5, 0.5, help="When the VWAP and its bands reset", unit="utc_hour"),
        Param("band", "Band width (standard deviations)", 2.0, 0.5, 5, 0.1),
        Param("confirm", "Wait for a close back inside the band", True,
              help="Off = trade as soon as a candle closes outside the band"),
        Param("min_candles", "No trades in the session's first (candles)", 12, 1, 1000, 1,
              help="The bands need some candles before they mean anything", unit="candles"),
        Param("atr_len", "ATR length", 14, 2, 200, 1, unit="candles", warmup=WILDER),
        Param("stop_atr", "Stop (x ATR)", 1.5, 0.1, 20, 0.1),
        Param("max_bars", "Time exit after candles (0 = none)", 0, 0, 5000, 1, unit="candles"),
    ]

    def prepare(self, d):
        p = self.p
        self.c = d.c
        self.vwap, sd = session_vwap(d.h, d.l, d.c, d.v, d.t, p.session_start)
        self.up, self.lo = self.vwap + p.band * sd, self.vwap - p.band * sd
        self.sid = session_ids(d.t, p.session_start)
        mins, self.last = session_clock(d.t, d.interval_ms, p.session_start)
        self.k = np.rint(mins / (d.interval_ms / 60_000.0)) - 1
        self.atr = atr(d.h, d.l, d.c, p.atr_len)

    def on_bar(self, i, pos, orders):
        p, c = self.p, self.c
        if pos is not None:
            if self.last[i] or self.sid[pos.entry_i] != self.sid[i]:
                orders.exit("End of session")
            elif (pos.side > 0 and c[i] >= self.vwap[i]) or (pos.side < 0 and c[i] <= self.vwap[i]):
                orders.exit("Back to the VWAP")
            return
        if i == 0 or self.k[i] < p.min_candles or self.last[i] or not np.isfinite(self.atr[i]) or self.up[i] <= self.lo[i]:
            return
        if p.confirm:
            same = self.sid[i - 1] == self.sid[i]
            side = (1 if same and c[i - 1] < self.lo[i - 1] and c[i] > self.lo[i] else
                    -1 if same and c[i - 1] > self.up[i - 1] and c[i] < self.up[i] else 0)
        else:
            side = 1 if c[i] < self.lo[i] else -1 if c[i] > self.up[i] else 0
        if side and self.allows(side):
            (orders.buy if side > 0 else orders.sell)(stop_dist=p.stop_atr * self.atr[i], max_bars=p.max_bars or None,
                                                     tag="Below the lower VWAP band" if side > 0 else "Above the upper VWAP band")
