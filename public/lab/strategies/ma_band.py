from indicators import sma
from strategy import WINDOW, Param, Strategy


class MaBand(Strategy):
    key = "ma_band"
    order = 155
    group = "intraday"
    label = "Price vs moving average with a band (Brock, Lakonishok & LeBaron)"
    description = ("The classic academic trading rule (Brock, Lakonishok & LeBaron 1992), which Corbet et al. (2019) found "
                   "worked best on 1-minute Bitcoin data: long when the short average (1 = the price itself) is more than "
                   "1% above the 50-candle average, short when more than 1% below; inside the band, keep the position.")
    params = [
        Param("short_len", "Short average (candles, 1 = the price)", 1, 1, 200, 1, unit="candles", warmup=WINDOW),
        Param("long_len", "Long average (candles)", 50, 5, 1000, 1, unit="candles", warmup=WINDOW),
        Param("band_pct", "Band (%)", 1.0, 0, 20, 0.05),
    ]

    def prepare(self, d):
        p = self.p
        self.short_ma, self.long_ma = sma(d.c, p.short_len), sma(d.c, p.long_len)   # kept for the Chart tab
        self.ratio = self.short_ma / self.long_ma - 1

    def on_bar(self, i, pos, orders):
        r, b = self.ratio[i], self.p.band_pct / 100
        side = 1 if r > b else -1 if r < -b else 0
        if not side or (pos is not None and pos.side == side):
            return
        if pos is not None:
            orders.exit("Crossed the other band")
        if self.allows(side):
            (orders.buy if side > 0 else orders.sell)(tag="Above the band" if side > 0 else "Below the band")
