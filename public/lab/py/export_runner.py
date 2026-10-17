# =============================================================================
# 5. Running it: get the candles, run the backtest, print the report
# =============================================================================
# This part is the same in every file MEDUSA exports. It uses only Python's standard library and numpy.
import argparse
import calendar
import csv
import io
import json
import sys
import time
import urllib.parse
import urllib.request
import zipfile

import numpy as np

import backtest
from strategy import Strategy

API = {"futures": ("https://fapi.binance.com/fapi/v1", 1500), "spot": ("https://api.binance.com/api/v3", 1000)}


def _get(url):
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.loads(r.read().decode())
        except OSError:
            if attempt == 5:
                raise
            time.sleep(2 + 2 * attempt)


def download_binance(symbol, market, interval, start_ms, end_ms, funding_from=None, funding_to=None):
    """Candles from start_ms to end_ms (open times, inclusive) and, for futures, the funding rates from
    funding_from to funding_to, from Binance's public API (no account or key). Funding times are rounded to
    the minute, as MEDUSA does (Binance stamps them a few milliseconds after the hour)."""
    base, limit = API[market]
    rows, t = [], int(start_ms)
    while t <= end_ms:
        q = urllib.parse.urlencode({"symbol": symbol, "interval": interval, "startTime": t, "endTime": int(end_ms), "limit": limit})
        batch = _get(f"{base}/klines?{q}")
        if not batch:
            break
        rows += batch
        t = batch[-1][0] + 1
        print(f"\r  candles: {len(rows):,}", end="", flush=True)
        if len(batch) < limit:
            break
    print()
    cols = {"t": np.array([r[0] for r in rows], dtype=float)}
    for k, j in (("o", 1), ("h", 2), ("l", 3), ("c", 4), ("v", 5), ("tbv", 9)):
        cols[k] = np.array([float(r[j]) for r in rows])
    if market == "futures" and funding_from is not None:
        f, t, last = [], int(funding_from) - 60_000, int(funding_to) + 60_000     # stamps are rounded: allow a minute
        while t <= last:
            q = urllib.parse.urlencode({"symbol": symbol, "startTime": t, "endTime": last, "limit": 1000})
            batch = _get(f"{API['futures'][0]}/fundingRate?{q}")
            if not batch:
                break
            f += batch
            t = int(batch[-1]["fundingTime"]) + 1
            if len(batch) < 1000:
                break
        cols["ft"] = np.array([round(int(x["fundingTime"]) / 60_000) * 60_000 for x in f], dtype=float)
        cols["fr"] = np.array([float(x["fundingRate"]) for x in f])
        print(f"  funding rates: {len(f):,}")
    return cols


def _rows(text):
    return [r for r in csv.reader(io.StringIO(text)) if r]


def read_file(path):
    """Candles (and funding rates) from a file: MEDUSA's CSV or ZIP export, or a Binance archive file.
    A plain CSV needs columns time (ms or ISO, UTC), open, high, low, close[, volume]."""
    texts = []
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            texts = [z.read(n).decode("utf-8-sig") for n in z.namelist() if n.lower().endswith((".csv", ".txt"))]
    else:
        with open(path, encoding="utf-8-sig") as fh:
            texts = [fh.read()]
    candles, funding = [], []
    for text in texts:
        rows = _rows(text)
        head = [x.strip().lower() for x in rows[0]]
        has_head = not head[0].replace(".", "").isdigit()
        body = rows[1:] if has_head else rows
        if has_head and any("funding_rate" in h or h == "last_funding_rate" for h in head):
            ti = head.index("funding_time_ms") if "funding_time_ms" in head else head.index("calc_time") if "calc_time" in head else 0
            ri = head.index("funding_rate") if "funding_rate" in head else head.index("last_funding_rate")
            funding += [(round(float(r[ti]) / 60_000) * 60_000, float(r[ri])) for r in body]
            continue
        if has_head and "open_time_ms" in head:                       # MEDUSA's export
            idx = {k: head.index(k) for k in ("open_time_ms", "open", "high", "low", "close", "volume") if k in head}
            tb = head.index("taker_buy_volume") if "taker_buy_volume" in head else None
            for r in body:
                candles.append((float(r[idx["open_time_ms"]]), *(float(r[idx[k]]) for k in ("open", "high", "low", "close")),
                                float(r[idx["volume"]]) if "volume" in idx else 0.0, float(r[tb]) if tb is not None else np.nan))
        else:                                                          # Binance archive or a plain time,o,h,l,c,v file
            for r in body:
                t0 = r[0].strip()
                t = float(t0) if t0.replace(".", "").isdigit() else calendar.timegm(time.strptime(t0[:19].replace("T", " "), "%Y-%m-%d %H:%M:%S")) * 1000
                if t > 1e14:                                           # microseconds (newer Binance archives)
                    t /= 1000
                candles.append((t, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]) if len(r) > 5 else 0.0,
                                float(r[9]) if len(r) > 9 else np.nan))
    candles.sort()
    a = np.array(candles, dtype=float)
    cols = {"t": a[:, 0], "o": a[:, 1], "h": a[:, 2], "l": a[:, 3], "c": a[:, 4], "v": a[:, 5]}
    if not np.isnan(a[:, 6]).all():
        cols["tbv"] = a[:, 6]
    if funding:
        funding.sort()
        cols["ft"], cols["fr"] = np.array([x[0] for x in funding], dtype=float), np.array([x[1] for x in funding])
    return cols


def local(ms, tz_min):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(ms / 1000 + tz_min * 60))


def pct(x):
    return "-" if x is None else f"{x * 100:+.2f}%"


def print_report(rep, expected):
    m, s, g, t = rep["meta"], rep["summary"], rep["gross"], rep["summary"]["trades"]
    tz = m["tz_offset_min"]
    sign = "+" if tz >= 0 else "-"
    print(f"\n{rep['title']}")
    print(f"  {local(m['from'], tz)} to {local(m['to'], tz)} (UTC{sign}{abs(tz) // 60:02d}:{abs(tz) % 60:02d}), {m['candles']:,} candles"
          f" + {m['warmup']:,} warm-up candles for the indicators")
    print(f"  Settings: {m['settings_text']}")
    print(f"  Net profit {s['net']:,.2f} ({pct(s['return'])}) · before costs {pct(g['return'])} · buy and hold {pct(s.get('bh_return'))}")
    print(f"  Yearly {pct(s.get('cagr'))} · worst drawdown {s['max_dd'] * 100:.2f}% · Sharpe {s.get('sharpe', 0):.2f}")
    if t.get("n"):
        pf = t["profit_factor"]
        print(f"  {t['n']:,} trades · {t['win_rate'] * 100:.1f}% winners · profit factor {pf if isinstance(pf, str) else round(pf, 2)}"
              + (f" · average {t['r_avg']:+.3f}R (t {t['r_t']:+.2f})" if t.get("r_n") else ""))
    for w in rep["warnings"]:
        print(f"  ! {w}")
    if expected:
        same = abs(s["final"] - expected["final"]) <= 1e-6 * max(1.0, abs(expected["final"])) and t.get("n", 0) == expected["trades"]
        print(f"\n  {'Same result as in MEDUSA.' if same else 'DIFFERENT from MEDUSA'} (MEDUSA: final {expected['final']:,.6f}, "
              f"{expected['trades']:,} trades; here: {s['final']:,.6f}, {t.get('n', 0):,})")
        if not same:
            print("  The candles downloaded now may differ from the ones MEDUSA had (Binance corrects old data rarely),"
                  " or the strategy file has changed since.")


def write_trades(rep, path):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["side", "entry_time_ms", "entry_price", "exit_time_ms", "exit_price", "pnl", "r", "return", "exit_reason", "candles", "fees", "funding"])
        for x in rep["trades"]:
            w.writerow(["long" if x["side"] > 0 else "short", x["et"], x["ep"], x["xt"], x["xp"], x["pnl"], x["r"], x["ret"], x["why"], x["bars"], x["fees"], x["fund"]])


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "MEDUSA backtest")
    ap.add_argument("--csv", help="read the candles from this file (MEDUSA's CSV/ZIP export) instead of downloading them")
    ap.add_argument("--trades", help="also write every trade to this CSV file")
    ap.add_argument("--json", help="also write the whole report to this JSON file")
    a = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):                  # a console that can't show a character prints "?"
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    cls = next(c for c in globals().values() if isinstance(c, type) and issubclass(c, Strategy) and c is not Strategy and c.key == STRATEGY_KEY)
    if a.csv:
        cols = read_file(a.csv)
    elif DATA["source"] == "binance":
        print(f"Downloading {DATA['symbol']} {DATA['interval']} ({DATA['market']}) from Binance ...")
        cols = download_binance(DATA["symbol"], DATA["market"], DATA["interval"], DATA["candles_from_ms"], DATA["candles_to_ms"],
                                DATA.get("funding_from_ms"), DATA.get("funding_to_ms"))
    else:
        raise SystemExit("This backtest used a file you uploaded to MEDUSA. Run again with --csv and that file "
                         f"({DATA.get('name') or 'the data file'}), for example: python {__file__.split('/')[-1]} --csv data.csv")
    report = backtest.run_backtest(cls, CONFIG, META, cols)
    print_report(report, EXPECTED)
    if a.trades:
        write_trades(report, a.trades)
        print(f"  trades written to {a.trades}")
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(backtest.clean(report), fh)
        print(f"  report written to {a.json}")
    return report


if __name__ == "__main__":
    main()
