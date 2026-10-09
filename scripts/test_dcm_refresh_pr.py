"""Unit tests for moratoriums.refresh.pr: PR body, guards, carry-over and publish commands.

No network and no real git or gh: a fake runner records argument lists and answers read-only calls.
"""
import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

from moratoriums.refresh import pr

REPORT = {
    "rows": {"moratoriums": 2, "bans": 1, "utilities": 0, "updates": 1},
    "llm": {"calls": 3, "errors": 0, "refusals": 0, "escalated": 0, "est_cost_usd": 0.5, "by_model": {}},
    "fetch": {"pages": 4, "outcomes": {"ok": 3, "http_404": 1}, "rate": 0.75},
    "leads": {"total": 7},
    "caps_hit": ["max_requests"],
    "search_requests": 20,
    "review": {"claims": 4, "accepted": 3, "model_calls": 3,
               "rejected": [{"kind": "extension", "state": "NC", "name": "Charlotte", "target": "nm-nc-charlotte-2026",
                             "problems": ["not_yet_happened"], "reason": "The council is only considering an extension.",
                             "url": "https://news.example/charlotte", "by": "model"}]},
}


def row(i):
    return {"id": f"add-{i}", "state": "OH", "name": f"Town {i}", "type": "temporary moratorium",
            "status": "active", "date_adopted": "2026-10-01", "source_urls": f"https://x.example/{i} https://y.example"}


class Fake:
    """Fake runner: reads answered from `answers` (by argv prefix), writes recorded and not run."""

    def __init__(self, answers=None, dry=False, fail=None, staged=True):
        self.answers, self.dry, self.fail, self.calls = answers or {}, dry, fail or {}, []
        self.staged = staged

    def __call__(self, argv, *, write=False, check=True):
        self.calls.append((list(argv), write))
        if write and self.dry:
            return subprocess.CompletedProcess(argv, 0, "", "")
        if argv[:4] == ["git", "diff", "--cached", "--quiet"]:
            return subprocess.CompletedProcess(argv, 1 if self.staged else 0, "", "")
        for key, err in self.fail.items():
            if argv[: len(key)] == list(key):
                raise pr.PrError(err)
        for key, out in self.answers.items():
            if argv[: len(key)] == list(key):
                return subprocess.CompletedProcess(argv, 0, out, "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    def argvs(self, write=None):
        return [a for a, w in self.calls if write is None or w == write]


class Body(unittest.TestCase):
    def test_title_and_sections(self):
        changes = [{"id": "nm-9", "state": "OH", "name": "Other", "event": "extended", "field": "date_expires",
                    "old": "2026-11-01", "new": "2027-01-01"},
                   {"id": "nm-9", "state": "OH", "name": "Other", "event": "extended", "field": "status", "old": "active", "new": "extended"}]
        body = pr.build_body(REPORT, " 1 file changed", [row(1), row(2)], changes,
                             [], ["WARNING add-1: no territory"], "2026-10-08", "research", 5, 2)
        self.assertTrue(body.startswith("# Moratorium refresh 2026-10-08: +2 new, 1 updated, 2 expired"))
        for h in ("## Summary", "## New rows", "## Updated rows", "## Rejected in review", "## Cost and usage", "## Caps hit",
                  "## Fetch outcomes", "## QA flags", "## Territory warnings", "## Leads", "## Correcting a row"):
            self.assertIn(h, body)
        self.assertIn("| OH | Town 1 | temporary moratorium | active | 2026-10-01 | [source](https://x.example/1) |", body)
        self.assertIn("| OH | Other | extended | date_expires | 2026-11-01 | 2027-01-01 |", body)
        self.assertIn("| NC | Charlotte | extension | not_yet_happened | The council is only considering an extension. |", body)
        self.assertIn("| changes reviewed | 4: 3 accepted, 1 rejected |", body)
        self.assertIn("| input rows written | 4 |", body)
        self.assertIn("inputs/research/weekly/2026-10-08/notes.md", body)
        self.assertIn("rebuild_only", body)
        self.assertIn("git revert", body)
        self.assertIn("unconfirmed", body)
        self.assertIn("WARNING add-1", body)

    def test_truncation(self):
        rows = [row(i) for i in range(3000)]
        body = pr.build_body(REPORT, "", rows, [], [], [f"WARNING w{i}" for i in range(3000)], "2026-10-08", "research")
        self.assertLessEqual(len(body), pr.MAX_BODY)
        self.assertRegex(body, r"… and \d+ more")

    def test_small_tables_not_truncated(self):
        body = pr.build_body(REPORT, "", [row(i) for i in range(5)], [], [], [], "2026-10-08", "research")
        self.assertNotIn("more", body)

    def test_qa_filtered_to_this_run(self):
        qa = [{"id": "add-1", "issue": "weak", "detail": ""}, {"id": "old-9", "issue": "dup", "detail": ""}]
        got = pr.filter_qa(qa, {"add-1", "add-2"})
        self.assertEqual([r["id"] for r in got], ["add-1"])

    def test_first_url_and_cells(self):
        self.assertEqual(pr.first_url("a, https://u.example/p, https://v"), "https://u.example/p")
        self.assertNotIn("|", pr._cell("a|b").replace("\\|", ""))


class Guards(unittest.TestCase):
    def test_outside_paths(self):
        paths = ["moratoriums.csv", "events.csv", "inputs/refresh_state.json", "inputs/research/weekly/2026-10-01/bans.csv",
                 "inputs/additions.csv", "dc_moratoriums.geojson.bak", "inputs/research/weekly", ""]
        self.assertEqual(pr.outside_paths(paths), ["dc_moratoriums.geojson.bak", "inputs/additions.csv", "inputs/research/weekly"])

    def test_carry_over_paths(self):
        out = "inputs/refresh_state.json\ninputs/research/weekly/2026-10-01/bans.csv\ninputs/research/other.csv\nREADME.md\n"
        self.assertEqual(pr.carry_over_paths(out), ["inputs/refresh_state.json", "inputs/research/weekly/2026-10-01/bans.csv"])

    def test_branch_check(self):
        pr.check_branches("data-moratoriums", "refresh/weekly")
        for bad in ("data-moratoriums", "main", "feature/x"):
            with self.assertRaises(pr.PrError):
                pr.check_branches("data-moratoriums", bad)
        with self.assertRaises(pr.PrError):
            pr.check_branches("refresh/weekly", "refresh/weekly")

    def test_permission_hint(self):
        self.assertIn("Allow GitHub Actions to create and approve pull requests", pr.permission_hint("HTTP 403: forbidden"))
        self.assertIn("create and approve", pr.permission_hint("Resource not accessible by integration"))
        self.assertIsNone(pr.permission_hint("network down"))


PR_LIST = ("gh", "pr", "list")


class Carry(unittest.TestCase):
    def test_no_open_pr_does_nothing(self):
        f = Fake({PR_LIST: "[]"})
        self.assertEqual(pr.carry_over(f, "data-moratoriums", "refresh/weekly"), [])
        self.assertEqual(f.argvs(write=True), [])

    def test_open_pr_checks_out_weekly_only(self):
        f = Fake({PR_LIST: json.dumps([{"number": 4, "headRefName": "refresh/weekly"}]),
                  ("git", "diff", "--name-only"): "events.csv\ninputs/research/weekly/2026-10-01/bans.csv\n",
                  ("git", "ls-tree"): "inputs/research/weekly/2026-10-01/bans.csv\ninputs/refresh_state.json\n"})
        pr.carry_over(f, "data-moratoriums", "refresh/weekly")
        self.assertEqual(f.argvs(write=True), [["git", "checkout", "origin/refresh/weekly", "--",
                                                "inputs/research/weekly", "inputs/refresh_state.json"]])

    def test_missing_state_file_not_requested(self):
        f = Fake({PR_LIST: json.dumps([{"number": 4, "headRefName": "refresh/weekly"}]),
                  ("git", "ls-tree"): "inputs/research/weekly/2026-10-01/bans.csv\n"})
        pr.carry_over(f, "data-moratoriums", "refresh/weekly")
        self.assertEqual(f.argvs(write=True)[0][-1], "inputs/research/weekly")

    def test_reviewer_edit_outside_fails_with_3(self):
        f = Fake({PR_LIST: json.dumps([{"number": 4, "headRefName": "refresh/weekly"}]),
                  ("git", "diff", "--name-only"): "inputs/additions.csv\n"})
        with self.assertRaises(pr.PrError) as cm:
            pr.carry_over(f, "data-moratoriums", "refresh/weekly")
        self.assertEqual(cm.exception.code, 3)
        self.assertIn("inputs/additions.csv", str(cm.exception))
        self.assertEqual(f.argvs(write=True), [])


class Publish(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        t = Path(self.tmp.name)
        self.co, self.build = t / "co", t / "build"
        wk = self.co / "inputs/research/weekly/2026-10-08"
        wk.mkdir(parents=True)
        self.build.mkdir()
        (wk / "moratoriums.csv").write_text("id,state,jurisdiction_name,type,status,date_adopted,source_urls\nadd-1,OH,Town,temporary moratorium,active,2026-10-01,https://x.example\n")
        (self.build / "qa_research.csv").write_text("id,issue,detail\nadd-1,weak,d\nold-2,dup,e\n")
        (self.co / "moratoriums.csv").write_text("id,level,name,state,type,status,date_adopted,source_urls\n"
                                                 "add-1,city,Town,OH,temporary moratorium,active,2026-10-01,https://x.example\n"
                                                 "nm-9,city,Other,OH,temporary moratorium,extended,2026-05-01,https://o.example\n")
        (self.co / "events.csv").write_text("recorded_at,id,event,event_date,field,old,new,note\n"
                                            "2026-10-01,a,adopted,,,,,\n2026-10-08,b,expired,,,,,\n2026-10-08,add-1,added,,,,,\n"
                                            "2026-10-08,nm-9,extended,,date_expires,2026-11-01,2027-01-01,\n")
        (t / "report.json").write_text(json.dumps(REPORT))
        self.args = Namespace(checkout=self.co, build=self.build, report=t / "report.json", run_date="2026-10-08", mode="research",
                              base="data-moratoriums", branch="refresh/weekly", log_dir=self.build / "logs")
        (self.build / "logs").mkdir()
        (self.build / "logs/build_layer.log").write_text("ok\nWARNING add-1: eia_id 5 has no HIFLD territory\n")

    def answers(self, extra=None):
        a = {PR_LIST: "[]", ("git", "show"): "recorded_at,id,event,event_date,field,old,new,note\n2026-10-01,a,adopted,,,,,\n",
             ("git", "diff", "--cached", "--stat"): " 2 files changed\n"}
        a.update(extra or {})
        return a

    def run_publish(self, fake):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            rc = pr.publish(fake, self.args)
        return rc, out.getvalue()

    def test_territory_warnings_source_and_filter(self):
        logs = self.build / "logs"
        got = pr.territory_warnings(logs)
        self.assertEqual(got, ["WARNING add-1: eia_id 5 has no HIFLD territory"])
        (logs / "rebuild.log").write_text("WARNING other thing\nnoise territory\nWARNING x-1: eia_id 9 has no HIFLD territory; drawn as a point\n")
        self.assertEqual(pr.territory_warnings(logs), ["WARNING x-1: eia_id 9 has no HIFLD territory; drawn as a point"])
        self.assertEqual(pr.territory_warnings(self.build / "nope"), [])

    def test_create_flow(self):
        f = Fake(self.answers())
        rc, _ = self.run_publish(f)
        self.assertEqual(rc, 0)
        w = f.argvs(write=True)
        self.assertEqual(w[0], ["git", "add", "--", "moratoriums.csv", "events.csv", "dc_moratoriums.geojson", "README.md", "inputs"])
        push = [a for a in w if a[:2] == ["git", "push"]][0]
        self.assertEqual(push, ["git", "push", "--force", "origin", "HEAD:refs/heads/refresh/weekly"])
        commit = [a for a in w if "commit" in a][0]
        self.assertIn("user.name=github-actions[bot]", commit)
        self.assertNotIn("Co-Authored-By", " ".join(commit))
        self.assertNotIn("Claude", " ".join(commit))
        self.assertEqual(w[-1][:3], ["gh", "pr", "create"])
        self.assertIn("--base", w[-1])
        body = (self.build / "pr_body.md").read_text()
        self.assertIn("+1 new, 1 updated, 1 expired", body)  # counted from the events the rebuild appended
        self.assertIn("| new on the map | 1 |", body)
        self.assertIn("| events added | 3 |", body)
        self.assertIn("| OH | Other | extended | date_expires | 2026-11-01 | 2027-01-01 |", body)
        self.assertIn("| add-1 | weak | d |", body)  # QA flags only for this run's rows
        self.assertNotIn("old-2", body)
        self.assertIn("eia_id 5 has no HIFLD territory", body)
        # no write touches the base branch
        for a in w:
            self.assertNotIn("refs/heads/data-moratoriums", " ".join(a))

    def test_direct_pushes_base_without_a_pr(self):
        self.args.direct = True
        f = Fake(self.answers())
        rc, _ = self.run_publish(f)
        self.assertEqual(rc, 0)
        self.assertFalse(any(a[0] == "gh" for a in f.argvs()))
        w = f.argvs(write=True)
        self.assertEqual(w[-1], ["git", "push", "origin", "HEAD:refs/heads/data-moratoriums"])
        commit = [a for a in w if "commit" in a][0]
        self.assertIn("| new on the map | 1 |", commit[-1])
        self.assertFalse(any("refresh/weekly" in " ".join(a) for a in w))

    def test_open_pr_edits(self):
        f = Fake(self.answers({PR_LIST: json.dumps([{"number": 9, "headRefName": "refresh/weekly"}])}))
        self.run_publish(f)
        self.assertEqual(f.argvs(write=True)[-1][:4], ["gh", "pr", "edit", "9"])

    def test_nothing_staged(self):
        f = Fake(self.answers(), staged=False)
        rc, out = self.run_publish(f)
        self.assertEqual(rc, 0)
        self.assertIn("no changes; no PR", out)
        self.assertEqual(len(f.argvs(write=True)), 1)

    def test_dry_run_executes_nothing(self):
        f = Fake(self.answers(), dry=True)
        rc, out = self.run_publish(f)
        self.assertEqual(rc, 0)
        self.assertIn(str(self.build / "pr_body.md"), out)
        self.assertIn("# Moratorium refresh", out)
        self.assertTrue(f.argvs(write=True))
        self.assertTrue(all(a[0] in ("git", "gh") for a in f.argvs()))

    def test_runner_dry_prints_not_runs(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            p = pr.Runner(dry=True)(["git", "push", "--force", "origin", "HEAD:refs/heads/refresh/weekly"], write=True)
        self.assertEqual(p.returncode, 0)
        self.assertIn("DRY RUN: git push --force", out.getvalue())

    def test_bad_branch_refused_before_any_call(self):
        self.args.branch = "data-moratoriums"
        f = Fake(self.answers())
        with self.assertRaises(pr.PrError):
            self.run_publish(f)
        self.assertEqual(f.calls, [])

    def test_gh_403_hint_surfaces(self):
        class F(Fake):
            def __call__(s, argv, **kw):
                if argv[:3] == ["gh", "pr", "create"]:
                    raise pr.PrError("gh pr create failed (1): HTTP 403\n" + pr.PERMISSION_HINT)
                if argv[:4] == ["git", "diff", "--cached", "--quiet"]:
                    return subprocess.CompletedProcess(argv, 1, "", "")
                return super().__call__(argv, **kw)
        with self.assertRaises(pr.PrError) as cm:
            self.run_publish(F(self.answers()))
        self.assertIn("Allow GitHub Actions to create and approve pull requests", str(cm.exception))

    def test_rebuild_only_open_pr_keeps_body(self):
        self.args.mode = "rebuild_only"
        f = Fake(self.answers({PR_LIST: json.dumps([{"number": 9, "headRefName": "refresh/weekly"}])}))
        self.run_publish(f)
        self.assertFalse(any(a[:3] == ["gh", "pr", "edit"] for a in f.argvs()))
        self.assertTrue(any(a[:2] == ["git", "push"] for a in f.argvs()))

    def test_published_changes_from_events(self):
        events = [{"id": "add-1", "event": "added"}, {"id": "b", "event": "expired"},
                  {"id": "nm-9", "event": "extended", "field": "status"}, {"id": "nm-9", "event": "extended", "field": "date_expires"}]
        new, changes, expired = pr.published_changes(self.co, events)
        self.assertEqual([r["id"] for r in new], ["add-1"])
        self.assertEqual([(c["id"], c["name"], c["field"]) for c in changes], [("nm-9", "Other", "status"), ("nm-9", "Other", "date_expires")])
        self.assertEqual(expired, 1)
        self.assertEqual(pr.make_title("2026-10-08", 1, 1, 1), "Moratorium refresh 2026-10-08: +1 new, 1 updated, 1 expired")

    def test_dry_run_reports_rows_written(self):
        self.args.mode = "dry_run"
        f = Fake(self.answers(), dry=True)
        _, out = self.run_publish(f)
        self.assertIn("| input rows written | 4 |", out)


if __name__ == "__main__":
    unittest.main()
