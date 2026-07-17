"""Smoke tests for geo_common.py's shared JSON I/O helpers: write_json_atomic
(atomic write, no stray .tmp sibling, json kwargs passthrough) and
read_prev_feed_last_ok (missing/malformed-file fallback contract relied on by
the live-feed carry-forward logic in fetch_nws_alerts.py / fetch_wildfire_live.py).
"""
import glob
import json
import os
import tempfile
import unittest
from pathlib import Path

from geo_common import read_prev_feed_last_ok, write_json_atomic


class TestWriteJsonAtomic(unittest.TestCase):
    def test_writes_parseable_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.json")
            write_json_atomic({"a": 1, "b": [1, 2, 3]}, path)
            with open(path) as f:
                data = json.load(f)
            self.assertEqual(data, {"a": 1, "b": [1, 2, 3]})

    def test_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.json")
            write_json_atomic({"a": 1}, path)
            write_json_atomic({"a": 2}, path)
            with open(path) as f:
                data = json.load(f)
            self.assertEqual(data, {"a": 2})

    def test_no_tmp_sibling_left_behind(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.json")
            write_json_atomic({"a": 1}, path)
            leftovers = glob.glob(os.path.join(tmp, "*.tmp*"))
            self.assertEqual(leftovers, [])

    def test_json_kwargs_passthrough(self):
        # separators is setdefault'd to compact by write_json_atomic itself;
        # an explicit override must still win.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.json")
            write_json_atomic({"a": 1, "b": 2}, path, separators=(", ", ": "), indent=2)
            content = Path(path).read_text()
            self.assertIn("\n", content)  # indent=2 forces newlines
            self.assertEqual(json.loads(content), {"a": 1, "b": 2})

    def test_default_separators_are_compact(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.json")
            write_json_atomic({"a": 1, "b": 2}, path)
            content = Path(path).read_text()
            self.assertNotIn(" ", content)


class TestReadPrevFeedLastOk(unittest.TestCase):
    def test_missing_file_returns_empty_dict(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "does_not_exist.json")
            self.assertEqual(read_prev_feed_last_ok(path), {})

    def test_valid_file_returns_feed_last_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "prev.json")
            payload = {"feed_last_ok": {"eccc": "2026-07-15T12:00:00Z"}}
            with open(path, "w") as f:
                json.dump(payload, f)
            self.assertEqual(
                read_prev_feed_last_ok(path),
                {"eccc": "2026-07-15T12:00:00Z"},
            )

    def test_file_missing_feed_last_ok_key_returns_empty_dict(self):
        # Predates the field entirely -> .get(...) or {} -> {}.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "prev.json")
            with open(path, "w") as f:
                json.dump({"type": "FeatureCollection", "features": []}, f)
            self.assertEqual(read_prev_feed_last_ok(path), {})

    def test_malformed_json_does_not_raise(self):
        # read_prev_feed_last_ok wraps the whole read in a bare `except
        # Exception: return {}`, so a truncated/corrupt file degrades to {}
        # instead of crashing the caller.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "prev.json")
            with open(path, "w") as f:
                f.write("{not valid json")
            self.assertEqual(read_prev_feed_last_ok(path), {})


if __name__ == "__main__":
    unittest.main()
