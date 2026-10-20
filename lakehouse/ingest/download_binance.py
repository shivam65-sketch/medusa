"""Download Binance USD-M futures daily files from data.binance.vision.

For each coin and dataset, the script:
  1. downloads that day's .zip file and its .CHECKSUM file,
  2. checks the zip's SHA-256 fingerprint against the checksum, so a corrupted
     or half-downloaded file is never loaded,
  3. saves the CSV inside it, gzip-compressed, to
     data/landing/<dataset>/date=<day>/<file>.csv.gz

A file that is already saved is skipped, so running it twice is safe.
A day Binance hasn't published yet, or a coin that wasn't trading, is reported as missing.
With --symbols ALL, the list of coins comes from Binance's archive itself: every USDT
perpetual it has ever published (coins delisted long ago simply come back as missing).

Standard library only: nothing to install.

  python download_binance.py --symbols BTCUSDT --date 2026-10-19
  python download_binance.py --symbols ALL                  (date defaults to yesterday, UTC)
"""
import argparse
import concurrent.futures
import datetime as dt
import gzip
import hashlib
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

BASE_URL = "https://data.binance.vision/data/futures/um/daily"
# The archive's file listing (it is an Amazon S3 bucket; the website reads the same listing).
LISTING_URL = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"

# Dataset name -> where that day's zip file lives under BASE_URL.
DATASETS = {
    "klines_1m": "klines/{symbol}/1m/{symbol}-1m-{day}.zip",
    "metrics": "metrics/{symbol}/{symbol}-metrics-{day}.zip",
}

# USDT-margined perpetuals only: no USDC/BUSD pairs, no dated futures like BTCUSDT_250926.
PERPETUAL = re.compile(r"^[A-Z0-9]+USDT$")

# lakehouse/data/landing (the data/ folder is in .gitignore, so downloads never reach Git).
LANDING = pathlib.Path(__file__).resolve().parent.parent / "data" / "landing"


def fetch(url):
    """Return the file at `url` as bytes, or None if it doesn't exist (HTTP 404).
    Network hiccups are retried twice before giving up."""
    for attempt in range(1, 4):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "medusa-lakehouse"})
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == 3:
                raise
        except urllib.error.URLError:
            if attempt == 3:
                raise
        time.sleep(2 * attempt)


def all_perpetuals():
    """Every USDT perpetual that has a folder in the archive. The listing comes in
    pages of up to 1,000 entries, so keep asking until it says it isn't truncated."""
    prefix = "data/futures/um/daily/klines/"
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


def download_one(dataset, symbol, day):
    """Download, check and save one file. Returns 'saved', 'skipped' or 'missing'."""
    zip_path = DATASETS[dataset].format(symbol=symbol, day=day)
    out_dir = LANDING / dataset / f"date={day}"
    out_file = out_dir / (pathlib.PurePosixPath(zip_path).stem + ".csv.gz")
    if out_file.exists():
        return "skipped"

    url = f"{BASE_URL}/{zip_path}"
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


def main():
    parser = argparse.ArgumentParser(description="Download Binance USD-M futures daily files.")
    parser.add_argument("--symbols", required=True, help="ALL, or comma-separated, e.g. BTCUSDT,ETHUSDT")
    parser.add_argument("--date", help="day to download, YYYY-MM-DD in UTC (default: yesterday)")
    parser.add_argument("--datasets", default=",".join(DATASETS), help="default: " + ",".join(DATASETS))
    parser.add_argument("--workers", type=int, default=16, help="downloads at the same time (default: 16)")
    args = parser.parse_args()

    if args.date:
        day = dt.date.fromisoformat(args.date).isoformat()
    else:
        day = (dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)).isoformat()
    datasets = [d.strip() for d in args.datasets.split(",") if d.strip()]
    unknown = [d for d in datasets if d not in DATASETS]
    if unknown:
        parser.error("unknown dataset(s): " + ", ".join(unknown))
    if args.symbols.strip().upper() == "ALL":
        symbols = all_perpetuals()
        print(f"{len(symbols)} USDT perpetuals in Binance's archive")
    else:
        symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]

    # Downloads wait on the network, not the CPU, so running several at once is much faster.
    jobs = [(dataset, symbol) for dataset in datasets for symbol in symbols]
    counts = {"saved": 0, "skipped": 0, "missing": 0, "failed": 0}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(download_one, d, s, day): (d, s) for d, s in jobs}
        for future in concurrent.futures.as_completed(futures):
            dataset, symbol = futures[future]
            try:
                result = future.result()
            except Exception as e:
                result = "failed"
                print(f"FAILED   {dataset:<10} {symbol} {day}: {e}", file=sys.stderr)
            counts[result] += 1
            if result != "failed" and len(symbols) <= 20:  # a full run would print hundreds of lines
                print(f"{result:<8} {dataset:<10} {symbol} {day}")

    print(f"\n{day}: " + ", ".join(f"{n} {name}" for name, n in counts.items()))
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())