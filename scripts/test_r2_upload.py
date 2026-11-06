"""Tests for r2_upload.sh: upload groups, order, keys and refusals (dry run; no rclone, no network)."""
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "r2_upload.sh"


def run(root, *paths, env=None, dry=True):
    cmd = ["bash", str(SCRIPT), "--bucket", "b", "--cache-control", "public, max-age=1", "--root", str(root)]
    if dry:
        cmd.append("--dry-run")
    e = {"PATH": os.environ.get("PATH", "")} if env is None else env
    return subprocess.run(cmd + list(paths), capture_output=True, text=True, env=e)


def tree(root, names):
    for n in names:
        p = Path(root) / n
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x")


class R2Upload(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.root = Path(self._t.name)

    def tearDown(self):
        self._t.cleanup()

    def test_groups_order_and_keys(self):
        names = ["d/a.json", "d/b.geojson", "d/c.gz", "d/e.i16", "d/f.webp", "d/g.png"]
        tree(self.root, names)
        r = run(self.root, "d")
        self.assertEqual(r.returncode, 0, r.stderr)
        groups = re.findall(r"^  \.(\w+): (\d+) files -> (\S+)", r.stdout, re.M)
        self.assertEqual([g[0] for g in groups], ["gz", "i16", "webp", "png", "geojson", "json"])
        self.assertEqual(dict((g[0], g[2]) for g in groups)["geojson"], "application/geo+json")
        self.assertEqual(dict((g[0], g[2]) for g in groups)["gz"], "application/octet-stream")
        self.assertEqual(sorted(re.findall(r"^    key (.+)$", r.stdout, re.M)), sorted(names))
        self.assertIn("nothing uploaded", r.stdout)

    def test_keys_relative_to_root_and_file_path(self):
        tree(self.root, ["one.geojson", "sub/deep/two.json", "other/skip.json"])
        r = run(self.root, "one.geojson", "sub")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(re.findall(r"^    key (.+)$", r.stdout, re.M)),
                         ["one.geojson", "sub/deep/two.json"])

    def test_unknown_extension_refused_with_nothing_planned(self):
        tree(self.root, ["d/a.json", "d/b.txt", "d/c.csv"])
        r = run(self.root, "d")
        self.assertEqual(r.returncode, 1)
        self.assertIn("d/b.txt", r.stderr)
        self.assertIn("d/c.csv", r.stderr)
        self.assertNotIn("files ->", r.stdout)

    def fake_rclone(self):
        """A stand-in rclone first on PATH that leaves a marker when called."""
        bin_dir = self.root / "_bin"
        bin_dir.mkdir()
        marker = self.root / "_rclone_called"
        (bin_dir / "rclone").write_text(f'#!/bin/sh\necho "$@" >> "{marker}"\n')
        (bin_dir / "rclone").chmod(0o755)
        return f"{bin_dir}:{os.environ.get('PATH', '')}", marker

    def test_missing_keys_refused_before_rclone(self):
        tree(self.root, ["a.json"])
        path, marker = self.fake_rclone()
        r = run(self.root, "a.json", env={"PATH": path}, dry=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("R2_ACCOUNT_ID is not set", r.stderr)
        env = {"PATH": path, "R2_ACCOUNT_ID": "acct", "R2_ACCESS_KEY_ID": "k"}
        r = run(self.root, "a.json", env=env, dry=False)
        self.assertIn("R2_SECRET_ACCESS_KEY is not set", r.stderr)
        self.assertNotIn("acct", r.stdout + r.stderr)
        self.assertFalse(marker.exists(), "rclone ran without keys")

    def test_real_run_calls_rclone_in_order_with_headers(self):
        tree(self.root, ["d/m.json", "d/x.webp", "d/y.geojson"])
        path, marker = self.fake_rclone()
        env = {"PATH": path, "R2_ACCOUNT_ID": "acct", "R2_ACCESS_KEY_ID": "k", "R2_SECRET_ACCESS_KEY": "s"}
        r = run(self.root, "d", env=env, dry=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = marker.read_text().splitlines()
        self.assertEqual(len(calls), 3)
        self.assertEqual([re.search(r"Content-Type: (\S+)", c).group(1) for c in calls],
                         ["image/webp", "application/geo+json", "application/json"])
        for c in calls:
            self.assertIn("copy --checksum --files-from", c)
            self.assertIn("Cache-Control: public, max-age=1", c)
            self.assertTrue(c.endswith(" r2:b"), c)
        self.assertNotIn("s", r.stdout.split())

    def test_tmp_files_skipped(self):
        tree(self.root, ["d/a.webp", "d/a.webp.tmp"])
        r = run(self.root, "d")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(re.findall(r"^    key (.+)$", r.stdout, re.M), ["d/a.webp"])
        self.assertIn("skipping d/a.webp.tmp", r.stderr)

    def test_missing_path_refused(self):
        r = run(self.root, "nope")
        self.assertEqual(r.returncode, 1)
        self.assertIn("nope", r.stderr)


if __name__ == "__main__":
    unittest.main()
