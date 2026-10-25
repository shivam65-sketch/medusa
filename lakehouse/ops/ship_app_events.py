"""Copy MEDUSA's failures into ops.logs.app_events (lakehouse step 31).

The daily load's log job runs this once a day, whatever happened to the load. It:
  1. asks Databricks for the highest MEDUSA id already copied, for each source (browser: the error
     lines MEDUSA's pages reported; server: the errors MEDUSA's server hit),
  2. asks MEDUSA for the errors after those ids: GET <MEDUSA_URL>/api/ops/events with its own
     read-only token (MEDUSA_OPS_TOKEN), up to 500 of each at a time, until there are no more,
  3. inserts each page in one statement; ids already in the table are left out, so a page sent twice
     adds nothing.

The high-water mark is MEDUSA's row id, not the time of the error: a page's lines can arrive late (a
browser that was offline), but they always get new ids, so nothing is skipped. MEDUSA never sends which
account had the error.

Standard library only (plus the Databricks CLI).

  MEDUSA_URL=https://... MEDUSA_OPS_TOKEN=... python ops/ship_app_events.py [--dry-run]

--dry-run reads from Databricks and MEDUSA but writes nothing.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from databricks_sql import run, warehouse_id

TABLE = "ops.logs.app_events"
MAX_PAGES = 20
SCHEMA = "array<struct<source:string,source_id:bigint,at:bigint,area:string,message:string,details:string>>"

HIGH_WATER = f"SELECT source, CAST(MAX(source_id) AS STRING) AS last FROM {TABLE} GROUP BY source"
INSERT = f"""
INSERT INTO {TABLE} (event_id, source, source_id, event_time, severity, area, message, details, logged_at)
SELECT concat(n.source, ':', CAST(n.source_id AS STRING)), n.source, n.source_id, timestamp_millis(n.at), 'error',
       n.area, n.message, n.details, current_timestamp()
FROM (SELECT inline(from_json(:rows, '{SCHEMA}'))) AS n
WHERE NOT EXISTS (SELECT 1 FROM {TABLE} AS a WHERE a.event_id = concat(n.source, ':', CAST(n.source_id AS STRING)))"""


def fetch(url, token):
    """GET one page from MEDUSA; retried twice on a network error or a server error."""
    for attempt in range(1, 4):
        req = urllib.request.Request(url, headers={"authorization": f"Bearer {token}", "user-agent": "medusa-lakehouse-ops"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            answer = e.read().decode(errors="replace")[:300]
            if e.code < 500 or attempt == 3:
                raise RuntimeError(f"MEDUSA answered {e.code}: {answer}") from None
        except (OSError, ValueError) as e:
            if attempt == 3:
                raise RuntimeError(f"couldn't reach MEDUSA: {e}") from None
        time.sleep(10 * attempt)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--dry-run", action="store_true", help="Read from Databricks and MEDUSA, write nothing")
    args = p.parse_args()
    base = os.environ.get("MEDUSA_URL", "").rstrip("/")
    token = os.environ.get("MEDUSA_OPS_TOKEN", "")
    if not base or not token:
        print("MEDUSA_URL and MEDUSA_OPS_TOKEN must be set.", file=sys.stderr)
        return 1

    warehouse = warehouse_id()
    after = {"browser": 0, "server": 0}
    for r in run(warehouse, HIGH_WATER):
        after[r["source"]] = int(r["last"] or 0)
    print(f"Already copied: browser up to id {after['browser']}, server up to id {after['server']}")

    copied = {"browser": 0, "server": 0}
    for _ in range(MAX_PAGES):
        q = urllib.parse.urlencode({"browser_after": after["browser"], "server_after": after["server"]})
        page = fetch(f"{base}/api/ops/events?{q}", token)
        for source in ("browser", "server"):
            last = (page.get("last") or {}).get(source) or 0
            if last < after[source]:
                print(f"::warning::MEDUSA's highest {source} id ({last}) is below the one already copied "
                      f"({after[source]}): was its table made again? New rows are not copied until it passes.")
        rows = [{"source": source, "source_id": e["id"], "at": e["at"], "area": e.get("area") or source,
                 "message": e.get("msg") or "Error", "details": e.get("data")}
                for source in ("browser", "server") for e in page.get(source) or []]
        if not rows:
            break
        for r in rows:
            print(f"{r['source']:<8} {r['source_id']:>8} {r['area']:<10} {r['message'][:110]}")
        if not args.dry_run:
            run(warehouse, INSERT, {"rows": json.dumps(rows)})
        for source in ("browser", "server"):
            ids = [r["source_id"] for r in rows if r["source"] == source]
            if ids:
                after[source] = max(after[source], max(ids))
                copied[source] += len(ids)
        if not page.get("more"):
            break

    verb = "Would copy" if args.dry_run else "Copied"
    print(f"{verb} {copied['browser']} browser and {copied['server']} server errors to {TABLE}.")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(f"### MEDUSA errors copied to `{TABLE}`\n\n| Source | New rows | Copied up to id |\n|---|---|---|\n"
                    f"| browser | {copied['browser']} | {after['browser']} |\n| server | {copied['server']} | {after['server']} |\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
