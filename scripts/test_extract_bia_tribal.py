#!/usr/bin/env python3
"""Tests for extract_bia_tribal.py's LARID check and column list. No data/ needed."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_bia_tribal as T

_HAS_GEO = all(importlib.util.find_spec(m) for m in ("shapely", "geopandas", "pyogrio"))


class TestCheckLarid(unittest.TestCase):
    def test_unique_passes(self):
        T.check_larid(["LAR0001", "LAR0002"])

    def test_null_refused(self):
        for bad in (None, float("nan"), "", " "):
            with self.assertRaises(ValueError, msg=repr(bad)):
                T.check_larid(["LAR0001", bad])

    def test_duplicate_refused(self):
        with self.assertRaises(ValueError):
            T.check_larid(["LAR0001", "LAR0002", "LAR0001"])


@unittest.skipUnless(_HAS_GEO, "geopandas, shapely and pyogrio are not installed")
class TestBuild(unittest.TestCase):
    def setUp(self):
        self._raw = T.RAW_FILE
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def tearDown(self):
        T.RAW_FILE = self._raw

    def raw(self, ids):
        feats = [{"type": "Feature", "properties": {"LARID": i, "LARNAME": f"n{k}", "AGENCY": "a", "X": 1},
                  "geometry": {"type": "Polygon", "coordinates": [[[k, 0], [k + 1, 0], [k + 1, 1], [k, 0]]]}}
                 for k, i in enumerate(ids)]
        p = Path(self._tmp.name) / "lar.geojson"
        p.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
        return p

    def test_larid_kept(self):
        T.RAW_FILE = self.raw(["LAR0001", "LAR0002"])
        gdf = T.build()
        self.assertEqual(list(gdf.columns), ["LARID", "LARNAME", "AGENCY", "geometry"])
        self.assertEqual(gdf["LARID"].tolist(), ["LAR0001", "LAR0002"])

    def test_duplicate_and_null_exit_nonzero(self):
        for ids in (["LAR0001", "LAR0001"], ["LAR0001", None]):
            T.RAW_FILE = self.raw(ids)
            with self.assertRaises(SystemExit) as cm:
                T.build()
            self.assertNotEqual(cm.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
