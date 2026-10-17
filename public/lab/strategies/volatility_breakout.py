import numpy as np

from indicators import session_clock, session_ids
from strategy import Param, Strategy


class VolatilityBreakout(Strategy):
    key = "volatility_breakout"
    order = 210
    group = "swing"
    label = "Volatility breakout (Larry Williams)"
    description = ("Larry Williams' volatility breakout, the most copied crypto bot rule (k = 0.5): buy when the price rises "
                   "above the session's open + k x the previous session's range (high - low), sell short below the open - "
                   "k x the range, and get out at the next session's open. One trade a session. Works on 1d candles (the "
                   "previous close stands in for the open) or, more precisely, on 5m to 1h candles.")
    params = [
        Param("k", "k (x the previous session's range)", 0.5, 0.05, 3, 0.05),
        Param("session_start", "Session start (UTC hour)", 0.0, 0, 23.5, 0.5,
              help="0 = midnight UTC (the Korean exchanges' 09:00 KST reset). With 1d candles keep 0", unit="utc_hour"),
        Param("stop_mult", "Stop (x the previous session's range, 0 = none)", 0.0, 0, 5, 0.05,
              help="0 = no stop, out at the next session's open (Williams' simplest form)"),
    ]

    def warmup(self, interval_ms):
        return max(1, 86_400_000 // interval_ms) + 1                  # the previous session's range

    def prepare(self, d):
        p = self.p
        n = len(d.c)
        self.c = d.c
        self.sid = session_ids(d.t, p.session_start)
        mins, self.last = session_clock(d.t, d.interval_ms, p.session_start)
        k = np.rint(mins / (d.interval_ms / 60_000.0)) - 1
        self.sopen, self.prev_rng = np.full(n, np.nan), np.full(n, np.nan)
        self.run_hi, self.run_lo = np.full(n, np.nan), np.full(n, np.nan)
        if not n:
            return
        first = np.r_[True, self.sid[1:] != self.sid[:-1]]
        starts = np.flatnonzero(first)
        ends = np.r_[starts[1:], n]
        hi_g = np.maximum.reduceat(d.h, starts)
        lo_g = np.minimum.reduceat(d.l, starts)
        sid_g = self.sid[starts]
        whole = k[starts] == 0                                      # the session's first candle exists
        for g, (a, b) in enumerate(zip(starts.tolist(), ends.tolist())):
            self.run_hi[a:b] = np.maximum.accumulate(d.h[a:b])        # the session's high and low so far
            self.run_lo[a:b] = np.minimum.accumulate(d.l[a:b])
            if whole[g]:
                self.sopen[a:b] = d.o[a]
            if g and sid_g[g - 1] == sid_g[g] - 1:
                self.prev_rng[a:b] = hi_g[g - 1] - lo_g[g - 1]

    def on_bar(self, i, pos, orders):
        p, c = self.p, self.c[i]
        if pos is not None:
            if self.last[i] or self.sid[pos.entry_i] != self.sid[i]:
                orders.exit("Next session's open")
            if not self.last[i]:
                return
        if self.last[i]:
            ref, rng = c, self.run_hi[i] - self.run_lo[i]           # the next session: its open ~ this close, range = this session
        else:
            if orders.last_exit_i is not None and self.sid[orders.last_exit_i] == self.sid[i]:
                return                                              # one trade a session
            ref, rng = self.sopen[i], self.prev_rng[i]
        if not (np.isfinite(ref) and np.isfinite(rng)) or rng <= 0:
            return
        up, dn = ref + p.k * rng, ref - p.k * rng
        kw = {"stop_dist": p.stop_mult * rng} if p.stop_mult else {}
        up_ok, dn_ok = self.allows(1), self.allows(-1)
        if c > up and up_ok and not self.last[i]:
            orders.buy(tag="Above open + k x range", **kw)          # crossed while the order was on the other side
        elif c < dn and dn_ok and not self.last[i]:
            orders.sell(tag="Below open - k x range", **kw)
        elif dn <= c <= up:
            # The engine holds one waiting order: it goes on the nearer side and is renewed every candle.
            if up_ok and (not dn_ok or up - c <= c - dn):
                orders.buy_stop(up, valid=1, tag="Broke open + k x range", **kw)
            elif dn_ok:
                orders.sell_stop(dn, valid=1, tag="Broke open - k x range", **kw)
