import math

import numpy as np

from indicators import session_clock, session_ids
from strategy import Param, Strategy


class IntradayMomentum(Strategy):
    key = "intraday_momentum"
    order = 130
    group = "intraday"
    label = "First half-hour predicts the last (intraday momentum)"
    description = ("If the session's first half-hour went up, buy for its last half-hour; if it went down, sell. From Gao, "
                   "Han, Li & Zhou (2018, US stocks) and Shen, Urquhart & Wang (2022), who found the same effect in Bitcoin. "
                   "A session is a 24-hour day from the chosen UTC hour. Use 1h or shorter candles.")
    params = [
        Param("session_start", "Session start (UTC hour)", 0.0, 0, 23.5, 0.5,
              help="0 = midnight UTC; 13.5 = 13:30 UTC, the US stock market open", unit="utc_hour"),
        Param("first_min", "First window (minutes)", 30, 1, 720, 1, help="Rounded up to whole candles", unit="minutes"),
        Param("last_min", "Trade window at the end (minutes)", 30, 1, 720, 1, help="Rounded up to whole candles", unit="minutes"),
        Param("min_move_pct", "Only if the first window moved at least (%)", 0.0, 0, 20, 0.01),
    ]

    def prepare(self, d):
        p = self.p
        n = len(d.c)
        iv_min = d.interval_ms / 60_000.0
        per = int(round(1440 / iv_min))                                 # candles per session
        m1 = max(1, int(math.ceil(p.first_min / iv_min - 1e-9)))
        self.m2 = max(1, int(math.ceil(p.last_min / iv_min - 1e-9)))
        sid = session_ids(d.t, p.session_start)
        mins, _ = session_clock(d.t, d.interval_ms, p.session_start)
        k = np.rint(mins / iv_min) - 1
        self.go = (k == per - self.m2 - 1) & (per > m1 + self.m2)       # the candle whose close starts the last window
        self.r1 = np.full(n, np.nan)
        if not n:
            return
        first = np.r_[True, sid[1:] != sid[:-1]]
        grp = np.cumsum(first) - 1
        starts = np.flatnonzero(first)
        sopen = np.where((k[starts] == 0), d.o[starts], np.nan)[grp]    # open of the session (its first candle must exist)
        done = np.flatnonzero(k == m1 - 1)                              # the first window's last candle
        r = np.full(len(starts), np.nan)
        r[grp[done]] = d.c[done] / sopen[done] - 1
        self.r1 = np.where(k >= m1 - 1, r[grp], np.nan)                 # known from the end of the first window on

    def on_bar(self, i, pos, orders):
        r = self.r1[i]
        if pos is not None or not self.go[i] or not np.isfinite(r) or abs(r) * 100 < self.p.min_move_pct:
            return
        side = 1 if r > 0 else -1 if r < 0 else 0
        if side and self.allows(side):
            (orders.buy if side > 0 else orders.sell)(max_bars=self.m2, tag=f"First window {r * 100:+.2f}%")
