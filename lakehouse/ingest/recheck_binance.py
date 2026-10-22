"""Find files Binance changed or added after a day was loaded, and download them again.

Binance sometimes rewrites a day's files after first publishing them (on 2026-10-21 it rewrote
every 1-minute candle file of 2026-10-20 at 11:55). The checksum check proves a file wasn't damaged
in transfer, not that Binance won't replace it later.

Every complete daily load leaves a manifest in the landing volume
(manifests/date=YYYY-MM-DD/manifest.csv): for each coin and dataset, Binance's SHA-256 fingerprint
of the file, or that it was missing. This script reads the manifests in --manifests (the workflow
copies the last few days' from the volume), asks Binance for each file's fingerprint again, and for
every file that changed or appeared since:
  1. downloads and checks it (download_binance.download_one),
  2. saves a changed file under a new name with the start of its new fingerprint, e.g.
     BTCUSDT-1m-2026-10-20.r3f9a1c2e.csv.gz. Bronze's Auto Loader never re-reads a file name it has
     already loaded, so the corrected file has to arrive as a new one. Silver keeps the newest row
     for each coin and minute, so the corrected values replace the old ones,
  3. writes the day's updated manifest.
The workflow then uploads data/landing as usual. A file that disappeared is only reported.

Standard library only.

  python recheck_binance.py                          (manifests in ../data/manifests)
  python recheck_binance.py --manifests some/folder
"""
import argparse
import concurrent.futures
import csv
import pathlib
import sys

import download_binance as db

DEFAULT_MANIFESTS = pathlib.Path(__file__).resolve().parent.parent / "data" / "manifests"


def current_sha256(dataset, symbol, period):
    """Binance's fingerprint of the file now, or '' if the file doesn't exist."""
    kind, path = db.DATASETS[dataset]
    checksum = db.fetch(f"{db.BASE_URL}/{kind}/" + path.format(symbol=symbol, period=period) + ".CHECKSUM")
    return checksum.decode().split()[0].lower() if checksum else ""


def recheck_day(period, rows, workers):
    """Compare one day's manifest with Binance. Returns (changes, failures, updated rows)."""
    # Rows whose fingerprint isn't known (a file the load skipped) can't be compared.
    known = [r for r in rows if r["status"] in ("saved", "missing")]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        now = list(pool.map(lambda r: current_sha256(r["dataset"], r["symbol"], period), known))

    changes, failures = [], 0
    for row, sha_now in zip(known, now):
        before = row["sha256"]
        if sha_now == before:
            continue
        if before and not sha_now:
            changes.append(("removed", row))                  # reported only
            continue
        kind = "changed" if before else "new"
        # A changed file gets a new name so Auto Loader loads it; a new one keeps the usual name.
        suffix = f".r{sha_now[:8]}" if kind == "changed" else ""
        try:
            result, sha256, file_name = db.download_one(row["dataset"], row["symbol"], period, suffix)
        except Exception as e:
            failures += 1
            print(f"FAILED   {row['dataset']:<10} {row['symbol']} {period}: {e}", file=sys.stderr)
            continue
        if result == "missing":                               # gone again since the fingerprint
            continue
        changes.append((kind, row))
        row.update(status="saved", file=file_name, sha256=sha256 or sha_now)
    return changes, failures, rows


def main():
    parser = argparse.ArgumentParser(description="Re-check loaded days against Binance.")
    parser.add_argument("--manifests", default=str(DEFAULT_MANIFESTS),
                        help="folder holding date=YYYY-MM-DD/manifest.csv (default: ../data/manifests)")
    parser.add_argument("--workers", type=int, default=16, help="requests at the same time (default: 16)")
    args = parser.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    files = sorted(pathlib.Path(args.manifests).glob("date=*/manifest.csv"))
    if not files:
        print("No manifests to check.")
        return 0

    total_changes, total_failures = 0, 0
    for path in files:
        period = path.parent.name.removeprefix("date=")
        with open(path, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        changes, failures, rows = recheck_day(period, rows, args.workers)
        total_failures += failures
        counts = {k: sum(1 for c, _ in changes if c == k) for k in ("changed", "new", "removed")}
        print(f"{period}: {len(rows)} files checked, " + ", ".join(f"{n} {k}" for k, n in counts.items()))
        for kind, row in changes:
            print(f"  {kind:<8} {row['dataset']:<10} {row['symbol']}")
        if counts["changed"] or counts["new"]:
            total_changes += counts["changed"] + counts["new"]
            db.write_manifest(period, [(r["dataset"], r["symbol"], r["status"], r["file"], r["sha256"]) for r in rows])

    if total_changes:
        # Shown on the run's summary page in GitHub.
        print(f"::warning title=Binance changed files::{total_changes} file(s) changed or appeared "
              "after their day was loaded; they are being loaded again.")
    return 1 if total_failures else 0


if __name__ == "__main__":
    sys.exit(main())
