"""Repair a day Binance's daily archive left out. Started by hand only (the Lakehouse repair day
workflow), never on a schedule, so every repair is a deliberate run that can be followed in the logs.

Binance sometimes never publishes a day's 1-minute candles: 2026-10-28 is missing from the daily
archive and from October's monthly file as well, for every coin. Binance does publish that day's raw
trades, and a 1-minute candle is only a summary of the trades in that minute. So a missing day can
be rebuilt exactly.

Each coin's 1-minute candles come from the first of these that works (--method picks one, or auto
tries them in this order):
  daily    Binance's own daily file, in case it has appeared since
  monthly  the day cut out of the month's file, once Binance publishes the month (about the 2nd)
  trades   the day rebuilt from Binance's trades, minute by minute
The day's metrics files are loaded the normal way.

Before anything is saved, --check rebuilds a day Binance did publish (by default the day before)
from its trades and compares it with Binance's own candles, number by number, on a sample of coins.
Any difference stops the repair, and nothing is written.

The files are saved under their usual names in data/landing, so bronze loads them like any other
day, and the day's manifest says how each file was made: saved (Binance's daily file),
cut_from_month or rebuilt_from_trades. A repaired file has no fingerprint, so if Binance ever
publishes the real daily file, the daily recheck loads it under a new name and it replaces the
repair (recheck_binance.py).

How a candle is rebuilt, the way Binance builds its own:
  open and close   the first and last trade's price in the minute
  high and low     the highest and lowest trade price
  volume           the trades' quantities added up; quote_volume their USDT values
  count            the number of trades
  taker_buy_*      the same, only for trades where the buyer took the price (is_buyer_maker false)
  a minute with no trades   open, high, low and close at the previous minute's close, volumes 0
The day starts at 00:00 if the coin traded the day before (its last close from Binance's daily file),
or at its first trade if it was listed that day. It runs to 23:59 if the coin trades the next day,
or ends at its last trade if it was delisted.

Standard library only.

  python repair_day.py --date 2026-10-28                       (auto, every coin, check first)
  python repair_day.py --date 2026-10-28 --method trades --symbols BTCUSDT,ETHUSDT
  python repair_day.py --date 2026-10-28 --check-only           (only compare, save nothing)
"""
import argparse
import concurrent.futures
import datetime as dt
import io
import os
import sys
import urllib.request
import zipfile
from decimal import Decimal

import download_binance as db

DAY_MS = 86_400_000
MINUTE_MS = 60_000
HEADER = b"open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore"
FIELDS = HEADER.decode().split(",")
METHODS = {"auto": ("daily", "monthly", "trades"), "daily": ("daily",), "monthly": ("monthly",), "trades": ("trades",)}
# The coins every check includes, besides an even spread of the rest: the busiest and a few quiet ones.
CHECK_ALWAYS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "1000PEPEUSDT")


def day_start(day):
    return int(dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)


def shift(day, days):
    return (dt.date.fromisoformat(day) + dt.timedelta(days)).isoformat()


def exists(url):
    """Whether Binance has a file at this address, without downloading it."""
    request = urllib.request.Request(urllib.parse.quote(url, safe=":/?&=%"), method="HEAD",
                                     headers={"User-Agent": "medusa-lakehouse"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30):
                return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
        except OSError:
            pass
    raise RuntimeError(f"{url}: couldn't ask Binance whether it exists")


def trades_url(symbol, day):
    return f"{db.BASE_URL}/daily/trades/{symbol}/{symbol}-trades-{day}.zip"


def klines_url(symbol, day):
    return f"{db.BASE_URL}/daily/klines/{symbol}/1m/{symbol}-1m-{day}.zip"


def last_close(symbol, day):
    """The coin's last 1-minute close of `day` from Binance's daily file, or None if there isn't one."""
    data = db.fetch(klines_url(symbol, day))
    if data is None:
        return None
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        lines = z.read(z.namelist()[0]).splitlines()
    return lines[-1].split(b",")[4] if len(lines) > 1 else None


def candles_from_trades(symbol, day):
    """The day's 1-minute candle lines (bytes, header first) rebuilt from Binance's trades, or None
    if Binance has no trades file for the coin that day."""
    data, _ = db.checked_zip(trades_url(symbol, day))
    if data is None:
        return None
    start = day_start(day)
    minutes = {}          # minute of the day -> [open, high, low, close, volume, quote, count, taker volume, taker quote]
    with zipfile.ZipFile(io.BytesIO(data)) as z, z.open(z.namelist()[0]) as f:
        first = f.readline()
        if not first.startswith(b"id,price,qty,quote_qty,time,is_buyer_maker"):
            raise RuntimeError(f"{symbol} {day}: the trades file's header isn't the expected one: {first[:80]!r}")
        for line in f:
            _, price, qty, quote, time_ms, buyer_maker = line.rstrip().split(b",")
            k = (int(time_ms) - start) // MINUTE_MS
            if not 0 <= k < 1440:
                continue
            q, v = Decimal(qty.decode()), Decimal(quote.decode())
            c = minutes.get(k)
            if c is None:
                c = minutes[k] = [price, price, price, price, Decimal(0), Decimal(0), 0, Decimal(0), Decimal(0)]
            else:
                p = float(price)
                if p > float(c[1]):
                    c[1] = price
                if p < float(c[2]):
                    c[2] = price
                c[3] = price
            c[4] += q
            c[5] += v
            c[6] += 1
            if buyer_maker == b"false":
                c[7] += q
                c[8] += v
    if not minutes:
        return [HEADER]

    previous = last_close(symbol, shift(day, -1))
    first_minute = 0 if previous is not None else min(minutes)          # listed this day: start at its first trade
    traded_next_day = exists(trades_url(symbol, shift(day, 1))) or exists(klines_url(symbol, shift(day, 1)))
    last_minute = 1439 if traded_next_day else max(minutes)            # delisted this day: end at its last trade
    close = previous if previous is not None else minutes[min(minutes)][0]
    out = [HEADER]
    for k in range(first_minute, last_minute + 1):
        t = start + k * MINUTE_MS
        c = minutes.get(k)
        if c is None:                                                   # no trades: flat at the last close
            out.append(b",".join([str(t).encode(), close, close, close, close, b"0", str(t + MINUTE_MS - 1).encode(), b"0", b"0", b"0", b"0", b"0"]))
            continue
        close = c[3]
        out.append(b",".join([str(t).encode(), c[0], c[1], c[2], c[3], str(c[4]).encode(), str(t + MINUTE_MS - 1).encode(),
                              str(c[5]).encode(), str(c[6]).encode(), str(c[7]).encode(), str(c[8]).encode(), b"0"]))
    return out


def compare(symbol, day):
    """Rebuild a day Binance did publish and compare it with Binance's candles. Returns
    (symbol, minutes compared, list of differences); None if Binance has no candles or trades for it."""
    data = db.fetch(klines_url(symbol, day))
    if data is None:
        return None
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        real = z.read(z.namelist()[0]).splitlines()
    rebuilt = candles_from_trades(symbol, day)
    if rebuilt is None:
        return None
    real_rows = {r.split(b",")[0]: r.split(b",") for r in real[1:] if r}
    built_rows = {r.split(b",")[0]: r.split(b",") for r in rebuilt[1:]}
    problems = []
    for t in sorted(set(real_rows) | set(built_rows)):
        a, b = real_rows.get(t), built_rows.get(t)
        if a is None or b is None:
            problems.append(f"minute {int(t)}: only in {'the rebuilt day' if a is None else 'Binance'}")
            continue
        for name, x, y in zip(FIELDS, a, b):
            if Decimal(x.decode()) != Decimal(y.decode()):
                problems.append(f"minute {int(t)} {name}: Binance {x.decode()}, rebuilt {y.decode()}")
    return symbol, len(real_rows), problems


def repair_one(symbol, day, methods):
    """Fill one coin's 1-minute candles for the day. Returns (symbol, status, file name, sha256, minutes)."""
    out_file = db.LANDING / "klines_1m" / f"date={day}" / f"{symbol}-1m-{day}.csv.gz"
    for method in methods:
        if method == "daily":
            result, sha256, name = db.download_one("klines_1m", symbol, day)
            if result in ("saved", "skipped"):
                return symbol, "saved", name, sha256, None
        elif method == "monthly":
            result, _, name = db.cut_from_month(symbol, day)
            if result in ("saved", "skipped"):
                return symbol, "cut_from_month", name, "", None
        elif method == "trades":
            lines = candles_from_trades(symbol, day)
            if lines is not None and len(lines) > 1:
                db.save_gz(out_file, b"\n".join(lines) + b"\n")
                return symbol, "rebuilt_from_trades", out_file.name, "", len(lines) - 1
    return symbol, "missing", "", "", None


def check(day, symbols, workers):
    """Run the comparison on a sample of coins. Returns True when every compared minute matched."""
    rest = [s for s in symbols if s not in CHECK_ALWAYS]
    sample = [s for s in CHECK_ALWAYS if s in symbols] + rest[:: max(1, len(rest) // 12)][:12]
    print(f"Check: rebuilding {day} from trades for {len(sample)} coins and comparing with Binance's candles")
    ok, compared = True, 0
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(compare, sample, [day] * len(sample)):
            if result is None:
                continue
            symbol, minutes, problems = result
            compared += 1
            print(f"  {symbol:<16} {minutes} minutes, {'all match' if not problems else f'{len(problems)} differences'}")
            for p in problems[:5]:
                print(f"      {p}")
            ok = ok and not problems
    if not compared:
        print("Nothing could be compared: Binance has no candles and trades for the check day.", file=sys.stderr)
        return False
    return ok


def main():
    parser = argparse.ArgumentParser(description="Repair a day Binance's daily archive left out (run by hand).")
    parser.add_argument("--date", required=True, help="day to repair, YYYY-MM-DD (UTC)")
    parser.add_argument("--method", choices=sorted(METHODS), default="auto", help="where the candles come from (default: auto)")
    parser.add_argument("--symbols", default="ALL", help="ALL, or comma-separated, e.g. BTCUSDT,ETHUSDT")
    parser.add_argument("--check", help="day Binance did publish, rebuilt from trades and compared first (default: the day before)")
    parser.add_argument("--check-only", action="store_true", help="only run the comparison; save nothing")
    parser.add_argument("--no-check", action="store_true", help="skip the comparison (not recommended)")
    parser.add_argument("--workers", type=int, default=max(2, (os.cpu_count() or 2) * 2), help="coins at the same time")
    args = parser.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    day = dt.date.fromisoformat(args.date).isoformat()

    symbols = db.all_perpetuals("daily") if args.symbols.strip().upper() == "ALL" else \
        [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    print(f"{len(symbols)} coins; repairing {day} with method {args.method}")

    if not args.no_check:
        if not check(args.check or shift(day, -1), symbols, args.workers):
            print("The rebuilt candles don't match Binance's, so nothing is repaired.", file=sys.stderr)
            return 1
        if args.check_only:
            print("Check passed. --check-only: nothing saved.")
            return 0

    rows, counts = [], {}
    methods = METHODS[args.method]
    with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(repair_one, s, day, methods): s for s in symbols}
        for future in concurrent.futures.as_completed(futures):
            try:
                symbol, status, name, sha256, _ = future.result()
            except Exception as e:
                symbol, status, name, sha256 = futures[future], "failed", "", ""
                print(f"FAILED   klines_1m  {symbol} {day}: {e}", file=sys.stderr)
            counts[status] = counts.get(status, 0) + 1
            rows.append(("klines_1m", symbol, status, name, sha256))

    # The day's other datasets the normal way.
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for symbol, (result, sha256, name) in zip(symbols, pool.map(lambda s: db.download_one("metrics", s, day), symbols)):
            rows.append(("metrics", symbol, result if result != "skipped" else "saved", name, sha256))
            counts[f"metrics {result}"] = counts.get(f"metrics {result}", 0) + 1

    print(f"\n{day}: " + ", ".join(f"{n} {k}" for k, n in sorted(counts.items())))
    if counts.get("failed"):
        print("Some coins failed, so the manifest isn't written and nothing should be uploaded. Run it again.", file=sys.stderr)
        return 1
    filled = sum(n for k, n in counts.items() if k in ("saved", "cut_from_month", "rebuilt_from_trades"))
    if not filled:
        hint = {"monthly": " The month's file isn't published yet (about the 2nd of the next month), or it skips this day too: try method trades.",
                "daily": " Binance still has no daily file for it: try method monthly or trades."}.get(args.method, "")
        print(f"No candles found for {day} by method {args.method}.{hint}", file=sys.stderr)
        return 1
    db.write_manifest(day, rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
