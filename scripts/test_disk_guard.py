"""Tests for scripts/disk_guard.py (stdlib only; shutil.disk_usage is mocked)."""

import os
import subprocess
import sys
import tempfile
import unittest
from collections import namedtuple
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import disk_guard  # noqa: E402

GIB = 2**30
Usage = namedtuple("Usage", "total used free")
GUARD = os.path.join(HERE, "disk_guard.py")


def fake_usage(free):
    return lambda path: Usage(total=100 * GIB, used=0, free=free)


class RequireFreeTest(unittest.TestCase):
    def test_allowed_when_plenty_free(self):
        with mock.patch("shutil.disk_usage", fake_usage(50 * GIB)):
            disk_guard.require_free(tempfile.gettempdir(), 5 * GIB)

    def test_refused_below_floor(self):
        with mock.patch("shutil.disk_usage", fake_usage(14 * GIB)):
            with self.assertRaises(SystemExit) as cm:
                disk_guard.require_free(tempfile.gettempdir(), 5 * GIB)
        msg = str(cm.exception)
        self.assertIn("free 14.00 GiB", msg)
        self.assertIn("need 5.00 GiB", msg)
        self.assertIn("floor 10.00 GiB", msg)

    def test_exactly_at_floor_is_allowed(self):
        with mock.patch("shutil.disk_usage", fake_usage(15 * GIB)):
            disk_guard.require_free(tempfile.gettempdir(), 5 * GIB)

    def test_one_byte_under_floor_is_refused(self):
        with mock.patch("shutil.disk_usage", fake_usage(15 * GIB - 1)):
            with self.assertRaises(SystemExit):
                disk_guard.require_free(tempfile.gettempdir(), 5 * GIB)

    def test_missing_dir_uses_nearest_existing_parent(self):
        base = tempfile.mkdtemp()
        missing = os.path.join(base, "a", "b", "c")
        seen = []

        def usage(path):
            seen.append(path)
            return Usage(total=100 * GIB, used=0, free=50 * GIB)

        with mock.patch("shutil.disk_usage", usage):
            disk_guard.require_free(missing, GIB)
        self.assertEqual(seen, [base])

    def test_custom_floor(self):
        with mock.patch("shutil.disk_usage", fake_usage(11 * GIB + GIB // 2)):
            disk_guard.require_free(tempfile.gettempdir(), GIB, floor=10 * GIB)
            with self.assertRaises(SystemExit):
                disk_guard.require_free(tempfile.gettempdir(), GIB, floor=11 * GIB)


class CliTest(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-S", GUARD, *args],
            capture_output=True, text=True,
            env={"PATH": os.environ.get("PATH", "")},
        )

    def test_cli_exit_codes(self):
        tmp = tempfile.gettempdir()
        # Real free space is unknown here, so the floor is set so the outcome is
        # decided by the requested need alone: a 0 GiB floor with a huge need refuses.
        ok = self.run_cli(tmp, "0", "--floor-gib", "0")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        bad = self.run_cli(tmp, str(2**62), "--floor-gib", "0")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("disk_guard: refused", bad.stderr)


if __name__ == "__main__":
    unittest.main()
