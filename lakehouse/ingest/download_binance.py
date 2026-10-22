"""Download Binance USD-M futures files from data.binance.vision.

Two kinds of files: daily ones (1-minute candles and 5-minute metrics, the daily load) and
monthly ones (1-hour candles, used to load the history once).

For each coin, dataset and day or month, the script:
  1. downloads the .zip file and its .CHECKSUM file,
  2. checks the zip's SHA-256 fingerprint against the checksum, so a corrupted
     or half-downloaded file is never loaded,
  3. saves the CSV inside it, gzip-compressed, to
     data/landing/<dataset>/date=<day>/<file>.csv.gz     (daily datasets)
     data/landing/<dataset>/month=<month>/<file>.csv.gz  (monthly datasets)

A file that is already saved is skipped, so running it twice is safe.
A day or month Binance hasn't published, or a coin that wasn't trading then, is reported as missing.
With --symbols ALL, the list of coins comes from Binance's archive itself: every USDT
perpetual it has ever published (coins delisted long ago simply come back as missing).
A daily run over every coin also checks that Binance has finished publishing the day, and fails
if it hasn't, so a half-published day is never loaded.

Standard library only: nothing to install.

  python download_binance.py --symbols BTCUSDT --date 2026-10-19
  python download_binance.py --symbols ALL                  (date defaults to yesterday, UTC)
  python download_binance.py --symbols ALL --months 2020-01..2020-12
"""
import argparse
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import http.client
import io
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

BASE_URL = "https://data.binance.vision/data/futures/um"
# The archive's file listing (it is an Amazon S3 bucket; the website reads the same listing).
LISTING_URL = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"

# Dataset name -> (daily or monthly, where its zip file lives under BASE_URL/<daily|monthly>/).
DATASETS = {
    "klines_1m": ("daily", "klines/{symbol}/1m/{symbol}-1m-{period}.zip"),
    "metrics": ("daily", "metrics/{symbol}/{symbol}-metrics-{period}.zip"),
    "klines_1h": ("monthly", "klines/{symbol}/1h/{symbol}-1h-{period}.zip"),
}

# The landing folder for each kind, named so Databricks reads it as a column: date=… or month=….
PARTITION = {"daily": "date", "monthly": "month"}

# USDT-margined perpetuals only: no USDC/BUSD pairs, no dated futures like BTCUSDT_250926.
PERPETUAL = re.compile(r"^[A-Z0-9]+USDT$")

# lakehouse/data/landing (the data/ folder is in .gitignore, so downloads never reach Git).
LANDING = pathlib.Path(__file__).resolve().parent.parent / "data" / "landing"


def fetch(url):
    """Return the file at `url` as bytes, or None if it doesn't exist (HTTP 404).
    Network hiccups are retried three times (after 5, 10 and 15 seconds) before giving up."""
    for attempt in range(1, 5):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "medusa-lakehouse"})
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == 4:
                raise
        except (OSError, http.client.HTTPException):
            # Covers failing to connect (URLError) and also the connection dropping in the
            # middle of a download: "Connection reset by peer", a timeout, a cut-off file.
            # Those happen inside response.read(), so they aren't URLErrors. Downloading the
            # file again from the start is safe.
            if attempt == 4:
                raise
        time.sleep(5 * attempt)


def all_perpetuals(kind):
    """Every USDT perpetual that has a candle folder in the archive's daily or monthly part.
    The listing comes in pages of up to 1,000 entries, so keep asking until it isn't truncated."""
    prefix = f"data/futures/um/{kind}/klines/"
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    symbols, marker = [], ""
    while True:
        query = urllib.parse.urlencode({"delimiter": "/", "prefix": prefix, "marker": marker})
        page = ET.fromstring(fetch(f"{LISTING_URL}?{query}"))
        for p in page.findall("s3:CommonPrefixes/s3:Prefix", ns):
            symbol = p.text[len(prefix):].strip("/")
            if PERPETUAL.match(symbol):
                symbols.append(symbol)
        if page.findtext("s3:IsTruncated", namespaces=ns) != "true":
            return sorted(symbols)
        marker = page.findtext("s3:NextMarker", namespaces=ns)


def month_range(text):
    """'2020-01..2020-12' (or a single '2020-01') -> ['2020-01', ..., '2020-12']."""
    first, _, last = text.partition("..")
    year, month = map(int, first.split("-"))
    end = tuple(map(int, (last or first).split("-")))
    months = []
    while (year, month) <= end:
        months.append(f"{year:04d}-{month:02d}")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    if not months:
        raise ValueError(f"no months in {text!r}")
    return months


def download_one(dataset, symbol, period):
    """Download, check and save one file. Returns 'saved', 'skipped' or 'missing'."""
    kind, path = DATASETS[dataset]
    zip_path = path.format(symbol=symbol, period=period)
    out_dir = LANDING / dataset / f"{PARTITION[kind]}={period}"
    out_file = out_dir / (pathlib.PurePosixPath(zip_path).stem + ".csv.gz")
    if out_file.exists():
        return "skipped"

    url = f"{BASE_URL}/{kind}/{zip_path}"
    data = fetch(url)
    if data is None:
        return "missing"

    # The .CHECKSUM file looks like "<sha256>  <file name>".
    checksum = fetch(url + ".CHECKSUM")
    if checksum is None:
        raise RuntimeError(f"{url}: Binance has no .CHECKSUM file for it")
    expected = checksum.decode().split()[0].lower()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise RuntimeError(f"{url}: checksum mismatch (expected {expected}, got {actual})")

    with zipfile.ZipFile(io.BytesIO(data)) as z:
        csv_bytes = z.read(z.namelist()[0])  # each Binance zip holds exactly one CSV

    # Write to a temporary name first and rename at the end, so a half-written
    # file never appears in the landing folder.
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / (out_file.name + ".tmp")
    tmp.write_bytes(gzip.compress(csv_bytes))
    tmp.replace(out_file)
    return "saved"


def not_published_yet(found, datasets, symbols, period):
    """Signs that Binance is still publishing a day, for a daily run over every coin.

    Binance publishes a day's metrics files first and its 1-minute candle files one to five
    hours later, and not all at once. Loading in between would leave some coins out of that
    day for good, because the next run only fetches its own day. Two signs:
      - a dataset with no files at all for the day,
      - a coin with a metrics file but no candle file. On complete days this never happens
        (checked on 2026-10-14 to 2026-10-20), while the reverse is normal: about 120 coins
        have candles but no metrics.
    `found` holds (dataset, symbol, period) for every file Binance has published."""
    have = {d: {s for s in symbols if (d, s, period) in found} for d in datasets}
    problems = [f"{d} {period}: no files yet" for d in datasets if not have[d]]
    if have.get("klines_1m") and have.get("metrics"):
        waiting = sorted(have["metrics"] - have["klines_1m"])
        if waiting:
            problems.append(f"klines_1m {period}: {len(waiting)} coins have metrics but no candles yet "
                            f"({', '.join(waiting[:5])}{', ...' if len(waiting) > 5 else ''})")
    return problems


def main():
    parser = argparse.ArgumentParser(description="Download Binance USD-M futures files.")
    parser.add_argument("--symbols", required=True, help="ALL, or comma-separated, e.g. BTCUSDT,ETHUSDT")
    parser.add_argument("--date", help="day to download, YYYY-MM-DD in UTC (default: yesterday)")
    parser.add_argument("--months", help="monthly files instead: one month or a range, e.g. 2020-01..2020-12")
    parser.add_argument("--datasets", help="default: the daily datasets, or the monthly ones with --months")
    parser.add_argument("--workers", type=int, default=16, help="downloads at the same time (default: 16)")
    args = parser.parse_args()
    # Print each line as it happens, so the log keeps messages and errors in order.
    sys.stdout.reconfigure(line_buffering=True)

    if args.months and args.date:
        parser.error("use --date or --months, not both")
    kind = "monthly" if args.months else "daily"
    if args.months:
        try:
            periods = month_range(args.months)
        except ValueError as e:
            parser.error(f"--months: {e}")
    elif args.date:
        periods = [dt.date.fromisoformat(args.date).isoformat()]
    else:
        periods = [(dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)).isoformat()]

    default = [name for name, (k, _) in DATASETS.items() if k == kind]
    datasets = [d.strip() for d in args.datasets.split(",") if d.strip()] if args.datasets else default
    wrong = [d for d in datasets if d not in default]
    if wrong:
        parser.error(f"not a {kind} dataset: " + ", ".join(wrong) + " (choose from " + ", ".join(default) + ")")
    if args.symbols.strip().upper() == "ALL":
        symbols = all_perpetuals(kind)
        print(f"{len(symbols)} USDT perpetuals in Binance's {kind} archive")
    else:
        symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]

    # Downloads wait on the network, not the CPU, so running several at once is much faster.
    jobs = [(dataset, symbol, period) for dataset in datasets for symbol in symbols for period in periods]
    counts = {"saved": 0, "skipped": 0, "missing": 0, "failed": 0}
    found = set()  # (dataset, symbol, period) of every file Binance has published
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(download_one, d, s, p): (d, s, p) for d, s, p in jobs}
        for future in concurrent.futures.as_completed(futures):
            dataset, symbol, period = futures[future]
            try:
                result = future.result()
            except Exception as e:
                result = "failed"
                print(f"FAILED   {dataset:<10} {symbol} {period}: {e}", file=sys.stderr)
            counts[result] += 1
            if result in ("saved", "skipped"):
                found.add((dataset, symbol, period))
            if result != "failed" and len(jobs) <= 40:  # a full run would print thousands of lines
                print(f"{result:<8} {dataset:<10} {symbol} {period}")

    span = periods[0] if len(periods) == 1 else f"{periods[0]} to {periods[-1]}"
    print(f"\n{span}: " + ", ".join(f"{n} {name}" for name, n in counts.items()))

    problems = []
    if kind == "daily" and args.symbols.strip().upper() == "ALL":
        for period in periods:
            problems += not_published_yet(found, datasets, symbols, period)
    for problem in problems:
        print(f"NOT READY {problem}", file=sys.stderr)
    if problems:
        print("Binance hasn't finished publishing this day, so nothing is uploaded. "
              "Run the load again later.", file=sys.stderr)
    return 1 if counts["failed"] or problems else 0


if __name__ == "__main__":
    sys.exit(main())
