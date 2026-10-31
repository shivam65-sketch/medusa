"""Refresh dbt/seeds/dim_market_type.csv: what each USDT perpetual is, from Binance's contract list.

Binance's archive of daily files doesn't say whether a market is a coin, a stock or a commodity. Only its
live contract list does, and that API turns away many cloud addresses, so this runs on a person's
computer, not in the daily workflow. dbt loads the file on every build. `assert_market_types_known`
warns when a trading market isn't in the file yet: run this, then commit the file.

A market Binance no longer lists stays in the file as it was, so old moves keep their type.

Standard library only.

  python refresh_market_types.py
"""
import csv
import datetime as dt
import json
import pathlib
import sys
import urllib.request

LIST_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo"
OUT_FILE = pathlib.Path(__file__).resolve().parent.parent / "dbt" / "seeds" / "dim_market_type.csv"
COLUMNS = ["symbol", "market_type", "underlying_type", "contract_type", "onboard_date"]
PERPETUALS = ("PERPETUAL", "TRADIFI_PERPETUAL")

# The same groups as the Markets page (TYPES in public/markets.js). Any other underlying is 'other'.
TYPES = {
    "COIN": "crypto",
    "EQUITY": "stock",
    "HK_EQUITY": "stock",
    "KR_EQUITY": "stock",
    "CN_EQUITY": "stock",
    "COMMODITY": "commodity",
}


def contract_list():
    req = urllib.request.Request(LIST_URL, headers={"user-agent": "medusa-lakehouse"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["symbols"]


def row_of(s):
    onboard = dt.datetime.fromtimestamp(s["onboardDate"] / 1000, dt.timezone.utc).date().isoformat()
    underlying = s.get("underlyingType") or ""
    return {"symbol": s["symbol"], "market_type": TYPES.get(underlying, "other"), "underlying_type": underlying,
            "contract_type": s["contractType"], "onboard_date": onboard}


def main():
    sys.stdout.reconfigure(encoding="utf-8")   # some symbols aren't Latin letters
    kept = {}
    if OUT_FILE.exists():
        with OUT_FILE.open(newline="", encoding="utf-8") as f:
            kept = {r["symbol"]: r for r in csv.DictReader(f)}

    listed = [row_of(s) for s in contract_list() if s.get("quoteAsset") == "USDT" and s.get("contractType") in PERPETUALS]
    if not listed:
        print("Binance's contract list came back empty; the file is unchanged.", file=sys.stderr)
        return 1

    new = [r["symbol"] for r in listed if r["symbol"] not in kept]
    changed = [r["symbol"] for r in listed if r["symbol"] in kept and kept[r["symbol"]] != r]
    rows = {**kept, **{r["symbol"]: r for r in listed}}

    tmp = OUT_FILE.with_suffix(".tmp")
    with tmp.open("w", newline="\n", encoding="utf-8") as f:
        w = csv.DictWriter(f, COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows[s] for s in sorted(rows))
    tmp.replace(OUT_FILE)

    gone = len(rows) - len(listed)
    print(f"{len(rows)} markets: {len(listed)} listed now, {gone} no longer listed and kept.")
    print(f"New: {', '.join(new) or 'none'}")
    print(f"Changed: {', '.join(changed) or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
