"""What every MEDUSA Lab strategy is built from.

A strategy is a small class in a .py file: built-in ones live in public/lab/strategies/ (listed in
index.json there), your own are uploaded or written under Lab -> Strategies. The class has:
  key, label, description   shown in the page
  params                    list of Param: the page builds a settings form from it
  prepare(self, d)          compute indicators once, from the candles d (arrays d.o d.h d.l d.c d.v d.t)
  on_bar(self, i, pos, orders)
                            called at the CLOSE of every candle i. `pos` is the open position or None.
                            Place orders with `orders`:
                              orders.buy(...) / orders.sell(...)            market order (long / short)
                              orders.buy_stop(price, valid=n, ...)          enter long if price trades up to `price`
                              orders.sell_stop / buy_limit / sell_limit     same idea
                              orders.exit()                                 close the position
                              orders.set_stop(price) / orders.set_target(price)
                            Entry options: stop=price or stop_dist=distance, target=price or target_r=R multiple,
                            max_bars=n (time exit).
                            orders.pending is a stop/limit entry still waiting; orders.last_exit_i is the candle
                            on which the last trade closed.
Rules may only use data up to candle i: "Check" in the Strategies tab fails if a strategy peeks ahead.

Warm-up: an indicator length is a Param with unit="candles" and warmup=k (k = how many times its value the
indicator needs to settle: 1 for a window such as an SMA or the highest high, 4 for an EMA, 8 for Wilder's
smoothing in RSI and ATR). The test starts once the largest of these has passed; candles before a start date
are used for it when the file has them. Override warmup() when a strategy needs something else.
"""
import math
from types import SimpleNamespace

EMA, WILDER, WINDOW = 4, 8, 1        # warm-up factors (see above)


class Param:
    """One setting. kind is "int", "float", "choice" or "bool" (taken from the default and choices)."""

    def __init__(self, key, label, default, min=None, max=None, step=None, choices=None, help="", unit=None, warmup=0):
        self.key, self.label, self.default, self.help = key, label, default, help
        self.min, self.max, self.step, self.choices = min, max, step, choices
        self.unit, self.warmup = unit, warmup          # unit "candles": the Lab also takes minutes/hours/days/weeks
        self.kind = "choice" if choices else "bool" if isinstance(default, bool) else "int" if isinstance(default, int) else "float"

    def clean(self, v):
        """The value from the page, converted and kept inside min..max (bad input -> default)."""
        if v is None:
            return self.default
        try:
            if self.kind == "choice":
                return v if v in [c[0] for c in self.choices] else self.default
            if self.kind == "bool":
                return v in (True, "true", "1", 1, "on")
            v = int(float(v)) if self.kind == "int" else float(v)
        except (TypeError, ValueError):
            return self.default
        if self.min is not None:
            v = max(v, self.min)
        if self.max is not None:
            v = min(v, self.max)
        return v

    def describe(self):
        return {"key": self.key, "label": self.label, "default": self.default, "kind": self.kind, "min": self.min,
                "max": self.max, "step": self.step, "choices": self.choices, "help": self.help, "unit": self.unit, "warmup": self.warmup}


DIRECTION = Param("direction", "Trade direction", "both", choices=[["both", "Long and short"], ["long", "Long only"], ["short", "Short only"]])


class Strategy:
    key = ""
    label = "Unnamed strategy"
    description = ""
    params = []
    directions = True          # adds the "Trade direction" setting
    group = ""                 # built-in strategies: "classic", "intraday" or "swing" (how the Lab lists them)

    def __init__(self, values=None):
        values = values or {}
        self.p = SimpleNamespace(**{p.key: p.clean(values.get(p.key)) for p in self.all_params()})

    @classmethod
    def all_params(cls):
        return list(cls.params) + ([DIRECTION] if cls.directions else [])

    @classmethod
    def describe(cls):
        return {"key": cls.key, "label": cls.label, "description": cls.description, "group": cls.group,
                "params": [p.describe() for p in cls.all_params()]}

    def warmup(self, interval_ms):
        """Candles of history the indicators need before the first trade: the largest indicator length x its
        warm-up factor, plus one (for rules that compare with the candle before); 0 without indicators."""
        lengths = [math.ceil(getattr(self.p, p.key) * p.warmup) for p in self.all_params() if p.warmup]
        return int(max(lengths) + 1) if lengths else 0

    def allows(self, side):
        """side: 1 long, -1 short."""
        d = getattr(self.p, "direction", "both")
        return d == "both" or (d == "long" and side > 0) or (d == "short" and side < 0)

    def settings_text(self):
        return ", ".join(f"{p.label.lower()} {getattr(self.p, p.key)}" for p in self.all_params())

    def prepare(self, d):
        pass

    def on_bar(self, i, pos, orders):
        raise NotImplementedError
