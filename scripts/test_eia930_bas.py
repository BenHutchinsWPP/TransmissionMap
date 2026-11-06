"""Checks the committed Grid Operations BA table (src/registry/eia930-bas.json,
written by build_eia930_bas.py): one row per code, every row placed, and the
PUDL pin equal across the script, the table and assets/constants.ts. Stdlib
only; reads no data/.

    python3 -m unittest scripts/test_eia930_bas.py
"""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABLE = json.loads((ROOT / "src" / "registry" / "eia930-bas.json").read_text())
SCRIPT = (ROOT / "scripts" / "build_eia930_bas.py").read_text()
CONSTANTS = (ROOT / "assets" / "constants.ts").read_text()


class Eia930Bas(unittest.TestCase):
    def test_pudl_pin_matches(self):
        script = re.search(r'^PUDL_VERSION = "(.+?)"', SCRIPT, re.M).group(1)
        app = re.search(r'export const PUDL_VERSION = "(.+?)"', CONSTANTS).group(1)
        self.assertEqual(script, app)
        self.assertEqual(TABLE["pudl_version"], app)

    def test_rows(self):
        codes = [b["code"] for b in TABLE["bas"]]
        self.assertEqual(len(codes), len(set(codes)))
        self.assertEqual(codes, sorted(codes))
        for b in TABLE["bas"]:
            self.assertRegex(b["code"], r"^[A-Z]{2,5}$")
            self.assertTrue(b["name"])
            self.assertTrue(-170 < b["lon"] < -50 and 14 < b["lat"] < 72, b["code"])
            self.assertEqual(len(b["anchor"]), 2)


if __name__ == "__main__":
    unittest.main()
