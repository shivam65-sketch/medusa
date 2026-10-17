import math

import numpy as np

from strategy import Param, Strategy

DAYS = [["all", "Every day"], ["weekdays", "Monday to Friday"], ["weekend", "Saturday and Sunday"],
        ["0", "Mondays"], ["1", "Tuesdays"], ["2", "Wednesdays"], ["3", "Thursdays"], ["4", "Fridays"],
        ["5", "Saturdays"], ["6", "Sundays"]]


class HourSeasonality(Strategy):
    key = "hour_seasonality"
    order = 135
    group = "intraday"
    label = "Bitcoin night hours 21-23 UTC (Quantpedia)"
    description = ("Buy at a fixed hour and sell a fixed time later, every day. The defaults are Quantpedia's Bitcoin "
                   "seasonality (Padyšák & Vojtko 2022): long from 21:00 to 23:00 UTC, when the big stock exchanges are "
                   "all closed. Change the hours and days to test any time-of-day or day-of-week idea. Use 1h or shorter candles.")
    directions = False
    params = [
        Param("entry_hour", "Buy at (UTC hour)", 21, 0, 23, 1, unit="utc_hour"),
        Param("exit_hour", "Sell at (UTC hour)", 23, 0, 23, 1, help="The same hour as the buy = hold 24 hours", unit="utc_hour"),
        Param("days", "Days", "all", choices=DAYS, help="The day of the buy, in UTC"),
    ]

    def prepare(self, d):
        p = self.p
        iv = int(d.interval_ms)
        close = np.asarray(d.t, dtype=np.int64) + iv                    # buy at the close of the candle ending at entry_hour
        sig = close % 86_400_000 == p.entry_hour * 3_600_000
        wd = (close // 86_400_000 + 3) % 7                               # 0 = Monday (1 Jan 1970 was a Thursday)
        if p.days == "weekdays":
            sig &= wd < 5
        elif p.days == "weekend":
            sig &= wd >= 5
        elif p.days != "all":
            sig &= wd == int(p.days)
        self.sig = sig
        hold = ((p.exit_hour - p.entry_hour) % 24 or 24) * 3_600_000
        self.bars = max(1, int(math.ceil(hold / iv)))
        if len(sig) and not sig.any():
            print(f"No candle closes at {p.entry_hour:02d}:00 UTC on this timeframe, so there are no trades: use 1h or shorter candles.")

    def on_bar(self, i, pos, orders):
        if pos is None and self.sig[i]:
            orders.buy(max_bars=self.bars, tag=f"{self.p.entry_hour:02d}:00 UTC")
