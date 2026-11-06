#!/usr/bin/env python3
"""Tests for toolchain.py: the tippecanoe version floor. Stdlib only."""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import toolchain  # noqa: E402


class TestTippecanoeFloor(unittest.TestCase):
    def test_parse_version(self):
        self.assertEqual(toolchain.parse_version("tippecanoe v2.79.0\n"), (2, 79, 0))
        self.assertEqual(toolchain.parse_version("tippecanoe 1.36.0"), (1, 36, 0))
        self.assertIsNone(toolchain.parse_version("usage: tippecanoe ..."))

    def problem(self, path, version):
        with mock.patch.object(toolchain, "tippecanoe_version", return_value=(path, version)):
            return toolchain.tippecanoe_problem()

    def test_the_floor_is_2_55_0(self):
        self.assertIsNone(self.problem("/usr/local/bin/tippecanoe", (2, 55, 0)))
        self.assertIsNone(self.problem("/usr/local/bin/tippecanoe", (2, 79, 0)))
        self.assertIn("v2.53.0", self.problem("/usr/bin/tippecanoe", (2, 53, 0)))
        self.assertIn("/usr/bin/tippecanoe", self.problem("/usr/bin/tippecanoe", (2, 53, 0)))
        self.assertIn("not found", self.problem(None, None))
        self.assertIn("could not read", self.problem("/x/tippecanoe", None))

    def test_require_exits_below_the_floor(self):
        with mock.patch.object(toolchain, "tippecanoe_version",
                               return_value=("/usr/bin/tippecanoe", (2, 53, 0))):
            with self.assertRaises(SystemExit):
                toolchain.require_tippecanoe()


if __name__ == "__main__":
    unittest.main()
