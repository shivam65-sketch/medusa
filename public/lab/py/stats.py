"""Numbers for the report, from an engine Result and its candles. `tz` (ms east of UTC) sets where days,
months and years begin: the Lab passes your time zone; 0 is UTC."""
import math
from datetime import datetime, timezone

import numpy as np

DAY = 86_400_000


def _ymd(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc)


def daily_equity(t, equity, tz=0):
    """Equity at the last candle of each day: (day start ms array, values)."""
    days = ((t + tz) // DAY) * DAY - tz
    last = np.r_[np.nonzero(np.diff(days))[0], len(days) - 1]
    return days[last], equity[last]


def drawdown(equity):
    peak = np.maximum.accumulate(equity)
    return equity / np.where(peak > 0, peak, np.nan) - 1      # 0 at highs, negative below


def streaks(signs):
    best = cur = 0
    last = 0
    out = {1: 0, -1: 0}
    for s in signs:
        cur = cur + 1 if s == last and s != 0 else (1 if s != 0 else 0)
        last = s
        if s:
            out[s] = max(out[s], cur)
    return out[1], out[-1]


def trade_stats(trades):
    n = len(trades)
    if not n:
        return {"n": 0}
    pnl = np.array([x["pnl"] for x in trades])
    wins, losses = pnl[pnl > 0], pnl[pnl < 0]
    rs = np.array([x["r"] for x in trades if x["r"] is not None])
    st = {
        "n": n, "wins": int((pnl > 0).sum()), "losses": int((pnl < 0).sum()),
        "win_rate": float((pnl > 0).mean()),
        "net": float(pnl.sum()), "avg": float(pnl.mean()),
        "avg_win": float(wins.mean()) if len(wins) else 0.0, "avg_loss": float(losses.mean()) if len(losses) else 0.0,
        "profit_factor": float(wins.sum() / -losses.sum()) if len(losses) and losses.sum() < 0 else (math.inf if len(wins) else 0.0),
        "best": float(pnl.max()), "worst": float(pnl.min()),
        "fees": float(sum(x["fees"] for x in trades)), "slippage": float(sum(x["slippage"] for x in trades)),
        "funding": float(sum(x["funding"] for x in trades)),
        "avg_bars": float(np.mean([x["bars"] for x in trades])),
        "longs": sum(1 for x in trades if x["side"] > 0), "shorts": sum(1 for x in trades if x["side"] < 0),
    }
    st["payoff"] = st["avg_win"] / -st["avg_loss"] if st["avg_loss"] < 0 else math.inf
    st["max_wins"], st["max_losses"] = streaks(np.sign(pnl).astype(int))
    if len(rs):
        st["r_n"] = len(rs)
        st["r_avg"] = float(rs.mean())
        st["r_total"] = float(rs.sum())
        st["r_t"] = float(rs.mean() / rs.std(ddof=1) * math.sqrt(len(rs))) if len(rs) > 2 and rs.std(ddof=1) > 0 else 0.0
    return st


def summary(d, res, bh_equity=None, tz=0):
    """Account-level numbers: return, CAGR, drawdown, Sharpe, exposure, plus trade stats."""
    t, eq = d.t, res.equity
    cap = res.settings.capital
    years = max((t[-1] - t[0]) / (365.25 * DAY), 1e-9)
    final = float(eq[-1])
    dd = drawdown(eq)
    out = {
        "start": int(t[0]), "end": int(t[-1]), "years": years, "candles": len(t),
        "capital": cap, "final": final, "net": final - cap, "return": final / cap - 1,
        "cagr": (final / cap) ** (1 / years) - 1 if final > 0 and years > 0.08 else None,
        "max_dd": float(-dd.min()) if len(dd) else 0.0,
        "exposure": float(res.exposure.mean()),
        "max_leverage_used": res.max_leverage_used, "skipped": res.skipped, "liquidations": res.liquidations,
    }
    # longest time under water (in days)
    under = dd < -1e-12
    longest, run_start = 0, None
    for k, u in enumerate(under):
        if u and run_start is None:
            run_start = k
        if (not u or k == len(under) - 1) and run_start is not None:
            longest = max(longest, int(t[k] - t[run_start]))
            run_start = None
    out["longest_dd_days"] = longest / DAY
    _, deq = daily_equity(t, eq, tz)
    with np.errstate(divide="ignore", invalid="ignore"):
        rets = np.diff(deq) / deq[:-1] if len(deq) > 2 else np.array([])
    rets = rets[np.isfinite(rets)]
    out["sharpe"] = float(rets.mean() / rets.std(ddof=1) * math.sqrt(365)) if len(rets) > 2 and rets.std(ddof=1) > 0 else 0.0
    neg = rets[rets < 0]
    out["sortino"] = float(rets.mean() / math.sqrt((neg ** 2).mean()) * math.sqrt(365)) if len(neg) > 2 else 0.0
    out["calmar"] = out["cagr"] / out["max_dd"] if out["cagr"] is not None and out["max_dd"] > 0 else None
    if bh_equity is not None:
        out["bh_return"] = float(bh_equity[-1] / bh_equity[0] - 1)
        out["bh_max_dd"] = float(-drawdown(bh_equity).min())
    out["trades"] = trade_stats(res.trades)
    return out


def by_year(d, res, tz=0):
    """[(year, return %, trades, net)] from the equity curve."""
    t, eq = d.t, res.equity
    years = np.array([_ymd(x + tz).year for x in t[::max(1, len(t) // 5000)]])  # rough list of years present
    out = []
    for y in sorted(set(years.tolist()) | {_ymd(t[-1] + tz).year}):
        y0 = int(datetime(y, 1, 1, tzinfo=timezone.utc).timestamp() * 1000) - tz
        y1 = int(datetime(y + 1, 1, 1, tzinfo=timezone.utc).timestamp() * 1000) - tz
        m = (t >= y0) & (t < y1)
        if not m.any():
            continue
        first = int(np.argmax(m))
        start = eq[first - 1] if first > 0 else res.settings.capital
        end = eq[np.nonzero(m)[0][-1]]
        tr = [x for x in res.trades if y0 <= x["exit_t"] < y1]
        out.append({"year": y, "return": float(end / start - 1) if start > 0 else 0.0, "trades": len(tr),
                    "net": float(sum(x["pnl"] for x in tr))})
    return out


def monthly(d, res, tz=0):
    """{year: [12 monthly returns or None]}."""
    t, eq = d.t, res.equity
    out = {}
    keys = np.array([_ymd(x + tz).year * 12 + _ymd(x + tz).month - 1 for x in t])
    change = np.r_[0, np.nonzero(np.diff(keys))[0] + 1]
    for k, s0 in enumerate(change):
        s1 = change[k + 1] if k + 1 < len(change) else len(t)
        start = eq[s0 - 1] if s0 > 0 else res.settings.capital
        end = eq[s1 - 1]
        y, m = divmod(int(keys[s0]), 12)
        out.setdefault(y, [None] * 12)[m] = float(end / start - 1) if start > 0 else None
    return out


def split(d, res, at_ms):
    """Trades and return before / from a date (the held-back check)."""
    t, eq = d.t, res.equity
    k = int(np.searchsorted(t, at_ms))
    parts = {}
    for name, lo, hi in (("before", 0, k), ("after", k, len(t))):
        if hi <= lo:
            parts[name] = None
            continue
        start = eq[lo - 1] if lo > 0 else res.settings.capital
        tr = [x for x in res.trades if (x["entry_t"] < at_ms) == (name == "before")]
        sub = eq[lo:hi]
        dd = drawdown(np.r_[start, sub])
        parts[name] = {"return": float(sub[-1] / start - 1) if start > 0 else 0.0, "max_dd": float(-dd.min()),
                       "from": int(t[lo]), "to": int(t[hi - 1]), "trades": trade_stats(tr)}
    return parts


def warnings(sm, gross=None):
    w = []
    ts = sm["trades"]
    n = ts.get("n", 0)
    if n == 0:
        w.append("No trades. Check the settings, the date range, or whether the data is long enough for the indicators.")
        return w
    if n < 30:
        w.append(f"Only {n} trade{'' if n == 1 else 's'}: far too few to tell skill from luck. Results this small swing wildly with a few trades.")
    elif n < 100:
        w.append(f"{n} trades is still a small sample; treat the numbers as rough.")
    if ts.get("r_n", 0) > 2 and abs(ts.get("r_t", 0)) < 2:
        w.append(f"The average trade isn't clearly different from zero (t = {ts['r_t']:.2f}; about 2 or more is needed).")
    if gross is not None and gross["net"] > 0 and sm["net"] <= 0:
        w.append("Profitable before costs but not after: fees, slippage and funding eat the whole edge.")
    if sm["max_dd"] > 0.5:
        w.append(f"The worst drawdown was {sm['max_dd']:.0%}. Few people keep trading a system through that.")
    if sm.get("liquidations"):
        w.append(f"The account was liquidated {sm['liquidations']} time(s): equity fell to the exchange's maintenance margin "
                 "and the rest was lost. Use less leverage, or remember that funding on a long-held futures position adds up.")
    elif sm["max_leverage_used"] > 5:
        w.append(f"Positions used up to {sm['max_leverage_used']:.1f}x leverage; a fast move could liquidate the account.")
    if sm.get("skipped"):
        w.append(f"{sm['skipped']} entries were skipped (stop on the wrong side of the price, or no money left).")
    w.append("A backtest picked after trying many settings looks better than the future will. Judge settings on a "
             "held-back period, or forward-test before trading real money.")
    return w
