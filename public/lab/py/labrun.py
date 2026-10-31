"""MEDUSA Lab in the browser: the bridge between the Lab page and the backtest engine.

The page runs Python with Pyodide inside a background worker (public/lab/py-worker.js), which calls:
  load_strategies(files_json)   register strategy files (built-in and your own); returns the catalog
  check(source)                 test a strategy file before it is saved: syntax, settings, a short run
                                on made-up candles, and the look-ahead check
  run(cfg_json, meta_json, cols, progress)
                                one backtest (with and without costs) -> everything the report shows;
                                the work is done by backtest.run_backtest, the same function the Python tab
                                and every exported .py file run
  warmup(key, params_json, interval)
                                candles of history a strategy needs with these settings (shown in the form)
  plots(key, params_json, meta_json, cols)
                                the strategy's own indicator lines, for the Lab's Chart tab
Everything returned is JSON text.
"""
import base64
import importlib
import json
import os
import sys
import time
import traceback

import numpy as np

import backtest as BT
import engine
from backtest import _arr  # noqa: F401  (console.py uses it)
from strategy import Strategy

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = {}            # strategy key -> class
INFO = {}           # strategy key -> {"origin", "id", "name", "doc"}
ERRORS = []         # files that failed to load: {"origin", "id", "name", "error"}


# ---------- strategy files ----------

def _package(name):
    """A folder next to this file that Python imports as a package (strategies, mine)."""
    path = os.path.join(HERE, name)
    os.makedirs(path, exist_ok=True)
    init = os.path.join(path, "__init__.py")
    if not os.path.exists(init):
        open(init, "w").close()
    return path


def _module_name(origin, file_id):
    return f"strategies.{file_id}" if origin == "builtin" else f"mine.s_{file_id}"


def _import(origin, file_id, source):
    """Write the file and import it fresh; returns the Strategy classes defined in it."""
    folder = _package("strategies" if origin == "builtin" else "mine")
    modname = _module_name(origin, file_id)
    with open(os.path.join(folder, modname.split(".")[1] + ".py"), "w", encoding="utf-8") as f:
        f.write(source)
    sys.modules.pop(modname, None)
    importlib.invalidate_caches()
    mod = importlib.import_module(modname)
    return mod, [c for c in vars(mod).values()
                 if isinstance(c, type) and issubclass(c, Strategy) and c is not Strategy and c.__module__ == modname and getattr(c, "key", "")]


def _key(origin, file_id, cls):
    return cls.key if origin == "builtin" else f"mine:{file_id}:{cls.key}"


def load_strategies(files_json, origins_json="[]"):
    """files: [{"origin": "builtin"|"mine", "id", "name", "source"}]. Every strategy loaded before
    from an origin in `origins` (or in the list) is replaced."""
    files = json.loads(files_json)
    for origin in {f["origin"] for f in files} | set(json.loads(origins_json)):
        for k in [k for k, v in INFO.items() if v["origin"] == origin]:
            LIB.pop(k, None)
            INFO.pop(k, None)
        ERRORS[:] = [e for e in ERRORS if e["origin"] != origin]
    for f in files:
        origin, file_id = f["origin"], str(f["id"])
        try:
            mod, classes = _import(origin, file_id, f["source"])
            if not classes:
                raise ValueError("No strategy class found. A strategy is a class based on Strategy with a `key`.")
            for cls in classes:
                cls.describe()                                     # fails early on broken settings
                key = _key(origin, file_id, cls)
                LIB[key] = cls
                INFO[key] = {"origin": origin, "id": file_id, "name": f.get("name") or file_id,
                             "doc": (mod.__doc__ or "").strip()[:4000]}
        except Exception as e:                                     # one bad file must not hide the others
            ERRORS.append({"origin": origin, "id": file_id, "name": f.get("name") or file_id, "error": _short_error(e)})
    return catalog()


def catalog():
    items = []
    for key, cls in sorted(LIB.items(), key=lambda kv: (INFO[kv[0]]["origin"] != "builtin", getattr(kv[1], "order", 50), kv[1].label)):
        d = cls.describe()
        d["key"] = key
        d.update({k: INFO[key][k] for k in ("origin", "id", "name", "doc")})
        items.append(d)
    return _dumps({"strategies": items, "errors": ERRORS})


def _short_error(e):
    """The error and the lines of the strategy file it happened on (not the engine's internals)."""
    tb = traceback.extract_tb(e.__traceback__)
    mine = [fr for fr in tb if any(f"{sep}{p}{sep}" in fr.filename for p in ("strategies", "mine") for sep in "/\\")
            or fr.filename.startswith("<")]
    where = ""
    if mine:
        fr = mine[-1]
        where = f" (line {fr.lineno}: {fr.line.strip()})" if fr.line else f" (line {fr.lineno})"
    elif isinstance(e, SyntaxError) and e.lineno:
        where = f" (line {e.lineno}: {(e.text or '').strip()})"
    return f"{type(e).__name__}: {e}{where}"


# ---------- checking a new strategy file ----------

def _test_candles(n=1600, seed=7):
    """Made-up hourly candles with up-trends, ranges and down-trends, so most strategies trade."""
    rng = np.random.default_rng(seed)
    drift = np.repeat(rng.choice([0.0012, 0.0, -0.0012, 0.0, 0.0006, -0.0006], size=n // 100 + 1), 100)[:n]
    close = 100 * np.exp(np.cumsum(drift + rng.normal(0, 0.008, n)))
    open_ = np.r_[100.0, close[:-1]]
    wick = np.abs(rng.normal(0, 0.004, n))
    high = np.maximum(open_, close) * (1 + wick)
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.004, n)))
    t = 1_700_000_000_000 + np.arange(n, dtype=np.int64) * 3_600_000      # int64: numpy's default int is 32-bit in the browser
    return engine.Candles(t=t, o=open_, h=high, l=low, c=close, v=rng.uniform(100, 1000, n), interval="1h", symbol="TEST", market="futures")


def _future_changed(d, k, factor):
    """The same candles up to k; after k every price is multiplied by `factor` (a jump up or a crash)."""
    f = np.r_[np.ones(k + 1), np.full(len(d) - k - 1, factor)]
    return engine.Candles(t=d.t, o=d.o * f, h=d.h * f, l=d.l * f, c=d.c * f, v=d.v, interval=d.interval, symbol=d.symbol, market=d.market)


def _r(x):
    return None if x is None else round(float(x), 9)


def _decisions(cls, d, zero):
    """Run once, recording every order the strategy places at every candle close."""
    strat, log = cls(), []
    plain = strat.on_bar

    def on_bar(i, pos, orders):
        plain(i, pos, orders)
        e = orders.entry
        log.append((i, None if e is None else (e.side, e.kind, _r(e.price), _r(e.stop), _r(e.stop_dist), _r(e.target), _r(e.target_r), e.max_bars),
                    orders.exit_tag, _r(orders.new_stop), _r(orders.new_target)))

    strat.on_bar = on_bar
    res = engine.run(d, strat, zero)
    return log, strat, res


def _first_diff(a, b):
    if a.dtype.kind == "f" and b.dtype.kind == "f":
        diff = ~((a == b) | (np.isnan(a) & np.isnan(b)))
    else:
        diff = a != b
    nz = np.nonzero(diff)[0]
    return int(nz[0]) if len(nz) else None


def _peeks(cls, d, zero):
    """Look-ahead check: change the future after candle k; nothing the strategy computed or decided up to
    k may change. Returns (description of the first difference or None, the normal run's result)."""
    base_log, base, res = _decisions(cls, d, zero)
    arrays = {k: v for k, v in vars(base).items() if isinstance(v, np.ndarray) and v.ndim == 1 and len(v) == len(d)}
    for k in (450, 800, 1150, 1400):
        for factor in (1.6, 0.6):
            log, alt, _ = _decisions(cls, _future_changed(d, k, factor), zero)
            for name, a in arrays.items():
                b = getattr(alt, name, None)
                if isinstance(b, np.ndarray) and b.shape == a.shape:
                    j = _first_diff(a[:k + 1], b[:k + 1])
                    if j is not None:
                        return f"self.{name}[{j}] changed when only candles after {k} were changed", res
            if log[:k + 1] != base_log[:k + 1]:
                j = next(n for n, (x, y) in enumerate(zip(log, base_log)) if x != y)
                return f"its orders on candle {j} changed when only candles after {k} were changed", res
    return None, res


def check(source):
    """Is this file a working strategy? Returns {"ok", "error", "strategies": [...], "notes": [...]}."""
    out = {"ok": False, "error": None, "strategies": [], "notes": []}
    try:
        compile(source, "your strategy", "exec")
    except SyntaxError as e:
        out["error"] = f"Python can't read line {e.lineno}: {e.msg}." + (f"\n    {e.text.strip()}" if e.text else "")
        return _dumps(out)
    try:
        _, classes = _import("mine", "check", source)
    except Exception as e:
        out["error"] = "The file stopped while loading: " + _short_error(e)
        return _dumps(out)
    if not classes:
        out["error"] = ("No strategy class found. Make a class based on Strategy with a key, a label and an on_bar method "
                        "(start from the template).")
        return _dumps(out)
    d = _test_candles()
    zero = engine.Settings(fee=0, slippage=0, funding=False)
    for cls in classes:
        info = {"key": cls.key, "label": getattr(cls, "label", cls.key)}
        try:
            info.update(cls.describe())
            t0 = time.time()
            problem, full = _peeks(cls, d, zero)
            info["trades"] = len(full.trades)
            info["seconds"] = round(time.time() - t0, 2)
            if problem:
                info["lookahead"] = True
                out["notes"].append(f"{info['label']} LOOKS AHEAD: {problem}. It uses information from the future (for example "
                                    "c[i + 1], an average centred on i, or a max/min over the whole array), so its backtests "
                                    "would look far better than reality.")
            elif not full.trades:
                out["notes"].append(f"{info['label']}: made no trades on the test candles, so its orders couldn't be checked for "
                                    "look-ahead (its indicators were). That can be fine, for example with very long settings.")
        except Exception as e:
            info["error"] = _short_error(e)
        out["strategies"].append(info)
    errors = [s for s in out["strategies"] if s.get("error")]
    if errors:
        out["error"] = "\n".join(f"{s['label']}: {s['error']}" for s in errors)
    out["ok"] = not errors and not any(s.get("lookahead") for s in out["strategies"])
    return _dumps(out)


# ---------- one backtest ----------

def run(cfg_json, meta_json, cols, progress=None):
    """cfg: the form (strategy, params, costs, sizing, fills, dates). meta: the dataset (symbol, market,
    source, interval). cols: t o h l c v [tbv] [ft fr] columns. Returns the report as JSON text."""
    cfg, meta = json.loads(cfg_json), json.loads(meta_json)
    key = cfg.get("strategy")
    if key not in LIB:
        raise ValueError("That strategy isn't loaded. Pick one from the list.")
    return _dumps(BT.run_backtest(LIB[key], cfg, meta, cols, progress))


def warmup(key, params_json, interval):
    """Candles of history a strategy needs with these settings on this timeframe (the form shows it)."""
    if key not in LIB or interval not in engine.INTERVAL_MS:
        return 0
    return int(LIB[key](json.loads(params_json or "{}")).warmup(engine.INTERVAL_MS[interval]))


MAX_PLOTS = 12
SCALE_TEST_CANDLES = 20_000


def _in_price(key, params, d):
    """The names of the arrays a strategy keeps that are measured in price: multiply every price by 10 and
    they grow 10 times too. A counter of candles, an RSI or a z-score doesn't change, however close its
    numbers happen to be to this coin's price. None if the strategy can't be run this way."""
    n = min(len(d), SCALE_TEST_CANDLES)

    def arrays(scale):
        strat = LIB[key](params)
        extra = {k: v[-n:] if k == "tbv" else v for k, v in d.extra.items()}
        strat.prepare(engine.Candles(t=d.t[-n:], o=d.o[-n:] * scale, h=d.h[-n:] * scale, l=d.l[-n:] * scale, c=d.c[-n:] * scale,
                                     v=d.v[-n:], interval=d.interval, symbol=d.symbol, market=d.market, extra=extra))
        return vars(strat)

    try:
        base, big = arrays(1.0), arrays(10.0)
    except Exception:
        return None
    names = set()
    for name, a in base.items():
        b = big.get(name)
        if isinstance(a, np.ndarray) and isinstance(b, np.ndarray) and a.dtype.kind == "f" and a.shape == b.shape:
            ok = np.isfinite(a) & np.isfinite(b) & (a != 0)
            if ok.sum() >= 2 and np.allclose(b[ok], a[ok] * 10, rtol=1e-6, atol=0):
                names.add(name)
    return names


def plots(key, params_json, meta_json, cols):
    """The lines a strategy computes in prepare(), for drawing on the Chart tab: every 1-D float array of one
    value per candle that it keeps on self (self.upper, self.atr ...), except copies of the prices. A line
    goes on the candles when it is measured in price and sits near it; any other (an ATR, an RSI, a candle
    counter) gets a pane of its own, which is off until it is chosen.
    meta: from/to (ms, the candles the backtest used, warm-up included), interval, symbol, market.
    Returns JSON: {"start": time of the first value, "n", "plots": [{"name", "kind": "price"|"pane", "b64"}]}
    with the values as little-endian float32 (NaN where there is none), or {"error"}."""
    try:
        if key not in LIB:
            return _dumps({"error": "That strategy isn't loaded (it may have been deleted)."})
        meta = json.loads(meta_json)
        t = BT.column(cols, "t").astype(np.int64)
        lo = int(np.searchsorted(t, int(meta["from"])))
        hi = int(np.searchsorted(t, int(meta["to"]), side="right"))
        if hi - lo < 2:
            return _dumps({"error": "The data file doesn't have the candles of this result any more."})
        o, h, l, c, v = (BT.column(cols, k)[lo:hi] for k in "ohlcv")
        extra = {}
        tbv = BT.column(cols, "tbv")
        if tbv is not None:
            extra["tbv"] = tbv[lo:hi]
        ft, fr = BT.column(cols, "ft"), BT.column(cols, "fr")
        if ft is not None and fr is not None and len(ft):
            extra.update(funding_t=ft.astype(np.int64), funding_r=fr)
        d = engine.Candles(t=t[lo:hi], o=o, h=h, l=l, c=c, v=v, interval=str(meta.get("interval") or "1h"),
                           symbol=str(meta.get("symbol", "")), market=str(meta.get("market", "")), extra=extra)
        params = json.loads(params_json or "{}")
        strat = LIB[key](params)
        strat.prepare(d)
        n, out = len(d), []
        priced = _in_price(key, params, d)
        prices = (d.o, d.h, d.l, d.c, d.v)
        absc = np.abs(d.c)
        for name, a in vars(strat).items():
            if (name.startswith("_") or not isinstance(a, np.ndarray) or a.ndim != 1 or len(a) != n
                    or a.dtype.kind != "f" or any(a is x or np.array_equal(a, x, equal_nan=True) for x in prices)):
                continue
            ok = np.isfinite(a) & (absc > 0)
            if ok.sum() < 2:
                continue
            ratio = float(np.median(np.abs(a[ok]) / absc[ok]))
            near = 0.5 <= ratio <= 2 and (priced is None or name in priced)
            out.append({"name": name, "kind": "price" if near else "pane",
                        "b64": base64.b64encode(np.asarray(a, dtype="<f4").tobytes()).decode()})
            if len(out) >= MAX_PLOTS:
                break
        return _dumps({"start": int(d.t[0]), "n": n, "plots": out})
    except Exception as e:
        return _dumps({"error": _short_error(e)})


def run_safe(cfg_json, meta_json, cols, progress=None):
    """run(), but a failure comes back as {"error", "trace"} instead of an exception."""
    try:
        return run(cfg_json, meta_json, cols, progress)
    except MemoryError:
        return _dumps({"error": "The browser ran out of memory. Pick a shorter date range or a bigger timeframe."})
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        own = isinstance(e, ValueError) and tb and os.path.basename(tb[-1].filename) in ("labrun.py", "backtest.py")
        return _dumps({"error": str(e) if own else _short_error(e), "trace": "" if own else traceback.format_exc()[-4000:]})


# ---------- JSON ----------

def _dumps(obj):
    return json.dumps(BT.clean(obj), separators=(",", ":"), allow_nan=False)
