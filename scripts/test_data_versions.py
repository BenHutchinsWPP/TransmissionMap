"""data_versions.py: token, rebuild in full, keep, rollback, no write without --write.
Stdlib only (runs under python3 -S)."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("data_versions.py")


def run(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)


class DataVersions(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.table = self.tmp / "t.json"
        self.a = self.tmp / "a.bin"
        self.b = self.tmp / "b.bin"
        self.a.write_bytes(b"alpha")
        self.b.write_bytes(b"beta")
        self.files = self.tmp / "files.txt"

    def listing(self, *paths):
        self.files.write_text("".join(f"{p}\n" for p in paths))

    def test_token_is_sha256_prefix_sorted_and_written(self):
        self.listing(self.b, self.a)
        r = run("publish", "--files", str(self.files), "--table", str(self.table), "--write")
        self.assertEqual(r.returncode, 0, r.stderr)
        t = json.loads(self.table.read_text())
        self.assertEqual(t[str(self.a)], hashlib.sha256(b"alpha").hexdigest()[:10])
        self.assertEqual(list(t), sorted(t))
        self.assertTrue(self.table.read_text().endswith("}\n"))

    def test_changed_bytes_change_only_that_token(self):
        self.listing(self.a, self.b)
        args = ("publish", "--files", str(self.files), "--table", str(self.table), "--write")
        run(*args)
        before = json.loads(self.table.read_text())
        self.b.write_bytes(b"beta2")
        run(*args)
        after = json.loads(self.table.read_text())
        self.assertEqual(after[str(self.a)], before[str(self.a)])
        self.assertNotEqual(after[str(self.b)], before[str(self.b)])

    def test_no_write_without_flag(self):
        self.table.write_text("{}\n")
        self.listing(self.a)
        r = run("publish", "--files", str(self.files), "--table", str(self.table))
        self.assertIn("not written", r.stdout)
        self.assertEqual(self.table.read_text(), "{}\n")

    def test_immutable_names_get_no_entry_and_dead_paths_drop(self):
        self.table.write_text(json.dumps({"gone": "0123456789"}))
        imm = self.tmp / "x.0123abcd.parquet"
        imm.write_bytes(b"p")
        self.listing(imm, self.a)
        run("publish", "--files", str(self.files), "--table", str(self.table), "--write")
        t = json.loads(self.table.read_text())
        self.assertEqual(list(t), [str(self.a)])

    def test_keep_carries_a_skipped_entry(self):
        self.table.write_text(json.dumps({"data/layers/skipped.json": "0123456789"}))
        keep = self.tmp / "keep.txt"
        keep.write_text("data/layers/skipped.json\n")
        self.listing(self.a)
        run("publish", "--files", str(self.files), "--table", str(self.table), "--keep", str(keep), "--write")
        self.assertEqual(json.loads(self.table.read_text())["data/layers/skipped.json"], "0123456789")

    def test_rollback_sets_stamp_token_on_restored_only(self):
        self.table.write_text(json.dumps({"data/layers/a.json": "aaaaaaaaaa", "data/layers/b.json": "bbbbbbbbbb"}))
        self.listing("data/layers/a.json", "data/layers/c.0123abcd.parquet")
        r = run("rollback", "--files", str(self.files), "--table", str(self.table),
                "--stamp", "20261114T120000Z", "--write")
        self.assertEqual(r.returncode, 0, r.stderr)
        t = json.loads(self.table.read_text())
        self.assertEqual(t, {"data/layers/a.json": "r20261114T120000Z", "data/layers/b.json": "bbbbbbbbbb"})

    def test_rollback_needs_a_stamp(self):
        self.listing("data/layers/a.json")
        self.assertEqual(run("rollback", "--files", str(self.files), "--table", str(self.table)).returncode, 2)


if __name__ == "__main__":
    unittest.main()
