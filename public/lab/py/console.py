"""MEDUSA Lab's Python tab: runs your own code, with your data files and the backtest engine at hand.

What your code can use without importing anything:
  load(name)          a data file you attached in the tab: arrays .t .o .h .l .c .v (numpy; t = open time in ms,
                      UTC), .funding_t .funding_r (futures files with funding), .symbol .market .interval, len(data),
                      and .df() for a pandas DataFrame in your time zone (import pandas in your code to use it)
  files()             the names of the attached files
  local_time(ms)      times in ms (data.t, a result's equity_t) as numpy datetimes in your time zone
  backtest(strategy, data, **settings)
                      runs a built-in strategy (its key, e.g. "turtle") or a Strategy class you wrote above it,
                      on the same engine as the Dashboard. Settings: the Dashboard's (fee_pct, slippage_pct,
                      funding, capital, sizing "risk"/"notional", risk_pct, notional_pct, max_leverage, compounding,
                      fill "next_open"/"close", start/end "YYYY-MM-DD" in your time zone, split) and the strategy's
                      own settings by their keys (lengths in candles). Returns a Result: .summary .gross (dicts), .trades (list of dicts), .equity_t
                      .equity (numpy), .report() prints the main numbers, .df() the trades as a DataFrame, .save()
                      adds it to the Results folder.
  Strategy, Param     to write a strategy class (as in Lab -> Strategies)
  np                  numpy
and the engine's modules: indicators (ema, sma, atr, rsi, macd, bollinger, supertrend, session_vwap ...),
engine, strategy, stats. pandas, matplotlib, scipy and statsmodels load when your code imports them.
matplotlib charts show under the output (plt.show(), or any figure still open at the end).
Dates are shown in the page's time zone (TZ_MIN minutes east of UTC); the arrays keep UTC milliseconds.
The thread running this has no network access."""
import base64
import contextlib
import io
import json
import os
import sys
import time
import traceback
from datetime import timedelta, timezone

import numpy as np

import engine
import labrun
from strategy import Param, Strategy

FILES = {}            # name -> Data
RESULTS = []          # reports made by backtest() and saved with .save()
IMAGES = []
TZ_MIN = 0            # the page's time zone, minutes east of UTC (set by run())
MAX_OUT = 200_000     # characters of printed output kept


class Data:
    """One attached data file, as load() gives it. One row per candle, oldest first; every array has len(data) values.

    Columns (numpy arrays):
      t          open time of each candle, milliseconds since 1970 (UTC), int64. A candle closes at the next one's t.
      o h l c v  open, high, low, close (float64) and volume in the coin (float64)
      tbv        taker-buy volume (float64), or None when the file has none (Binance files have it)
      funding_t  funding times in ms (UTC, int64), or None: only futures files downloaded with funding rates
      funding_r  the funding rate at each of those times (0.0001 = 0.01%), or None
    About the file:
      name       the name load() knows it by, e.g. "BTCUSDT-futures-4h"
      symbol     e.g. "BTCUSDT" ("" when an uploaded file's name doesn't say)
      market     "futures" or "spot"
      interval   the timeframe, e.g. "4h"
      cols       every column above in one dict (keys t o h l c v, and tbv ft fr when present)
    Methods:
      len(data)  the number of candles
      print(data) one line: name, symbol, market, timeframe, candles, first and last day (your time zone)
      data.df()  a pandas DataFrame: columns open high low close volume (+ taker_buy_volume), indexed by
                 open time in your time zone (index name "time"). pandas loads by itself when your code
                 calls .df(). Funding isn't in it.
    The arrays are your copy for this run: changing them doesn't change the stored file.
    """

    def __init__(self, name, meta, cols):
        self.name = name
        self.symbol, self.market, self.interval = meta.get("symbol", ""), meta.get("market", "futures"), meta.get("interval", "")
        self.cols = cols
        self.t = cols["t"].astype(np.int64)
        self.o, self.h, self.l, self.c, self.v = (cols[k] for k in "ohlcv")
        self.tbv = cols.get("tbv")
        self.funding_t = cols["ft"].astype(np.int64) if cols.get("ft") is not None else None
        self.funding_r = cols.get("fr")

    def __len__(self):
        return len(self.t)

    def __repr__(self):
        span = f"{_day(self.t[0])} to {_day(self.t[-1])}" if len(self.t) else "empty"
        return f"<{self.name}: {self.symbol} {self.market} {self.interval}, {len(self.t):,} candles, {span}>"

    def df(self):
        """The candles as a pandas DataFrame indexed by open time in your time zone (pandas loads when your code calls .df())."""
        import pandas as pd
        d = {"open": self.o, "high": self.h, "low": self.l, "close": self.c, "volume": self.v}
        if self.tbv is not None:
            d["taker_buy_volume"] = self.tbv
        return pd.DataFrame(d, index=_times(pd, self.t).rename("time"))


def _day(ms):
    return time.strftime("%Y-%m-%d", time.gmtime(int(ms) / 1000 + TZ_MIN * 60))


def local_time(ms):
    """Milliseconds since 1970 (UTC), e.g. data.t -> numpy datetimes in your time zone, for charts and printing."""
    return (np.asarray(ms, dtype=np.int64) + TZ_MIN * 60_000).astype("datetime64[ms]")


def _times(pd, ms):
    """Milliseconds since 1970 (UTC) -> pandas times in the page's time zone."""
    t, tz = pd.to_datetime(ms, unit="ms", utc=True), timezone(timedelta(minutes=TZ_MIN))
    return t.dt.tz_convert(tz) if isinstance(t, pd.Series) else t.tz_convert(tz)


def files():
    return list(FILES)


def load(name=None):
    """An attached data file as a Data object (help(Data) lists everything in it). load() when one file is ticked,
    load("BTCUSDT-futures-4h") to pick one; files() lists the names."""
    if not FILES:
        raise ValueError("No data file is attached. Tick one under 'Data files for Python' (or add one from this computer).")
    if name is None:
        if len(FILES) > 1:
            raise ValueError(f"Several files are attached; name one: {', '.join(repr(k) for k in FILES)}")
        return next(iter(FILES.values()))
    if name not in FILES:
        raise ValueError(f"No attached file is called {name!r}. Attached: {', '.join(repr(k) for k in FILES) or 'none'}")
    return FILES[name]


SETTINGS = {"fee_pct", "slippage_pct", "funding", "capital", "sizing", "risk_pct", "notional_pct", "max_leverage", "compounding",
            "fill", "start", "end", "split", "tz_offset_min"}


class Result:
    def __init__(self, report):
        self.report_json = report
        self.title = report["title"]
        self.summary, self.gross = report["summary"], report["gross"]
        self.trades = report["trades"]
        self.equity_t = np.array(report["equity"]["t"], dtype=np.int64)
        self.equity = np.array(report["equity"]["s"], dtype=float)
        self.warnings = report["warnings"]

    def __repr__(self):
        return f"<Result {self.title}: {self.summary['return'] * 100:+.1f}%, {self.summary['trades'].get('n', 0)} trades>"

    def report(self):
        s, g, t = self.summary, self.gross, self.summary["trades"]
        pct = lambda x: "–" if x is None else f"{x * 100:+.1f}%"
        print(self.title)
        print(f"  {_day(s['start'])} to {_day(s['end'])} ({s['years']:.1f} years)")
        print(f"  Net return {pct(s['return'])}  (before costs {pct(g['return'])}, buy and hold {pct(s.get('bh_return'))})")
        print(f"  Yearly {pct(s.get('cagr'))}, worst drawdown {s['max_dd'] * 100:.1f}%, Sharpe {s.get('sharpe', 0):.2f}")
        if t.get("n"):
            pf = t["profit_factor"]
            print(f"  {t['n']} trades, {t['win_rate'] * 100:.0f}% winners, profit factor {pf if isinstance(pf, str) else round(pf, 2)}"
                  + (f", average {t['r_avg']:+.2f}R (t {t['r_t']:+.2f})" if t.get("r_n") else ""))
        else:
            print("  No trades.")
        for w in self.warnings:
            print("  ! " + w)
        return None

    def df(self):
        import pandas as pd
        d = pd.DataFrame(self.trades)
        for k in ("et", "xt"):
            if k in d:
                d[k] = _times(pd, d[k])
        return d.rename(columns={"et": "entry_time", "ep": "entry", "xt": "exit_time", "xp": "exit", "why": "exit_reason", "tp": "target"})

    def save(self):
        """Adds this result to the Results folder (the page saves it when the run ends)."""
        if self.report_json not in RESULTS:
            RESULTS.append(self.report_json)
        print(f"Will be saved in the Results folder: {self.title}")


def backtest(strategy, data=None, **kw):
    data = data if isinstance(data, Data) else load(data)
    key, temp = strategy, None
    if isinstance(strategy, type) and issubclass(strategy, Strategy):
        temp = f"console:{strategy.__name__}"
        strategy.key = strategy.key or strategy.__name__
        if strategy.label == Strategy.label:
            strategy.label = strategy.__name__
        labrun.LIB[temp] = strategy
        labrun.INFO[temp] = {"origin": "mine", "id": "console", "name": "Python tab", "doc": ""}
        key = temp
    elif key not in labrun.LIB:
        raise ValueError(f"Unknown strategy {strategy!r}. Built in: {', '.join(k for k in labrun.LIB if ':' not in k)}")
    cfg = {k: v for k, v in kw.items() if k in SETTINGS}
    cfg.setdefault("tz_offset_min", TZ_MIN)
    cfg.update(strategy=key, params={k: v for k, v in kw.items() if k not in SETTINGS})
    meta = {"symbol": data.symbol, "market": data.market, "interval": data.interval, "name": data.name, "source": "python"}
    try:
        out = json.loads(labrun.run(json.dumps(cfg), json.dumps(meta), data.cols))
    finally:
        if temp:
            labrun.LIB.pop(temp, None)
            labrun.INFO.pop(temp, None)
    return Result(out)


def _capture_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=192, bbox_inches="tight")     # shown at half size; full size in a new tab
        if len(IMAGES) < 30:
            IMAGES.append(base64.b64encode(buf.getvalue()).decode())
    plt.close("all")


def _prepare_matplotlib(code):
    """Charts: no screen here, so figures are drawn to PNG (Agg) and plt.show() hands them to the page."""
    if "matplotlib" not in code and "pylab" not in code:
        return
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        plt.show = lambda *a, **k: _capture_figures()
    except ImportError:
        pass


def syntax(code):
    """Python's own check of the editor's code, nothing runs. JSON list of {line, col, end_line, end_col, msg, sev}
    (lines and columns from 1): the first syntax error, and warnings such as an invalid escape like "\\d"."""
    import warnings
    out = []
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            compile(code, "<your code>", "exec", dont_inherit=True)
        except SyntaxError as e:
            out.append({"line": e.lineno or 1, "col": e.offset or 1, "end_line": getattr(e, "end_lineno", None),
                        "end_col": getattr(e, "end_offset", None), "msg": e.msg, "sev": "error"})
        except (ValueError, OverflowError) as e:
            out.append({"line": 1, "col": 1, "msg": str(e), "sev": "error"})
    for w in caught:
        out.append({"line": w.lineno or 1, "col": 1, "msg": str(w.message), "sev": "warn", "whole": True})
    return json.dumps(out)


class _Out(io.StringIO):
    def write(self, s):
        if self.tell() < MAX_OUT:
            return super().write(s[:MAX_OUT - self.tell()])
        return len(s)


def run(code, files_json, cols_list, tz_min=0):
    """Runs one piece of code. Returns JSON: {out, error, images, results, seconds}."""
    global TZ_MIN
    TZ_MIN = int(tz_min or 0)
    FILES.clear()
    RESULTS.clear()
    IMAGES.clear()
    for f, cols in zip(json.loads(files_json), cols_list):
        c = {k: labrun._arr(cols.get(k) if isinstance(cols, dict) else getattr(cols, k, None)) for k in ("t", "o", "h", "l", "c", "v", "tbv", "ft", "fr")}
        FILES[f["name"]] = Data(f["name"], f.get("meta") or {}, {k: v for k, v in c.items() if v is not None})
    _prepare_matplotlib(code)
    import indicators
    import stats
    g = {"__name__": "__main__", "np": np, "load": load, "files": files, "backtest": backtest, "local_time": local_time, "Strategy": Strategy,
         "Param": Param, "indicators": indicators, "engine": engine, "stats": stats}
    out, err = _Out(), None
    t0 = time.time()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        try:
            exec(compile(code, "<your code>", "exec"), g)
        except SystemExit:
            pass
        except BaseException as e:                                  # noqa: BLE001 - everything goes back to the page
            tb = traceback.extract_tb(e.__traceback__)
            mine = [fr for fr in tb if fr.filename == "<your code>"]
            where = f" (line {mine[-1].lineno})" if mine else ""
            if isinstance(e, ModuleNotFoundError):
                err = (f"{e}. Available here: numpy, pandas, matplotlib, scipy, statsmodels and the Python standard library, "
                       "plus MEDUSA's indicators, engine, strategy and stats.")
            elif isinstance(e, SyntaxError):
                err = f"Python can't read line {e.lineno}: {e.msg}" + (f"\n    {e.text.strip()}" if e.text else "")
            else:
                frames = [fr for fr in tb if not fr.filename.endswith("console.py")]     # your code and the engine, not this file
                err = (f"{type(e).__name__}: {e}{where}\n\nTraceback (most recent call last):\n"
                       + "".join(traceback.format_list(frames)) + "".join(traceback.format_exception_only(e)))[-3000:]
    _capture_figures()
    text = out.getvalue()
    if len(text) >= MAX_OUT:
        text += "\n… (output cut at 200,000 characters)"
    return labrun._dumps({"out": text, "error": err, "images": IMAGES, "results": RESULTS, "seconds": round(time.time() - t0, 2)})
