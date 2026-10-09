"""Pull-request step of the weekly moratorium refresh: PR body, carry-over and publish.

Role: turns one refresh run into one rolling pull request (`refresh/weekly` -> `data-moratoriums`,
plan D8). Subcommands:
  carry-over  with an open refresh PR, copy its inputs/research/weekly/** and
              inputs/refresh_state.json into the checkout (which sits at the base tip); exits 3
              when the PR head changed anything a rebuild would overwrite (a reviewer edit there
              would be lost).
  publish     stage the four root files and inputs/, commit as github-actions[bot], force-push
              the refresh branch only, then `gh pr create` or `gh pr edit`. No staged change
              means no commit and no PR. With --direct: no branch and no PR; the commit, its
              message carrying the PR body, is pushed straight to the base branch (a plain
              push, so it fails rather than overwrite a base that moved).
Reads run_report.json (refresh/run.py), BUILD/qa_research.csv (build_research.py) and
BUILD/logs/rebuild.log (else build_layer.log) for build_layer.py territory WARNING lines. Writes BUILD/pr_body.md.
The title and summary count new rows that reached the map (this run's weekly ids found in the
rebuilt moratoriums.csv) and show how many were not drawn; the QA table says why.
Every git and gh call is an argument list through `Runner`; with --mode dry_run or PR_DRY_RUN=1
the mutating calls are printed, not run. GH_TOKEN comes from the environment and is never printed.
Dependencies: stdlib, and the git and gh CLIs.
Usage: python -m moratoriums.refresh.pr publish --checkout D --build B --report R
         --run-date YYYY-MM-DD --mode research|dry_run|rebuild_only [--base data-moratoriums]
         [--branch refresh/weekly] [--log-dir B/logs] [--direct]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

MAX_BODY = 60_000
ROOT_FILES = ("moratoriums.csv", "events.csv", "dc_moratoriums.geojson", "README.md")
ADD_PATHS = ROOT_FILES + ("inputs",)
CARRY_PATHS = ("inputs/research/weekly", "inputs/refresh_state.json")
WEEKLY_PREFIX = "inputs/research/weekly/"
ALLOWED_EXACT = frozenset(ROOT_FILES) | {"inputs/refresh_state.json"}
BOT_NAME = "github-actions[bot]"
BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"
ROW_FILES = ("moratoriums", "bans", "utilities")
PERMISSION_HINT = (
    'gh was refused. In the repository, enable Settings > Actions > General > Workflow permissions >'
    ' "Allow GitHub Actions to create and approve pull requests".'
)


class PrError(Exception):
    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- pure helpers

def outside_paths(paths: list[str]) -> list[str]:
    """Paths a reviewer changed that the pipeline would overwrite (everything not pipeline-owned)."""
    return sorted(p for p in (x.strip() for x in paths) if p and p not in ALLOWED_EXACT and not p.startswith(WEEKLY_PREFIX))


def carry_over_paths(ls_tree_output: str) -> list[str]:
    """Carry-over files from `git ls-tree -r --name-only`: weekly folders and refresh_state.json."""
    out = []
    for p in (x.strip() for x in ls_tree_output.splitlines()):
        if p == "inputs/refresh_state.json" or p.startswith(WEEKLY_PREFIX):
            out.append(p)
    return sorted(out)


def permission_hint(stderr: str) -> str | None:
    low = stderr.lower()
    if "403" in low or "resource not accessible" in low or "not permitted" in low:
        return PERMISSION_HINT
    return None


def check_branches(base: str, branch: str) -> None:
    if branch == base or not branch.startswith("refresh/"):
        raise PrError(f"refusing to push {branch!r}: the refresh branch must start with refresh/ and differ from {base!r}", 2)


def first_url(text: str) -> str:
    m = re.search(r"https?://[^\s,;|]+", text or "")
    return m.group(0) if m else ""


def _cell(text: object, width: int = 140) -> str:
    s = " ".join(str(text if text is not None else "").split()).replace("|", "\\|")
    return s if len(s) <= width else s[: width - 1] + "…"


def _link(row: dict) -> str:
    u = first_url(row.get("source_urls", "") or row.get("new", ""))
    return f"[source]({u})" if u else ""


def count_rows(report: dict) -> tuple[int, int]:
    rows = report.get("rows", {})
    return sum(int(rows.get(k, 0)) for k in ROW_FILES), int(rows.get("updates", 0))


def on_map_ids(checkout: Path, new_rows: list[dict]) -> set[str]:
    """Ids of this run's new rows that the rebuild published in the checkout's moratoriums.csv."""
    drawn = {r.get("id") for r in read_csv(checkout / "moratoriums.csv")}
    return {r["id"] for r in new_rows if r.get("id") in drawn}


def make_title(report: dict, run_date: str, expired: int, on_map: int | None = None) -> str:
    """`on_map` (new rows that reached the map) replaces the report's extracted-row count when known."""
    new, changes = count_rows(report)
    if on_map is not None:
        new = on_map
    return f"Moratorium refresh {run_date}: +{new} new, {changes} changes, {expired} expired"


def _table(headers: list[str], rows: list[list[str]], limit: int) -> list[str]:
    if not rows:
        return ["_none_", ""]
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    out += ["| " + " | ".join(r) + " |" for r in rows[:limit]]
    if len(rows) > limit:
        out.append(f"\n… and {len(rows) - limit} more")
    return out + [""]


def _render(report, diff_stat, new_rows, changed_rows, qa_rows, territory_warnings, run_date, mode,
            events_added, expired, limit, on_map=None, added_events=None) -> str:
    extracted_n, change_n = count_rows(report)
    new_cell = str(extracted_n) if on_map is None else f"{on_map} on the map, {max(0, extracted_n - on_map)} not drawn (see QA)"
    llm = report.get("llm", {})
    fetch = report.get("fetch", {})
    leads = report.get("leads", {})
    L = [f"# {make_title(report, run_date, expired, on_map)}", "",
         f"Run mode: `{mode}`. Rows are AI-extracted from public pages and marked unconfirmed; check each source before merging."
         " Carried-over rows are re-synced every run, so their `events.csv` `recorded_at` is the latest run's date.", "",
         "## Summary", "", "| item | count |", "|---|---|",
         f"| new rows | {new_cell} |", f"| changes to existing rows | {change_n} |",
         f"| events added | {events_added}" + ("" if added_events is None else f" ({added_events} `added`)") + " |", f"| expired | {expired} |",
         f"| leads | {leads.get('total', 0)} |", ""]
    if diff_stat.strip():
        L += ["```", diff_stat.strip(), "```", ""]
    by_model = llm.get("by_model", {})
    L += ["## Cost and usage", "",
          f"- Search requests: {report.get('search_requests', 0)}",
          f"- Model calls: {llm.get('calls', 0)} ({llm.get('errors', 0)} errors, {llm.get('refusals', 0)} refusals, {llm.get('escalated', 0)} escalated)",
          f"- Estimated cost: ${float(llm.get('est_cost_usd', 0)):.2f}"]
    for name in sorted(by_model):
        m = by_model[name]
        L.append(f"- `{name}`: {m.get('calls', 0)} calls, {m.get('input', 0)} input, {m.get('output', 0)} output,"
                 f" cache read {m.get('cache_read', 0)}, cache write {m.get('cache_write', 0)} tokens")
    for name, how in sorted(llm.get("price_assumed", {}).items()):
        L.append(f"- `{name}`: " + ("no price known, not in the estimate" if how == "unpriced" else f"price assumed ({how} family)"))
    L.append("")
    caps = report.get("caps_hit", [])
    L += ["## Caps hit", "", ", ".join(f"`{c}`" for c in caps) if caps else "_none_", ""]
    outcomes = fetch.get("outcomes", {})
    L += ["## Fetch outcomes", "", f"{fetch.get('pages', 0)} pages" + (f", success rate {fetch['rate']}" if "rate" in fetch else "")
          + (": " + ", ".join(f"{k} {outcomes[k]}" for k in sorted(outcomes)) if outcomes else ""), ""]
    L += ["## New rows", ""]
    L += _table(["state", "name", "type", "status", "adopted", "source"],
                [[_cell(r.get("state")), _cell(r.get("jurisdiction_name")), _cell(r.get("type")), _cell(r.get("status")),
                  _cell(r.get("date_adopted")), _link(r)] for r in new_rows], limit)
    L += ["## Changed rows", ""]
    L += _table(["id", "field", "old", "new", "source"],
                [[_cell(r.get("id")), _cell(r.get("field")), _cell(r.get("old"), 60), _cell(r.get("new"), 60), _link(r)]
                 for r in changed_rows], limit)
    L += ["## QA flags for this run's rows", ""]
    L += _table(["id", "issue", "detail"], [[_cell(r.get("id")), _cell(r.get("issue")), _cell(r.get("detail"))] for r in qa_rows], limit)
    L += ["## Territory warnings", ""]
    if territory_warnings:
        L += ["```"] + [_cell(w, 300).replace("\\|", "|") for w in territory_warnings[:limit]] + ["```"]
        if len(territory_warnings) > limit:
            L.append(f"\n… and {len(territory_warnings) - limit} more")
        L.append("")
    else:
        L += ["_none_", ""]
    L += ["## Leads", "",
          f"{leads.get('total', 0)} candidates did not pass verification; see `inputs/research/weekly/{run_date}/notes.md`.", "",
          "## Reviewing", "",
          "To reject a row, add an `updates.csv` `DROP` line for it (or delete the row) in this pull request,"
          " then dispatch the workflow with `mode=rebuild_only`. That rebuilds this branch from its `inputs/` without any search or model call.", ""]
    return "\n".join(L)


def build_body(report: dict, diff_stat: str, new_rows: list[dict], changed_rows: list[dict], qa_rows: list[dict],
               territory_warnings: list[str], run_date: str, mode: str, events_added: int = 0, expired: int = 0,
               on_map: int | None = None, added_events: int | None = None) -> str:
    """PR markdown under MAX_BODY characters; tables shrink with an "… and N more" count when needed."""
    limit = 200
    while True:
        body = _render(report, diff_stat, new_rows, changed_rows, qa_rows, territory_warnings, run_date, mode,
                       events_added, expired, limit, on_map, added_events)
        if len(body) <= MAX_BODY or limit <= 1:
            break
        limit //= 2
    if len(body) > MAX_BODY:
        body = body[: MAX_BODY - 40] + "\n\n… truncated"
    return body


# ---------------------------------------------------------------- git / gh

class Runner:
    """Runs argument lists. Calls with write=True are printed instead when dry."""

    def __init__(self, dry: bool = False, cwd: Path | None = None):
        self.dry, self.cwd = dry, cwd

    def __call__(self, argv: list[str], *, write: bool = False, check: bool = True) -> subprocess.CompletedProcess:
        if write and self.dry:
            print("DRY RUN:", " ".join(argv))
            return subprocess.CompletedProcess(argv, 0, "", "")
        p = subprocess.run(argv, cwd=self.cwd, capture_output=True, text=True)
        if check and p.returncode != 0:
            hint = permission_hint(p.stderr) if argv and argv[0] == "gh" else None
            msg = f"{' '.join(argv[:3])} failed ({p.returncode}): {p.stderr.strip()[:500]}"
            raise PrError(msg + (f"\n{hint}" if hint else ""), 1)
        return p


def find_open_pr(run, base: str, branch: str) -> int | None:
    p = run(["gh", "pr", "list", "--head", branch, "--base", base, "--state", "open", "--json", "number,headRefName"])
    prs = json.loads(p.stdout or "[]")
    for pr in prs:
        if pr.get("headRefName") == branch:
            return int(pr["number"])
    return None


def guard_open_pr(run, base: str, branch: str) -> None:
    run(["git", "fetch", "origin", base, branch])
    p = run(["git", "diff", "--name-only", f"origin/{base}...origin/{branch}"])
    bad = outside_paths(p.stdout.splitlines())
    if bad:
        raise PrError("the open refresh PR changed files a rebuild would overwrite, so they would be lost:\n  "
                      + "\n  ".join(bad) + "\nMove the change into inputs/research/weekly/** or revert it, then rerun.", 3)


def carry_over(run, base: str, branch: str) -> list[str]:
    if find_open_pr(run, base, branch) is None:
        print("carry-over: no open refresh PR; nothing carried")
        return []
    guard_open_pr(run, base, branch)
    paths = carry_over_paths(run(["git", "ls-tree", "-r", "--name-only", f"origin/{branch}", "--", *CARRY_PATHS]).stdout)
    if paths:
        run(["git", "checkout", f"origin/{branch}", "--", *carry_targets(paths)], write=True)
    print(f"carry-over: {len(paths)} files from origin/{branch}")
    return paths


def carry_targets(paths: list[str]) -> list[str]:
    """Top-level carry targets that exist on the branch (a missing pathspec makes git checkout fail)."""
    return [t for t in CARRY_PATHS if any(p == t or p.startswith(t + "/") for p in paths)]


# ---------------------------------------------------------------- inputs

def read_csv(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_report(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def weekly_rows(checkout: Path, run_date: str) -> tuple[list[dict], list[dict]]:
    d = checkout / "inputs" / "research" / "weekly" / run_date
    new = [r for k in ROW_FILES for r in read_csv(d / f"{k}.csv")]
    return new, read_csv(d / "updates.csv")


def filter_qa(qa_rows: list[dict], new_rows: list[dict], changed_rows: list[dict]) -> list[dict]:
    ids = {r.get("id") for r in new_rows + changed_rows}
    return [r for r in qa_rows if r.get("id") in ids]


def territory_warnings(log_dir: Path) -> list[str]:
    """build_layer.py's `WARNING <id>: eia_id <n> has no HIFLD territory;` lines, from rebuild.log (else build_layer.log)."""
    for name in ("rebuild.log", "build_layer.log"):
        p = log_dir / name
        if p.is_file():
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
            return [ln.strip() for ln in lines if ln.startswith("WARNING ") and "territor" in ln]
    return []


def new_events(run, checkout: Path, base: str) -> list[dict]:
    """Events appended: events.csv is append-only, so the rows past the base copy's."""
    head = read_csv(checkout / "events.csv")
    p = run(["git", "show", f"origin/{base}:events.csv"], check=False)
    old_n = len(list(csv.DictReader(io.StringIO(p.stdout)))) if p.returncode == 0 else 0
    return head[old_n:]


def events_added(run, checkout: Path, base: str) -> tuple[int, int]:
    """(events appended, of which expired)."""
    added = new_events(run, checkout, base)
    return len(added), sum(1 for e in added if e.get("event") == "expired")


# ---------------------------------------------------------------- publish

def publish(run, a) -> int:
    check_branches(a.base, a.branch)
    dry = run.dry
    direct = getattr(a, "direct", False)
    number = None
    if not direct:
        try:
            number = find_open_pr(run, a.base, a.branch)
        except PrError:
            if not dry:
                raise
    if number is not None:
        guard_open_pr(run, a.base, a.branch)
    run(["git", "add", "--", *ADD_PATHS], write=True)
    if not dry and run(["git", "diff", "--cached", "--quiet"], check=False).returncode == 0:
        print("no changes; no PR")
        return 0
    stat = "" if dry else run(["git", "diff", "--cached", "--stat"]).stdout
    report = load_report(a.report)
    new_rows, changed_rows = weekly_rows(a.checkout, a.run_date)
    n_events, n_expired = events_added(run, a.checkout, a.base)
    n_added = sum(1 for e in new_events(run, a.checkout, a.base) if e.get("event") == "added")
    on_map = len(on_map_ids(a.checkout, new_rows)) if a.mode == "research" else None
    if a.mode == "rebuild_only" and not report:
        report = {"rows": {"moratoriums": 0, "bans": 0, "utilities": 0, "updates": 0}}
    qa = filter_qa(read_csv(a.build / "qa_research.csv"), new_rows, changed_rows)
    body = build_body(report, stat, new_rows, changed_rows, qa, territory_warnings(a.log_dir), a.run_date, a.mode,
                      n_events, n_expired, on_map, n_added)
    title = make_title(report, a.run_date, n_expired, on_map)
    body_file = a.build / "pr_body.md"
    a.build.mkdir(parents=True, exist_ok=True)
    body_file.write_text(body, encoding="utf-8")
    if dry:
        print(f"--- PR title ---\n{title}\n--- PR body ({body_file}) ---\n{body}\n--- end ---")
    run(["git", "-c", f"user.name={BOT_NAME}", "-c", f"user.email={BOT_EMAIL}", "commit",
         f"--author={BOT_NAME} <{BOT_EMAIL}>", "-m", title, "-m",
         f"Weekly refresh of the data center moratorium layer, run date {a.run_date}, mode {a.mode}.",
         *(["-m", body] if direct else [])], write=True)
    if direct:
        run(["git", "push", "origin", f"HEAD:refs/heads/{a.base}"], write=True)
        return 0
    run(["git", "push", "--force", "origin", f"HEAD:refs/heads/{a.branch}"], write=True)
    if number is not None:
        if a.mode == "rebuild_only":
            print(f"rebuild_only: pushed {a.branch}; PR #{number} title and body left as written")
            return 0
        run(["gh", "pr", "edit", str(number), "--title", title, "--body-file", str(body_file)], write=True)
    else:
        run(["gh", "pr", "create", "--base", a.base, "--head", a.branch, "--title", title, "--body-file", str(body_file)], write=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Weekly moratorium refresh: pull request step")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("publish", "carry-over"):
        p = sub.add_parser(name)
        p.add_argument("--checkout", type=Path, required=True)
        p.add_argument("--base", default="data-moratoriums")
        p.add_argument("--branch", default="refresh/weekly")
        if name == "publish":
            p.add_argument("--build", type=Path, required=True)
            p.add_argument("--report", type=Path, required=True)
            p.add_argument("--run-date", required=True)
            p.add_argument("--mode", choices=("research", "dry_run", "rebuild_only"), required=True)
            p.add_argument("--log-dir", type=Path)
            p.add_argument("--direct", action="store_true",
                           help="push the commit straight to --base instead of opening a pull request")
    a = ap.parse_args(argv)
    if a.cmd == "publish":
        a.log_dir = a.log_dir or a.build / "logs"
    dry = os.environ.get("PR_DRY_RUN") == "1" or (a.cmd == "publish" and a.mode == "dry_run")
    run = Runner(dry=dry, cwd=a.checkout)
    try:
        if a.cmd == "publish":
            return publish(run, a)
        check_branches(a.base, a.branch)
        carry_over(run, a.base, a.branch)
        return 0
    except PrError as e:
        print(f"pr.py: {e}", file=sys.stderr)
        return e.code


if __name__ == "__main__":
    sys.exit(main())
