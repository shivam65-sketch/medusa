"""Run SQL in Databricks from a script: the SQL Statement API through the Databricks CLI, which is
already signed in (DATABRICKS_HOST and DATABRICKS_TOKEN in GitHub Actions, the CLI profile on a
developer's computer). Used by the ops scripts in this folder. Standard library only.
"""
import json
import os
import subprocess
import tempfile
import time

WAREHOUSE_NAME = "Serverless Starter Warehouse"
CLI = os.environ.get("DATABRICKS_CLI", "databricks")


def cli(*args, body=None):
    """Run a Databricks CLI api call and return its JSON answer."""
    cmd = [CLI, "api", *args]
    tmp = None
    if body is not None:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
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
    """The warehouse is found by its name, so no id is stored in the repository."""
    for w in cli("get", "/api/2.0/sql/warehouses").get("warehouses", []):
        if w["name"] == WAREHOUSE_NAME:
            return w["id"]
    raise RuntimeError(f"no SQL warehouse named {WAREHOUSE_NAME!r}")


def run(warehouse, sql, params=None):
    """Run one statement, with named parameters (:name) sent separately from the SQL, and return its
    rows as dicts. A value sent as a parameter is only ever data, never part of the statement."""
    body = {"warehouse_id": warehouse, "statement": sql, "wait_timeout": "50s",
            "on_wait_timeout": "CONTINUE", "format": "JSON_ARRAY", "disposition": "INLINE"}
    if params:
        body["parameters"] = [{"name": k, "value": v, "type": "STRING"} for k, v in params.items()]
    r = cli("post", "/api/2.0/sql/statements", body=body)
    while r["status"]["state"] in ("PENDING", "RUNNING"):
        time.sleep(5)
        r = cli("get", f"/api/2.0/sql/statements/{r['statement_id']}")
    if r["status"]["state"] != "SUCCEEDED":
        raise RuntimeError(f"statement failed: {r['status'].get('error', {}).get('message', r['status'])}")
    columns = [c["name"] for c in r.get("manifest", {}).get("schema", {}).get("columns", [])]
    return [dict(zip(columns, row)) for row in (r.get("result", {}).get("data_array") or [])]
