from strategy import Strategy


class BuyHold(Strategy):
    key = "buy_hold"
    order = 99
    group = "classic"
    label = "Buy and hold (baseline)"
    description = "Buys on the first candle and holds to the end. Use it as the yardstick: a strategy should beat this after costs, or have much smaller drawdowns."
    directions = False

    def warmup(self, interval_ms):
        return 0                                         # no indicators: buy on the first candle

    def on_bar(self, i, pos, orders):
        if i == 0 and pos is None:
            orders.buy(tag="Buy and hold")
