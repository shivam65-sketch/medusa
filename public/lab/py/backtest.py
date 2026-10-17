"""One backtest, start to finish: the part of MEDUSA Lab that turns a strategy, its settings and the candles
into a report. The Dashboard (through labrun.py), the Python tab and every exported .py file all run this
same function, so they give the same numbers.

    run_backtest(strategy_class, cfg, meta, cols, progress=None) -> report (a dict)

cfg   the settings: strategy params (lengths in candles), costs, sizing, fills, and optionally the dates as
      start_ms / end_ms (or start / end "YYYY-MM-DD", read in the time zone tz_offset_min minutes east of UTC),
      split_ms / split for the held-back check
meta  the data: symbol, market ("futures" / "spot"), interval ("1m" ... "1w"), source, id, name
cols  numpy arrays t (open times, ms UTC) o h l c v, and optional tbv, ft / fr (funding times and rates)

Warm-up: the indicators need history before the first trade, as much as the strategy's warmup() says for
the settings used (an EMA of n candles needs 4n, an RSI or ATR 8n, a plain average or channel n). The test
starts at the start date, or at the end of the warm-up if that is later; the warm-up candles are used only
to compute the indicators.
"""
import math
import time
from dataclasses import replace
from datetime import datetime, timezone

import numpy as np

import engine
import stats as ST

DAY = 86_400_000
MAX_EQUITY_POINTS = 2000


def settings_from(cfg):
    def num(k, d, lo, hi):
        try:
            v = float(cfg.get(k, d))
        except (TypeError, ValueError):
            v = d
        return min(max(v if math.isfinite(v) else d, lo), hi)
    return engine.Settings(
        fee=num("fee_pct", 0.05, 0, 2) / 100, slippage=num("slippage_pct", 0.05, 0, 5) / 100,
        funding=bool(cfg.get("funding", True)), capital=num("capital", 1000, 1, 1e12),
        sizing="notional" if cfg.get("sizing") == "notional" else "risk", risk_pct=num("risk_pct", 1, 0.01, 100),
        notional_pct=num("notional_pct", 100, 1, 10000), max_leverage=num("max_leverage", 3, 0.1, 125),
        compounding=bool(cfg.get("compounding", True)), fill="close" if cfg.get("fill") == "close" else "next_open")


def tz_ms(cfg):
    """The time zone used for dates and for days, months and years in the report (ms east of UTC)."""
    try:
        return int(round(float(cfg.get("tz_offset_min") or 0))) * 60_000
    except (TypeError, ValueError):
        return 0


def date_ms(cfg, key):
    """cfg[key + "_ms"] if given, else cfg[key] ("YYYY-MM-DD") at 00:00 in the report's time zone; None if absent."""
    v = cfg.get(key + "_ms")
    if isinstance(v, (int, float)) and math.isfinite(v):
        return int(v)
    text = cfg.get(key)
    if not text:
        return None
    try:
        day = datetime.strptime(str(text)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return int(day.timestamp() * 1000) - tz_ms(cfg)


def _arr(x, dtype=np.float64):
    """A column: a numpy array or list, or a JavaScript Float64Array in the browser."""
    if x is None or type(x).__name__ in ("JsNull", "JsUndefined"):
        return None
    if hasattr(x, "assign_to"):
        a = np.empty(x.length, dtype=np.float64)
        x.assign_to(a)
        return a.astype(dtype) if dtype is not np.float64 else a
    return np.asarray(x, dtype=dtype)


def column(cols, k):
    return _arr(cols.get(k) if isinstance(cols, dict) else getattr(cols, k, None))


def _thin(t, *series):
    k = max(1, len(t) // MAX_EQUITY_POINTS)
    idx = np.unique(np.r_[np.arange(0, len(t), k), len(t) - 1])
    return [t[idx].tolist()] + [np.round(s[idx], 6).tolist() for s in series]


def run_backtest(cls, cfg, meta, cols, progress=None):
    t_start = time.time()
    say = progress or (lambda f, m: None)
    market = "spot" if meta.get("market") == "spot" else "futures"
    interval = meta.get("interval")
    if interval not in engine.INTERVAL_MS:
        raise ValueError(f"Unknown timeframe {interval!r}.")
    iv = engine.INTERVAL_MS[interval]
    tz = tz_ms(cfg)
    t = column(cols, "t").astype(np.int64)
    o, h, l, c, v = (column(cols, k) for k in "ohlcv")
    tbv = column(cols, "tbv")
    ft, fr = column(cols, "ft"), column(cols, "fr")
    params = dict(cfg.get("params") or {})
    notes = []
    s = settings_from(cfg)
    if market == "spot":                                           # spot: no shorting, no leverage, no funding
        s = replace(s, funding=False, max_leverage=min(s.max_leverage, 1.0))
        if any(p.key == "direction" for p in cls.all_params()) and params.get("direction", "both") != "long":
            params["direction"] = "long"
            notes.append("Spot can't be shorted, so only the long trades were taken (use a futures dataset to test shorts).")
    strat = cls(params)
    warm_need = max(0, int(strat.warmup(iv)))
    start, end = date_ms(cfg, "start"), date_ms(cfg, "end")
    lo = int(np.searchsorted(t, start)) if start is not None else 0
    hi = int(np.searchsorted(t, end + DAY)) if end is not None else len(t)
    first = max(lo, warm_need)                                     # the first candle of the test
    if hi - first < 2:
        raise ValueError(f"Not enough candles: the indicators need {warm_need:,} candles of history before the first trade "
                         f"(from the settings), and the chosen data has {hi - lo:,} candles"
                         + (f" with {lo:,} before the start date." if start is not None else ".")
                         + " Use more data, an earlier start, or shorter indicator settings.")
    if start is not None and first > lo:
        notes.append(f"The file has only {lo:,} candles before the start date, but these settings need {warm_need:,} for the "
                     f"indicators, so the test starts {first - lo:,} candles later than asked.")
    warm = min(first, warm_need)                                   # candles before the test used for the indicators
    sw, sl = slice(first - warm, hi), slice(first, hi)
    extra = {"tbv": tbv[sw]} if tbv is not None else {}
    if ft is not None and fr is not None and len(ft):              # strategies may read the rates (funding_fade does)
        extra.update(funding_t=ft.astype(np.int64), funding_r=fr)
    full = engine.Candles(t=t[sw], o=o[sw], h=h[sw], l=l[sw], c=c[sw], v=v[sw], interval=interval,
                          symbol=str(meta.get("symbol", "")), market=market, extra=extra)
    d = engine.Candles(t=t[sl], o=o[sl], h=h[sl], l=l[sl], c=c[sl], v=v[sl], interval=interval,
                       symbol=full.symbol, market=market, extra={"tbv": tbv[sl]} if tbv is not None else {})
    funding = None
    if market == "futures" and s.funding:
        if ft is not None and len(ft):
            funding = (ft.astype(np.int64), fr)
        else:
            s = replace(s, funding=False)
            notes.append("This data has no funding rates, so funding payments are not included. Download futures data with "
                         "\"Include funding rates\" (uploads keep them when you upload MEDUSA's ZIP file).")
    say(0.05, f"Simulating {len(d):,} candles")
    res = engine.run(full, cls(params), s, funding, progress=lambda f: say(0.05 + 0.55 * f, f"Simulating {len(d):,} candles"), start_i=warm)
    say(0.62, "Same again without costs, for comparison")
    gross = engine.run(full, cls(params), replace(s, fee=0.0, slippage=0.0, funding=False),
                       progress=lambda f: say(0.62 + 0.28 * f, "Same again without costs, for comparison"), start_i=warm)
    if warm:                                                       # the report covers the tested range only
        res = replace(res, equity=res.equity[warm:], exposure=res.exposure[warm:])
        gross = replace(gross, equity=gross.equity[warm:], exposure=gross.exposure[warm:])
    say(0.92, "Adding up the numbers")
    bh = s.capital * d.c / d.c[0]
    sm = ST.summary(d, res, bh, tz)
    gs = ST.summary(d, gross, bh, tz)
    split_ms = date_ms(cfg, "split")

    def group(rows):
        return [[k, ST.trade_stats(tr)] for k, tr in rows if tr]

    trades = res.trades
    out = {
        "v": 2,
        "title": f"{d.symbol} · {interval} · {strat.label}",
        "meta": {
            "symbol": d.symbol, "market": market, "source": meta.get("source"), "interval": interval, "dataset": meta.get("id"),
            "dataset_name": meta.get("name"), "from": int(d.t[0]), "to": int(d.t[-1]), "candles": len(d), "warmup": warm,
            "slice_from": int(full.t[0]), "funding_from": int(ft[0]) if ft is not None and len(ft) else None,
            "funding_to": int(ft[-1]) if ft is not None and len(ft) else None, "funding_n": int(len(ft)) if ft is not None else 0,
            "warmup_needed": warm_need, "tz_offset_min": tz // 60_000, "interval_ms": iv, "strategy": cfg.get("strategy"),
            "strategy_label": strat.label, "settings_text": strat.settings_text(), "params": vars(strat.p),
            "made": int(time.time() * 1000), "seconds": round(time.time() - t_start, 1),
        },
        "config": cfg,
        "settings": {"fee": s.fee, "slippage": s.slippage, "funding": funding is not None, "capital": s.capital, "sizing": s.sizing,
                     "risk_pct": s.risk_pct, "notional_pct": s.notional_pct, "max_leverage": s.max_leverage,
                     "compounding": s.compounding, "fill": s.fill},
        "summary": sm,
        "gross": gs,
        "warnings": notes + ST.warnings(sm, gs),
        "years": ST.by_year(d, res, tz),
        "monthly": ST.monthly(d, res, tz),
        "split_at": split_ms,
        "split": ST.split(d, res, split_ms) if split_ms else None,
        "groups": {
            "side": group([("Long", [x for x in trades if x["side"] > 0]), ("Short", [x for x in trades if x["side"] < 0])]),
            "reason": group([(r, [x for x in trades if x["reason"] == r]) for r in sorted({x["reason"] for x in trades})]),
        },
        "equity": dict(zip(["t", "s", "bh", "dd"], _thin(d.t, res.equity, bh, np.nan_to_num(ST.drawdown(res.equity), nan=-1.0)))),
        "rs": [round(x["r"], 3) for x in trades if x["r"] is not None],
        "trades": [{"side": x["side"], "et": x["entry_t"], "ep": x["entry"], "xt": x["exit_t"], "xp": x["exit"],
                    "pnl": round(x["pnl"], 6), "r": None if x["r"] is None else round(x["r"], 4), "ret": round(x["ret"], 6),
                    "why": x["reason"], "bars": x["bars"], "stop": x["stop"], "tp": x["target"], "tag": x["tag"],
                    "fees": round(x["fees"], 6), "fund": round(x["funding"], 6), "qty": x["qty"], "lev": round(x["leverage"], 3)}
                   for x in trades],
    }
    out["meta"]["seconds"] = round(time.time() - t_start, 1)
    say(1.0, "Done")
    return out


def clean(v):
    """For JSON: no inf/NaN (infinity becomes "inf", NaN null), numpy numbers become plain ones."""
    if isinstance(v, dict):
        return {str(k): clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if isinstance(v, (np.floating, float)):
        v = float(v)
        return v if math.isfinite(v) else ("inf" if v == math.inf else "-inf" if v == -math.inf else None)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, np.ndarray):
        return clean(v.tolist())
    return v
