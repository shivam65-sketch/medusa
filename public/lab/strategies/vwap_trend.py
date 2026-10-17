import numpy as np

from indicators import atr, session_clock, session_ids, session_vwap
from strategy import WILDER, Param, Strategy


class VwapTrend(Strategy):
    key = "vwap_trend"
    order = 110
    group = "intraday"
    label = "VWAP trend (Zarattini & Aziz)"
    description = ("Intraday trend following on the session VWAP: long while candles close above the VWAP, short while "
                   "they close below, reversing on every cross, and flat at the end of the session. From Zarattini & Aziz "
                   "(2023), tested on 1-minute QQQ candles. Use 1m to 15m candles.")
    params = [
        Param("session_start", "Session start (UTC hour)", 0.0, 0, 23.5, 0.5,
              help="When the VWAP resets. 0 = midnight UTC; 13.5 = 13:30 UTC, the US stock market open", unit="utc_hour"),
        Param("skip", "Wait after the session starts (candles)", 1, 0, 500, 1, unit="candles"),
        Param("buffer_pct", "Close must clear the VWAP by (%)", 0.0, 0, 5, 0.01,
              help="0 = any close beyond the VWAP, as in the paper; higher = fewer back-and-forth trades"),
        Param("flat_at_end", "Close at the end of the session", True),
        Param("stop_atr", "Stop (x ATR, 0 = none)", 0.0, 0, 20, 0.1),
        Param("atr_len", "ATR length", 14, 2, 200, 1, unit="candles"),
    ]

    def warmup(self, interval_ms):
        return WILDER * self.p.atr_len + 1 if self.p.stop_atr else 0     # the VWAP restarts every session

    def prepare(self, d):
        p = self.p
        self.c = d.c
        self.vwap, _ = session_vwap(d.h, d.l, d.c, d.v, d.t, p.session_start)
        self.sid = session_ids(d.t, p.session_start)
        mins, self.last = session_clock(d.t, d.interval_ms, p.session_start)
        self.k = np.rint(mins / (d.interval_ms / 60_000.0)) - 1        # candle number within the session, 0 = first
        self.atr = atr(d.h, d.l, d.c, p.atr_len)

    def on_bar(self, i, pos, orders):
        p, c, vw = self.p, self.c[i], self.vwap[i]
        if pos is not None and p.flat_at_end and (self.last[i] or self.sid[pos.entry_i] != self.sid[i]):
            orders.exit("End of session")
            return
        if self.k[i] < p.skip or (p.flat_at_end and self.last[i]):
            return
        b = p.buffer_pct / 100
        side = 1 if c > vw * (1 + b) else -1 if c < vw * (1 - b) else 0
        if pos is not None:
            if side != -pos.side:
                return
            orders.exit("Crossed the VWAP")
        if side and self.allows(side):
            kw = {"tag": "Above the VWAP" if side > 0 else "Below the VWAP"}
            if p.stop_atr and np.isfinite(self.atr[i]):
                kw["stop_dist"] = p.stop_atr * self.atr[i]
            (orders.buy if side > 0 else orders.sell)(**kw)
