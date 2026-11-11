"""Tests for publish_r2.sh — the R2 publish of data/layers, data/releases, data/analysis.

Runs the script over a temporary fake repo (its own validate_build.py stub) with a
stub rclone that records each call. Stdlib only; needs bash.
"""
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
OCTET, JSON_T, GEOJSON, ZIP = "application/octet-stream", "application/json", "application/geo+json", "application/zip"
IMMUTABLE = "public, max-age=31536000, immutable"
FIXED = "public, max-age=3600, s-maxage=2592000"
SECRET = "sEcReT-9f8e7d6c5b4a"
KEY_ID = "kEyId-0a1b2c3d"

LISTED = [  # what the validate_build.py stub names; the last one is not built
    "data/layers/lines.pmtiles", "data/layers/subs.geojson.gz", "data/layers/wind_lut.json",
    "data/layers/wind_lut.i16.gz", "data/layers/manifest.json", "data/layers/plain.geojson",
    "data/layers/never_built.pmtiles",
]
RELEASE_YAML = """disclaimer: disclaimer.txt

layers:

  lines-pack:
    doc: x.md
    shp: a.gpkg

  points-pack:
    csv_only: true  # points

  world-pack:
    continental: true
    geojson_only: true

  skipped-pack:
    skip: true  # no redistribution
"""
RELEASE_KEEP = {  # packs the yaml above can build
    "data/releases/lines-pack.zip", "data/releases/lines-pack-shp.zip",
    "data/releases/points-pack.zip",
    *(f"data/releases/world-pack-{c}.zip" for c in ("na", "eu", "as", "sa", "af", "oc", "ca", "an")),
}
SOURCE_ONLY = [  # on disk, not uploaded
    "data/layers/lines_eu.pmtiles",  # not named by the layers list
    "data/releases/stray.txt",       # not a pack zip
]
ANALYSIS = [
    "data/analysis/index.json",
    "data/analysis/columns/lines.1234abcd.parquet",
    "data/analysis/osm_lines/_manifest.json",
]
EXPECTED = {  # file → (phase, content type, cache control)
    "data/layers/lines.pmtiles": ("objects", OCTET, FIXED),
    "data/layers/subs.geojson.gz": ("objects", OCTET, FIXED),
    "data/layers/wind_lut.json": ("objects", JSON_T, FIXED),
    "data/layers/wind_lut.i16.gz": ("objects", OCTET, FIXED),
    "data/layers/manifest.json": ("manifests", JSON_T, FIXED),
    "data/layers/plain.geojson": ("objects", GEOJSON, FIXED),
    "data/releases/lines_na.zip": ("objects", ZIP, FIXED),
    "data/analysis/index.json": ("manifests", JSON_T, FIXED),
    "data/analysis/columns/lines.1234abcd.parquet": ("objects", OCTET, IMMUTABLE),
    "data/analysis/osm_lines/_manifest.json": ("objects", JSON_T, FIXED),
}

# A fake bucket on disk: lsf, cat, copy, sync, check, delete and move over $STUB_BUCKET.
STUB_RCLONE = r"""#!/usr/bin/env python3
import json, os, shutil, sys
from pathlib import Path
argv = sys.argv[1:]
cmd = argv[0]
bucket = Path(os.environ["STUB_BUCKET"])
rec = {"argv": argv, "files": None,
       "endpoint": os.environ.get("RCLONE_CONFIG_R2_ENDPOINT"),
       "provider": os.environ.get("RCLONE_CONFIG_R2_PROVIDER"),
       "key": os.environ.get("RCLONE_CONFIG_R2_SECRET_ACCESS_KEY")}
opts, pos, i = {}, [], 1
while i < len(argv):
    a = argv[i]
    if a in ("--files-from", "--header-upload", "--combined"):
        opts.setdefault(a, []).append(argv[i + 1]); i += 2
    else:
        opts[a] = True
        if not a.startswith("-"):
            pos.append(a)
        i += 1
pos = [a for a in pos if a != True]
if "--files-from" in opts:
    rec["files"] = open(opts["--files-from"][0]).read().split()
with open(os.environ["RCLONE_LOG"], "a") as f:
    f.write(json.dumps(rec) + "\n")

def where(spec):
    if spec == ".":
        return Path(".")
    assert spec.startswith("r2:data-wpptx-org"), spec
    return bucket / spec[len("r2:data-wpptx-org"):].lstrip("/")

def files(root):
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()) if root.exists() else []

def put(src, dst, rels):
    for r in rels:
        if (src / r).is_file():
            (dst / r).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src / r, dst / r)

if cmd == "lsf":
    if os.environ.get("STUB_FAIL") == "lsf":
        sys.exit(3)
    root = where(pos[0])
    if not root.exists():
        print("directory not found", file=sys.stderr); sys.exit(3)
    print("\n".join(files(root)))
elif cmd == "cat":
    sys.stdout.write(where(pos[0]).read_text())
elif cmd in ("copy", "sync"):
    src, dst = where(pos[0]), where(pos[1])
    rels = rec["files"] if rec["files"] is not None else files(src)
    if cmd == "sync":
        for r in files(dst):
            if r not in files(src):
                (dst / r).unlink()
    put(src, dst, rels)
elif cmd == "check":
    mode = os.environ.get("STUB_CHECK", "")
    if mode == "fail":
        print("Failed to check: network down", file=sys.stderr); sys.exit(1)
    out, bad = [], 0
    for r in rec["files"]:
        d = bucket / r
        if not d.exists():
            out.append("- " + r); bad = 1
        elif d.read_bytes() != Path(r).read_bytes():
            out.append("* " + r); bad = 1
        else:
            out.append("= " + r)
    if mode == "partial":
        out, bad = out[:1] + ["! " + out[1][2:]], 1
    if mode == "rc3":
        bad = 3
    if mode == "truncated":
        out, bad = out[:1], 1
    Path(opts["--combined"][0]).write_text("\n".join(out) + "\n")
    sys.exit(bad)
else:
    sys.exit(9)
"""


def index_with_dataset():
    """An index.json naming the osm_lines dataset (idx + one GEO part), plus the files."""
    files = {}
    entries = {}
    for kind in ("idx", "geo"):
        body = parquet_bytes(kind.encode() * 4)
        sha = hashlib.sha256(body).hexdigest()
        name = "osm_lines.%s.%s.parquet" % (kind, sha[:8])
        files[name] = body
        entries[kind] = {"name": name, "bytes": len(body), "sha256": sha, "footer_len": 12,
                         "rows": 5, **({"row_offset": 0} if kind == "geo" else {})}
    index = {"datasets": {"osm_lines": {"build_id": "b1", "path": "osm_lines/", "rows": 5,
                                        "idx": entries["idx"], "geo": [entries["geo"]]}},
             "columns": {}}
    return index, files


def parquet_bytes(body=b"x" * 10):
    return b"PAR1" + body + len(body).to_bytes(4, "little") + b"PAR1"


for _name in index_with_dataset()[1]:
    EXPECTED["data/analysis/osm_lines/" + _name] = ("objects", OCTET, IMMUTABLE)


class PublishR2(unittest.TestCase):
    def setUp(self):
        if not shutil.which("bash"):
            self.skipTest("needs bash")
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        sd = self.repo / "scripts"
        sd.mkdir(parents=True)
        shutil.copy(HERE / "publish_r2.sh", sd)
        shutil.copy(HERE / "geoparquet_common.py", sd)
        shutil.copy(HERE / "route_publish_plan.py", sd)
        (sd / "validate_build.py").write_text(
            "import sys\nif '--list-expected' in sys.argv:\n    print(%r)\n" % "\n".join(LISTED))
        (self.repo / "scripts/release_manifest.yaml").write_text(RELEASE_YAML)
        for f in LISTED[:-1] + SOURCE_ONLY + ANALYSIS + ["data/releases/lines_na.zip"]:
            p = self.repo / f
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(parquet_bytes() if f.endswith(".parquet") else b"data " + f.encode())
        index, parts = index_with_dataset()
        (self.repo / "data/analysis/index.json").write_text(json.dumps(index))
        (self.repo / "data/analysis/osm_lines/_manifest.json").write_text('{"build_id": "b1"}')
        for name, body in parts.items():
            (self.repo / "data/analysis/osm_lines" / name).write_bytes(body)
        self.part_names = sorted(parts)
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

    def run_script(self, *args, keys=True, **extra):
        env = dict(self.env, **extra)
        if keys:
            env.update(R2_ACCOUNT_ID="acct123", R2_ACCESS_KEY_ID=KEY_ID, R2_SECRET_ACCESS_KEY=SECRET)
        return subprocess.run(["bash", str(self.repo / "scripts/publish_r2.sh"), *args],
                              env=env, capture_output=True, text=True, cwd=self.tmp)

    def put(self, key, data=b"old"):
        p = self.bucket / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data if isinstance(data, bytes) else data.encode())

    def bucket_keys(self):
        return sorted(str(p.relative_to(self.bucket)) for p in self.bucket.rglob("*") if p.is_file())

    def verbs(self):
        return [c["argv"][0] for c in self.calls()]

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def parse_plan(self, out):
        """file → (group index, phase, content type, cache control)."""
        plan, g = {}, None
        for line in out.splitlines():
            if line.startswith("Group "):
                g = {"n": int(line.split()[1]), "phase": line.split("(")[1].split(")")[0]}
            elif g and line.startswith("  Content-Type: "):
                g["ct"] = line.split(": ", 1)[1]
            elif g and line.startswith("  Cache-Control: "):
                g["cc"] = line.split(": ", 1)[1]
            elif g and line.startswith("    "):
                plan[line.split()[0]] = (g["n"], g["phase"], g["ct"], g["cc"])
            elif not line.strip():
                g = None
        return plan

    def test_dry_run_groups_and_headers(self):
        r = self.run_script("--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        plan = self.parse_plan(r.stdout)
        self.assertEqual(set(plan), set(EXPECTED))
        for f, (_, phase, ct, cc) in plan.items():
            self.assertEqual((phase, ct, cc), EXPECTED[f], f)
        last_object = max(n for n, ph, *_ in plan.values() if ph == "objects")
        self.assertTrue(all(n > last_object for n, ph, *_ in plan.values() if ph == "manifests"))
        self.assertIn("missing (skipped): data/layers/never_built.pmtiles", r.stderr)
        self.assertNotIn("Content-Encoding", r.stdout)
        rclone_lines = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("rclone ")]
        copies = [l for l in rclone_lines if l.startswith("rclone copy --checksum --files-from")]
        self.assertEqual(len(copies), len({(n) for n, *_ in plan.values()}))
        for l in rclone_lines:
            self.assertRegex(l, r"^rclone (copy|check) ")
            for word in (" sync ", " delete ", " move ", "--delete"):
                self.assertNotIn(word, l)
        self.assertEqual(self.calls(), [], "a dry run must not call rclone")

    def test_dry_run_never_prints_keys(self):
        (self.repo / ".env.r2").write_text(
            f"R2_ACCOUNT_ID=acct123\nR2_ACCESS_KEY_ID={KEY_ID}\nR2_SECRET_ACCESS_KEY={SECRET}\n")
        for keys in (True, False):
            r = self.run_script("--dry-run", keys=keys)
            self.assertEqual(r.returncode, 0, r.stderr)
            for s in (SECRET, KEY_ID, "acct123"):
                self.assertNotIn(s, r.stdout + r.stderr)

    def test_missing_key_is_refused(self):
        r = self.run_script(keys=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("local/r2-deploy.md", r.stderr)
        self.assertEqual(self.calls(), [])
        r = self.run_script(keys=False, R2_ACCOUNT_ID="acct123", R2_ACCESS_KEY_ID=KEY_ID)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("R2_SECRET_ACCESS_KEY", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_rclone_required_without_dry_run(self):
        path = "/usr/bin:/bin"
        if shutil.which("rclone", path=path):
            self.skipTest("rclone installed system-wide")
        r = self.run_script(PATH=path)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("sudo apt install rclone", r.stderr)

    def test_keys_from_env_file(self):
        (self.repo / ".env.r2").write_text(
            f'R2_ACCOUNT_ID=acct123\nR2_ACCESS_KEY_ID="{KEY_ID}"\nR2_SECRET_ACCESS_KEY={SECRET}\n')
        r = self.run_script(keys=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()[0]
        self.assertEqual(c["endpoint"], "https://acct123.r2.cloudflarestorage.com")
        self.assertEqual((c["provider"], c["key"]), ("Cloudflare", SECRET))

    def test_upload_copies_per_group_backs_up_then_manifests_last(self):
        self.put("data/layers/lines.pmtiles", b"old archive")
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        for s in (SECRET, KEY_ID):
            self.assertNotIn(s, r.stdout + r.stderr)
        calls = self.calls()
        self.assertEqual(calls[0]["argv"][0], "check")
        self.assertEqual(calls[1]["argv"][:1] + calls[1]["argv"][-2:],
                         ["copy", "r2:data-wpptx-org", calls[1]["argv"][-1]])
        self.assertRegex(calls[1]["argv"][-1], r"^r2:data-wpptx-org/prev/\d{8}T\d{6}Z$")
        self.assertEqual(calls[1]["files"], ["data/layers/lines.pmtiles"])
        uploads = calls[2:]
        seen = {}
        for c in uploads:
            a = c["argv"]
            self.assertEqual(a[:2], ["copy", "--checksum"])
            self.assertEqual(a[-2:], [".", "r2:data-wpptx-org"])
            self.assertNotIn(SECRET, " ".join(a))
            hdr = [a[i + 1] for i, x in enumerate(a) if x == "--header-upload"]
            self.assertEqual(len(hdr), 2)
            self.assertFalse(any(h.lower().startswith("content-encoding") for h in hdr))
            ct = hdr[0].split(": ", 1)[1]
            cc = hdr[1].split(": ", 1)[1]
            for f in c["files"]:
                seen[f] = (ct, cc)
        self.assertEqual(seen, {f: v[1:] for f, v in EXPECTED.items()})
        names = [Path(f).name for f in uploads[-1]["files"]]
        self.assertEqual(sorted(names), ["index.json", "manifest.json"])
        for c in calls:
            self.assertIn(c["argv"][0], ("check", "copy"))
        self.assertNotIn("data/releases/stray.txt", self.bucket_keys())
        self.assertNotIn("data/layers/lines_eu.pmtiles", self.bucket_keys())

    def test_publish_prints_changed_fixed_urls_as_purge_list(self):
        self.put("data/layers/lines.pmtiles", b"old archive")
        self.put("data/layers/plain.geojson", Path(self.repo / "data/layers/plain.geojson").read_bytes())
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        urls = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("https://")]
        want = sorted("https://data.wpptx.org/" + f for f, v in EXPECTED.items()
                      if v[2] == FIXED and f != "data/layers/plain.geojson")
        self.assertEqual(sorted(urls), want)
        self.assertIn("https://data.wpptx.org/data/layers/lines.pmtiles", urls)
        self.assertFalse(any(u.endswith(".parquet") for u in urls))
        self.log.unlink()
        r = self.run_script()  # nothing changed now
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("https://", r.stdout)
        self.assertIn("nothing to purge", r.stdout)

    def test_failing_list_expected_aborts_before_any_rclone(self):
        (self.repo / "scripts/validate_build.py").write_text("print('data/layers/lines.pmtiles')\nimport sys\nsys.exit('boom')\n")
        for args in ((), ("--dry-run",), ("--prune-list",)):
            r = self.run_script(*args)
            self.assertNotEqual(r.returncode, 0, args)
            self.assertIn("boom", r.stderr)
            self.assertEqual(self.calls(), [], args)
        self.assertEqual(self.bucket_keys(), [])

    def test_empty_list_expected_aborts(self):
        (self.repo / "scripts/validate_build.py").write_text("pass\n")
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_check_errors_abort_without_overwriting_fixed_names(self):
        self.put("data/layers/lines.pmtiles", b"old archive")
        for mode in ("fail", "partial", "truncated", "rc3"):
            self.log.unlink(missing_ok=True)
            r = self.run_script(STUB_CHECK=mode)
            self.assertNotEqual(r.returncode, 0, mode)
            self.assertIn("nothing uploaded", r.stderr)
            self.assertEqual(self.verbs(), ["check"], mode)
            self.assertEqual(self.bucket_keys(), ["data/layers/lines.pmtiles"], mode)
            self.assertEqual((self.bucket / "data/layers/lines.pmtiles").read_bytes(), b"old archive")

    def test_releases_ship_only_zips(self):
        r = self.run_script("--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("stray.txt", r.stdout)

    def test_analysis_files_outside_covered_dirs_are_refused(self):
        for rel in ("data/analysis/notes.txt", "data/analysis/elsewhere/x.parquet",
                    "data/analysis/osm_lines/orphan.parquet"):
            f = self.repo / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(b"x")
            for args in (("--dry-run",), ()):
                r = self.run_script(*args)
                self.assertNotEqual(r.returncode, 0, rel)
                self.assertEqual(self.calls(), [], rel)
            if "orphan" not in rel:
                self.assertIn(rel.split("data/analysis/")[1], r.stderr)
            f.unlink()
        r = self.run_script("--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_archive_sha256_mismatch_aborts_before_upload(self):
        body = parquet_bytes(b"y" * 12)
        name = "lines.%s.parquet" % hashlib.sha256(body).hexdigest()[:8]
        (self.repo / "data/analysis/columns/lines.1234abcd.parquet").unlink()
        (self.repo / "data/analysis/columns" / name).write_bytes(body)
        entry = {"build_id": "b1", "path": "columns/", "archive_sha256": "0" * 64,
                 "file": {"name": name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                          "footer_len": 12}}
        index = json.loads((self.repo / "data/analysis/index.json").read_text())
        index["columns"] = {"lines": entry}
        (self.repo / "data/analysis/index.json").write_text(json.dumps(index))
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("archive_sha256 differs", r.stderr)
        self.assertEqual(self.calls(), [])
        r = self.run_script("--dry-run")
        self.assertNotEqual(r.returncode, 0)

    def test_env_file_trims_whitespace_and_export(self):
        (self.repo / ".env.r2").write_text(
            f'  export R2_ACCOUNT_ID = acct123  \r\nexport   R2_ACCESS_KEY_ID=" {KEY_ID}"  \n'
            f"# comment\n\tR2_SECRET_ACCESS_KEY={SECRET}   \n")
        r = self.run_script(keys=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.calls()[0]
        self.assertEqual(c["endpoint"], "https://acct123.r2.cloudflarestorage.com")
        self.assertEqual(c["key"], SECRET)

    def test_env_file_is_parsed_never_sourced(self):
        canary = self.tmp / "PWNED"
        (self.repo / ".env.r2").write_text(
            f"R2_ACCOUNT_ID=acct123\nR2_ACCESS_KEY_ID=$(touch {canary})\nR2_SECRET_ACCESS_KEY={SECRET}\n")
        self.run_script(keys=False)
        self.assertFalse(canary.exists())

    # ── prune-list ──────────────────────────────────────────────────────────
    def seed_bucket(self):
        keys = [*LISTED, *RELEASE_KEEP, "data/analysis/index.json", "data/analysis/osm_lines/_manifest.json",
                *("data/analysis/osm_lines/" + n for n in self.part_names)]
        for k in keys:
            self.put(k)

    def test_prune_list_keeps_what_manifests_name_even_when_not_on_disk(self):
        self.seed_bucket()
        self.put("data/layers/old.pmtiles")
        self.put("data/releases/old-pack.zip")
        self.put("data/releases/skipped-pack.zip")
        self.put("data/releases/points-pack-shp.zip")
        self.put("data/analysis/columns/stale.12345678.parquet")
        self.put("prev/20260101T000000Z/data/layers/lines.pmtiles")
        r = self.run_script("--prune-list")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[1:], [
            "data/analysis/columns/stale.12345678.parquet", "data/layers/old.pmtiles",
            "data/releases/old-pack.zip", "data/releases/points-pack-shp.zip",
            "data/releases/skipped-pack.zip"])
        self.assertNotIn("never_built", r.stdout)
        self.assertEqual(set(self.verbs()), {"lsf"})

    def test_prune_list_keeps_files_a_prev_index_names(self):
        self.seed_bucket()
        old = {"datasets": {}, "columns": {"lines": {"build_id": "b0", "path": "columns/",
               "file": {"name": "lines.0badc0de.parquet"}}}}
        self.put("data/analysis/columns/lines.0badc0de.parquet")
        self.put("prev/20260101T000000Z/data/analysis/index.json", json.dumps(old))
        r = self.run_script("--prune-list")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[1:], [])
        self.assertIn("cat", self.verbs())

    def test_prune_list_refuses_when_an_input_is_missing(self):
        self.seed_bucket()
        self.put("data/layers/old.pmtiles")
        for rel in ("scripts/release_manifest.yaml", "data/analysis/index.json"):
            f = self.repo / rel
            keep = f.read_bytes()
            f.unlink()
            r = self.run_script("--prune-list")
            self.assertNotEqual(r.returncode, 0, rel)
            self.assertNotIn("old.pmtiles", r.stdout)
            self.assertEqual(self.calls(), [])
            f.write_bytes(keep)

    def test_prune_list_aborts_when_listing_fails(self):
        self.seed_bucket()
        r = self.run_script("--prune-list", STUB_FAIL="lsf")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")

    def test_prune_delete_is_gone_and_nothing_ever_deletes(self):
        self.seed_bucket()
        self.put("data/layers/old.pmtiles")
        r = self.run_script("--prune-delete")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.calls(), [])
        self.run_script("--prune-list")
        self.assertIn("data/layers/old.pmtiles", self.bucket_keys())
        text = (HERE / "publish_r2.sh").read_text()
        self.assertNotIn("rclone delete", text)
        self.assertNotIn("rclone sync", text)

    def test_continent_codes_match_build_releases(self):
        import re
        codes = re.search(r"CONTINENT_CODES = \[(.*?)\]", (HERE / "build_releases.py").read_text()).group(1)
        script = (HERE / "publish_r2.sh").read_text()
        self.assertIn("CODES = [%s]" % codes, script)

    # ── rollback ────────────────────────────────────────────────────────────
    STAMP = "20260101T000000Z"

    def seed_rollback(self):
        self.put(f"prev/{self.STAMP}/data/layers/lines.pmtiles", "prev archive")
        self.put(f"prev/{self.STAMP}/data/layers/manifest.json", "prev manifest")
        self.put(f"prev/{self.STAMP}/data/analysis/index.json", "prev index")
        self.put("data/layers/lines.pmtiles", "cur archive")
        self.put("data/layers/manifest.json", "cur manifest")
        self.put("data/analysis/index.json", "cur index")
        self.put("data/layers/only_now.pmtiles", "new file")
        self.put("data/analysis/columns/keep.0a0a0a0a.parquet", "immutable")

    def test_rollback_needs_an_explicit_stamp(self):
        self.seed_rollback()
        for args in (("--rollback",), ("--rollback", "newest"), ("--rollback", "../x")):
            r = self.run_script(*args)
            self.assertEqual(r.returncode, 2, args)
        self.assertEqual(self.calls(), [])

    def test_rollback_unknown_or_empty_stamp_changes_nothing(self):
        self.seed_rollback()
        before = {k: (self.bucket / k).read_bytes() for k in self.bucket_keys()}
        r = self.run_script("--rollback", "20250101T000000Z")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual({k: (self.bucket / k).read_bytes() for k in self.bucket_keys()}, before)

    def test_rollback_saves_current_then_restores_files_before_manifests_with_copy_only(self):
        self.seed_rollback()
        r = self.run_script("--rollback", self.STAMP)
        self.assertEqual(r.returncode, 0, r.stderr)
        rd = lambda k: (self.bucket / k).read_text()
        self.assertEqual(rd("data/layers/lines.pmtiles"), "prev archive")
        self.assertEqual(rd("data/layers/manifest.json"), "prev manifest")
        self.assertEqual(rd("data/analysis/index.json"), "prev index")
        # extras survive: copy never deletes
        self.assertEqual(rd("data/layers/only_now.pmtiles"), "new file")
        self.assertEqual(rd("data/analysis/columns/keep.0a0a0a0a.parquet"), "immutable")
        saved = [k for k in self.bucket_keys() if k.startswith("prev/") and f"/{self.STAMP}/" not in k]
        self.assertEqual(len(saved), 3)
        self.assertTrue(all(k.split("/")[1] != self.STAMP for k in saved))
        by_name = {k.split("/", 2)[2]: rd(k) for k in saved}
        self.assertEqual(by_name, {"data/layers/lines.pmtiles": "cur archive",
                                   "data/layers/manifest.json": "cur manifest",
                                   "data/analysis/index.json": "cur index"})
        calls = self.calls()
        verbs = [c["argv"][0] for c in calls]
        self.assertTrue(set(verbs) <= {"lsf", "copy"}, verbs)
        copies = [c for c in calls if c["argv"][0] == "copy"]
        self.assertEqual(len(copies), 3)
        self.assertRegex(copies[0]["argv"][-1], r"^r2:data-wpptx-org/prev/\d{8}T\d{6}Z$")
        names = [[Path(f).name for f in c["files"]] for c in copies[1:]]
        self.assertEqual(names[0], ["lines.pmtiles"])
        self.assertEqual(sorted(names[1]), ["index.json", "manifest.json"])
        urls = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("https://")]
        self.assertIn("https://data.wpptx.org/data/layers/lines.pmtiles", urls)

    # ── dry-run commands ────────────────────────────────────────────────────
    def test_dry_run_prints_check_and_backup_commands(self):
        r = self.run_script("--dry-run")
        self.assertIn("rclone check", r.stdout)
        self.assertIn("--combined", r.stdout)


if __name__ == "__main__":
    unittest.main()
