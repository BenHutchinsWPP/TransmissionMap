#!/usr/bin/env python3
"""Tests for westtec_ogf.py: the WestTEC content id (stable under reversal,
part order and coordinate rounding; distinct across features), the overlap
matcher on synthetic lines, and the committed crosswalk table. No data/ or
network needed; the geometry tests skip without shapely/geopandas."""
import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import westtec_ogf as X  # noqa: E402

_HAS_GEO = all(importlib.util.find_spec(m) for m in ("shapely", "geopandas"))


@unittest.skipUnless(_HAS_GEO, "shapely and geopandas are not installed")
class TestFid(unittest.TestCase):
    def setUp(self):
        from shapely.geometry import LineString, MultiLineString
        self.LineString, self.MultiLineString = LineString, MultiLineString
        self.line = LineString([(-117.12345, 36.5), (-116.8, 36.71), (-116.4012, 36.9)])
        self.attrs = ("planned", "Base Case", "Example 500 kV", 500.0, "New Line")

    def fid(self, geom, **kw):
        a = dict(zip(("dataset", "scenario", "name", "voltage_kv", "upgrade_type"), self.attrs)) | kw
        return X.westtec_fid(geom=geom, **a)

    def test_same_under_reversal_rounding_and_part_order(self):
        import shapely
        base = self.fid(self.line)
        self.assertRegex(base, r"^[0-9a-f]{12}$")
        self.assertEqual(self.fid(shapely.reverse(self.line)), base)
        for dp in (5, 6):
            self.assertEqual(self.fid(shapely.transform(self.line, lambda c, dp=dp: c.round(dp))), base)
        a, b = self.LineString([(0.1, 0.1), (0.5, 0.5)]), self.LineString([(1.1, 1.1), (2.5, 2.5)])
        self.assertEqual(self.fid(self.MultiLineString([a, b])),
                         self.fid(self.MultiLineString([shapely.reverse(b), a])))
        self.assertEqual(self.fid(self.line, name="  Example 500 kV "), base)
        self.assertEqual(self.fid(self.line, voltage_kv=500), base)

    def test_differs_on_any_content_field(self):
        base = self.fid(self.line)
        for kw in ({"name": "Other"}, {"scenario": "SRA"}, {"dataset": "identified"},
                   {"voltage_kv": 345.0}, {"upgrade_type": "Rebuild"}):
            self.assertNotEqual(self.fid(self.line, **kw), base, kw)
        self.assertNotEqual(self.fid(self.LineString([(-117.12345, 36.5), (-116.0, 36.9)])), base)


@unittest.skipUnless(_HAS_GEO, "shapely and geopandas are not installed")
class TestMatcher(unittest.TestCase):
    def frames(self, ogf_rows):
        import geopandas as gpd
        from shapely.geometry import LineString
        w = gpd.GeoDataFrame({"fid": ["w1"], "scenario": ["SRA"], "voltage_kv": [500.0]},
                             geometry=[LineString([(0, 0), (10_000, 0)])], crs=5070)
        o = gpd.GeoDataFrame(
            {"RecordID": [r[0] for r in ogf_rows], "PlanProc": [r[1] for r in ogf_rows],
             "MinVolt": [r[2] for r in ogf_rows], "MaxVolt": [r[2] for r in ogf_rows]},
            geometry=[LineString(r[3]) for r in ogf_rows], crs=5070)
        return w, o

    def test_overlap_fractions(self):
        from shapely.geometry import LineString
        seg, longer = LineString([(0, 0), (10_000, 0)]), LineString([(0, 100), (40_000, 100)])
        fw, fo = X.overlap(seg, longer)
        self.assertAlmostEqual(fw, 1.0)
        self.assertAlmostEqual(fo, 0.25, places=1)
        self.assertEqual(X.overlap(seg, LineString([(0, 2_000), (10_000, 2_000)])), (0.0, 0.0))

    def test_propose_needs_scenario_voltage_and_overlap(self):
        plan = "WestTEC 10 Yr Plan (SRA)"
        w, o = self.frames([
            ("R-1", plan, 500, [(0, 200), (10_000, 200)]),               # same line, offset 200 m
            ("R-2", plan, 500, [(0, 0), (40_000, 0)]),                   # longer project: fw = 1
            ("R-3", "WestTEC 10 Yr Plan (IDA)", 500, [(0, 0), (10_000, 0)]),  # other scenario
            ("R-4", plan, 345, [(0, 0), (10_000, 0)]),                   # other voltage
            ("R-5", plan, 500, [(0, 0), (3_000, 0), (3_000, 30_000)]),   # shares 30 % only
            ("R-6", plan, 500, [(0, 3_000), (10_000, 3_000)]),           # parallel, 3 km away
        ])
        self.assertEqual([h[0] for h in X.propose(w, o)["w1"]], ["R-1", "R-2"])

    def test_ogf_scenario(self):
        self.assertEqual(X.ogf_scenario("WestTEC 10 Yr Plan (Base Case)"), "Base Case")
        self.assertIsNone(X.ogf_scenario("CAISO TPP"))
        self.assertIsNone(X.ogf_scenario(None))


class TestTable(unittest.TestCase):
    def test_ogf_ids_ship_only_reviewed_rows(self):
        rows = [
            {"westtec_fid": "a", "ogf_record_ids": "R-1|R-2", "status": "auto"},
            {"westtec_fid": "b", "ogf_record_ids": "R-3", "status": "review"},
            {"westtec_fid": "c", "ogf_record_ids": "R-4", "status": "confirmed"},
            {"westtec_fid": "d", "ogf_record_ids": "", "status": "none"},
            {"westtec_fid": "f", "ogf_record_ids": "R-6", "status": "none"},
            {"westtec_fid": "", "ogf_record_ids": "R-5", "status": "none"},
        ]
        self.assertEqual(X.ogf_ids(rows), {"a": "|R-1|R-2|", "b": None, "c": "|R-4|", "d": None, "f": None})
        self.assertEqual(X.uncovered(rows, ["a", "b", "c", "e"], ["R-3", "R-5", "R-9"]),
                         (["e"], ["R-9"], ["d", "f"]))

    def test_committed_table_is_well_formed(self):
        rows = X.read_table()
        fids = [r["westtec_fid"] for r in rows if r["westtec_fid"]]
        self.assertEqual(len(fids), len(set(fids)), "a fid has two rows")
        self.assertEqual(list(rows[0]), X.COLUMNS)
        for r in rows:
            self.assertTrue(all(i.startswith("R-") for i in X.record_ids(r["ogf_record_ids"])), r)
            if not r["westtec_fid"]:
                self.assertEqual(r["status"], "none", r)
            if r["status"] in ("auto", "confirmed"):
                self.assertTrue(r["ogf_record_ids"], r)
            elif r["westtec_fid"]:
                self.assertFalse(r["ogf_record_ids"] and r["status"] == "none", r)


if __name__ == "__main__":
    unittest.main()
