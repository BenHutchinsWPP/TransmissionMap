"""Unit tests for moratoriums.refresh.artifact: the research job's hand-off, checked as untrusted input,
and pr.py's defanging of research text in the PR body.

Stdlib only, no network. The valid artifact is built from the run golden files
(moratoriums/refresh/fixtures/run/expected/), i.e. what run.py really writes, checked against a copy of
the fixture work dir it was written from (fixtures/run/work) as the publish checkout.
"""
import contextlib
import csv
import io
import json
import os
import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path

from moratoriums.refresh import artifact, pr, run, verify
from moratoriums.refresh.config import Config

FIXTURES = Path(__file__).parent / "moratoriums" / "refresh" / "fixtures" / "run"
EXPECTED = FIXTURES / "expected"
RUN_DATE = "2026-10-08"
WEEK = f"inputs/research/weekly/{RUN_DATE}"


class ArtifactTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = self.tmp / "artifact"
        (self.root / WEEK).mkdir(parents=True)
        for name in ("moratoriums.csv", "bans.csv", "utilities.csv", "updates.csv", "notes.md"):
            shutil.copy(EXPECTED / name, self.root / WEEK / name)
        for name in ("refresh_state.json", "refresh_ledger.json"):
            shutil.copy(EXPECTED / name, self.root / "inputs" / name)
        self.report = json.loads((EXPECTED / "run_report.json").read_text(encoding="utf-8"))
        self.report["mode"] = "research"  # the golden run is a dry run
        self.write_report()
        self.dest = self.tmp / "site"
        shutil.copytree(FIXTURES / "work", self.dest)
        shutil.copy(FIXTURES / "work" / "dataset" / "moratoriums.csv", self.dest / "moratoriums.csv")  # dataset = checkout root

    def write_report(self):
        (self.root / "run_report.json").write_text(json.dumps(self.report), encoding="utf-8")

    def problems(self):
        return artifact.validate(self.root, RUN_DATE, self.dest)[1]

    def edit(self, rel, old, new):
        p = self.root / rel
        s = p.read_text(encoding="utf-8")
        self.assertIn(old, s)
        p.write_text(s.replace(old, new, 1), encoding="utf-8")

    def append(self, rel, line):
        with open(self.root / rel, "a", encoding="utf-8") as f:
            f.write(line)

    def json_edit(self, rel, fn):
        p = self.root / rel
        v = json.loads(p.read_text(encoding="utf-8"))
        fn(v)
        p.write_text(json.dumps(v), encoding="utf-8")

    def assertRejected(self, needle):
        p = self.problems()
        self.assertTrue(any(needle in x for x in p), f"{needle!r} not in {p}")

    def test_valid_artifact_passes_and_is_copied(self):
        self.assertEqual(self.problems(), [])
        dest = self.dest
        (dest / WEEK).mkdir(parents=True)
        (dest / WEEK / "stale.csv").write_text("old\n", encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = artifact.main(["validate", "--artifact", str(self.root), "--run-date", RUN_DATE,
                                "--dest", str(dest), "--report-out", str(self.tmp / "build" / "run_report.json")])
        self.assertEqual(rc, 0, out.getvalue())
        self.assertFalse((dest / WEEK / "stale.csv").exists())  # the run's folder is replaced whole
        self.assertEqual((dest / WEEK / "moratoriums.csv").read_bytes(), (EXPECTED / "moratoriums.csv").read_bytes())
        self.assertEqual((dest / "inputs" / "refresh_ledger.json").read_bytes(), (EXPECTED / "refresh_ledger.json").read_bytes())
        self.assertTrue((self.tmp / "build" / "run_report.json").is_file())
        self.assertFalse((dest / "run_report.json").exists())

    def test_rejected_artifact_copies_nothing(self):
        (self.root / "extra.txt").write_text("x", encoding="utf-8")
        before = sorted(str(p) for p in self.dest.rglob("*"))
        with contextlib.redirect_stdout(io.StringIO()):
            rc = artifact.main(["validate", "--artifact", str(self.root), "--run-date", RUN_DATE,
                                "--dest", str(self.dest), "--report-out", str(self.tmp / "r.json")])
        self.assertEqual(rc, 1)
        self.assertEqual(sorted(str(p) for p in self.dest.rglob("*")), before)
        self.assertFalse((self.tmp / "r.json").exists())

    def test_symlink(self):
        (self.root / WEEK / "bans.csv").unlink()
        os.symlink("/etc/passwd", self.root / WEEK / "bans.csv")
        self.assertRejected("bans.csv: symlink")

    def test_symlinked_directory(self):
        shutil.rmtree(self.root / WEEK)
        target = self.tmp / "elsewhere"
        target.mkdir()
        os.symlink(target, self.root / WEEK)
        self.assertRejected(f"{WEEK}: symlink")

    def test_hard_link(self):
        os.link(self.root / WEEK / "notes.md", self.tmp / "outside.md")
        self.assertRejected("notes.md: hard link")

    def test_file_outside_allowed_folder(self):
        (self.root / "inputs" / "research" / "weekly" / "2026-10-01").mkdir()
        (self.root / "inputs" / "research" / "weekly" / "2026-10-01" / "moratoriums.csv").write_text("x", encoding="utf-8")
        (self.root / "inputs" / "additions.csv").write_text("x", encoding="utf-8")
        p = self.problems()
        self.assertIn("inputs/research/weekly/2026-10-01/: directory not allowed", p)
        self.assertIn("inputs/additions.csv: file not allowed", p)

    def test_unknown_file_type_in_week(self):
        (self.root / WEEK / "run.sh").write_text("echo", encoding="utf-8")
        self.assertRejected(f"{WEEK}/run.sh: file not allowed")

    def test_dotdot_path(self):
        (self.root / WEEK / "..notes.md").write_text("x", encoding="utf-8")
        self.assertRejected("file not allowed")
        self.assertEqual(artifact.validate(self.root, "../2026-10-08", self.dest)[1], ["run date '../2026-10-08' is not YYYY-MM-DD"])
        self.assertEqual(artifact.validate(self.root, "/etc", self.dest)[1], ["run date '/etc' is not YYYY-MM-DD"])
        for bad in ("٢٠٢٦-١٠-٠٨", "2026-W41-3"):
            self.assertEqual(artifact.validate(self.root, bad, self.dest)[1], [f"run date {bad!r} is not YYYY-MM-DD"])

    def test_bad_name(self):
        (self.root / WEEK / "a b.csv").write_text("x", encoding="utf-8")
        self.assertRejected("name not allowed")

    def test_fifo(self):
        os.mkfifo(self.root / WEEK / "updates.csv.fifo")
        self.assertRejected("not a regular file")

    def test_missing_required(self):
        (self.root / WEEK / "notes.md").unlink()
        self.assertRejected(f"{WEEK}/notes.md: missing")

    def test_wrong_csv_header(self):
        p = self.root / WEEK / "moratoriums.csv"
        p.write_text(p.read_text(encoding="utf-8").replace("source_quality", "quality", 1), encoding="utf-8")
        self.assertRejected("header is not the moratoriums header")

    def test_wrong_row_width(self):
        p = self.root / WEEK / "bans.csv"
        p.write_text(p.read_text(encoding="utf-8") + "add-x,y\n", encoding="utf-8")
        self.assertRejected("2 cells, expected")

    def test_non_web_url(self):
        p = self.root / WEEK / "moratoriums.csv"
        s = p.read_text(encoding="utf-8")
        self.assertIn(",https://", s)
        p.write_text(s.replace(",https://", ",file:///etc/", 1), encoding="utf-8")
        self.assertRejected("URL not ")

    def test_http_url_allowed(self):
        p = self.root / WEEK / "moratoriums.csv"
        s = p.read_text(encoding="utf-8")
        p.write_text(s.replace(",https://", ",http://", 1), encoding="utf-8")
        self.assertEqual(self.problems(), [])

    def test_url_in_updates_append(self):
        p = self.root / WEEK / "updates.csv"
        s = p.read_text(encoding="utf-8")
        self.assertIn("append https://", s)
        p.write_text(s.replace("append https://", "append javascript:alert(1)//", 1), encoding="utf-8")
        self.assertRejected("URL not ")

    def test_oversized_file(self):
        with open(self.root / WEEK / "notes.md", "ab") as f:
            f.write(b"x" * (artifact.CAPS["notes.md"] + 1))
        self.assertRejected("over the")

    def test_non_utf8(self):
        (self.root / WEEK / "notes.md").write_bytes(b"caf\xe9\n")
        self.assertRejected("not UTF-8")

    def test_report_not_object(self):
        (self.root / "run_report.json").write_text("[1, 2]", encoding="utf-8")
        self.assertRejected("run_report.json: not a JSON object")

    def test_report_other_date(self):
        self.report["run_date"] = "2026-10-09"
        self.write_report()
        self.assertRejected("run_report.run_date: unexpected value")

    def test_report_out_dir(self):
        self.report["out_dir"] = "inputs/research/weekly/2026-10-01"
        self.write_report()
        self.assertEqual(self.problems(), ["run_report.out_dir: unexpected value"])

    def test_report_mode(self):
        self.report["mode"] = "dry_run"
        self.write_report()
        self.assertEqual(self.problems(), ["run_report.mode: unexpected value"])

    def test_report_unknown_key_and_types(self):
        self.report["note"] = "approved by @owner"
        self.report["search_requests"] = "31"
        self.report["llm"]["by_model"]["x` @owner ![p](https://evil.example/p.png) `"] = {"calls": 1}
        self.report["caps_hit"] = ["max_pages", "approved"]
        self.report["review"]["rejected"] = [{"kind": "new", "state": "OH", "name": "Elmstead", "target": "",
                                              "problems": ["other"], "reason": "r", "url": "javascript:alert(1)", "by": "model"}]
        self.write_report()
        p = self.problems()
        for needle in ("run_report.note: unknown key", "run_report.search_requests: unexpected value",
                       "run_report.llm.by_model: key", "run_report.caps_hit[1]", "run_report.review.rejected[0].url"):
            self.assertTrue(any(needle in x for x in p), f"{needle!r} not in {p}")

    def test_report_rejected_entry_passes(self):
        self.report["review"]["rejected"] = [{"kind": "extension", "state": "NC", "name": "Charlotte", "target": "nm-nc-charlotte-2026",
                                              "problems": ["not_yet_happened"], "reason": "Only considered.",
                                              "url": "http://news.example/c", "by": "model"}]
        self.report["llm"]["price_assumed"] = {"claude-haiku-5-5": "haiku"}
        self.write_report()
        self.assertEqual(self.problems(), [])

    def test_report_text_cap(self):
        self.report["leads"]["by_reason"] = {"x" * (artifact.TEXT + 1): 1}
        self.write_report()
        self.assertRejected("run_report.leads.by_reason: key")

    def test_duplicate_json_key(self):
        (self.root / "inputs" / "refresh_state.json").write_text('{"add-x": "2026-10-08", "add-x": "2026-10-08"}', encoding="utf-8")
        self.assertRejected("duplicate key")

    def test_nan(self):
        self.report["fetch"]["rate"] = float("nan")
        self.write_report()
        self.assertRejected("NaN not allowed")

    def test_nul_byte(self):
        self.append(f"{WEEK}/notes.md", "\x00")
        self.assertRejected("NUL byte")

    def test_file_count_and_total_caps(self):
        old = artifact.MAX_FILES, artifact.MAX_TOTAL
        self.addCleanup(lambda: (setattr(artifact, "MAX_FILES", old[0]), setattr(artifact, "MAX_TOTAL", old[1])))
        artifact.MAX_FILES = 3
        self.assertRejected("over the artifact cap")
        artifact.MAX_FILES, artifact.MAX_TOTAL = old[0], 1000
        self.assertRejected("over the artifact cap")

    # ---- rows

    def test_validate_row_is_applied(self):
        self.edit(f"{WEEK}/bans.csv", ",active,", ",bogus,")
        self.assertRejected("status not in vocabulary: bogus")

    def test_row_formats(self):
        self.edit(f"{WEEK}/moratoriums.csv", "add-", "add-<x>", )
        self.assertRejected("id has characters outside")

    def test_row_date_state_level(self):
        rows = (self.root / WEEK / "utilities.csv").read_text(encoding="utf-8").splitlines()
        import csv as _csv
        hdr = next(_csv.reader([rows[0]]))
        cells = next(_csv.reader([rows[1]]))
        row = dict(zip(hdr, cells))
        for col, val, needle in (("date_adopted", "2099-01-01", "date_adopted after run date"),
                                 ("date_adopted", "2026-1-1", "not ISO"), ("date_adopted", "2026-W41-3", "not YYYY-MM"),
                                 ("state", "ZZ", "state 'ZZ' unknown"),
                                 ("jurisdiction_level", "galaxy", "jurisdiction_level 'galaxy' unknown")):
            bad = dict(row, **{col: val})
            buf = io.StringIO()
            w = _csv.writer(buf, lineterminator="\n")
            w.writerow(hdr)
            w.writerow([bad[h] for h in hdr])
            (self.root / WEEK / "utilities.csv").write_text(buf.getvalue(), encoding="utf-8")
            self.assertRejected(needle)

    # ---- updates.csv: only what run.py writes

    NOTE = 'AI-extracted by claude-haiku-5-5 (confidence 0.90). Quote: ""The board extended it to 2027."""'
    UPD = "sweep.csv,add-pa-birch-hollow-2026,{field},,{new},https://a.example/p,secondary,\"" + NOTE.replace('"', '""') + "\"\n"

    def test_updates_reviewer_fields_refused(self):
        for field, new in (("confirmed", "2026-10-08"), ("DROP", ""), ("eia_id", "123"), ("summary", "x"), ("kind", "new")):
            with self.subTest(field=field):
                self.setUp()
                self.append(f"{WEEK}/updates.csv", self.UPD.format(field=field, new=new))
                self.assertRejected(f"field {field!r} is not one run.py writes")

    def test_updates_values_checked(self):
        for field, new, needle in (("status", "confirmed", "status 'confirmed' not in vocabulary"),
                                   ("date_expires", "2027", "is not YYYY-MM or YYYY-MM-DD"),
                                   ("date_adopted", "2026-13-01", "is not YYYY-MM or YYYY-MM-DD"),
                                   ("date_adopted", "٢٠٢٦-١٠", "is not YYYY-MM or YYYY-MM-DD"),
                                   ("date_adopted", "2026-W41-3", "is not YYYY-MM or YYYY-MM-DD"),
                                   ("source_urls", "https://a.example/p", "is not `append <url>`")):
            with self.subTest(field=field, new=new):
                self.setUp()
                self.append(f"{WEEK}/updates.csv", self.UPD.format(field=field, new=new))
                self.assertRejected(needle)

    def test_updates_good_values_pass(self):
        for field, new in (("status", "lifted"), ("date_expires", "2027-04"), ("date_adopted", "2026-10-01"),
                           ("source_urls", "append http://a.example/p|https://b.example/q")):
            self.append(f"{WEEK}/updates.csv", self.UPD.format(field=field, new=new))
        self.assertEqual(self.problems(), [])

    def test_updates_file_must_exist(self):
        self.append(f"{WEEK}/updates.csv", self.UPD.format(field="status", new="lifted").replace("sweep.csv", "evil.csv"))
        self.assertRejected("file 'evil.csv' is not a research file")

    # ---- state and ledger

    def test_state_entries(self):
        self.json_edit("inputs/refresh_state.json", lambda v: v.update({"nm-oh-washington-township-2026": "2026-10-01"}))
        self.assertEqual(self.problems(), [])  # the published entry, unchanged
        for value in ("2026-10-02", "9999-12-31", "٢٠٢٦-١٠-٠٨", {"a": 1}):
            with self.subTest(value=value):
                self.json_edit("inputs/refresh_state.json", lambda v: v.update({"add-x": value}))
                self.assertRejected("entry 'add-x' is neither the published one")
        self.json_edit("inputs/refresh_state.json", lambda v: (v.pop("add-x"), v.update({"bad id!": RUN_DATE})))
        self.assertRejected("entry 'bad id!'")

    def test_ledger_entries(self):
        old = {"claims": {}, "pages": {}, "seeds": {}, "discovery": {}, "hosts": {"legistar.com": {"date": "2026-09-01"}}}
        (self.dest / "inputs" / "refresh_ledger.json").write_text(json.dumps(old), encoding="utf-8")
        self.json_edit("inputs/refresh_ledger.json", lambda v: v["hosts"].update(old["hosts"]))
        self.assertEqual(self.problems(), [])  # an unchanged published entry
        cases = (("hosts", "legistar.com", {"date": "9999-12-31"}), ("hosts", "a b", {"date": RUN_DATE}),
                 ("pages", "javascript:alert(1)", {"date": RUN_DATE, "sha": "0" * 20, "ctx": [], "claims": False, "idle": 1}),
                 ("pages", "https://a.example/p", "x"),
                 ("pages", "https://a.example/p", {"date": RUN_DATE, "sha": "0" * 20, "ctx": [], "claims": False, "idle": 1, "x": 1}),
                 ("seeds", "https://a.example/", {"date": "2026-10-07", "zero": 1}),
                 ("discovery", "query", "9999-12-31"),
                 ("claims", "k", {"date": RUN_DATE, "who": "OH|x", "problems": [], "reason": "r", "pages": ["nothex"]}))
        for sec, key, val in cases:
            with self.subTest(sec=sec, key=key):
                self.setUp()
                (self.dest / "inputs" / "refresh_ledger.json").write_text(json.dumps(old), encoding="utf-8")
                self.json_edit("inputs/refresh_ledger.json", lambda v: v[sec].update({key: val}))
                self.assertRejected(f"{sec} entry {key!r}")

    def test_ledger_sections(self):
        self.json_edit("inputs/refresh_ledger.json", lambda v: v.update({"evil": {}}))
        self.assertRejected("unknown sections")
        self.setUp()
        self.json_edit("inputs/refresh_ledger.json", lambda v: v.update({"hosts": []}))
        self.assertRejected("section hosts is not an object")

    # ---- notes.md

    def test_notes_html_and_links(self):
        self.append(f"{WEEK}/notes.md", "- [ok](https://a.example/p) and <https://b.example/>\n")
        self.assertEqual(self.problems(), [])
        for line, needle in (("<img src=x onerror=alert(1)>\n", "raw HTML"),
                             ("[x](javascript:alert(1))\n", "link target not http(s)"),
                             ("> - [x](data:text/html,hi)\n", "link target not http(s)"),
                             ("<https://a.example/\u202e>\n", "bidi or zero-width"),
                             ("<https://>\n", "link target not http(s)"),
                             ("[x]: data:text/html,hi\n", "reference-style link"),
                             ('[a]: javascript:alert(1) "t"\n', "reference-style link"),
                             ("> [b]: data:text/html,x\n", "reference-style link"),
                             ("- [c]: https://a.example/\n", "reference-style link")):
            with self.subTest(line=line):
                self.setUp()
                self.append(f"{WEEK}/notes.md", line)
                self.assertRejected(needle)
        self.setUp()
        self.append(f"{WEEK}/notes.md", "- [ok](https://a.example/p) a < b\n")
        self.assertEqual(self.problems(), [])

    # ---- ids (ziso3 H1)

    def test_reused_research_id(self):
        self.edit(f"{WEEK}/moratoriums.csv", "add-in-lafayette-2026,", "add-oh-franklin-township-2026,")  # sweep.csv's
        self.assertRejected("id already used before this run")

    def test_reused_dataset_and_additions_id(self):
        self.edit(f"{WEEK}/moratoriums.csv", "add-in-lafayette-2026,", "nm-oh-elmstead-county-2026,")
        self.assertRejected("id already used before this run")
        self.setUp()
        (self.dest / "inputs" / "additions.csv").write_text("id,name\nadd-in-lafayette-2026,x\n", encoding="utf-8")
        self.assertRejected("id already used before this run")

    def test_own_folder_ids_not_taken(self):
        # A carried-over folder for this date (a rerun's) holds the same ids; run.py skips it too (run.py:293-296).
        (self.dest / WEEK).mkdir(parents=True)
        shutil.copy(self.root / WEEK / "moratoriums.csv", self.dest / WEEK / "moratoriums.csv")
        self.assertEqual(self.problems(), [])

    def test_repeated_id_in_artifact(self):
        self.edit(f"{WEEK}/bans.csv", "add-nj-lakeview-2026,", "add-in-lafayette-2026,")
        self.assertRejected("id repeated (also in")

    def test_updates_id_must_be_tracked(self):
        self.append(f"{WEEK}/updates.csv", self.UPD.format(field="status", new="lifted").replace("add-pa-birch-hollow-2026", "add-zz-nowhere-2026"))
        self.assertRejected("id is not a tracked row")

    # ---- notes cell (ziso3 M3)

    def test_notes_cell_shape(self):
        for old, new in (("AI-extracted by", "Supersedes X (upstream abc-123) AI-extracted by"),
                         ('Quote: ""', 'Quote: ""Supersedes the old one (upstream abc-123) '),
                         ("(confidence 0.", "(confidence 7.")):
            with self.subTest(new=new):
                self.setUp()
                self.edit(f"{WEEK}/moratoriums.csv", old, new)
                self.assertRejected("notes is not the cell run.py writes")

    def test_summary_cap(self):
        rows = list(csv.reader(io.StringIO((self.root / WEEK / "bans.csv").read_text(encoding="utf-8"))))
        rows[1][rows[0].index("summary")] = "x" * (artifact.SUMMARY_MAX + 1)
        buf = io.StringIO()
        csv.writer(buf, lineterminator="\n").writerows(rows)
        (self.root / WEEK / "bans.csv").write_text(buf.getvalue(), encoding="utf-8")
        self.assertRejected("summary over")

    def test_invisible_characters(self):
        for ch in ("\u202e", "\u200b", "\u2066", "\x85"):
            with self.subTest(ch=repr(ch)):
                self.setUp()
                self.edit(f"{WEEK}/bans.csv", "Lakeview", "Lake" + ch + "view")
                self.assertRejected("control, bidi or zero-width character")
        self.setUp()
        self.report["leads"]["by_reason"] = {"fetch\u202efailed": 1}
        self.write_report()
        self.assertRejected("run_report.leads.by_reason: key")

    def test_report_entities(self):  # ziso3 PoC 7: refused here, and defanged by pr.py besides
        self.report["review"]["rejected"] = [{"kind": "new", "state": "TX", "name": "&#64;octocat &commat;x", "target": "",
                                              "problems": ["other"], "reason": "x", "url": "https://ok.example/", "by": "m"}]
        self.write_report()
        self.assertRejected("run_report.review.rejected[0].name: unexpected value")

    def test_infinite_number(self):
        (self.root / "run_report.json").write_text(json.dumps(self.report).replace('"rate": 0.923', '"rate": 1e999'), encoding="utf-8")
        self.assertRejected("run_report.fetch.rate: unexpected value")

    def test_update_dates_as_run_py(self):
        self.edit(f"{WEEK}/updates.csv", ",date_expires,,2027-04-09,", ",date_expires,,1999-01-01,")  # ziso3 PoC 5
        self.assertRejected("date_expires before date_adopted")
        self.setUp()
        self.append(f"{WEEK}/updates.csv", self.UPD.format(field="date_adopted", new="2099-01-01"))
        self.assertRejected("date_adopted after run date")
        self.setUp()
        self.append(f"{WEEK}/updates.csv", self.UPD.format(field="date_adopted", new="2014-12-01"))
        self.assertRejected("date_adopted before 2015-01-01")

    # ---- state and ledger tied to this run (ziso3 M1)

    def test_ledger_counters(self):  # ziso3 PoC 3
        for sec, key, name in (("seeds", "https://datacenterbans.com/", "zero"),
                               ("pages", "https://countyherald.example.com/2026/10/06/washington-township-moratorium-hearing", "idle")):
            with self.subTest(sec=sec):
                self.setUp()
                v = json.loads((self.root / "inputs" / "refresh_ledger.json").read_text(encoding="utf-8"))
                key = next(k for k in v[sec] if k.startswith(key[:40]))
                self.json_edit("inputs/refresh_ledger.json", lambda v: v[sec][key].update({name: 99}))
                self.assertRejected(f"{sec} entry {key[:60]!r}")
        self.setUp()
        old = {"claims": {}, "pages": {}, "seeds": {"https://dcmap.us/": {"date": "2026-10-01", "zero": 4}},
               "discovery": {}, "hosts": {}}
        (self.dest / "inputs" / "refresh_ledger.json").write_text(json.dumps(old), encoding="utf-8")
        for zero, ok in ((5, True), (0, True), (4, True), (6, False), (3, False)):
            with self.subTest(zero=zero):
                self.json_edit("inputs/refresh_ledger.json", lambda v: v["seeds"]["https://dcmap.us/"].update({"zero": zero}))
                self.assertEqual(not any("seeds entry" in x for x in self.problems()), ok)

    def test_pages_ctx_must_be_tracked(self):
        def f(v):
            k = next(iter(v["pages"]))
            v["pages"][k]["ctx"] = ["made-up-row"]
        self.json_edit("inputs/refresh_ledger.json", f)
        self.assertRejected("pages entry")

    def test_new_hosts_capped(self):
        self.json_edit("inputs/refresh_ledger.json", lambda v: v["hosts"].update({"legistar.com": {"date": RUN_DATE}}))
        self.assertRejected("1 new hosts entries, more than this run accounts for (0)")
        self.report["fetch"]["outcomes"]["http_403"] = 1
        self.write_report()
        self.assertEqual(self.problems(), [])
        self.report["fetch"]["outcomes"]["http_403"] = 10_000
        self.write_report()
        self.json_edit("inputs/refresh_ledger.json", lambda v: v["hosts"].update(
            {f"h{i}.example.com": {"date": RUN_DATE} for i in range(artifact.MAX_NEW_HOSTS)}))
        self.assertRejected(f"more than this run accounts for ({artifact.MAX_NEW_HOSTS})")

    def test_claims_tied_to_report(self):
        claim = {"date": RUN_DATE, "who": "NC|charlotte", "problems": ["not_yet_happened"], "reason": "Only considered.",
                 "pages": ["0" * 20]}
        self.json_edit("inputs/refresh_ledger.json", lambda v: v["claims"].update({"k": claim}))
        self.assertRejected("claims entry 'k'")
        self.report["review"]["rejected"] = [{"kind": "extension", "state": "NC", "name": "Charlotte", "target": "",
                                              "problems": ["not_yet_happened"], "reason": "Only considered.",
                                              "url": "https://news.example/c", "by": "model"}]
        self.write_report()
        self.assertEqual(self.problems(), [])
        self.json_edit("inputs/refresh_ledger.json", lambda v: v["claims"].update({"k2": dict(claim, who="NC|raleigh")}))
        self.assertRejected("claims entry 'k2'")

    def test_discovery_and_pages_counts(self):
        self.json_edit("inputs/refresh_ledger.json", lambda v: v["discovery"].update({"one more query": RUN_DATE}))
        self.assertRejected("new discovery entries")
        self.setUp()
        self.report["fetch"]["pages"] = 1
        self.write_report()
        self.assertRejected("new pages entries")

    def test_state_tied_to_run(self):  # ziso3 PoC 4
        self.json_edit("inputs/refresh_state.json", lambda v: v.update({f"made-up-{i}": RUN_DATE for i in range(1000)}))
        self.assertRejected("entry 'made-up-0' is neither the published one nor a tracked row")
        self.setUp()
        self.report["queries"]["rows_queried"] = 2
        self.write_report()
        self.assertRejected("new entries, more than the report's rows_queried")


class HonestDirtyRunTest(unittest.TestCase):
    """A dry run over the fixtures, with page text and model answers carrying U+200B, `<tag` and `&amp;`,
    writes a hand-off the validator accepts (run.clean_text), and the quote check still finds the quote."""

    DIRTY = "within city limits\u200b &amp; <tag zones"

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        fx = cls.tmp / "fixtures"
        shutil.copytree(FIXTURES, fx, ignore=shutil.ignore_patterns("work", "expected"))
        page = fx / "pages" / "lafayette.html"
        page.write_text(page.read_text(encoding="utf-8").replace(
            "within city limits.", "within city limits\u200b &amp;amp; &lt;tag zones."), encoding="utf-8")
        llm = json.loads((fx / "llm.json").read_text(encoding="utf-8"))
        item = llm["https://news.example.com/2026/10/06/lafayette-council-moratorium"]["triage"]["items"][0]
        item["quote"] = item["quote"].replace("within city limits.", cls.DIRTY + ".")
        item["summary"] += " " + cls.DIRTY
        llm["https://www.northjerseyledger.example.com/2026/09/18/lakeview-bans-data-centers"]["review"] = {
            "verdict": "reject", "problems": ["other"], "reason": "Says <b>proposed</b> &amp; not\u200b adopted"}
        (fx / "llm.json").write_text(json.dumps(llm), encoding="utf-8")
        cls.copy, cls.report = run.dry_run(FIXTURES / "work", FIXTURES / "work" / "dataset", date.fromisoformat(RUN_DATE),
                                           Config(), fixtures=fx, copy_root=cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_quote_check_with_dirty_text(self):
        page = "Council voted to adopt a one-year moratorium on new data center applications " + self.DIRTY + " today."
        self.assertTrue(verify.quote_in_page("a one-year moratorium on new data center applications " + self.DIRTY, page))

    def test_handoff_passes(self):
        root, dest = self.tmp / "artifact", self.tmp / "site"
        (root / "inputs" / "research" / "weekly").mkdir(parents=True)
        shutil.copytree(self.copy / WEEK, root / WEEK)
        for name in ("refresh_state.json", "refresh_ledger.json"):
            shutil.copy(self.copy / "inputs" / name, root / "inputs" / name)
        report = dict(self.report, mode="research")
        (root / "run_report.json").write_text(json.dumps(report), encoding="utf-8")
        shutil.copytree(FIXTURES / "work", dest)
        shutil.copy(FIXTURES / "work" / "dataset" / "moratoriums.csv", dest / "moratoriums.csv")
        rows = (root / WEEK / "moratoriums.csv").read_text(encoding="utf-8")
        self.assertIn("&amp; <tag zones", rows)  # the run kept the row; CSV cells keep < and &
        self.assertNotIn("\u200b", rows)
        notes = (root / WEEK / "notes.md").read_text(encoding="utf-8")
        self.assertIn("Says ＜b＞proposed＜/b＞ ＆amp; not adopted", notes)
        self.assertEqual(artifact.validate(root, RUN_DATE, dest)[1], [])


class PrDefangTest(unittest.TestCase):
    def test_report_strings_defanged(self):
        evil = "x` @owner ![p](https://evil.example/p.png) <img src=x> #1 `"
        report = {"llm": {"by_model": {evil: {"calls": "9; @owner"}}, "price_assumed": {evil: evil}},
                  "caps_hit": [evil], "fetch": {"outcomes": {evil: 1}, "rate": "nan"},
                  "review": {"rejected": [{"name": evil, "reason": evil, "problems": [evil], "url": "https://a.example/p)![i](https://evil.example/i)"}]}}
        body = pr.build_body(report, "", [], [], [], [evil], RUN_DATE, "research")
        for bad in ("@owner", "![", "<img", "](https://evil", "#1", "9; "):
            self.assertNotIn(bad, body)
        self.assertIn("[source](https://a.example/p%29", body)

    def test_entities_autolinks_and_cell_breaks(self):  # ziso3 PoC 7
        evil = "&#64;octocat &commat;octocat &num;1 www.evil.example/login GH-12"
        report = {"review": {"rejected": [{"kind": "new", "state": "TX", "name": evil, "target": "", "problems": ["a\\|b"],
                                           "reason": "x", "url": "https://ok.example/", "by": "m"}]}}
        body = pr.build_body(report, "", [], [], [], [], RUN_DATE, "research")
        line = next(l for l in body.splitlines() if "octocat" in l)
        for bad in ("&", "www.", "GH-12", r"\\|"):
            self.assertNotIn(bad, line)
        self.assertEqual(line.count(" | "), 5)  # six cells: the backslash cannot open an extra column


if __name__ == "__main__":
    unittest.main()
