#!/usr/bin/env python3
"""Tests for extract_regions.py's control-area id: the HIFLD ID as a string,
a null or repeated ID refused. No data/ needed; skips without geopandas."""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

_HAS_GEO = all(importlib.util.find_spec(m) for m in ("shapely", "geopandas"))


@unittest.skipUnless(_HAS_GEO, "geopandas and shapely are not installed")
class TestControlAreaIds(unittest.TestCase):
    def build(self, ids):
        import geopandas as gpd
        from shapely.geometry import box
        import extract_regions as R
        n = len(ids)
        src = gpd.GeoDataFrame({
            "ID": ids, "NAME": [f"BA {i}" for i in range(n)], "STATE": ["TX"] * n,
            "TOTAL_CAP": [100] * n, "PEAK_LOAD": [50] * n, "MIN_LOAD": [10] * n,
            "AVAIL_CAP": [40] * n, "YEAR": ["2020"] * n, "WEBSITE": ["x"] * n},
            geometry=[box(i, 0, i + 1, 1) for i in range(n)], crs="EPSG:4326")
        with mock.patch.object(R, "_read", return_value=src):
            return R.build_control_areas(Path("unused.parquet"))

    def test_the_id_is_the_hifld_id_as_a_string(self):
        self.assertEqual(self.build(["19547", "5580"])["id"].tolist(), ["19547", "5580"])
        self.assertEqual(self.build([19547.0, 5580.0])["id"].tolist(), ["19547", "5580"])

    def test_a_null_id_is_refused(self):
        with self.assertRaises(ValueError):
            self.build(["19547", None])

    def test_a_repeated_id_is_refused(self):
        with self.assertRaises(ValueError):
            self.build(["19547", "19547"])

    def test_a_blank_id_is_refused(self):
        with self.assertRaises(ValueError):
            self.build(["19547", "   "])

    def test_ids_equal_after_strip_are_refused(self):
        with self.assertRaises(ValueError):
            self.build(["19547", " 19547 "])


if __name__ == "__main__":
    unittest.main()
