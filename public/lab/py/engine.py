"""MEDUSA Lab backtest engine: runs one strategy over one coin's candles, bar by bar.

How a candle is processed (candle i):
  1. At its OPEN: a market exit or entry ordered at the previous close is filled at this open
     (when Settings.fill is "next_open", the default).
  2. INSIDE it: pending stop/limit entries are checked against the high and low; then the open
     position's stop and target. Candles don't show their path, so the engine assumes the worse
     case: if a candle touches both stop and target, the stop came first; an entry filled inside a
     candle can be stopped in that same candle but never hit its target there; a candle that opens
     beyond the stop fills at the open.
  3. Funding (futures) settled during the candle is paid or received if the position is still open.
  4. A position held max_bars candles is closed at this close.
  5. At its CLOSE: the strategy's on_bar(i) sees candles 0..i and may place orders. With fill
     "close", its market orders fill at this close instead of the next open.
Costs: fee on every fill (on the traded value) and slippage (every fill is moved against you).
Sizing: "risk" = lose risk_pct of equity if the stop is hit (needs a stop); "notional" = position
value is notional_pct of equity. Either is capped at max_leverage x equity.
Liquidation (cross margin, all equity backs the position): when equity falls to the maintenance
margin (MAINTENANCE x position value), on the candle's low/high or after funding, the position is
closed at the liquidation price and whatever is left is lost, as on the exchange. With nothing left,
no new trades open.
"""
from dataclasses import dataclass, field

import numpy as np

INTERVAL_MS = {"1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000,
               "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000,
               "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000}
MAINTENANCE = 0.005            # Binance's maintenance margin rate for small positions


@dataclass
class Candles:
    t: np.ndarray               # open time, ms
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray
    c: np.ndarray
    v: np.ndarray
    interval: str = "1h"
    symbol: str = ""
    market: str = ""
    extra: dict = field(default_factory=dict)   # qv (quote volume), n (trades), tbv (taker-buy volume)

    def __len__(self):
        return len(self.c)

    @property
    def interval_ms(self):
        return INTERVAL_MS[self.interval]


@dataclass
class Settings:
    fee: float = 0.0005          # per fill, fraction of traded value (Binance futures taker 0.05%)
    slippage: float = 0.0005     # per fill, fraction of price
    funding: bool = True         # futures funding payments (needs funding rates)
    capital: float = 1000.0
    sizing: str = "risk"         # "risk" | "notional"
    risk_pct: float = 1.0
    notional_pct: float = 100.0
    max_leverage: float = 3.0
    compounding: bool = True     # size from current equity (True) or from the starting capital
    fill: str = "next_open"      # market orders: "next_open" | "close"


@dataclass
class Order:
    side: int
    kind: str                    # "market" | "stop" | "limit"
    price: float = None
    expires: int = None          # last candle index on which a stop/limit order may fill
    stop: float = None
    stop_dist: float = None
    target: float = None
    target_r: float = None
    max_bars: int = None
    tag: str = ""


@dataclass
class Position:
    side: int
    entry_i: int
    entry_px: float              # fill price incl. slippage
    qty: float
    stop: float
    target: float
    max_bars: int
    stop0: float
    risk0: float                 # money lost if the first stop is hit, before costs (0 = no stop)
    fees: float
    slip: float
    at_open: bool                # filled at a candle's open (else at a close or inside a candle)
    tag: str = ""
    funding: float = 0.0
    lev: float = 0.0

    @property
    def is_long(self):
        return self.side > 0


class Orders:
    """What a strategy's on_bar() uses to trade. Requests are applied by the engine after on_bar returns."""

    def __init__(self):
        self.entry = None
        self.exit_tag = None
        self.new_stop = None
        self.new_target = None
        self.pending = None          # the engine shows a still-waiting stop/limit entry here
        self.last_exit_i = None      # the candle on which the last trade closed

    def _enter(self, side, kind, price=None, valid=1, stop=None, stop_dist=None, target=None, target_r=None, max_bars=None, tag=""):
        self.entry = Order(side, kind, price, valid, stop, stop_dist, target, target_r, max_bars, tag)

    def buy(self, **kw):
        self._enter(1, "market", **kw)

    def sell(self, **kw):
        self._enter(-1, "market", **kw)

    def buy_stop(self, price, valid=1, **kw):
        self._enter(1, "stop", price, valid, **kw)

    def sell_stop(self, price, valid=1, **kw):
        self._enter(-1, "stop", price, valid, **kw)

    def buy_limit(self, price, valid=1, **kw):
        self._enter(1, "limit", price, valid, **kw)

    def sell_limit(self, price, valid=1, **kw):
        self._enter(-1, "limit", price, valid, **kw)

    def exit(self, tag="Signal"):
        self.exit_tag = tag

    def set_stop(self, price):
        self.new_stop = price

    def set_target(self, price):
        self.new_target = price

    def cancel(self):
        self.entry = None
        self.pending = None


@dataclass
class Result:
    trades: list
    equity: np.ndarray           # account value at every candle close (open position marked to the close)
    exposure: np.ndarray         # True where a position was held at the close
    settings: Settings
    skipped: int = 0             # entries refused (stop on the wrong side, no money left)
    max_leverage_used: float = 0.0
    liquidations: int = 0


def run(d: Candles, strategy, s: Settings, funding=None, progress=None, start_i=0):
    """funding: (times_ms array, rates array) for futures, or None. progress(fraction) is called now and then.
    start_i: the candles before it are warm-up only. The strategy sees them (its indicators are computed from
    them) but nothing is traded; the first order it can place is at the close of candle start_i."""
    n = len(d)
    o, h, l, c, t = d.o, d.h, d.l, d.c, d.t
    iv = d.interval_ms
    strategy.prepare(d)
    ft, fr = (funding if (funding is not None and s.funding) else (np.array([], dtype=np.int64), np.array([])))
    fj = int(np.searchsorted(ft, t[0], side="right")) if len(ft) and n else 0
    cash = float(s.capital)
    pos, pending, exit_tag = None, None, None
    trades, equity, exposure = [], np.empty(n), np.zeros(n, bool)
    skipped, lev_max, liquidations = 0, 0.0, 0
    orders = Orders()

    def open_pos(i, order, raw, at_open):
        nonlocal cash, skipped, lev_max
        side = order.side
        px = raw * (1 + side * s.slippage)
        stop = order.stop
        if stop is None and order.stop_dist:
            stop = px - side * order.stop_dist
        if stop is not None and not np.isfinite(stop):
            stop = None
        if stop is not None and (stop - px) * side >= 0:            # stop at or beyond the entry: refuse
            skipped += 1
            return None
        target = order.target
        if target is None and order.target_r and stop is not None:
            target = px + side * order.target_r * abs(px - stop)
        basis = cash if s.compounding else min(cash, s.capital)
        if basis <= 0 or not (px > 0):
            skipped += 1
            return None
        if s.sizing == "risk" and stop is not None:
            qty = basis * s.risk_pct / 100 / abs(px - stop)
        else:
            qty = basis * s.notional_pct / 100 / px
        qty = min(qty, basis * s.max_leverage / px)
        fee = qty * px * s.fee
        cash -= fee
        lev = qty * px / basis
        lev_max = max(lev_max, lev)
        return Position(side, i, px, qty, stop, target, order.max_bars, stop, qty * abs(px - stop) if stop is not None else 0.0,
                        fee, qty * abs(px - raw), at_open, order.tag, 0.0, lev)

    def close_pos(i, raw, reason):
        nonlocal cash, pos
        p = pos
        px = raw * (1 - p.side * s.slippage)
        fee = p.qty * px * s.fee
        gross = p.side * p.qty * (px - p.entry_px)
        cash += gross - fee
        pnl = gross - p.fees - fee + p.funding
        trades.append({
            "side": p.side, "entry_i": p.entry_i, "exit_i": i, "entry_t": int(t[p.entry_i]), "exit_t": int(t[i]),
            "entry": p.entry_px, "exit": px, "qty": p.qty, "value": p.qty * p.entry_px, "stop": p.stop0,
            "target": p.target if p.target is not None else None, "fees": p.fees + fee, "slippage": p.slip + p.qty * abs(px - raw),
            "funding": p.funding, "pnl": pnl, "r": pnl / p.risk0 if p.risk0 > 0 else None,
            "ret": pnl / (p.qty * p.entry_px), "reason": reason, "bars": i - p.entry_i + (1 if p.at_open else 0),
            "tag": p.tag, "leverage": p.lev,
        })
        orders.last_exit_i = i
        pos = None

    def liq_price(p):
        """Price at which equity = maintenance margin (None if it can't happen)."""
        if p.side > 0:
            px = (p.qty * p.entry_px - cash) / (p.qty * (1 - MAINTENANCE))
        else:
            px = (cash + p.qty * p.entry_px) / (p.qty * (1 + MAINTENANCE))
        return px if px > 0 else None

    def liquidate(i, raw):
        nonlocal cash, liquidations
        close_pos(i, raw, "Liquidated")
        trades[-1]["pnl"] -= cash          # what is left goes to the exchange; a negative balance is covered by its insurance fund
        if trades[-1]["r"] is not None:
            trades[-1]["r"] = trades[-1]["pnl"] / (trades[-1]["qty"] * abs(trades[-1]["entry"] - trades[-1]["stop"]))
        trades[-1]["ret"] = trades[-1]["pnl"] / trades[-1]["value"]
        cash = 0.0
        liquidations += 1

    for i in range(n):
        if i < start_i:                                    # warm-up: the strategy sees the candle, nothing is traded
            orders.entry = orders.exit_tag = orders.new_stop = orders.new_target = orders.pending = None
            strategy.on_bar(i, None, orders)
            equity[i] = cash
            continue
        # 1. fills at the open
        if pos is not None and exit_tag:
            close_pos(i, o[i], exit_tag)
        exit_tag = None
        if pending is not None and pending.kind == "market":
            if pos is None:
                pos = open_pos(i, pending, o[i], True)
            pending = None
        # 2a. stop / limit entries inside the candle
        intrabar = False
        if pending is not None and pos is None:
            if i > pending.expires:
                pending = None
            else:
                side, px = pending.side, pending.price
                fill = None
                if pending.kind == "stop":
                    if side > 0 and h[i] >= px:
                        fill = max(o[i], px)
                    elif side < 0 and l[i] <= px:
                        fill = min(o[i], px)
                else:
                    if side > 0 and l[i] <= px:
                        fill = min(o[i], px)
                    elif side < 0 and h[i] >= px:
                        fill = max(o[i], px)
                if fill is not None:
                    pos = open_pos(i, pending, fill, fill == o[i])
                    intrabar = pos is not None and not pos.at_open
                    pending = None
        # 2b. liquidation, stop and target
        if pos is not None and (pos.entry_i < i or pos.at_open or intrabar):
            sd = pos.side
            hit = None
            lq = liq_price(pos)
            if lq is not None and ((sd > 0 and l[i] <= lq) or (sd < 0 and h[i] >= lq)) and \
                    (pos.stop is None or (sd > 0 and pos.stop < lq) or (sd < 0 and pos.stop > lq)):
                gap = (sd > 0 and o[i] <= lq) or (sd < 0 and o[i] >= lq)
                liquidate(i, o[i] if gap and not intrabar else lq)
            elif pos.stop is not None and ((sd > 0 and l[i] <= pos.stop) or (sd < 0 and h[i] >= pos.stop)):
                gap = (sd > 0 and o[i] <= pos.stop) or (sd < 0 and o[i] >= pos.stop)
                hit = (o[i] if gap and not intrabar else pos.stop, "Stop")
            elif not intrabar and pos.target is not None and ((sd > 0 and h[i] >= pos.target) or (sd < 0 and l[i] <= pos.target)):
                gap = (sd > 0 and o[i] >= pos.target) or (sd < 0 and o[i] <= pos.target)
                hit = (o[i] if gap else pos.target, "Target")
            if hit:
                close_pos(i, *hit)
        # 3. funding settled during this candle
        if len(ft):
            while fj < len(ft) and ft[fj] <= t[i] + iv:
                if pos is not None:
                    pay = pos.side * pos.qty * c[i] * fr[fj]
                    pos.funding -= pay
                    cash -= pay
                fj += 1
            if pos is not None and cash + pos.side * pos.qty * (c[i] - pos.entry_px) <= MAINTENANCE * pos.qty * c[i]:
                liquidate(i, c[i])
        # 4. time exit
        if pos is not None and pos.max_bars:
            held = i - pos.entry_i + (1 if pos.at_open else 0)
            if held >= pos.max_bars:
                close_pos(i, c[i], "Time")
        # 5. the strategy, at the close
        orders.entry = orders.exit_tag = orders.new_stop = orders.new_target = None
        orders.pending = pending
        strategy.on_bar(i, pos, orders)
        if orders.pending is None:
            pending = None                                 # the strategy cancelled it
        if pos is not None:
            if orders.new_stop is not None:
                pos.stop = orders.new_stop
            if orders.new_target is not None:
                pos.target = orders.new_target
            if orders.exit_tag:
                if s.fill == "close":
                    close_pos(i, c[i], orders.exit_tag)
                else:
                    exit_tag = orders.exit_tag
        if orders.entry is not None:
            e = orders.entry
            if e.kind == "market":
                if s.fill == "close" and pos is None:
                    pos = open_pos(i, e, c[i], False)
                elif pos is None or exit_tag:
                    pending = e
            else:
                e.expires = i + max(1, int(e.expires or 1))     # `valid` candles after this one
                pending = e
        if pos is not None:
            exposure[i] = True
            equity[i] = cash + pos.side * pos.qty * (c[i] - pos.entry_px)
        else:
            equity[i] = cash
        if progress and i % 20000 == 0:
            progress(i / max(n, 1))
    if pos is not None:
        close_pos(n - 1, c[-1], "End of data")
        equity[-1] = cash
    return Result(trades, equity, exposure, s, skipped, lev_max, liquidations)
