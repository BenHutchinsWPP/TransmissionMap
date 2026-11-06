#!/usr/bin/env python3
"""Tests for extract_padus.py's content id: hashed from the source-CRS frame, so
the output projection cannot move it, and missing attributes hash the same
whatever pandas uses for them. No data/ or network needed; skips without
geopandas/pyogrio."""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

_HAS_GEO = all(importlib.util.find_spec(m) for m in ("shapely", "geopandas", "pyogrio"))
ALBERS = "ESRI:102039"


@unittest.skipUnless(_HAS_GEO, "geopandas, shapely and pyogrio are not installed")
class TestContentKey(unittest.TestCase):
    def setUp(self):
        import geopandas as gpd
        from shapely.geometry import box
        import extract_padus as P
        self.P, self.gpd = P, gpd
        row = {c: "x" for c in P.ID_COLS}
        row.update(GIS_Acres=12.5, Source_PAID=None, Mang_Type="FED", Own_Type="FED",
                   Pub_Access="OA", Date_Est="1990", Des_Tp="NP", Mang_Name="NPS", Own_Name="NPS")
        self.src = gpd.GeoDataFrame([row, {**row, "Unit_Nm": "y"}],
                                    geometry=[box(-1e6, 1.5e6, -0.9e6, 1.6e6),
                                              box(0, 2e6, 1e3, 2.001e6)], crs=ALBERS)

    def extract_with(self, out_crs):
        real = self.gpd.GeoDataFrame.to_crs
        with mock.patch.object(self.P.pyogrio, "read_dataframe", return_value=self.src.copy()), \
             mock.patch.object(self.gpd.GeoDataFrame, "to_crs",
                               lambda self_, crs=None, **kw: real(self_, out_crs)):
            return self.P._extract("PADUS4_1Fee", "", {k: {} for k in ("agency", "atype", "desig", "access")}, "fee")

    def test_key_does_not_depend_on_the_output_projection(self):
        a = self.extract_with("EPSG:4326")["key"].tolist()
        b = self.extract_with("EPSG:3857")["key"].tolist()
        self.assertEqual(a, b)
        self.assertEqual(a, self.P._content_key("fee", self.src).tolist())
        self.assertEqual(len(set(a)), 2)

    def test_bounds_hash_on_a_1_m_grid(self):
        moved = self.src.copy()
        moved["geometry"] = moved.translate(0.3, -0.2)
        self.assertEqual(self.P._content_key("fee", moved).tolist(),
                         self.P._content_key("fee", self.src).tolist())

    def test_missing_attributes_hash_alike(self):
        import numpy as np
        a, b = self.src.copy(), self.src.copy()
        a["Source_PAID"], b["Source_PAID"] = None, np.nan
        self.assertEqual(self.P._content_key("fee", a).tolist(), self.P._content_key("fee", b).tolist())


if __name__ == "__main__":
    unittest.main()
