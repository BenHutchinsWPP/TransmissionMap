"""Tests for route_crossings.py's stdlib core on synthetic data (no data/, no pyarrow/shapely):
the EPSG:5070 projection, WKB decoding, segment crossing/distance, polygon
interval length with a hole and overlap, crossing-point merging, the lng/lat
corridor filter and an end-to-end analyse() over a toy corridor.
"""
import math
import struct
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

from route_crossings import (
    FT, MI, WKB_SKIPPED, Corridor, PARQUET, _read_parquet, Route, albers, analyse, decode_wkb, dedupe_points, format_table,
    in_polygon, interval_length, merge_intervals, project_parts, pt_seg_dist,
    route_coords, seg_intersect, seg_seg_dist,
)


def wkb_point(x, y):
    return struct.pack("<BIdd", 1, 1, x, y)


def wkb_line(pts, big=False):
    h = struct.pack(">BII" if big else "<BII", 0 if big else 1, 2, len(pts))
    return h + b"".join(struct.pack(">dd" if big else "<dd", *p) for p in pts)


def wkb_poly(rings):
    b = struct.pack("<BII", 1, 3, len(rings))
    for r in rings:
        b += struct.pack("<I", len(r)) + b"".join(struct.pack("<dd", *p) for p in r)
    return b


def box(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


class TestProjection(unittest.TestCase):
    def test_known_points(self):
        x, y = albers(-96, 37.5)
        self.assertAlmostEqual(x, 0, places=3)
        self.assertAlmostEqual(y, 1606786.26, places=0)
        x, y = albers(-116.2, 43.62)  # Boise, same as the route cube's grid.ts
        self.assertAlmostEqual(x, -1611105.9, delta=1)
        self.assertAlmostEqual(y, 2463801.9, delta=1)

    def test_scale(self):
        # 1 degree of longitude at 40N is 85.39 km on the ground; the Albers scale there is 0.991
        self.assertAlmostEqual(math.dist(albers(-100, 40), albers(-99, 40)) / 85390, 0.991, delta=0.003)


class TestWkb(unittest.TestCase):
    def test_point_line_poly_multi(self):
        self.assertEqual(decode_wkb(wkb_point(1.5, 2.5)), ("point", [(1.5, 2.5)]))
        self.assertEqual(decode_wkb(wkb_line([(0, 0), (1, 1)])), ("line", [[(0, 0), (1, 1)]]))
        self.assertEqual(decode_wkb(wkb_line([(0, 0), (1, 1)], big=True)), ("line", [[(0, 0), (1, 1)]]))
        k, parts = decode_wkb(wkb_poly([box(0, 0, 2, 2), box(.5, .5, 1, 1)]))
        self.assertEqual((k, len(parts), len(parts[0])), ("poly", 1, 2))
        multi = struct.pack("<BII", 1, 5, 2) + wkb_line([(0, 0), (1, 0)]) + wkb_line([(2, 2), (3, 3)])
        k, parts = decode_wkb(multi)
        self.assertEqual((k, len(parts)), ("line", 2))


class TestSkips(unittest.TestCase):
    def test_geometry_collection_is_skipped_and_counted(self):
        gc = struct.pack("<BII", 1, 7, 1) + wkb_point(1, 2)
        before = WKB_SKIPPED["collections"]
        self.assertEqual(decode_wkb(gc), ("none", []))
        self.assertEqual(WKB_SKIPPED["collections"], before + 1)

    def test_parquet_file_with_no_row_groups(self):
        class PF:
            def __init__(self, path):
                self.schema_arrow = types.SimpleNamespace(names=["geometry"])
                self.metadata = types.SimpleNamespace(num_row_groups=0)
        pq = types.SimpleNamespace(ParquetFile=PF)
        pa = types.ModuleType("pyarrow")
        pa.parquet = pq
        with mock.patch.dict(sys.modules, {"pyarrow": pa, "pyarrow.parquet": pq}):
            self.assertEqual(_read_parquet("tribal", [(-110.0, 40.0), (-109.0, 40.5)]), ([], 0.0))

    def test_wsr_and_trails_read_from_parquet(self):
        import route_crossings
        self.assertFalse(hasattr(route_crossings, "GEOJSON"))
        self.assertEqual(PARQUET["wsr"][:2], (["wsr"], ["wsr_river_name", "agency"]))
        self.assertEqual(PARQUET["nht_nst"][:2], (["nht_nst"], ["trail"]))
        self.assertEqual(PARQUET["wsr"][2:], PARQUET["nht_nst"][2:])

    def test_empty_wsr_parquet(self):
        class PF:
            def __init__(self, path):
                self.schema_arrow = types.SimpleNamespace(names=["geometry"])
                self.metadata = types.SimpleNamespace(num_row_groups=0)
        pq = types.SimpleNamespace(ParquetFile=PF)
        pa = types.ModuleType("pyarrow")
        pa.parquet = pq
        with mock.patch.dict(sys.modules, {"pyarrow": pa, "pyarrow.parquet": pq}):
            self.assertEqual(_read_parquet("wsr", [(-110.0, 40.0), (-109.0, 40.5)]), ([], 0.0))


class TestReportBuilder(unittest.TestCase):
    def test_every_layer_has_a_source(self):
        import ast
        tree = ast.parse((Path(__file__).parent / "build_route_report_data.py").read_text())
        keys = {}
        for n in tree.body:
            if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name) and n.targets[0].id in ("LAYERS", "SOURCES"):
                keys[n.targets[0].id] = {k.value for k in n.value.keys}
        self.assertTrue({"wsr", "nht_nst"} <= keys["LAYERS"])
        self.assertEqual(keys["LAYERS"] - keys["SOURCES"], set())


class TestPlane(unittest.TestCase):
    def test_intersect_and_distance(self):
        self.assertEqual(seg_intersect((0, 0), (2, 2), (0, 2), (2, 0)), (0.5, 0.5))
        self.assertIsNone(seg_intersect((0, 0), (1, 0), (0, 1), (1, 1)))
        self.assertIsNone(seg_intersect((0, 0), (1, 0), (2, -1), (2, 1)))
        self.assertAlmostEqual(pt_seg_dist((1, 1), (0, 0), (2, 0)), 1)
        self.assertAlmostEqual(pt_seg_dist((5, 0), (0, 0), (2, 0)), 3)
        self.assertAlmostEqual(seg_seg_dist((0, 0), (1, 0), (0, 3), (1, 3)), 3)
        self.assertEqual(seg_seg_dist((0, 0), (2, 2), (0, 2), (2, 0)), 0.0)

    def test_polygon_hole(self):
        rings = [box(0, 0, 10, 10), box(4, 4, 6, 6)]
        self.assertTrue(in_polygon((1, 1), rings))
        self.assertFalse(in_polygon((5, 5), rings))
        self.assertFalse(in_polygon((11, 5), rings))

    def test_intervals_and_dedupe(self):
        self.assertEqual(merge_intervals([(5, 8), (0, 2), (1, 3)]), [[0, 3], [5, 8]])
        self.assertEqual(interval_length([(5, 8), (0, 2), (1, 3)]), 6)
        pts = [(10, 0, 0), (10.5, 30, 0), (900, 900, 0)]
        self.assertEqual(len(dedupe_points(pts, 100)), 2)


# a route of two straight (in EPSG:5070) one-degree legs east along 40N, in lng/lat; U = one leg in metres
# (Albers metres run up to ~1 % under ground distance in mid-latitudes, so the expectations use U, not 85 km)
ROUTE = [(-112.0, 40.0), (-111.0, 40.0), (-110.0, 40.0)]
U = math.dist(albers(-112, 40), albers(-111, 40))


def xy_line(lonlat):
    return project_parts("line", [lonlat])


class TestRoute(unittest.TestCase):
    def setUp(self):
        self.r = Route(ROUTE)

    def test_length(self):
        self.assertAlmostEqual(self.r.length_m, 2 * U, delta=0.01 * U)

    def test_line_hits_crossing_and_near(self):
        n_s = xy_line([(-111.5, 39.9), (-111.5, 40.1)])
        cross, d = self.r.line_hits(n_s)
        self.assertEqual((len(cross), d), (1, 0.0))
        self.assertAlmostEqual(cross[0][0], 0.5 * U, delta=0.01 * U)
        # a parallel line 600 m north: no crossing, within 2,500 ft only when asked for
        (ax, ay), (bx, by) = self.r.xy[:2]   # a line 600 m beside the first leg, then 5 km beside it
        L = math.hypot(bx - ax, by - ay)
        nx, ny = -(by - ay) / L, (bx - ax) / L
        def beside(off):
            return [[(ax + nx * off + (bx - ax) * f, ay + ny * off + (by - ay) * f) for f in (0.3, 0.6)]]
        self.assertEqual(self.r.line_hits(beside(600)), ([], None))
        cross, d = self.r.line_hits(beside(600), 2500 * FT)
        self.assertEqual(cross, [])
        self.assertAlmostEqual(d, 600, delta=1)
        self.assertEqual(self.r.line_hits(beside(5000), 2500 * FT), ([], None))

    def test_point_dist(self):
        p = albers(-111.5, 40.02)
        self.assertAlmostEqual(self.r.point_dist(p) / 1000, 2.22, delta=0.15)   # 0.02 deg of latitude, chord vs parallel

    def test_inside_with_hole_and_overlap(self):
        outer = project_parts("poly", [[[(-111.8, 39.9), (-111.2, 39.9), (-111.2, 40.1), (-111.8, 40.1), (-111.8, 39.9)]]])[0]
        full = interval_length(self.r.inside_intervals(outer))
        self.assertAlmostEqual(full, 0.6 * U, delta=0.01 * U)
        hole = project_parts("poly", [[[(-111.8, 39.9), (-111.2, 39.9), (-111.2, 40.1), (-111.8, 40.1), (-111.8, 39.9)],
                                       [(-111.6, 39.95), (-111.4, 39.95), (-111.4, 40.05), (-111.6, 40.05), (-111.6, 39.95)]]])[0]
        self.assertAlmostEqual(interval_length(self.r.inside_intervals(hole)), 0.4 * U, delta=0.01 * U)
        away = project_parts("poly", [[box(-105, 30, -104, 31)]])[0]
        self.assertEqual(self.r.inside_intervals(away), [])
        # overlapping polygons of one category union, not add
        iv = self.r.inside_intervals(outer) + self.r.inside_intervals(outer)
        self.assertAlmostEqual(interval_length(iv), full, delta=1)


class TestCorridor(unittest.TestCase):
    def test_hits(self):
        c = Corridor(ROUTE, 2000)
        self.assertTrue(c.hits(-111.6, 39.99, -111.5, 40.01))
        self.assertTrue(c.hits(-111.5, 40.015, -111.5, 40.016))   # 1.7 km north: inside the margin
        self.assertFalse(c.hits(-111.5, 40.05, -111.4, 40.06))    # 5.5 km north
        self.assertTrue(c.hits(-120, 30, -100, 50))               # huge bbox, scan path
        self.assertFalse(c.hits(-100, 30, -99, 31))


class TestAnalyse(unittest.TestCase):
    def feats(self):
        def f(kind, parts, **props):
            return {"geom": project_parts(kind, parts), "props": props}
        ns = lambda lon: [[(lon, 39.9), (lon, 40.1)]]
        return {
            "airports": [f("point", [(-111.5, 40.04)], IDENT="ABC", NAME="Near", TYPE_CODE="AD", STATE="UT", PRIVATEUSE=0),   # ~4.4 km = 14,500 ft
                         f("point", [(-111.5, 40.0125)], IDENT="XYZ", NAME="Close", TYPE_CODE="AD", STATE="UT", PRIVATEUSE=1),  # 1.4 km = 4,560 ft
                         f("point", [(-111.5, 41.0)], IDENT="FAR", NAME="Far")],
            "wsr": [f("line", ns(-111.7), wsr_river_name="Test Wild River", agency="USFS")],
            "nht_nst": [f("line", [[(-111.3, 40.0054), (-111.2, 40.0054)]], trail="Test Trail NHT")],
            "pipelines": [f("line", ns(-111.6), name="Big Gas", pipe_type="Interstate", _src="hifld")],
            "roads": [f("line", ns(-111.5), name="Main St", ref="US 1", highway="primary"),
                      f("line", ns(-111.5), name="Main St", ref="US 1", highway="primary"),   # same point from a second row: one crossing
                      f("line", ns(-111.4), highway="motorway")],
            "rivers": [f("line", ns(-111.9), name="Test River")],
            "rail": [f("line", ns(-111.1), RROWNER1="UP", TRACKS=2)],
            "lines": [f("line", ns(-111.2), kv=345, operator="PacifiCorp", _src="osm")],
            "padus": [f("poly", [[box(-111.8, 39.9, -111.2, 40.1)]], mng_agency="BLM", gap="3"),
                      f("poly", [[box(-111.5, 39.9, -111.0, 40.1)]], mng_agency="BLM", gap="3"),   # overlaps the first
                      f("poly", [[box(-110.9, 39.9, -110.5, 40.1)]], mng_agency="NPS", gap="1")],
            "tribal": [],
        }

    def test_report(self):
        rep = analyse(ROUTE, self.feats())
        s = rep["sections"]
        self.assertAlmostEqual(rep["route"]["length_mi"], 2 * U / MI, delta=1.0)
        self.assertEqual([r["item"] for r in s["airports"]["rows"]], ["XYZ Close", "ABC Near"])
        self.assertIn("within 5,000 ft", s["airports"]["rows"][0]["detail"])
        self.assertIn("private", s["airports"]["rows"][0]["detail"])
        self.assertIn("within 20,000 ft", s["airports"]["rows"][1]["detail"])
        self.assertEqual([(r["item"], r["count"]) for r in s["wsr"]["rows"]], [("Test Wild River", 1)])
        trail = s["nht_nst"]["rows"][0]
        self.assertEqual((trail["item"], trail["count"]), ("Test Trail NHT", 0))
        self.assertTrue(0 < trail["value"] <= 2500)   # near, not crossed
        self.assertEqual(s["pipelines"]["rows"][0]["count"], 1)
        roads = {r["item"]: r["count"] for r in s["roads"]["rows"]}
        self.assertEqual(roads, {"Main St (US 1)": 1, "(unnamed)": 1})
        self.assertEqual(s["rivers"]["rows"][0]["item"], "Test River")
        self.assertEqual(s["rail"]["rows"][0]["item"], "UP")
        self.assertEqual(s["lines"]["rows"][0]["item"], "osm 345 kV PacifiCorp")
        pad = {r["item"]: r["value"] for r in s["padus"]["rows"]}
        self.assertAlmostEqual(pad["BLM / GAP 3"], 0.8 * U / MI, delta=0.8)   # -111.8 .. -111.0, union
        self.assertAlmostEqual(pad["NPS / GAP 1"], 0.4 * U / MI, delta=0.8)
        self.assertEqual(s["tribal"], {"status": "ok", "rows": []})
        self.assertEqual(s["crithab"]["status"], "not checked")
        self.assertEqual(s["coastal_zone"]["status"], "not checked")
        self.assertEqual(s["nrhp"]["status"], "not checked")
        self.assertIn("[padus]", format_table(rep))

    def test_route_coords(self):
        ls = {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}
        self.assertEqual(route_coords({"type": "Feature", "geometry": ls}), ls["coordinates"])
        self.assertEqual(route_coords({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": ls}]}), ls["coordinates"])
        with self.assertRaises(ValueError):
            route_coords({"type": "Point", "coordinates": [0, 0]})


if __name__ == "__main__":
    unittest.main()
