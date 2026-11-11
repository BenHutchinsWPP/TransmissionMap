"""Tests for `publish_r2.sh --only route` and scripts/route_publish_plan.py.

A temporary fake repo (tiny cube, report, constraints, screening behind a symlink) and a
stub rclone over a bucket directory that records each call. Stdlib only; needs bash.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OCTET = "application/octet-stream"
IMMUTABLE = "public, max-age=31536000, immutable"
FILES = ["roads_primary", "rivers"]
CONCERNS = ["what-constrains", "slope"]
GEN = "ab12cd34"

STUB_RCLONE = r"""#!/usr/bin/env python3
import json, os, shutil, sys
from pathlib import Path
argv = sys.argv[1:]
cmd = argv[0]
bucket = Path(os.environ["STUB_BUCKET"])
opts, pos, i = {}, [], 1
while i < len(argv):
    a = argv[i]
    if a in ("--files-from", "--header-upload", "--combined"):
        opts.setdefault(a, []).append(argv[i + 1]); i += 2
    elif a.startswith("-"):
        opts[a] = True; i += 1
    else:
        pos.append(a); i += 1
files = open(opts["--files-from"][0]).read().split() if "--files-from" in opts else None
with open(os.environ["RCLONE_LOG"], "a") as f:
    f.write(json.dumps({"argv": argv, "pos": pos, "files": files, "headers": opts.get("--header-upload")}) + "\n")
def where(spec):
    if spec.startswith("r2:data-wpptx-org"):
        return bucket / spec[len("r2:data-wpptx-org"):].lstrip("/")
    return Path(spec)
if cmd == "copy":
    src, dst = where(pos[0]), where(pos[1])
    for r in files:
        if r == os.environ.get("STUB_COPY_SKIP"):
            continue
        (dst / r).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src / r, dst / r)
elif cmd == "check":
    src, dst = where(pos[0]), where(pos[1])
    out = []
    for r in files:
        d = dst / r
        if not d.exists(): out.append("+ " + r)
        elif d.read_bytes() != (src / r).read_bytes(): out.append("* " + r)
        else: out.append("= " + r)
    if os.environ.get("STUB_CHECK_DROP"):
        out = out[:-1]
    forced = None
    if os.environ.get("STUB_BEFORE_BANG") and not opts["--combined"][0].endswith(".after"):
        out[-1] = "! " + out[-1][2:]; forced = 1
    if os.environ.get("STUB_AFTER_DASH") and opts["--combined"][0].endswith(".after"):
        out[-1] = "- " + out[-1][2:]; forced = 0
    Path(opts["--combined"][0]).write_text("\n".join(out) + "\n")
    print("Failed to check" if os.environ.get("STUB_CHECK_RC") else "", file=sys.stderr)
    sys.exit(forced if forced is not None else int(os.environ.get("STUB_CHECK_RC") or (1 if any(o[0] != "=" for o in out) else 0)))
elif cmd == "lsf":
    root = where(pos[0])
    print("\n".join(sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())))
else:
    sys.exit(9)
"""


def sha(b):
    return hashlib.sha256(b).hexdigest()


class RoutePublish(unittest.TestCase):
    def setUp(self):
        if not shutil.which("bash"):
            self.skipTest("needs bash")
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        for n in ("publish_r2.sh", "route_publish_plan.py", "geoparquet_common.py"):
            shutil.copy(HERE / n, self.repo / "scripts")
        (self.repo / "scripts/route_data_LICENSE.txt").write_text("licence notice\n")
        (self.repo / "scripts/validate_build.py").write_text("print('data/layers/x.pmtiles')\n")
        (self.repo / "scripts/route_constraints.json").write_text(
            json.dumps({"concerns": [{"id": c} for c in CONCERNS]}))
        (self.repo / "assets/route").mkdir(parents=True)
        rows = "".join(f"  {{ file: '{f}', family: 'road', src: 'osm', cols: [] }},\n" for f in FILES)
        (self.repo / "assets/route/report-read.ts").write_text(
            f"const FILES: X[] = [\n{rows}];\nconst FAMILIES = [];\n")
        cube = self.repo / "data/route/250m"
        cube.mkdir(parents=True)
        (cube / "grid.json").write_text(json.dumps({
            "super_tiles_present": [[1, 2], [3, 4]],
            "pd_files": {"pattern": "pd_{col}_{row}.tif"}, "osm_files": {"pattern": "osm_{col}_{row}.tif"}}))
        for n in ("pd_1_2", "pd_3_4", "osm_1_2", "osm_3_4"):
            (cube / f"{n}.tif").write_bytes(n.encode() * 3)
        rep = self.repo / "data/route/report"
        rep.mkdir()
        for f in FILES + ["airports"]:
            (rep / f"{f}.parquet").write_bytes(f.encode() * 5)
        (rep / "manifest.json").write_text("{}")
        con = self.repo / "data/route/constraints"
        con.mkdir()
        for c in CONCERNS:
            (con / f"{c}.pmtiles").write_bytes(c.encode() * 4)
        (con / "manifest.json").write_text("{}")
        # screening lives outside the repo, behind a symlink
        self.scr = self.tmp / "screening"
        gen = self.scr / GEN
        gen.mkdir(parents=True)
        (gen / "aviation.json").write_text('{"a": 1}')
        (gen / "generation.json").write_text("{}")
        (self.scr / "manifest.json").write_text(json.dumps(
            {"generation": GEN, "aviation": {"file": "aviation.json", "sha256": sha(b'{"a": 1}')}}))
        (self.scr / "retired").mkdir()
        (self.scr / "retired/old.parquet").write_bytes(b"old")
        (self.scr / "manifest.regional-v1.json").write_text("{}")
        os.symlink(self.scr, rep / "screening")
        self.constants = self.repo / "assets/constants.ts"
        self.set_pin(None)
        self.bucket = self.tmp / "bucket"
        self.bucket.mkdir()
        bindir = self.tmp / "bin"
        bindir.mkdir()
        (bindir / "rclone").write_text(STUB_RCLONE)
        (bindir / "rclone").chmod(0o755)
        self.log = self.tmp / "rclone.log"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("R2_", "RCLONE_"))}
        self.env.update(PATH=f"{bindir}:{os.environ['PATH']}", RCLONE_LOG=str(self.log),
                        STUB_BUCKET=str(self.bucket))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def set_pin(self, rid):
        self.constants.write_text('export const X = 1;\n' + (f'export const ROUTE_ID = "{rid}";\n' if rid else ""))

    def compute_id(self, *flags):
        r = subprocess.run(["python3", "scripts/route_publish_plan.py", "--print-id", *flags],
                           cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def pin(self):
        rid = self.compute_id()
        self.set_pin(rid)
        return rid

    def run_script(self, *args, keys=True, **extra):
        env = dict(self.env, **extra)
        if keys:
            env.update(R2_ACCOUNT_ID="acct", R2_ACCESS_KEY_ID="kid", R2_SECRET_ACCESS_KEY="sec")
        return subprocess.run(["bash", str(self.repo / "scripts/publish_r2.sh"), *args],
                              env=env, capture_output=True, text=True, cwd=self.tmp)

    def calls(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []

    def copies(self):
        return [c for c in self.calls() if c["argv"][0] == "copy"]

    def plan_keys(self, *flags):
        """Keys the plan names, from keys.txt of a direct helper run."""
        out = self.tmp / "plan"
        r = subprocess.run(["python3", "scripts/route_publish_plan.py", "--out", str(out), *flags],
                           cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = [l.split("\t") for l in (out / "keys.txt").read_text().splitlines()]
        return {k: (int(s), ph) for k, s, ph in rows}

    # ── selection and id ──
    def test_selection_is_exactly_the_route_set_under_the_id_prefix(self):
        rid = self.compute_id()
        keys = self.plan_keys()
        p = f"data/route/{rid}/"
        want = {p + "250m/grid.json", p + "report/screening/manifest.json", p + "LICENSE.txt"}
        want |= {p + f"250m/{n}.tif" for n in ("pd_1_2", "pd_3_4", "osm_1_2", "osm_3_4")}
        want |= {p + f"report/{f}.parquet" for f in FILES}
        want |= {p + f"constraints/{c}.pmtiles" for c in CONCERNS}
        want |= {p + f"report/screening/{GEN}/{n}" for n in ("aviation.json", "generation.json")}
        self.assertFalse([k for k in keys if k.endswith("AL.parquet") or k.endswith("CA.parquet")])
        self.assertEqual(set(keys), want)
        self.assertFalse([k for k in keys if "data/layers" in k or "data/analysis" in k])
        self.assertEqual({k for k, v in keys.items() if v[1] == "final"},
                         {p + "250m/grid.json", p + "report/screening/manifest.json", p + "LICENSE.txt"})

    def test_uploaded_pointer_is_the_local_one(self):
        keys = self.plan_keys()
        self.assertEqual((self.tmp / "plan/stage/manifest.json").read_bytes(), (self.scr / "manifest.json").read_bytes())
        size = next(v[0] for k, v in keys.items() if k.endswith("screening/manifest.json"))
        self.assertEqual(size, (self.scr / "manifest.json").stat().st_size)

    def test_a_pointer_with_buildings_is_refused(self):
        ptr = json.loads((self.scr / "manifest.json").read_text())
        ptr["buildings"] = {"files": [{"name": "CA.parquet", "bytes": 1, "sha256": "0" * 64}]}
        (self.scr / "manifest.json").write_text(json.dumps(ptr))
        self.refused("names building files")

    def test_report_selection_equals_report_read_files_of_the_real_repo(self):
        text = (ROOT / "assets/route/report-read.ts").read_text()
        block = text[text.index("const FILES"):]
        block = block[:block.index("];")]
        names = [m.group(1) for line in block.splitlines() for m in [re.search(r"file: '([^']+)'", line)] if m]
        self.assertEqual(len(names), 8)
        import importlib.util
        spec = importlib.util.spec_from_file_location("rpp", HERE / "route_publish_plan.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        cwd = os.getcwd()
        os.chdir(ROOT)
        try:
            self.assertEqual(mod.report_files(), names)
        finally:
            os.chdir(cwd)

    def test_id_follows_the_file_set_and_sizes(self):
        a = self.compute_id()
        self.assertRegex(a, r"^[0-9a-f]{12}$")
        self.assertEqual(a, self.compute_id())
        (self.repo / "data/route/report/rivers.parquet").write_bytes(b"longer than before")
        self.assertNotEqual(a, self.compute_id())

    def test_retired_generation_and_unread_files_are_skipped_and_listed(self):
        r = self.run_script("--only", "route", "--dry-run", keys=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        for s in ("airports.parquet", "report/manifest.json", "constraints/manifest.json",
                  "retired", "manifest.regional-v1.json"):
            self.assertIn(s, r.stdout.split("Skipped")[1])
        self.assertNotIn("airports.parquet", "".join(" ".join(c["argv"]) for c in self.calls()))
        keys = self.plan_keys()
        self.assertFalse([k for k in keys if "retired" in k or "airports" in k])

    # ── refusals ──
    def refused(self, fragment):
        r = self.run_script("--only", "route", "--dry-run", keys=False)
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertIn(fragment, r.stderr)
        self.assertNotIn("Route set under", r.stdout)

    def test_stray_cube_file_aborts(self):
        (self.repo / "data/route/250m/pd_9_9.tif").write_bytes(b"x")
        self.refused("unexpected file in data/route/250m: pd_9_9.tif")

    def test_stray_constraints_file_aborts(self):
        (self.repo / "data/route/constraints/old.pmtiles").write_bytes(b"x")
        self.refused("unexpected file in data/route/constraints: old.pmtiles")

    def test_stray_generation_file_aborts(self):
        (self.scr / GEN / "extra.parquet").write_bytes(b"x")
        self.refused("unexpected file in screening generation")

    def test_a_building_file_in_the_generation_aborts(self):
        (self.scr / GEN / "AL.parquet").write_bytes(b"short")
        self.refused("unexpected file in screening generation")

    def test_missing_file_aborts(self):
        (self.repo / "data/route/250m/osm_3_4.tif").unlink()
        self.refused("missing:")

    def test_route_id_mismatch_aborts_before_any_rclone(self):
        self.set_pin("0" * 12)
        r = self.run_script("--only", "route")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("ROUTE_ID computed", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_unpinned_id_aborts_a_real_run_but_not_a_dry_run(self):
        self.assertNotEqual(self.run_script("--only", "route").returncode, 0)
        d = self.run_script("--only", "route", "--dry-run", keys=False)
        self.assertEqual(d.returncode, 0)
        self.assertIn("[unpinned]", d.stdout)
        self.assertIn("ROUTE_ID computed: " + self.compute_id(), d.stdout)

    def test_existing_key_with_different_content_aborts_and_uploads_nothing(self):
        rid = self.pin()
        k = self.bucket / f"data/route/{rid}/report/rivers.parquet"
        k.parent.mkdir(parents=True)
        k.write_bytes(b"other content")
        r = self.run_script("--only", "route")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("different content", r.stderr)
        self.assertEqual(self.copies(), [])

    def test_bad_flag_combinations(self):
        self.assertEqual(self.run_script("--no-final", keys=False).returncode, 2)
        self.assertEqual(self.run_script("--only", "layers", keys=False).returncode, 2)
        self.assertEqual(self.run_script("--only", "route", "--prune-list", keys=False).returncode, 2)

    def test_two_mode_flags_are_refused_in_either_order(self):
        for args in (("--dry-run", "--rollback", "20261106T120000Z"), ("--rollback", "20261106T120000Z", "--dry-run"),
                     ("--dry-run", "--prune-list")):
            r = self.run_script(*args)
            self.assertEqual(r.returncode, 2, args)
            self.assertIn("only one of", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_aviation_sha_is_verified(self):
        (self.scr / GEN / "aviation.json").write_text('{"a": 2}')
        r = self.run_script("--only", "route", "--dry-run", "--verify-sha", keys=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("sha256 differs from manifest: aviation.json", r.stderr)

    def test_pointer_names_with_path_parts_are_refused(self):
        for bad in ("../x.parquet", "a/b.parquet", "a\\b.parquet"):
            ptr = json.loads((self.scr / "manifest.json").read_text())
            ptr["aviation"]["file"] = bad
            (self.scr / "manifest.json").write_text(json.dumps(ptr))
            self.refused("pointer file name")

    def test_grid_json_with_a_local_path_aborts(self):
        g = self.repo / "data/route/250m/grid.json"
        d = json.loads(g.read_text())
        d["src"] = "/mnt/data/x"
        g.write_text(json.dumps(d))
        self.refused("local path")

    # ── upload ──
    def test_dry_run_needs_no_rclone_or_keys(self):
        r = self.run_script("--only", "route", "--dry-run", keys=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls(), [])
        self.assertIn("cube           5 files", r.stdout)
        self.assertIn("constraints    2 files", r.stdout)
        self.assertIn("screening      2 files", r.stdout)

    def test_upload_order_headers_and_final_group_last(self):
        rid = self.pin()
        r = self.run_script("--only", "route")
        self.assertEqual(r.returncode, 0, r.stderr)
        copies = self.copies()
        self.assertTrue(copies)
        for c in copies:
            ct = "text/plain; charset=utf-8" if c["files"] == ["LICENSE.txt"] else OCTET
            self.assertEqual(c["headers"], [f"Content-Type: {ct}", f"Cache-Control: {IMMUTABLE}"])
            self.assertIn("--checksum", c["argv"])
        self.assertEqual(copies[-1]["files"], ["grid.json"])
        finals = {"grid.json", "manifest.json", "LICENSE.txt"}
        flags = [set(c["files"]) <= finals for c in copies]
        self.assertTrue(any(flags) and not all(flags))
        first_final = flags.index(True)
        self.assertTrue(all(flags[first_final:]), "a bulk copy runs after a final one")
        self.assertEqual({n for c in copies[first_final:] for n in c["files"]}, finals)
        # every check ran before the first copy
        verbs = [c["argv"][0] for c in self.calls()]
        n = len(copies)
        self.assertEqual(verbs, ["check"] * n + ["copy"] * n + ["check"] * n)
        got = sorted(str(p.relative_to(self.bucket)) for p in self.bucket.rglob("*") if p.is_file())
        self.assertEqual(got, sorted(self.plan_keys()))
        self.assertTrue(all(k.startswith(f"data/route/{rid}/") for k in got))
        self.assertEqual((self.bucket / f"data/route/{rid}/LICENSE.txt").read_text(), "licence notice\n")
        self.assertEqual((self.bucket / f"data/route/{rid}/report/screening/{GEN}/aviation.json").read_bytes(),
                         (self.scr / GEN / "aviation.json").read_bytes())

    def test_guard_aborts_when_the_check_listing_is_incomplete(self):
        self.pin()
        r = self.run_script("--only", "route", STUB_CHECK_DROP="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("comparison is incomplete", r.stderr)
        self.assertEqual(self.copies(), [])

    def test_guard_aborts_on_a_check_error_exit(self):
        self.pin()
        r = self.run_script("--only", "route", STUB_CHECK_RC="3")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("exit 3", r.stderr)
        self.assertEqual(self.copies(), [])

    def test_guard_aborts_on_an_error_line_with_a_clean_exit_code(self):
        self.pin()
        r = self.run_script("--only", "route", STUB_BEFORE_BANG="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("different content", r.stderr)
        self.assertEqual(self.copies(), [])

    def test_post_upload_check_fails_on_a_non_match_line_with_a_clean_exit_code(self):
        self.pin()
        r = self.run_script("--only", "route", STUB_AFTER_DASH="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("after the upload", r.stderr)
        self.assertNotIn("Published", r.stdout)

    def test_a_file_the_copy_skipped_fails_the_post_upload_check(self):
        self.pin()
        r = self.run_script("--only", "route", STUB_COPY_SKIP="rivers.parquet")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("after the upload", r.stderr)
        self.assertNotIn("Published", r.stdout)

    def test_no_final_leaves_the_final_group_out(self):
        rid = self.pin()
        r = self.run_script("--only", "route", "--no-final")
        self.assertEqual(r.returncode, 0, r.stderr)
        got = {str(p.relative_to(self.bucket)) for p in self.bucket.rglob("*") if p.is_file()}
        p = f"data/route/{rid}/"
        self.assertFalse(got & {p + "250m/grid.json", p + "report/screening/manifest.json", p + "LICENSE.txt"})
        self.assertIn(p + "250m/pd_1_2.tif", got)

    def test_republish_of_same_content_passes_the_guard(self):
        self.pin()
        self.assertEqual(self.run_script("--only", "route").returncode, 0)
        self.assertEqual(self.run_script("--only", "route").returncode, 0)

    def test_route_run_touches_no_layers_or_analysis(self):
        self.pin()
        self.run_script("--only", "route")
        for c in self.calls():
            self.assertNotIn("data/layers", " ".join(c["argv"]))
            self.assertNotIn("data/analysis", " ".join(c["argv"]))
            self.assertNotIn("prev/", " ".join(c["argv"]))
            self.assertNotIn(c["argv"][0], ("sync", "delete", "move", "purge"))

    # ── prune list ──
    def test_prune_list_keeps_pinned_route_keys_only(self):
        rid = self.pin()
        (self.repo / "data/analysis").mkdir()
        (self.repo / "data/analysis/index.json").write_text('{"datasets": {}, "columns": {}}')
        (self.repo / "scripts/release_manifest.yaml").write_text("layers:\n")
        for k in (f"data/route/{rid}/250m/grid.json", "data/route/deadbeef0000/250m/grid.json"):
            p = self.bucket / k
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("x")
        r = self.run_script("--prune-list")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("data/route/deadbeef0000/250m/grid.json", r.stdout)
        self.assertNotIn(f"data/route/{rid}/", r.stdout)


if __name__ == "__main__":
    unittest.main()
