"""Copy the live scanner's tables into MEDUSA's database (the serving layer, step 24): two gold tables,
and the current version of every metric definition (market.semantic, step 27).

After the daily `dbt build`, the transform workflow runs this script. For each table it:
  1. reads the gold table from Databricks (the SQL Statement API, through the Databricks CLI, which
     is already signed in: DATABRICKS_HOST and DATABRICKS_TOKEN in GitHub Actions, the CLI profile on
     a developer's computer),
  2. sends every row to MEDUSA's write-only endpoint, POST <MEDUSA_URL>/api/market/ingest, with the
     MEDUSA_INGEST_TOKEN; MEDUSA replaces the table in one transaction (ADR-024),
  3. reconciles: MEDUSA must report exactly as many rows as gold has, or the step fails.

Standard library only (plus the Databricks CLI).

  MEDUSA_URL=https://... MEDUSA_INGEST_TOKEN=... python publish_to_medusa.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

WAREHOUSE_NAME = "Serverless Starter Warehouse"
CLI = os.environ.get("DATABRICKS_CLI", "databricks")

# MEDUSA table -> the gold query that fills it. Column names match MEDUSA's columns (src/market.js).
TABLES = {
    "market_baseline": """
        select symbol, base_asset, status, cast(as_of_date as string) as as_of_date, last_close, history_days,
               avg_return_30d, sd_return_30d, avg_abs_return_30d, avg_quote_volume_30d, avg_log_volume_30d,
               sd_log_volume_30d, avg_abs_hour_return_30d
        from market.gold.coin_baseline""",
    "market_evidence": """
        select direction, z_band, liquidity, horizon_hours, events, days, avg_continuation, median_continuation,
               hit_rate, in_sample_days, in_sample_avg_continuation, in_sample_t, held_back_days,
               held_back_avg_continuation, held_back_t, held_back_hit_rate, side, held_back_net_after_cost,
               verdict, round_trip_cost
        from market.gold.event_evidence""",
    # Only the version in use of each definition; the full history stays in the lakehouse.
    "market_metrics": """
        select metric_id, version, kind, name, description, sql_text, display,
               date_format(valid_from, 'yyyy-MM-dd HH:mm:ss') as valid_from, changed_by, change_note
        from market.semantic.metric_definitions
        where is_current""",
}
# The day the copy reflects: the newest day in the lakehouse.
AS_OF = "select cast(max(trade_date) as string) as as_of from market.gold.coin_daily"


def cli(*args, body=None):
    """Run a Databricks CLI api call and return its JSON answer."""
    cmd = [CLI, "api", *args]
    tmp = None
    if body is not None:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(body, tmp)
        tmp.close()
        cmd += ["--json", "@" + tmp.name]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    finally:
        if tmp:
            os.unlink(tmp.name)
    if out.returncode:
        raise RuntimeError(f"databricks {' '.join(args[:2])} failed: {out.stderr.strip()[:300]}")
    return json.loads(out.stdout)


def warehouse_id():
    for w in cli("get", "/api/2.0/sql/warehouses").get("warehouses", []):
        if w["name"] == WAREHOUSE_NAME:
            return w["id"]
    raise RuntimeError(f"no SQL warehouse named {WAREHOUSE_NAME!r}")


def query(warehouse, sql):
    """Rows of a query as dicts, with numbers and strings typed from the result's schema."""
    r = cli("post", "/api/2.0/sql/statements", body={
        "warehouse_id": warehouse, "statement": sql, "wait_timeout": "50s",
        "on_wait_timeout": "CONTINUE", "format": "JSON_ARRAY", "disposition": "INLINE"})
    while r["status"]["state"] in ("PENDING", "RUNNING"):
        time.sleep(5)
        r = cli("get", f"/api/2.0/sql/statements/{r['statement_id']}")
    if r["status"]["state"] != "SUCCEEDED":
        raise RuntimeError(f"query failed: {r['status'].get('error', {}).get('message', r['status'])}")
    columns = r["manifest"]["schema"]["columns"]
    data, result = [], r.get("result", {})
    while True:
        data += result.get("data_array") or []
        link = result.get("next_chunk_internal_link")
        if not link:
            break
        result = cli("get", link)

    def typed(col, v):
        if v is None:
            return None
        if col["type_name"] in ("INT", "BIGINT", "LONG", "SHORT", "BYTE"):
            return int(v)
        if col["type_name"] in ("DOUBLE", "FLOAT", "DECIMAL"):
            return float(v)
        return v

    return [{c["name"]: typed(c, v) for c, v in zip(columns, row)} for row in data]


def send(url, token, payload):
    """POST one table to MEDUSA; retried twice on a network error or a server error."""
    data = json.dumps(payload).encode()
    for attempt in range(1, 4):
        req = urllib.request.Request(url, data=data, method="POST", headers={
            "authorization": f"Bearer {token}", "content-type": "application/json",
            "user-agent": "medusa-lakehouse-publish"})
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
    url = os.environ.get("MEDUSA_URL", "").rstrip("/")
    token = os.environ.get("MEDUSA_INGEST_TOKEN", "")
    if not url or not token:
        print("MEDUSA_URL and MEDUSA_INGEST_TOKEN must be set.", file=sys.stderr)
        return 1

    warehouse = warehouse_id()
    as_of = query(warehouse, AS_OF)[0]["as_of"]
    print(f"Lakehouse day: {as_of}")

    summary, failed = [], False
    for table, sql in TABLES.items():
        try:
            rows = query(warehouse, sql)
            answer = send(f"{url}/api/market/ingest", token, {"table": table, "as_of": as_of, "rows": rows})
            ok = answer.get("ok") is True and answer.get("rows") == len(rows)
            # "kv": MEDUSA rebuilt the scanner's ready-made answer; "d1": it couldn't, so the scanner
            # reads D1 until the next publish (the data is still right, ADR-026).
            served = answer.get("served", "-")
            summary.append((table, len(rows), answer.get("rows"), "OK" if ok else "MISMATCH", served))
            print(f"{table}: lakehouse {len(rows)} rows, MEDUSA {answer.get('rows')} rows: {'OK' if ok else 'MISMATCH'}; scanner answer from {served}")
            failed |= not ok
        except Exception as e:
            summary.append((table, None, None, "FAILED", "-"))
            print(f"FAILED   {table}: {e}", file=sys.stderr)
            failed = True

    # A small table on the run's summary page in GitHub.
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(f"### Published to MEDUSA (lakehouse day {as_of})\n\n| Table | Lakehouse rows | MEDUSA rows | Check | Scanner answer |\n|---|---|---|---|---|\n")
            for t, g, m, s, v in summary:
                f.write(f"| `{t}` | {g if g is not None else '-'} | {m if m is not None else '-'} | {s} | {v} |\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
