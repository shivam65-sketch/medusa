import numpy as np

from indicators import DAY_MS, session_clock, session_ids, session_vwap
from strategy import Param, Strategy


class NoiseBreakout(Strategy):
    key = "noise_breakout"
    order = 125
    group = "intraday"
    label = "Noise-area breakout (Zarattini, Aziz & Barbon)"
    description = ("Intraday momentum from the paper 'Beat the Market' (2024): a 'noise area' around the session's open "
                   "is drawn from how far the price usually moves from the open by each time of day (average of the last "
                   "14 sessions). A close outside it, checked every 30 minutes, starts a trade in that direction; the stop "
                   "trails at the band or the VWAP, whichever is tighter; flat at the session's end. Use 1m to 30m candles.")
    params = [
        Param("session_start", "Session start (UTC hour)", 0.0, 0, 23.5, 0.5,
              help="Where the noise area starts. 0 = midnight UTC; 13.5 = 13:30 UTC, the US stock market open", unit="utc_hour"),
        Param("lookback", "Average over the last (sessions)", 14, 2, 100, 1, unit="sessions"),
        Param("mult", "Band width (x the average move)", 1.0, 0.2, 5, 0.1),
        Param("check_min", "Check every (minutes)", 30, 1, 720, 1,
              help="Entries and stops are checked only on these candle closes (HH:00, HH:30 ...), to skip brief spikes", unit="minutes"),
        Param("use_vwap", "Trail the stop at the VWAP too", True),
    ]

    def warmup(self, interval_ms):
        return (self.p.lookback + 1) * max(1, 86_400_000 // interval_ms)     # the previous sessions' moves

    def prepare(self, d):
        p = self.p
        n = len(d.c)
        self.c = d.c
        iv = int(d.interval_ms)
        t = np.asarray(d.t, dtype=np.int64)
        off = int(round(p.session_start * 3_600_000))
        nslot = DAY_MS // iv
        self.sid = session_ids(t, p.session_start)
        _, self.last = session_clock(t, iv, p.session_start)
        slot = ((t - off) % DAY_MS) // iv                          # candle number within the session
        step = max(int(p.check_min) * 60_000, iv)
        self.check = ((slot + 1) * iv) % step == 0                 # candles closing at HH:00, HH:30 ... (check_min 30)
        self.upper, self.lower = np.full(n, np.nan), np.full(n, np.nan)
        self.vwap = session_vwap(d.h, d.l, d.c, d.v, t, p.session_start)[0]
        if not n or nslot < 2:                                     # needs candles shorter than a day
            return
        first = np.r_[True, self.sid[1:] != self.sid[:-1]]
        grp = np.cumsum(first) - 1
        starts = np.flatnonzero(first)
        ok = (slot[starts] == 0)[grp]                              # sessions whose first candle exists
        sopen = d.o[starts][grp]
        prev_close = np.r_[np.nan, d.c[np.r_[starts[1:] - 1]]][grp]
        # move from the open at every time of day, one row per session (missing candles stay NaN)
        row = self.sid - self.sid[0]
        S = int(row[-1]) + 1
        M = np.full((S, nslot), np.nan)
        M[row, slot] = np.where(ok, np.abs(d.c / sopen - 1), np.nan)
        have = ~np.isnan(M)
        cs = np.vstack([np.zeros(nslot), np.cumsum(np.where(have, M, 0.0), axis=0)])
        cn = np.vstack([np.zeros(nslot), np.cumsum(have, axis=0)])
        r = np.arange(S)
        a = np.maximum(r - p.lookback, 0)
        cnt = cn[r] - cn[a]                                        # only the sessions BEFORE each one
        sigma = np.where(cnt >= max(2, p.lookback // 2), (cs[r] - cs[a]) / np.maximum(cnt, 1), np.nan)[row, slot]
        self.upper = np.fmax(sopen, prev_close) * (1 + p.mult * sigma)
        self.lower = np.fmin(sopen, prev_close) * (1 - p.mult * sigma)
        self.upper[~ok] = np.nan
        self.lower[~ok] = np.nan

    def on_bar(self, i, pos, orders):
        p, c = self.p, self.c[i]
        if pos is not None and (self.last[i] or self.sid[pos.entry_i] != self.sid[i]):
            orders.exit("End of session")
            return
        up, lo, vw = self.upper[i], self.lower[i], self.vwap[i]
        if self.last[i] or not self.check[i] or not (np.isfinite(up) and np.isfinite(lo)):
            return
        if pos is not None:
            if pos.side > 0:
                stop = max(up, vw) if p.use_vwap else up
                if c >= stop:
                    return
            else:
                stop = min(lo, vw) if p.use_vwap else lo
                if c <= stop:
                    return
            orders.exit("Trailing stop (band or VWAP)")
        side = 1 if c > up else -1 if c < lo else 0
        if side and (pos is None or side != pos.side) and self.allows(side):
            (orders.buy if side > 0 else orders.sell)(tag="Above the noise area" if side > 0 else "Below the noise area")
