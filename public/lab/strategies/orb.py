import math

import numpy as np

from indicators import session_clock, session_ids
from strategy import Param, Strategy


class OpeningRangeBreakout(Strategy):
    key = "orb"
    order = 120
    group = "intraday"
    label = "Opening range breakout (Crabel, Zarattini & Aziz)"
    description = ("One trade a session, decided by its first minutes. 'Direction of the opening range' (Zarattini & Aziz "
                   "2023): if the opening range closes up, buy; if down, sell; stop at the other side of the range, target "
                   "10x the risk, else out at the session's end. 'Breakout' (Toby Crabel's classic): trade the first break "
                   "of the range's high or low instead. Use 1m to 15m candles.")
    params = [
        Param("mode", "Entry", "direction", choices=[["direction", "Direction of the opening range (Zarattini & Aziz)"],
                                                     ["breakout", "Breakout of the range (Crabel)"]]),
        Param("session_start", "Session start (UTC hour)", 0.0, 0, 23.5, 0.5,
              help="Crypto has no opening bell: 0 = midnight UTC; 13.5 = 13:30 UTC, the US stock market open", unit="utc_hour"),
        Param("range_min", "Opening range (minutes)", 5, 1, 720, 1, help="Rounded up to whole candles: at least one candle", unit="minutes"),
        Param("target_r", "Target (x the risk, 0 = none)", 10.0, 0, 50, 0.1),
        Param("min_range_pct", "Skip if the range is smaller than (% of price)", 0.0, 0, 10, 0.01,
              help="A tiny range means a tiny stop, so costs eat the trade"),
        Param("last_entry_min", "No new entries in the session's last (minutes)", 60, 0, 1440, 1, unit="minutes"),
    ]

    def prepare(self, d):
        p = self.p
        self.c = d.c
        iv_min = d.interval_ms / 60_000.0
        self.n_or = max(1, int(math.ceil(p.range_min / iv_min - 1e-9)))          # candles in the opening range
        self.sid = session_ids(d.t, p.session_start)
        self.mins, self.last = session_clock(d.t, d.interval_ms, p.session_start)
        self.k = np.rint(self.mins / iv_min) - 1
        n = len(d.c)
        # each session's opening range, known from the close of its last candle on (NaN before, and for a
        # session whose first candle is missing)
        self.or_hi, self.or_lo, self.or_open = np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
        hi = lo = op = np.nan
        ok = False
        for i in range(n):
            if i == 0 or self.sid[i] != self.sid[i - 1]:
                hi, lo, op, ok = -np.inf, np.inf, d.o[i], self.k[i] == 0
            if self.k[i] < self.n_or:
                hi, lo = max(hi, d.h[i]), min(lo, d.l[i])
            if ok and self.k[i] >= self.n_or - 1:
                self.or_hi[i], self.or_lo[i], self.or_open[i] = hi, lo, op

    def traded(self, i, pos, orders):
        return (pos is not None and self.sid[pos.entry_i] == self.sid[i]) or \
               (orders.last_exit_i is not None and self.sid[orders.last_exit_i] == self.sid[i])

    def on_bar(self, i, pos, orders):
        p, c = self.p, self.c[i]
        if self.last[i] or (pos is not None and self.sid[pos.entry_i] != self.sid[i]):
            orders.cancel()
            if pos is not None:
                orders.exit("End of session")
            return
        hi, lo = self.or_hi[i], self.or_lo[i]
        if not np.isfinite(hi) or pos is not None or self.traded(i, pos, orders):
            return
        if hi <= lo or (hi - lo) / c * 100 < p.min_range_pct or 1440 - self.mins[i] < p.last_entry_min:
            orders.cancel()
            return
        kw = {"target_r": p.target_r} if p.target_r else {}
        if p.mode == "direction":
            if self.k[i] != self.n_or - 1:                                         # decided once, when the range is complete
                return
            side = 1 if c > self.or_open[i] else -1 if c < self.or_open[i] else 0
            if side and self.allows(side):
                (orders.buy if side > 0 else orders.sell)(stop=lo if side > 0 else hi,
                                                         tag="Opening range closed up" if side > 0 else "Opening range closed down", **kw)
            return
        # Breakout: the engine holds one waiting order, so it goes on the side the price is nearer to and is renewed
        # every candle. A close already beyond the range (the order was on the other side) enters at the next open.
        up_ok, dn_ok = self.allows(1), self.allows(-1)
        if c > hi and up_ok:
            orders.buy(stop=lo, tag="Closed above the opening range", **kw)
        elif c < lo and dn_ok:
            orders.sell(stop=hi, tag="Closed below the opening range", **kw)
        elif lo <= c <= hi:
            if up_ok and (not dn_ok or hi - c <= c - lo):
                orders.buy_stop(hi, valid=1, stop=lo, tag="Broke the opening range high", **kw)
            elif dn_ok:
                orders.sell_stop(lo, valid=1, stop=hi, tag="Broke the opening range low", **kw)
