"""Write what a lakehouse workflow run did into ops.logs.pipeline_events (lakehouse step 31).

Two commands:
  jobs  At the end of a workflow run (the log job of lakehouse-log-run.yml, which runs even when an
        earlier job failed): reads every finished job of this run, with its steps, from GitHub's API
        and writes one row per job: succeeded, failed (and at which step), cancelled or skipped.
  dbt   Right after dbt, in the transform job: writes one row with the build's counts and one more
        for each model, snapshot, test or source freshness check that failed or warned, from the
        files dbt writes in target/ (run_results.json, sources.json).

All the rows go to Databricks in one INSERT, through the SQL Statement API. The rows travel as one
JSON parameter, never inside the SQL, and only event ids not in the table yet are added, so running
it twice for the same run adds nothing (a re-run of the run is a new attempt, with new ids).

Standard library only (plus the Databricks CLI).

  python ops/log_pipeline_run.py jobs [--data-date YYYY-MM-DD|yesterday] [--dry-run]
  python ops/log_pipeline_run.py dbt --target dbt/target [--dry-run]

In GitHub Actions the run comes from the environment (GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, ...); the
jobs command also needs GITHUB_TOKEN. --dry-run prints the rows instead of writing them; with
--repo and --run-id it describes any past run of a public repository.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.request

from databricks_sql import run, warehouse_id

TABLE = "ops.logs.pipeline_events"
FIELDS = [("event_id", "string"), ("event_time", "string"), ("severity", "string"), ("status", "string"),
          ("source", "string"), ("workflow", "string"), ("job", "string"), ("component", "string"),
          ("message", "string"), ("details", "string"), ("data_date", "string"), ("started_at", "string"),
          ("duration_seconds", "int"), ("run_id", "bigint"), ("run_attempt", "int"), ("run_url", "string"),
          ("git_sha", "string"), ("trigger", "string")]
SCHEMA = "array<struct<" + ",".join(f"{n}:{t}" for n, t in FIELDS) + ">>"

# The JSON rows become table rows inside Databricks: inline() turns the array of structs into rows,
# the times are cast, and rows whose event_id is already in the table are left out.
INSERT = f"""
INSERT INTO {TABLE} (event_id, event_time, severity, status, source, workflow, job, component, message, details,
                     data_date, started_at, duration_seconds, run_id, run_attempt, run_url, git_sha, trigger, logged_at)
SELECT n.event_id, CAST(n.event_time AS TIMESTAMP), n.severity, n.status, n.source, n.workflow, n.job, n.component,
       n.message, n.details, CAST(n.data_date AS DATE), CAST(n.started_at AS TIMESTAMP), n.duration_seconds,
       n.run_id, n.run_attempt, n.run_url, n.git_sha, n.trigger, current_timestamp()
FROM (SELECT inline(from_json(:rows, '{SCHEMA}'))) AS n
WHERE NOT EXISTS (SELECT 1 FROM {TABLE} AS p WHERE p.event_id = n.event_id)"""

# GitHub's conclusion of a job -> the table's status and severity.
STATUS = {"success": "success", "failure": "failure", "timed_out": "failure", "cancelled": "cancelled",
          "skipped": "skipped", "startup_failure": "failure", "action_required": "failure", "neutral": "success"}
SEVERITY = {"success": "info", "skipped": "info", "cancelled": "warning", "failure": "error"}
DAY = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")


def run_context(args):
    """Who and what this run is, from GitHub's environment (or the command line, for a dry run)."""
    env = os.environ
    repo = args.repo or env.get("GITHUB_REPOSITORY", "")
    run_id = int(args.run_id or env.get("GITHUB_RUN_ID", "0"))
    attempt = int(args.attempt or env.get("GITHUB_RUN_ATTEMPT", "1"))
    server = env.get("GITHUB_SERVER_URL", "https://github.com")
    return {
        "repo": repo, "run_id": run_id, "run_attempt": attempt,
        "workflow": args.workflow or env.get("GITHUB_WORKFLOW", ""),
        "run_url": f"{server}/{repo}/actions/runs/{run_id}/attempts/{attempt}" if repo else None,
        "git_sha": env.get("GITHUB_SHA") or None,
        "trigger": env.get("GITHUB_EVENT_NAME") or None,
    }


def seconds_between(start, end):
    if not start or not end:
        return None
    a = dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
    b = dt.datetime.fromisoformat(end.replace("Z", "+00:00"))
    return max(0, int((b - a).total_seconds()))


def took(sec):
    if sec is None:
        return ""
    return f" in {sec // 60}m {sec % 60:02d}s" if sec >= 60 else f" in {sec}s"


def github(path, token):
    req = urllib.request.Request("https://api.github.com" + path, headers={
        "accept": "application/vnd.github+json", "user-agent": "medusa-lakehouse-log",
        **({"authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def job_rows(ctx, data_date):
    """One row per finished job of this run attempt (the log job itself is still running: left out)."""
    answer = github(f"/repos/{ctx['repo']}/actions/runs/{ctx['run_id']}/attempts/{ctx['run_attempt']}/jobs?per_page=100",
                    os.environ.get("GITHUB_TOKEN", ""))
    if data_date == "yesterday":
        # The daily load loads the day before it starts (UTC), like download_binance.py.
        starts = [j["started_at"] for j in answer.get("jobs", []) if j.get("started_at")]
        first = dt.datetime.fromisoformat(min(starts).replace("Z", "+00:00")) if starts else dt.datetime.now(dt.timezone.utc)
        data_date = (first.date() - dt.timedelta(days=1)).isoformat()
    rows = []
    for j in answer.get("jobs", []):
        if j.get("status") != "completed":
            continue
        # "transform / transform" (a reusable workflow) -> "transform"; matrix values stay: "load (2026-10-01)".
        name = j["name"].split(" / ")[0]
        status = STATUS.get(j.get("conclusion") or "", "failure")
        steps = [{"name": s["name"], "conclusion": s.get("conclusion"),
                  "seconds": seconds_between(s.get("started_at"), s.get("completed_at"))}
                 for s in j.get("steps", [])
                 if s["name"] not in ("Set up job", "Complete job") and not s["name"].startswith("Post ")]
        failed = next((s["name"] for s in steps if s["conclusion"] in ("failure", "timed_out", "cancelled")), None)
        sec = seconds_between(j.get("started_at"), j.get("completed_at"))
        if status == "success":
            message = f"{name} succeeded{took(sec)}"
        elif status == "skipped":
            message = f"{name} skipped (a job it needs didn't succeed, or it wasn't needed)"
        elif status == "cancelled":
            message = f"{name} cancelled" + (f" during step '{failed}'" if failed else "")
        else:
            message = f"{name} failed" + (f" at step '{failed}'" if failed else "") + took(sec)
        day = DAY.search(name)
        rows.append({
            "event_id": f"gh:{ctx['run_id']}:{ctx['run_attempt']}:{j['id']}",
            "event_time": j.get("completed_at") or dt.datetime.now(dt.timezone.utc).isoformat(),
            "severity": SEVERITY[status], "status": status, "source": "github_actions",
            "workflow": j.get("workflow_name") or ctx["workflow"], "job": name, "component": "job",
            "message": message,
            "details": json.dumps({"job_url": j.get("html_url"), "failed_step": failed, "steps": steps}),
            "data_date": day.group(1) if day else data_date,
            "started_at": j.get("started_at"), "duration_seconds": sec,
            "run_id": ctx["run_id"], "run_attempt": ctx["run_attempt"], "run_url": ctx["run_url"],
            "git_sha": j.get("head_sha") or ctx["git_sha"], "trigger": ctx["trigger"],
        })
    return rows


def kind_and_name(unique_id):
    """'test.medusa_lakehouse.not_null_coin_daily_close' -> ('test', 'not_null_coin_daily_close')."""
    parts = unique_id.split(".")
    return parts[0], ".".join(parts[2:]) or unique_id


def dbt_rows(ctx, target, job, data_date):
    """One row with the build's counts, and one per node that failed or warned."""
    rows, now = [], dt.datetime.now(dt.timezone.utc).isoformat()

    def row(suffix, when, severity, status, message, details):
        return {"event_id": f"gh:{ctx['run_id']}:{ctx['run_attempt']}:dbt:{suffix}", "event_time": when or now,
                "severity": severity, "status": status, "source": "github_actions", "workflow": ctx["workflow"],
                "job": job, "component": "dbt", "message": message[:1000], "details": json.dumps(details),
                "data_date": data_date, "started_at": None, "duration_seconds": None, "run_id": ctx["run_id"],
                "run_attempt": ctx["run_attempt"], "run_url": ctx["run_url"], "git_sha": ctx["git_sha"],
                "trigger": ctx["trigger"]}

    # Source freshness (dbt source freshness, before the build): only checks that warned or failed.
    path = os.path.join(target, "sources.json")
    if os.path.exists(path):
        doc = json.load(open(path, encoding="utf-8"))
        when = doc.get("metadata", {}).get("generated_at")
        for r in doc.get("results", []):
            if r.get("status") in ("warn", "error", "runtime error"):
                _, name = kind_and_name(r["unique_id"])
                age = r.get("max_loaded_at_time_ago_in_s")
                hours = f", last data {age / 3600:.0f} hours ago" if isinstance(age, (int, float)) else ""
                bad = r["status"] != "warn"
                rows.append(row(f"freshness:{r['unique_id']}", when, "error" if bad else "warning",
                                "failure" if bad else "success", f"source {name} freshness {r['status']}{hours}",
                                {"unique_id": r["unique_id"], "status": r["status"], "max_loaded_at": r.get("max_loaded_at"),
                                 "criteria": r.get("criteria"), "error": r.get("error")}))

    # The build: counts, then each node that didn't pass.
    path = os.path.join(target, "run_results.json")
    if os.path.exists(path):
        doc = json.load(open(path, encoding="utf-8"))
        if doc.get("args", {}).get("which") == "build":
            when = doc.get("metadata", {}).get("generated_at")
            results = doc.get("results", [])
            built = sum(1 for r in results if r["unique_id"].split(".")[0] in ("model", "snapshot", "seed") and r["status"] == "success")
            passed = sum(1 for r in results if r["status"] == "pass")
            failed = [r for r in results if r["status"] in ("error", "fail", "runtime error")]
            warned = [r for r in results if r["status"] == "warn"]
            skipped = sum(1 for r in results if r["status"] == "skipped")
            sec = int(doc.get("elapsed_time") or 0)
            status = "failure" if failed else "success"
            rows.append(row("build", when, "error" if failed else "warning" if warned else "info", status,
                            f"dbt build: {built} models and snapshots built, {passed} tests passed, {len(failed)} failed, "
                            f"{len(warned)} warned, {skipped} skipped{took(sec)}",
                            {"built": built, "passed": passed, "failed": len(failed), "warned": len(warned),
                             "skipped": skipped, "elapsed_seconds": sec}))
            for r in failed + warned:
                kind, name = kind_and_name(r["unique_id"])
                bad = r["status"] != "warn"
                n = r.get("failures")
                what = (f"{n} failing row{'' if n == 1 else 's'}" if kind == "test" and isinstance(n, int) and n
                        else (r.get("message") or r["status"]))
                rows.append(row(r["unique_id"], when, "error" if bad else "warning", "failure" if bad else "success",
                                f"{kind} {name} {'failed' if bad else 'warned'}: {what}",
                                {"unique_id": r["unique_id"], "status": r["status"], "failures": n,
                                 "message": (r.get("message") or "")[:2000], "relation": r.get("relation_name"),
                                 "seconds": round(r.get("execution_time") or 0, 1)}))
    return rows


def main():
    sys.stdout.reconfigure(line_buffering=True)
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("command", choices=["jobs", "dbt"])
    p.add_argument("--data-date", default="",
                   help="The day of market data the run loaded: YYYY-MM-DD, or yesterday (the day before the run's first job started)")
    p.add_argument("--target", default="dbt/target", help="dbt's target folder (dbt command)")
    p.add_argument("--job", default="transform", help="The job that ran dbt (dbt command)")
    p.add_argument("--dry-run", action="store_true", help="Print the rows instead of writing them")
    p.add_argument("--repo", help="owner/name, for a dry run outside GitHub Actions")
    p.add_argument("--run-id", help="A run id, for a dry run outside GitHub Actions")
    p.add_argument("--attempt", help="The run attempt, for a dry run outside GitHub Actions")
    p.add_argument("--workflow", help="The workflow name, for a dry run outside GitHub Actions")
    args = p.parse_args()

    data_date = args.data_date if DAY.fullmatch(args.data_date or "") or args.data_date == "yesterday" else None
    if args.command == "dbt" and data_date == "yesterday":
        data_date = None
    ctx = run_context(args)
    rows = job_rows(ctx, data_date) if args.command == "jobs" else dbt_rows(ctx, args.target, args.job, data_date)
    for r in rows:
        print(f"{r['severity']:<7} {r['job']:<22} {r['message']}")
    if args.dry_run or not rows:
        if args.dry_run:
            print(json.dumps(rows, indent=1)[:4000])
        return 0
    run(warehouse_id(), INSERT, {"rows": json.dumps(rows)})
    print(f"Wrote {len(rows)} rows to {TABLE} (any already there were left as they were).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
