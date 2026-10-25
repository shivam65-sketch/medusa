"""Write what the lakehouse workflow runs did into the ETL log tables in ops.logs (lakehouse step 31):

  etl_runs    one row per run of a workflow: scheduled or manual, the day(s) loaded, the result
    etl_jobs    one row per job of the run
      etl_steps   one row per step of the job (dbt's steps with their counts)
    etl_errors  each failed step with the end of its log, and each dbt model, test or freshness check
                that failed or warned

Two commands:
  run       The last job of every lakehouse workflow (lakehouse-log-run.yml) describes its own run,
            whose other jobs have all finished: the run, its jobs and steps, and the log of a failed
            job, from GitHub's API; dbt's counts and failures from the result files the transform
            left (the dbt-results artifact), when it ran.
  backfill  Describes every finished run of the lakehouse workflows since a day, from GitHub's API
            (GitHub keeps 90 days). Used once, to fill the tables from GitHub's history. dbt's result
            files aren't kept, so these runs have no dbt counts or dbt errors.

Each table gets one INSERT. The rows travel as one JSON parameter, never inside the SQL, and only keys
not in the table yet are added, so describing the same run twice adds nothing. A re-run is a new
attempt with its own keys.

Standard library only (plus the Databricks CLI). In GitHub Actions the run comes from the environment
(GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT) and GITHUB_TOKEN reads it; a failed job's log
needs the token. --dry-run prints the rows instead of writing them; with --repo and --run-id it
describes any run of a public repository.

  python ops/log_pipeline_run.py run [--data-date YYYY-MM-DD|yesterday] [--inputs JSON] [--dbt-results DIR] [--dry-run]
  python ops/log_pipeline_run.py backfill --since YYYY-MM-DD [--dry-run]
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request

from databricks_sql import run as run_sql, warehouse_id

SCHEMA = "ops.logs"
WORKFLOWS = {"lakehouse-daily.yml", "lakehouse-backfill.yml", "lakehouse-history.yml", "lakehouse-transform.yml"}
LABEL = {"Lakehouse daily load": "Daily load", "Lakehouse backfill": "Backfill", "Lakehouse history": "History load",
         "Lakehouse transform": "Transform"}
DBT_STEPS = {"freshness": "Check bronze is fresh", "build": "Build and test silver and gold"}
HOUSEKEEPING = ("Set up job", "Complete job")
DAY = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
YEAR = re.compile(r"\((\d{4})\)")

# Each table's columns as the JSON rows carry them ("timestamp" and "date" travel as text and are cast).
TABLES = {
    "etl_runs": ("run_key", [
        ("run_key", "string"), ("workflow", "string"), ("workflow_file", "string"), ("run_number", "int"),
        ("run_id", "bigint"), ("run_attempt", "int"), ("run_type", "string"), ("triggered_by", "string"),
        ("trigger_event", "string"), ("scheduled_for", "timestamp"), ("start_delay_minutes", "int"), ("inputs", "string"), ("data_date", "date"), ("data_from", "date"),
        ("data_to", "date"), ("status", "string"), ("started_at", "timestamp"), ("finished_at", "timestamp"),
        ("duration_seconds", "int"), ("jobs_total", "int"), ("jobs_succeeded", "int"), ("jobs_failed", "int"),
        ("jobs_skipped", "int"), ("jobs_cancelled", "int"), ("message", "string"), ("git_sha", "string"),
        ("branch", "string"), ("run_url", "string")]),
    "etl_jobs": ("job_key", [
        ("job_key", "string"), ("run_key", "string"), ("job_id", "bigint"), ("job_name", "string"),
        ("status", "string"), ("data_date", "date"), ("started_at", "timestamp"), ("finished_at", "timestamp"),
        ("duration_seconds", "int"), ("steps_total", "int"), ("failed_step", "string"), ("message", "string"),
        ("job_url", "string")]),
    "etl_steps": ("step_key", [
        ("step_key", "string"), ("job_key", "string"), ("run_key", "string"), ("step_number", "int"),
        ("step_name", "string"), ("status", "string"), ("started_at", "timestamp"), ("finished_at", "timestamp"),
        ("duration_seconds", "int"), ("details", "string")]),
    "etl_errors": ("error_key", [
        ("error_key", "string"), ("run_key", "string"), ("job_key", "string"), ("step_key", "string"),
        ("event_time", "timestamp"), ("severity", "string"), ("category", "string"), ("object", "string"),
        ("message", "string"), ("details", "string")]),
}


def insert_sql(table):
    """INSERT ... SELECT from the JSON rows: inline() turns the array of structs into rows, times and
    days are cast, and rows whose key is already in the table are left out."""
    key, fields = TABLES[table]
    schema = "array<struct<" + ",".join(f"{n}:{'string' if t in ('timestamp', 'date') else t}" for n, t in fields) + ">>"
    pick = [f"CAST(n.{n} AS {t.upper()})" if t in ("timestamp", "date") else f"n.{n}" for n, t in fields]
    return (f"INSERT INTO {SCHEMA}.{table} ({', '.join(n for n, _ in fields)}, logged_at)\n"
            f"SELECT {', '.join(pick)}, current_timestamp()\n"
            f"FROM (SELECT inline(from_json(:rows, '{schema}'))) AS n\n"
            f"WHERE NOT EXISTS (SELECT 1 FROM {SCHEMA}.{table} AS t WHERE t.{key} = n.{key})")


# ---------- GitHub ----------

API = "https://api.github.com"


def github(path):
    token = os.environ.get("GITHUB_TOKEN", "")
    req = urllib.request.Request(API + path, headers={"accept": "application/vnd.github+json", "user-agent": "medusa-lakehouse-log",
                                                      **({"authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


class _Stay(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def job_log(repo, job_id):
    """A finished job's log as text, or None. GitHub answers with a redirect to a storage address,
    which is fetched without the token (the token is only for GitHub)."""
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        return None
    req = urllib.request.Request(f"{API}/repos/{repo}/actions/jobs/{job_id}/logs",
                                 headers={"authorization": f"Bearer {token}", "user-agent": "medusa-lakehouse-log"})
    try:
        with urllib.request.build_opener(_Stay).open(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308) and e.headers.get("location"):
            with urllib.request.urlopen(urllib.request.Request(e.headers["location"], headers={"user-agent": "medusa-lakehouse-log"}), timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        return None
    except OSError:
        return None


def error_lines(log):
    """The lines GitHub marked as errors and up to 15 lines before the first, without timestamps."""
    lines = [re.sub(r"^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?", "", l) for l in log.splitlines()]
    marks = [i for i, l in enumerate(lines) if "##[error]" in l]
    if not marks:
        return None, None
    first, last = marks[0], marks[-1]
    tail = "\n".join(lines[max(0, first - 15): last + 1][-40:])[-4000:]
    headline = next((lines[i].split("##[error]", 1)[1].strip() for i in marks if "exit code" not in lines[i]),
                    lines[first].split("##[error]", 1)[1].strip())
    return headline, tail


# ---------- describing a run ----------

def ts(v):
    return dt.datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None


def seconds(a, b):
    a, b = ts(a), ts(b)
    return max(0, int((b - a).total_seconds())) if a and b else None


def took(sec):
    if sec is None:
        return ""
    return f" in {sec // 60}m {sec % 60:02d}s" if sec >= 60 else f" in {sec}s"


STATUS = {"success": "success", "failure": "failure", "timed_out": "failure", "cancelled": "cancelled",
          "skipped": "skipped", "startup_failure": "failure", "action_required": "failure", "neutral": "success"}


def job_name(name):
    """A called workflow's job is named '<caller job> / <its job>': 'transform / transform' -> 'transform',
    'load (2026-10-01) / load' -> 'load (2026-10-01)' (matrix values stay). Any other is kept whole."""
    parts = name.split(" / ")
    return parts[0] if re.sub(r" \(.*\)$", "", parts[0]) == parts[-1] else name


def dbt_files(folder):
    """dbt's result files from the transform, if it ran: (sources.json, run_results.json of a build)."""
    def load(name):
        p = os.path.join(folder, name) if folder else None
        return json.load(open(p, encoding="utf-8")) if p and os.path.exists(p) else None
    results = load("run_results.json")
    if results and results.get("args", {}).get("which") != "build":
        results = None
    return load("sources.json"), results


def describe(repo, run, jobs, data_date=None, inputs=None, dbt_folder=None, current=False):
    """Rows for the four tables from one run attempt (GitHub's run and its jobs)."""
    attempt = run["run_attempt"]
    run_key = f"gh:{run['id']}:{attempt}"
    workflow = run.get("name") or ""
    event = run.get("event")
    if attempt > 1:
        run_type = "re-run"
        triggered_by = f"Re-run (attempt {attempt}) of a {'scheduled' if event == 'schedule' else 'manual'} run, started by hand on GitHub"
    elif event == "schedule":
        run_type, triggered_by = "scheduled", "GitHub schedule"
    else:
        run_type, triggered_by = "manual", "Started by hand with Run workflow on GitHub"
    started = run.get("run_started_at") or run.get("created_at")
    scheduled_for = delay = None
    if event == "schedule":
        hm = cron_of(repo, run)
        if hm:
            # The schedule's last time at or before GitHub created the run (GitHub often starts it late).
            created = ts(run.get("created_at") or started)
            slot = created.replace(hour=hm[0], minute=hm[1], second=0, microsecond=0)
            if slot > created:
                slot -= dt.timedelta(days=1)
            scheduled_for = slot.isoformat().replace("+00:00", "Z")
            if attempt == 1:   # a re-run starts when someone presses Re-run, not on the schedule
                delay = int((ts(started) - slot).total_seconds() // 60)
                triggered_by = f"GitHub schedule: cron \"{hm[1]} {hm[0]} * * *\", every day at {hm[0]:02d}:{hm[1]:02d} UTC"

    if data_date == "yesterday":
        data_date = (ts(started).date() - dt.timedelta(days=1)).isoformat()
    elif not DAY.fullmatch(data_date or ""):
        data_date = None
    if data_date is None and workflow == "Lakehouse daily load" and event == "schedule":
        data_date = (ts(started).date() - dt.timedelta(days=1)).isoformat()   # a scheduled daily load loads yesterday

    rows = {t: [] for t in TABLES}
    sources, results = dbt_files(dbt_folder) if current else (None, None)
    counted = {"success": 0, "failure": 0, "skipped": 0, "cancelled": 0}
    days, years, first_failure, last_end = [], [], None, None
    for j in jobs:
        parts = j["name"].split(" / ")
        if j.get("status") != "completed" or parts[-1] == "log":   # the log job doesn't log itself
            continue
        name = job_name(j["name"])
        status = STATUS.get(j.get("conclusion") or "", "failure")
        counted[status] += 1
        job_key = f"{run_key}:{j['id']}"
        sec = seconds(j.get("started_at"), j.get("completed_at"))
        if j.get("completed_at") and (last_end is None or ts(j["completed_at"]) > ts(last_end)):
            last_end = j["completed_at"]
        steps = [s for s in j.get("steps", []) if s["name"] not in HOUSEKEEPING and not s["name"].startswith("Post ")]
        failed = next((s for s in steps if s.get("conclusion") in ("failure", "timed_out")), None)
        day = DAY.search(name)
        year = YEAR.search(name)
        if day:
            days.append(day.group(1))
        elif year:
            years.append(year.group(1))
        if status == "success":
            message = f"{name} succeeded{took(sec)}"
        elif status == "skipped":
            message = f"{name} skipped: a job it needs didn't succeed, or it wasn't needed"
        elif status == "cancelled":
            message = f"{name} cancelled" + (f" during step '{failed['name']}'" if failed else "")
        else:
            what = f"{name} failed" + (f" at step '{failed['name']}'" if failed else "")
            message = what + took(sec)
            if first_failure is None:
                first_failure = what
        rows["etl_jobs"].append({
            "job_key": job_key, "run_key": run_key, "job_id": j["id"], "job_name": name, "status": status,
            "data_date": day.group(1) if day else data_date, "started_at": j.get("started_at"),
            "finished_at": j.get("completed_at"), "duration_seconds": sec, "steps_total": len(steps),
            "failed_step": failed["name"] if failed else None, "message": message, "job_url": j.get("html_url")})

        step_keys = {}
        for s in steps:
            step_key = f"{job_key}:{s['number']}"
            step_keys[s["name"]] = step_key
            details = None
            if current and name == "transform" and s["name"] == DBT_STEPS["build"] and results:
                details = build_counts(results)
            if current and name == "transform" and s["name"] == DBT_STEPS["freshness"] and sources:
                details = {"sources": len(sources.get("results", [])),
                           "status": {k: sum(1 for r in sources["results"] if r.get("status") == k) for k in ("pass", "warn", "error")}}
            rows["etl_steps"].append({
                "step_key": step_key, "job_key": job_key, "run_key": run_key, "step_number": s["number"],
                "step_name": s["name"], "status": STATUS.get(s.get("conclusion") or "", "skipped"),
                "started_at": s.get("started_at"), "finished_at": s.get("completed_at"),
                "duration_seconds": seconds(s.get("started_at"), s.get("completed_at")),
                "details": json.dumps(details) if details else None})

        if failed:
            headline, tail = (error_lines(log) if (log := job_log(repo, j["id"])) else (None, None))
            rows["etl_errors"].append({
                "error_key": f"{step_keys[failed['name']]}:step", "run_key": run_key, "job_key": job_key,
                "step_key": step_keys[failed["name"]], "event_time": failed.get("completed_at") or j.get("completed_at"),
                "severity": "error", "category": "step_failed", "object": failed["name"],
                "message": f"{name}: step '{failed['name']}' failed" + (f": {headline}" if headline else ""),
                "details": json.dumps({"log": tail} if tail else {"log": None, "why": "the job log wasn't readable (it needs a GitHub token)"})})
        if current and name == "transform":
            rows["etl_errors"] += dbt_errors(run_key, job_key, step_keys, sources, results)

    total = sum(counted.values())
    if counted["failure"] or STATUS.get(run.get("conclusion") or "") == "failure":
        status = "failure"
    elif counted["cancelled"] or run.get("conclusion") == "cancelled":
        status = "cancelled"
    else:
        status = "success"
    data_from = data_to = data_date
    if days:
        data_from, data_to = min(days), max(days)
    elif years:
        data_from, data_to = f"{min(years)}-01-01", f"{max(years)}-12-31"
    if not days and inputs:
        data_from = inputs.get("start") or (f"{inputs['first_year']}-01-01" if inputs.get("first_year") else data_from)
        data_to = inputs.get("end") or (f"{inputs['last_year']}-12-31" if inputs.get("last_year") else data_to)
    covered = f" of {data_date}" if data_date else f" of {data_from} to {data_to}" if data_from and data_to else ""
    sec = seconds(started, last_end)
    if status == "success":
        jobs_word = "job" if total == 1 else "jobs"
        outcome = (f"all {total} jobs succeeded" if total > 1 else f"its {total} {jobs_word} succeeded") if not counted["skipped"]             else f"{counted['success']} of {total} {jobs_word} succeeded, {counted['skipped']} skipped"
    elif status == "cancelled":
        outcome = "cancelled"
    else:
        outcome = first_failure or "failed"
    rows["etl_runs"].append({
        "run_key": run_key, "workflow": workflow, "workflow_file": (run.get("path") or "").split("/")[-1] or None,
        "run_number": run.get("run_number"), "run_id": run["id"], "run_attempt": attempt, "run_type": run_type,
        "triggered_by": triggered_by, "trigger_event": event, "scheduled_for": scheduled_for,
        "start_delay_minutes": delay, "inputs": json.dumps(inputs) if inputs else None,
        "data_date": data_date, "data_from": data_from, "data_to": data_to, "status": status,
        "started_at": started, "finished_at": last_end, "duration_seconds": sec,
        "jobs_total": total, "jobs_succeeded": counted["success"], "jobs_failed": counted["failure"],
        "jobs_skipped": counted["skipped"], "jobs_cancelled": counted["cancelled"],
        "message": f"{LABEL.get(workflow, workflow)} ({run_type}){covered}: {outcome}{took(sec)}",
        "git_sha": run.get("head_sha"), "branch": run.get("head_branch"), "run_url": run.get("html_url")})
    return rows


_crons = {}


def cron_of(repo, run):
    """(hour, minute) of the cron line in the run's workflow file, as it was at the run's commit. Read
    from the checked-out file when it is that commit, otherwise from GitHub (public repository)."""
    path, sha = run.get("path"), run.get("head_sha")
    if not path or not sha:
        return None
    if (sha, path) not in _crons:
        text = None
        here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", path)
        if os.environ.get("GITHUB_SHA") == sha and os.path.exists(here):
            text = open(here, encoding="utf-8").read()
        else:
            try:
                with urllib.request.urlopen(f"https://raw.githubusercontent.com/{repo}/{sha}/{path}", timeout=30) as r:
                    text = r.read().decode("utf-8")
            except OSError:
                pass
        m = re.search(r'cron:\s*"(\d+)\s+(\d+)\s+\*\s+\*\s+\*"', text or "")
        _crons[(sha, path)] = (int(m.group(2)), int(m.group(1))) if m else None
    return _crons[(sha, path)]


def build_counts(results):
    rs = results.get("results", [])
    return {"built": sum(1 for r in rs if r["unique_id"].split(".")[0] in ("model", "snapshot", "seed") and r["status"] == "success"),
            "tests_passed": sum(1 for r in rs if r["status"] == "pass"),
            "failed": sum(1 for r in rs if r["status"] in ("error", "fail", "runtime error")),
            "warned": sum(1 for r in rs if r["status"] == "warn"),
            "skipped": sum(1 for r in rs if r["status"] == "skipped"),
            "elapsed_seconds": int(results.get("elapsed_time") or 0)}


def dbt_errors(run_key, job_key, step_keys, sources, results):
    """One row per dbt model, snapshot, test or freshness check that failed or warned."""
    out = []
    for r in (sources or {}).get("results", []):
        if r.get("status") in ("warn", "error", "runtime error"):
            name = ".".join(r["unique_id"].split(".")[2:])
            age = r.get("max_loaded_at_time_ago_in_s")
            bad = r["status"] != "warn"
            out.append({"error_key": f"{job_key}:dbt:{r['unique_id']}:freshness", "run_key": run_key, "job_key": job_key,
                        "step_key": step_keys.get(DBT_STEPS["freshness"]), "event_time": (sources.get("metadata") or {}).get("generated_at"),
                        "severity": "error" if bad else "warning", "category": "dbt_freshness", "object": name,
                        "message": f"source {name} freshness {r['status']}" + (f": last data {age / 3600:.0f} hours ago" if isinstance(age, (int, float)) else ""),
                        "details": json.dumps({"max_loaded_at": r.get("max_loaded_at"), "criteria": r.get("criteria"), "error": r.get("error")})})
    for r in (results or {}).get("results", []):
        if r["status"] not in ("error", "fail", "runtime error", "warn"):
            continue
        kind = r["unique_id"].split(".")[0]
        name = ".".join(r["unique_id"].split(".")[2:])
        bad = r["status"] != "warn"
        n = r.get("failures")
        what = (f"{n} failing row{'' if n == 1 else 's'}" if kind == "test" and isinstance(n, int) and n
                else (r.get("message") or r["status"]))
        out.append({"error_key": f"{job_key}:dbt:{r['unique_id']}", "run_key": run_key, "job_key": job_key,
                    "step_key": step_keys.get(DBT_STEPS["build"]), "event_time": (results.get("metadata") or {}).get("generated_at"),
                    "severity": "error" if bad else "warning",
                    "category": {"model": "dbt_model", "snapshot": "dbt_snapshot", "test": "dbt_test"}.get(kind, "dbt_model"),
                    "object": name, "message": f"{kind} {name} {'failed' if bad else 'warned'}: {what}"[:1000],
                    "details": json.dumps({"unique_id": r["unique_id"], "status": r["status"], "failures": n,
                                           "message": (r.get("message") or "")[:2000], "relation": r.get("relation_name"),
                                           "seconds": round(r.get("execution_time") or 0, 1)})})
    return out


def attempt_rows(repo, run_id, attempt, **kw):
    run = github(f"/repos/{repo}/actions/runs/{run_id}/attempts/{attempt}")
    jobs = github(f"/repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100").get("jobs", [])
    return describe(repo, run, jobs, **kw)


def merge(into, rows):
    for t in TABLES:
        into[t] += rows[t]


def main():
    sys.stdout.reconfigure(line_buffering=True)
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("command", choices=["run", "backfill"])
    p.add_argument("--data-date", default="", help="run: the day the run loaded, YYYY-MM-DD, or yesterday (the day before the run started, UTC)")
    p.add_argument("--inputs", default="", help="run: JSON of what was typed when the run was started by hand")
    p.add_argument("--dbt-results", default="", help="run: the folder with dbt's run_results.json and sources.json")
    p.add_argument("--since", help="backfill: the first day, YYYY-MM-DD")
    p.add_argument("--dry-run", action="store_true", help="Print the rows instead of writing them")
    p.add_argument("--repo", help="owner/name, outside GitHub Actions")
    p.add_argument("--run-id", help="run: a run id, outside GitHub Actions")
    p.add_argument("--attempt", help="run: the attempt, outside GitHub Actions")
    args = p.parse_args()

    repo = args.repo or os.environ.get("GITHUB_REPOSITORY", "")
    rows = {t: [] for t in TABLES}
    if args.command == "run":
        try:
            inputs = json.loads(args.inputs) if args.inputs else None
        except ValueError:
            inputs = None
        inputs = {k: v for k, v in (inputs or {}).items() if v not in ("", None)} or None
        merge(rows, attempt_rows(repo, int(args.run_id or os.environ["GITHUB_RUN_ID"]),
                                 int(args.attempt or os.environ.get("GITHUB_RUN_ATTEMPT", "1")),
                                 data_date=args.data_date, inputs=inputs, dbt_folder=args.dbt_results, current=True))
    else:
        if not DAY.fullmatch(args.since or ""):
            p.error("backfill needs --since YYYY-MM-DD")
        this_run = os.environ.get("GITHUB_RUN_ID")
        page = 1
        while True:
            answer = github(f"/repos/{repo}/actions/runs?per_page=100&page={page}&created=%3E%3D{args.since}")
            runs = answer.get("workflow_runs", [])
            for r in runs:
                if (r.get("path") or "").split("/")[-1] in WORKFLOWS and r.get("status") == "completed" and str(r["id"]) != this_run:
                    for attempt in range(1, r["run_attempt"] + 1):
                        merge(rows, attempt_rows(repo, r["id"], attempt))
            if len(runs) < 100:
                break
            page += 1

    for r in sorted(rows["etl_runs"], key=lambda r: r["started_at"] or ""):
        print(f"{r['status']:<9} {r['run_key']:<24} {r['message']}")
    for e in rows["etl_errors"]:
        print(f"  {e['severity']:<7} {e['category']:<13} {e['message'][:120]}")
    print("rows:", {t: len(v) for t, v in rows.items()})
    if args.dry_run:
        if os.environ.get("LOG_ROWS_FILE"):
            json.dump(rows, open(os.environ["LOG_ROWS_FILE"], "w", encoding="utf-8"))
        return 0
    warehouse = warehouse_id()
    for table in TABLES:   # parents first: runs, jobs, steps, then errors
        if rows[table]:
            run_sql(warehouse, insert_sql(table), {"rows": json.dumps(rows[table])})
    print(f"Wrote {sum(len(v) for v in rows.values())} rows to {SCHEMA}.etl_* (keys already there were left as they were).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
