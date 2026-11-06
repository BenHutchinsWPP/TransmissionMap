"""Tests for build_line_parquet.py — line geometry as GeoParquet.

The chain tests are stdlib and run under `python3 -S`. The fixture build needs
numpy, pyarrow, shapely, pyogrio and scipy (the venv) and skips without them.

Fixture (OSM-style, lon/lat, along the equator unless noted):

    S=substation polygon around A
    A ──11──▶ B ◀──21── C ──31──▶ D ──41──▶ E ──61(115 kV)──▶ G
                                  │
                                  51 (up) ──▶ F  · substation point 60 m away
    71 far away, alone, no substation

  * 11, 21 (drawn reversed), 31 join into one 230 kV chain: from S to the tap at D
  * D is a tap (three way ends): 31, 41 and 51 stop there
  * E is a voltage change: 41 and 61 stay apart
"""
import importlib.util
import json
import math
import os
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import build_line_parquet as blp

HAVE_STACK = all(importlib.util.find_spec(m) for m in
                 ("numpy", "pyarrow", "shapely", "pyogrio", "scipy"))

# Awkward decimals on purpose: GEO must hold exactly these doubles.
A, B, C, D = [0.000001, -0.000001], [0.010003, 0.0], [0.020007, 0.000001], [0.030011, 0.0]
E, G, F = [0.040013, 0.0], [0.050017, -0.000003], [0.030011, 0.010019]
LINES = [  # fid, kv, circuits, coordinates
    (11, 230.0, 2, [A, [0.005, 0.000002], B]),
    (21, 230.0, 1, [C, [0.015001, 0.000001], B]),      # drawn C → B, against the chain
    (31, 230.0, -1, [C, D]),
    (41, 230.0, 1, [D, E]),
    (51, 230.0, 1, [D, F]),
    (61, 115.0, 1, [E, G]),
    (71, 345.0, 2, [[10.123457, 50.000001], [10.2, 50.3], [10.300001, 50.300002]]),
]
SUB_POLY_FID, SUB_POINT_FID = 9002, 8001


def _sq(x, y, w=0.002):
    return [[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]


BIG_FID = 2**53 + 3     # the Parquet / BigInt side only; real OSM fids are ~1e11
POLYGONS = [  # fid, type, coordinates (1e-6° grid, awkward decimals on purpose)
    (101, "Polygon", [_sq(5.000001, 45.000003)]),
    (102, "MultiPolygon", [[_sq(6.000007, 46.0)], [_sq(6.01, 46.010001)]]),
    (103, "Polygon", [_sq(7.0, 47.0, 0.01), _sq(7.002, 47.002, 0.002)[::-1]]),    # with a hole
    (BIG_FID, "Polygon", [_sq(8.123457, 48.000001)]),
    (105, "Polygon", [_sq(-120.000001, 35.5)]),
]


def write_polygon_input(path):
    with open(path, "w") as f:
        for fid, kind, coords in POLYGONS:
            f.write(_feature({"fid": fid}, coords, kind) + "\n")


def chain_by_ways(chains):
    return {frozenset(w for w, _ in ch): ch for ch in chains}


class TestChainWays(unittest.TestCase):
    #           11    21    31    41    51    61
    a = ["A", "C", "C", "D", "D", "E"]
    b = ["B", "B", "D", "E", "F", "G"]
    kv = [230, 230, 230, 230, 230, 115]

    def _chains(self, stop=frozenset(), order=None):
        return blp.chain_ways(self.a, self.b, self.kv, stop, order)

    def test_joins_through_degree_two_and_flags_the_reversed_way(self):
        chains, _ = self._chains()
        ch = chain_by_ways(chains)[frozenset({0, 1, 2})]
        self.assertIn(ch, ([(0, False), (1, True), (2, False)],
                           [(2, True), (1, False), (0, True)]))

    def test_the_same_chain_whichever_way_seeds_it(self):
        for seed in (0, 1, 2):
            order = [seed] + [i for i in range(6) if i != seed]
            chains, _ = self._chains(order=order)
            self.assertIn(frozenset({0, 1, 2}), chain_by_ways(chains))

    def test_stops_at_a_tap_and_a_voltage_change(self):
        chains, reasons = self._chains()
        self.assertEqual(set(chain_by_ways(chains)),
                         {frozenset({0, 1, 2}), frozenset({3}), frozenset({4}), frozenset({5})})
        self.assertEqual(reasons["branch"], 3)   # the 11-21-31 chain, 41 and 51 at D
        self.assertEqual(reasons["end"], 3)      # A, F, G
        self.assertEqual(reasons["voltage"], 2)  # 41 and 61 at E

    def test_stops_at_a_substation(self):
        chains, reasons = self._chains(stop={"B"})
        self.assertIn(frozenset({0}), chain_by_ways(chains))
        self.assertIn(frozenset({1, 2}), chain_by_ways(chains))
        self.assertEqual(reasons["substation"], 2)

    def test_end_nodes_follow_the_chain_direction(self):
        chains, _ = self._chains(order=[1, 0, 2, 3, 4, 5])
        ch = chain_by_ways(chains)[frozenset({0, 1, 2})]
        ends = blp.chain_end_nodes(ch, self.a, self.b)
        self.assertIn(ends, (("A", "D"), ("D", "A")))

    def test_a_ring_ends_as_a_loop(self):
        chains, reasons = blp.chain_ways(["P", "Q", "R"], ["Q", "R", "P"], [1, 1, 1])
        self.assertEqual(len(chains), 1)
        self.assertEqual(len(chains[0]), 3)
        self.assertGreaterEqual(reasons["loop"], 1)

    def test_a_closed_way_stays_alone(self):
        chains, reasons = blp.chain_ways(["P"], ["P"], [1])
        self.assertEqual(chains, [[(0, False)]])
        self.assertEqual(reasons["loop"], 2)

    def test_gpkg_options_match_the_tile_build(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML not installed")
        doc = yaml.safe_load((Path(blp.__file__).parent / "tile_manifest.yaml").read_text())
        for ds in (blp.HIFLD, blp.NATGAS):
            entry = next(L for L in doc["layers"] if L["id"] == ds)
            self.assertEqual(entry["id_field"], blp.DATASET[ds]["id_field"])
            self.assertIn(f"COORDINATE_PRECISION={entry['precision']}", blp.ogr_options(ds))
            self.assertEqual(blp.ogr_options(ds)[:2], ["-select", entry["id_field"]])


def _feature(props, coords, kind="LineString"):
    return json.dumps({"type": "Feature", "properties": props,
                       "geometry": {"type": kind, "coordinates": coords}})


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestPlantsPolygons(unittest.TestCase):
    def test_plants_polygons_build_as_a_polygon_dataset(self):
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as tmp:
            inp = Path(tmp) / "input"
            inp.mkdir()
            write_polygon_input(inp / f"{blp.PLANTS_POLY}.geojsonl")
            with unittest.mock.patch.object(blp.log, "info"):
                blp.main(["--fixture", tmp, "--only", blp.PLANTS_POLY])
            out = Path(tmp) / "analysis"
            index = json.loads((out / "index.json").read_text())
            self.assertEqual(set(index["datasets"]), {blp.PLANTS_POLY})
            m = index["datasets"][blp.PLANTS_POLY]
            self.assertEqual((m["geometry"], m["rows"]), ("polygon", len(POLYGONS)))
            d = out / blp.PLANTS_POLY
            idx = pq.read_table(d / m["idx"]["name"]).to_pydict()
            geo = pq.read_table(d / m["geo"][0]["name"]).to_pydict()
            self.assertEqual(idx["fid"], sorted(f for f, _, _ in POLYGONS))
            for fid, row in zip(idx["fid"], idx["row"]):
                self.assertEqual(geo["fid"][row], fid)


PIPE_LINES = [(7000000011, [[0, 0], [0.01, 0.0], [0.02, 0.005]], "LineString"),
              (7000000021, [[[1, 1], [1.01, 1.0]], [[1.02, 1.0], [1.03, 1.01]]], "MultiLineString"),
              (7000000031, [[2, 2], [2.0, 2.01]], "LineString")]
NATGAS_LINES = [("ng:12", [[[-95.0, 30.0], [-95.01, 30.01]]], "MultiLineString"),
                ("hgl:7", [[[-96.0, 31.0], [-96.02, 31.0], [-96.02, 31.02]]], "MultiLineString")]


def _build_line_dataset(tmp, ds, rows, fid_type):
    import pyarrow.parquet as pq
    inp = Path(tmp) / "input"
    inp.mkdir()
    with open(inp / f"{ds}.geojsonl", "w") as f:
        for fid, coords, kind in rows:
            f.write(_feature({"fid": fid}, coords, kind) + "\n")
    with unittest.mock.patch.object(blp.log, "info"):
        blp.main(["--fixture", tmp, "--only", ds])
    out = Path(tmp) / "analysis"
    index = json.loads((out / "index.json").read_text())
    m = index["datasets"][ds]
    d = out / ds
    idx = pq.read_table(d / m["idx"]["name"]).to_pydict()
    geo = pq.read_table(d / m["geo"][0]["name"]).to_pydict()
    return index, m, idx, geo


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestPipelinesLines(unittest.TestCase):
    def test_pipelines_build_as_a_line_dataset_without_chains(self):
        with tempfile.TemporaryDirectory() as tmp:
            index, m, idx, geo = _build_line_dataset(tmp, blp.PIPES, PIPE_LINES, "int64")
            self.assertEqual(set(index["datasets"]), {blp.PIPES})
            self.assertEqual((m["geometry"], m["rows"], m["fid_type"]), ("line", len(PIPE_LINES), "int64"))
            self.assertIsNone(m["chains"])
            self.assertIn("length_km", m["idx"]["columns"])
            self.assertNotIn("chain", m["idx"]["columns"])
            self.assertNotIn("circuits", m["idx"]["columns"])
            self.assertGreater(m["total_km"], 0)
            self.assertEqual(m["attribution"], "© OpenStreetMap contributors")
            self.assertEqual(idx["fid"], sorted(f for f, _, _ in PIPE_LINES))
            self.assertTrue(all(k > 0 for k in idx["length_km"]))
            for fid, row in zip(idx["fid"], idx["row"]):
                self.assertEqual(geo["fid"][row], fid)


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestNatgasLines(unittest.TestCase):
    def test_natgas_builds_as_a_line_dataset_with_string_fids(self):
        with tempfile.TemporaryDirectory() as tmp:
            index, m, idx, geo = _build_line_dataset(tmp, blp.NATGAS, NATGAS_LINES, "string")
            self.assertEqual(set(index["datasets"]), {blp.NATGAS})
            self.assertEqual((m["geometry"], m["rows"], m["fid_type"]), ("line", len(NATGAS_LINES), "string"))
            self.assertIsNone(m["chains"])
            self.assertIn("length_km", m["idx"]["columns"])
            self.assertNotIn("chain", m["idx"]["columns"])
            self.assertEqual(idx["fid"], sorted(f for f, _, _ in NATGAS_LINES))
            self.assertTrue(all(k > 0 for k in idx["length_km"]))
            for fid, row in zip(idx["fid"], idx["row"]):
                self.assertEqual(geo["fid"][row], fid)

    def test_natgas_options_match_the_tile_build(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML not installed")
        doc = yaml.safe_load((Path(__file__).parent / "tile_manifest.yaml").read_text())
        entry = next(L for L in doc["layers"] if L["id"] == blp.NATGAS)
        self.assertEqual(entry["id_field"], blp.DATASET[blp.NATGAS]["id_field"])
        self.assertIn(entry["id_field"], entry["select"])
        self.assertIn(f"COORDINATE_PRECISION={entry['precision']}", blp.ogr_options(blp.NATGAS))
        self.assertNotIn("where", entry)
        self.assertEqual(Path(entry["src"]).stem, blp.DATASET[blp.NATGAS]["file"])


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestRailroads(unittest.TestCase):
    """A line dataset read by `path` at source precision, with int64 fids from FRAARCID."""
    DS = blp.RAILROADS
    ROWS = [(2147483647, [[-95.0123456789, 30.0], [-95.0, 30.0123456789], [-94.9, 30.0]], "LineString"),
            (301, [[[-96.0, 31.0], [-96.02, 31.0]], [[-96.03, 31.0], [-96.03, 31.02]]], "MultiLineString"),
            (42, [[-97.0, 32.0], [-97.01, 32.01]], "LineString")]

    def write_input(self, path):
        path.write_text("".join(_feature({"FRAARCID": f}, c, k) + "\n" for f, c, k in self.ROWS))

    def check_build(self, m, idx, geo):
        import shapely
        self.assertEqual((m["geometry"], m["rows"], m["fid_type"]), ("line", len(self.ROWS), "int64"))
        self.assertIsNone(m["chains"])
        self.assertEqual(m["idx"]["columns"], ["fid", "row", "length_km"])
        self.assertIsNone(m["coordinate_grid_deg"])
        self.assertGreater(m["total_km"], 0)
        self.assertEqual(idx["fid"], sorted(f for f, _, _ in self.ROWS))
        want = {f: (c, k) for f, c, k in self.ROWS}

        def hav(p, q):
            a = math.sin(math.radians(q[1] - p[1]) / 2) ** 2 + math.cos(math.radians(p[1])) * \
                math.cos(math.radians(q[1])) * math.sin(math.radians(q[0] - p[0]) / 2) ** 2
            return 2 * 6371.0088 * math.asin(math.sqrt(a))
        for fid, km in zip(idx["fid"], idx["length_km"]):
            c, k = want[fid]
            parts = c if k == "MultiLineString" else [c]
            self.assertAlmostEqual(km, sum(hav(a, b) for part in parts for a, b in zip(part, part[1:])),
                                   delta=1e-3 * km + 1e-4, msg=fid)     # parts only: the gap between them is not counted
        for fid, row in zip(idx["fid"], idx["row"]):
            self.assertEqual(geo["fid"][row], fid)
            c, k = want[fid]
            g = shapely.from_wkb(geo["geometry"][row])
            self.assertTrue(shapely.equals_exact(g, shapely.from_geojson(json.dumps(
                {"type": k, "coordinates": c})), 0), fid)       # source precision kept

    def test_the_fixture_input_builds_as_a_line_dataset_with_int_fids(self):
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as tmp:
            inp = Path(tmp) / "input"
            inp.mkdir()
            self.write_input(inp / f"{self.DS}.geojsonl")
            with unittest.mock.patch.object(blp.log, "info"):
                blp.main(["--fixture", tmp, "--only", self.DS])
            out = Path(tmp) / "analysis"
            m = json.loads((out / "index.json").read_text())["datasets"][self.DS]
            d = out / self.DS
            self.check_build(m, pq.read_table(d / m["idx"]["name"]).to_pydict(),
                             pq.read_table(d / m["geo"][0]["name"]).to_pydict())

    @unittest.skipUnless(shutil.which("ogr2ogr"), "needs ogr2ogr")
    def test_real_mode_reads_the_geojson_at_the_manifest_path_as_stored(self):
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            raw = tmp / "data" / "raw" / "railroads"
            raw.mkdir(parents=True)
            (tmp / "data" / "build").mkdir(parents=True)
            seq = tmp / "src.geojsonl"
            self.write_input(seq)
            subprocess.run(["ogr2ogr", "-f", "GeoJSON", str(raw / "narn_rail_lines.geojson"), str(seq)], check=True)
            with unittest.mock.patch.object(blp, "BUILD_DIR", tmp / "data" / "build"), \
                    unittest.mock.patch.object(blp, "OUT_DIR", tmp / "analysis"), \
                    unittest.mock.patch.object(blp.log, "info"):
                blp.main(["--only", self.DS])
            m = json.loads((tmp / "analysis" / "index.json").read_text())["datasets"][self.DS]
            d = tmp / "analysis" / self.DS
            self.check_build(m, pq.read_table(d / m["idx"]["name"]).to_pydict(),
                             pq.read_table(d / m["geo"][0]["name"]).to_pydict())

    def test_it_is_optional_in_a_fixture_and_stops_in_real_mode_without_the_file(self):
        self.assertIn(self.DS, blp.FIXTURE_OPTIONAL)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(blp.Inputs(tmp).has_input(self.DS))
        with tempfile.TemporaryDirectory() as tmp, \
                unittest.mock.patch.object(blp, "BUILD_DIR", Path(tmp) / "data" / "build"), \
                unittest.mock.patch.object(blp, "OUT_DIR", Path(tmp) / "analysis"), \
                unittest.mock.patch.object(blp.log, "info"):
            with self.assertRaises(SystemExit) as cm:
                blp.main(["--only", self.DS])
            self.assertIn("narn_rail_lines.geojson missing", str(cm.exception))

    def test_the_row_matches_the_tile_manifest_and_the_data_manifest(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML not installed")
        here = Path(__file__).parent
        entry = next(L for L in yaml.safe_load((here / "tile_manifest.yaml").read_text())["layers"]
                     if L["id"] == self.DS)
        self.assertEqual((entry["id_field"], entry["native_id"]), ("FRAARCID", True))
        self.assertIn("FRAARCID", entry["select"])
        self.assertEqual(blp.DATASET[self.DS]["id_field"], entry["id_field"])
        self.assertEqual(blp.DATASET[self.DS]["path"], entry["src"])
        data = yaml.safe_load((here / "data_manifest.yaml").read_text())["layers"][self.DS]
        self.assertEqual(blp.DATASET[self.DS]["attribution"], data["source"])


# MultiPolygons with a hole and coordinates finer than the tiles' 1e-6° grid.
REGION_POLYS = {
    blp.RETAIL: ("id", [("40429", [[[[-95.0123456789, 30.0], [-94.9, 30.0], [-94.9876543211, 30.1234567891],
                                      [-95.0123456789, 30.0]]]]),
                        ("19547", [[[[-96.0, 31.0], [-95.0, 31.0], [-95.0, 32.0], [-96.0, 32.0], [-96.0, 31.0]],
                                    [[-95.7, 31.3], [-95.7, 31.6], [-95.3, 31.6], [-95.3, 31.3], [-95.7, 31.3]]]])]),
    blp.EIA_BA: ("abbrev", [("AESO", [[[[-114.0, 50.0], [-110.0, 50.0], [-110.0, 54.0000000123], [-114.0, 50.0]]]]),
                            ("YAD", [[[[-80.0, 35.0], [-79.0, 35.0], [-79.0, 36.0], [-80.0, 35.0]]]])]),
    blp.NERC: ("sub_nm", [("CA-MX US", [[[[-120.0, 33.0], [-115.0, 33.0], [-115.0, 35.00000001], [-120.0, 33.0]]]]),
                          ("NWPP", [[[[-125.0, 42.0], [-110.0, 42.0], [-110.0, 49.0], [-125.0, 42.0]]]])]),
    # integer ids; padus's `fid` is a normal column (the GeoPackage's FID column is ogc_fid)
    # and holds values nowhere near 1..n
    blp.CONTROL_AREAS: ("id", [("19547", [[[[-158.0, 21.0], [-157.0, 21.0], [-157.0, 22.00000001], [-158.0, 21.0]]]]),
                               ("5580", [[[[-100.0, 30.0], [-99.0, 30.0], [-99.0, 31.0], [-100.0, 30.0]]]])]),
    blp.US_STATES: ("stusps", [("WA", [[[[-120.0, 47.0], [-117.0, 47.0], [-117.0, 49.0000000123], [-120.0, 47.0]]]]),
                               ("AS", [[[[-170.9, -14.4], [-170.5, -14.4], [-170.5, -14.2], [-170.9, -14.4]]]])]),
    blp.COUNTRIES: ("iso_a3", [("NZL", [[[[174.0, -41.0], [175.0, -41.0], [175.0, -40.0000000123], [174.0, -41.0]]]]),
                               ("115", [[[[20.0, 40.0], [21.0, 40.0], [21.0, 41.0], [20.0, 40.0]]]])]),
    blp.ADMIN1: ("code", [("1", [[[[10.0, 50.0], [11.0, 50.0], [11.0, 51.0000000123], [10.0, 50.0]]]]),
                          ("3224", [[[[30.0, 20.0], [31.0, 20.0], [31.0, 21.0], [30.0, 20.0]]]])]),
    blp.TRIBAL: ("geoid", [("4075T", [[[[-110.0, 35.0], [-109.0, 35.0], [-109.0, 36.0000000123], [-110.0, 35.0]]]]),
                           ("0010R", [[[[-100.0, 40.0], [-99.0, 40.0], [-99.0, 41.0], [-100.0, 40.0]]]])]),
    # zero-padded string ids, never coerced
    blp.US_ZCTA: ("zcta5", [("00601", [[[[-66.8, 18.1], [-66.7, 18.1], [-66.7, 18.2000000123], [-66.8, 18.1]]]]),
                            ("99950", [[[[-131.5, 55.5], [-131.4, 55.5], [-131.4, 55.6], [-131.5, 55.5]]]])]),
    blp.COUNTIES: ("GEOID", [("01001", [[[[-86.9, 32.3], [-86.4, 32.3], [-86.4, 32.7000000123], [-86.9, 32.3]]]]),
                             ("56045", [[[[-104.9, 43.5], [-104.0, 43.5], [-104.0, 44.0], [-104.9, 43.5]]]])]),
    blp.BIA: ("LARID", [("LAR0001", [[[[-110.9, 32.3], [-110.4, 32.3], [-110.4, 32.7000000123], [-110.9, 32.3]]]]),
                        ("LAR0335", [[[[-104.9, 43.5], [-104.0, 43.5], [-104.0, 44.0], [-104.9, 43.5]]]])]),
    blp.BOEM: ("fid", [("0a1b2c3d4e5f", [[[[-71.1, 41.0], [-70.9, 41.0], [-70.9, 41.1000000123], [-71.1, 41.0]]]]),
                       ("ffeeddccbbaa", [[[[-124.5, 40.8], [-124.3, 40.8], [-124.3, 40.9], [-124.5, 40.8]]]])]),
    blp.CRITHAB: ("entity_id", [(11686, [[[[-120.0, 35.0], [-119.0, 35.0], [-119.0, 36.0000000123], [-120.0, 35.0]]]]),
                                (3, [[[[-100.0, 30.0], [-99.0, 30.0], [-99.0, 31.0], [-100.0, 30.0]]]])]),
    blp.PADUS: ("fid", [(4503599627370495, [[[[-105.0123456789, 40.0], [-104.0, 40.0], [-104.0, 41.00000001], [-105.0123456789, 40.0]]]]),
                        (1234567890123, [[[[-106.0, 39.0], [-105.5, 39.0], [-105.5, 39.5], [-106.0, 39.0]]]])]),
}
REGION_ATTRIBUTION = {blp.RETAIL: "HIFLD (DHS/CISA), via source.coop",
                      blp.EIA_BA: "U.S. Energy Information Administration (EIA)",
                      blp.NERC: "HIFLD (DHS/CISA), via source.coop",
                      blp.CONTROL_AREAS: "HIFLD (DHS/CISA), via source.coop",
                      blp.US_STATES: "U.S. Census Bureau, TIGER/Line cartographic boundary files",
                      blp.COUNTRIES: "geoBoundaries (William & Mary geoLab), CC BY 4.0",
                      blp.ADMIN1: "geoBoundaries (William & Mary geoLab), CC BY 4.0",
                      blp.TRIBAL: "U.S. Census Bureau, TIGER/Line",
                      blp.US_ZCTA: "U.S. Census Bureau, TIGER/Line cartographic boundary files",
                      blp.COUNTIES: "U.S. Census Bureau, TIGER/Line cartographic boundary files",
                      blp.BIA: "Bureau of Indian Affairs (BIA)",
                      blp.BOEM: "Bureau of Ocean Energy Management (BOEM)",
                      blp.CRITHAB: "US Fish & Wildlife Service — ECOS",
                      blp.PADUS: "USGS Gap Analysis Project"}


class _RegionPolygonsCase:
    DS = None
    FID_TYPE = "string"

    def rows(self):
        return REGION_POLYS[self.DS][1]

    def write_input(self, path):
        field = REGION_POLYS[self.DS][0]
        path.write_text("".join(_feature({field: fid}, coords, "MultiPolygon") + "\n" for fid, coords in self.rows()))

    def check_build(self, m, idx, geo):
        import shapely
        fids = sorted(f for f, _ in self.rows())
        self.assertEqual((m["geometry"], m["rows"], m["fid_type"]), ("polygon", len(fids), self.FID_TYPE))
        self.assertIsNone(m["chains"])
        self.assertEqual(m["idx"]["columns"], ["fid", "row"])
        self.assertNotIn("total_km", m)
        self.assertIsNone(m["coordinate_grid_deg"])
        self.assertFalse(blp.DATASET[self.DS]["osm"])
        self.assertIsNone(m["snapshot"])
        self.assertEqual(m["attribution"], REGION_ATTRIBUTION[self.DS])
        self.assertEqual(idx["fid"], fids)
        want = dict(self.rows())
        for fid, row in zip(idx["fid"], idx["row"]):
            self.assertEqual(geo["fid"][row], fid)
            g = shapely.from_wkb(geo["geometry"][row])
            self.assertTrue(shapely.equals_exact(g, shapely.from_geojson(json.dumps(
                {"type": "MultiPolygon", "coordinates": want[fid]})), 0), fid)   # source precision kept

    def test_the_fixture_input_builds_as_a_polygon_dataset_at_source_precision(self):
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as tmp:
            inp = Path(tmp) / "input"
            inp.mkdir()
            self.write_input(inp / f"{self.DS}.geojsonl")
            with unittest.mock.patch.object(blp.log, "info"):
                blp.main(["--fixture", tmp, "--only", self.DS])
            out = Path(tmp) / "analysis"
            index = json.loads((out / "index.json").read_text())
            self.assertEqual(set(index["datasets"]), {self.DS})
            m = index["datasets"][self.DS]
            d = out / self.DS
            self.check_build(m, pq.read_table(d / m["idx"]["name"]).to_pydict(),
                             pq.read_table(d / m["geo"][0]["name"]).to_pydict())

    def test_it_is_optional_in_a_fixture_and_real_mode_stops_without_the_geopackage(self):
        self.assertIn(self.DS, blp.FIXTURE_OPTIONAL)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(blp.Inputs(tmp).has_input(self.DS))   # a fixture without it builds the rest
        with tempfile.TemporaryDirectory() as tmp, \
                unittest.mock.patch.object(blp, "BUILD_DIR", Path(tmp) / "build"), \
                unittest.mock.patch.object(blp, "OUT_DIR", Path(tmp) / "analysis"), \
                unittest.mock.patch.object(blp.log, "info"):
            with self.assertRaises(SystemExit) as cm:
                blp.main(["--only", self.DS])
            self.assertIn(f"{self.DS}.gpkg missing", str(cm.exception))

    @unittest.skipUnless(shutil.which("ogr2ogr"), "needs ogr2ogr")
    def test_real_mode_reads_the_geopackage_as_stored(self):
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "build").mkdir()
            seq = tmp / "src.geojsonl"
            self.write_input(seq)
            subprocess.run(["ogr2ogr", "-f", "GPKG", str(tmp / "build" / f"{self.DS}.gpkg"), str(seq),
                            "-nln", self.DS, "-lco", "FID=ogc_fid"], check=True)
            with unittest.mock.patch.object(blp, "BUILD_DIR", tmp / "build"), \
                    unittest.mock.patch.object(blp, "OUT_DIR", tmp / "analysis"), \
                    unittest.mock.patch.object(blp.log, "info"):
                blp.main(["--only", self.DS])
            index = json.loads((tmp / "analysis" / "index.json").read_text())
            m = index["datasets"][self.DS]
            d = tmp / "analysis" / self.DS
            self.assertNotEqual(m["label"], "UNKNOWN")
            self.check_build(m, pq.read_table(d / m["idx"]["name"]).to_pydict(),
                             pq.read_table(d / m["geo"][0]["name"]).to_pydict())

    @unittest.skipUnless(shutil.which("ogr2ogr"), "needs ogr2ogr")
    def test_a_geopackage_not_in_wgs84_or_with_z_is_refused_by_the_builder_and_reference_1(self):
        import check_geometry_parquet as cg
        for name, args, text in (("crs", ["-t_srs", "EPSG:3857"], "EPSG:3857"), ("z", ["-dim", "XYZ"], "Z coordinates")):
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                (tmp / "build").mkdir()
                seq = tmp / "src.geojsonl"
                self.write_input(seq)
                gpkg = tmp / "build" / f"{self.DS}.gpkg"
                subprocess.run(["ogr2ogr", "-f", "GPKG", str(gpkg), str(seq), "-nln", self.DS,
                                "-lco", "FID=ogc_fid", *args], check=True)
                with unittest.mock.patch.object(blp, "BUILD_DIR", tmp / "build"), \
                        unittest.mock.patch.object(blp, "OUT_DIR", tmp / "analysis"), \
                        unittest.mock.patch.object(blp.log, "info"):
                    with self.assertRaises(SystemExit) as cm:
                        blp.main(["--only", self.DS])
                self.assertIn(text, str(cm.exception))
                # reference 1 on files built from a good copy of the same rows
                good = tmp / "good.gpkg"
                subprocess.run(["ogr2ogr", "-f", "GPKG", str(good), str(seq), "-nln", self.DS, "-lco", "FID=ogc_fid"], check=True)
                (tmp / "build2").mkdir()
                shutil.copyfile(good, tmp / "build2" / f"{self.DS}.gpkg")
                with unittest.mock.patch.object(blp, "BUILD_DIR", tmp / "build2"), \
                        unittest.mock.patch.object(blp, "OUT_DIR", tmp / "analysis"), \
                        unittest.mock.patch.object(blp.log, "info"):
                    blp.main(["--only", self.DS])
                m = json.loads((tmp / "analysis" / "index.json").read_text())["datasets"][self.DS]
                ok, c, _ = cg.reference1(self.DS, m, tmp / "analysis", good)
                self.assertTrue(ok)
                ok, c, _ = cg.reference1(self.DS, m, tmp / "analysis", gpkg)
                self.assertFalse(ok)
                self.assertEqual(c["input not EPSG:4326 2D"], 1)


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestRetailTerritories(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.RETAIL


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestEiaBa(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.EIA_BA


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestNercRegions(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.NERC



@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestControlAreas(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.CONTROL_AREAS


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestUsStates(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.US_STATES


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestCountries(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.COUNTRIES


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestAdmin1(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.ADMIN1


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestTribalLands(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.TRIBAL


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestUsZcta(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.US_ZCTA

    def test_leading_zeros_survive(self):
        self.assertEqual(blp.DATASET[self.DS]["fid_type"], "string")
        self.assertIn("00601", [f for f, _ in self.rows()])


class _PathRegionCase(_RegionPolygonsCase):
    FIRST = None

    # a `path` input: the base class's GeoPackage cases, redone for a GeoJSON under the build root
    def test_it_is_optional_in_a_fixture_and_real_mode_stops_without_the_geopackage(self):
        self.assertIn(self.DS, blp.FIXTURE_OPTIONAL)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(blp.Inputs(tmp).has_input(self.DS))
        with tempfile.TemporaryDirectory() as tmp, \
                unittest.mock.patch.object(blp, "BUILD_DIR", Path(tmp) / "data" / "build"), \
                unittest.mock.patch.object(blp, "OUT_DIR", Path(tmp) / "analysis"), \
                unittest.mock.patch.object(blp.log, "info"):
            with self.assertRaises(SystemExit) as cm:
                blp.main(["--only", self.DS])
            self.assertIn(f"{self.DS}.geojson missing", str(cm.exception))

    @unittest.skipUnless(shutil.which("ogr2ogr"), "needs ogr2ogr")
    def test_real_mode_reads_the_geopackage_as_stored(self):
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "data" / "build").mkdir(parents=True)
            seq = tmp / "src.geojsonl"
            self.write_input(seq)
            subprocess.run(["ogr2ogr", "-f", "GeoJSON", str(tmp / "data" / "build" / f"{self.DS}.geojson"), str(seq)],
                           check=True)
            with unittest.mock.patch.object(blp, "BUILD_DIR", tmp / "data" / "build"), \
                    unittest.mock.patch.object(blp, "OUT_DIR", tmp / "analysis"), \
                    unittest.mock.patch.object(blp.log, "info"):
                blp.main(["--only", self.DS])
            m = json.loads((tmp / "analysis" / "index.json").read_text())["datasets"][self.DS]
            d = tmp / "analysis" / self.DS
            self.check_build(m, pq.read_table(d / m["idx"]["name"]).to_pydict(),
                             pq.read_table(d / m["geo"][0]["name"]).to_pydict())

    def test_a_geopackage_not_in_wgs84_or_with_z_is_refused_by_the_builder_and_reference_1(self):
        self.assertTrue(hasattr(TestPathInputs, "test_a_mixed_geojson_with_z_is_refused_by_the_builder_and_reference_1"))


class TestGeoBoundariesAttribution(unittest.TestCase):
    def test_the_two_geoboundaries_rows_name_the_licence(self):
        for ds in (blp.COUNTRIES, blp.ADMIN1):
            self.assertIn("CC BY 4.0", blp.DATASET[ds]["attribution"])
            self.assertIn("geoBoundaries", blp.DATASET[ds]["attribution"])


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestCountyBoundaries(_PathRegionCase, unittest.TestCase):
    DS = blp.COUNTIES

    def test_leading_zeros_survive(self):
        self.assertEqual(blp.DATASET[self.DS]["path"], "data/build/county_boundaries.geojson")
        self.assertIn("01001", [f for f, _ in self.rows()])


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestBiaTribalLands(_PathRegionCase, unittest.TestCase):
    DS = blp.BIA

    def test_the_string_ids_are_kept(self):
        self.assertEqual(blp.DATASET[self.DS]["path"], "data/build/bia_tribal_lands.geojson")
        self.assertIn("LAR0001", [f for f, _ in self.rows()])


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestBoemWindLeases(_PathRegionCase, unittest.TestCase):
    DS = blp.BOEM

    def test_the_content_ids_are_kept_as_strings(self):
        self.assertEqual(blp.DATASET[self.DS]["path"], "data/build/boem_wind_leases.geojson")
        self.assertIn("0a1b2c3d4e5f", [f for f, _ in self.rows()])


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestCrithab(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.CRITHAB
    FID_TYPE = "int64"


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestPadus(_RegionPolygonsCase, unittest.TestCase):
    DS = blp.PADUS
    FID_TYPE = "int64"


class TestPathInputs(unittest.TestCase):
    """A DATASET row may name `path` (an OGR-readable file in the repo) instead of `file`."""
    DS = "retail_territories"
    ROWS = [("A1", [[[[-95.0123456789, 30.0], [-95.0, 30.0123456789], [-94.9, 30.0], [-95.0123456789, 30.0]]]]),
            ("B2", [[[[-96.0, 31.0], [-96.0, 31.1], [-95.9, 31.1], [-96.0, 31.0]]],
                    [[[-97.0, 32.0], [-97.0, 32.1], [-96.9, 32.1], [-97.0, 32.0]]]]),
            ("C3", [[[[-98.0, 33.0], [-98.0, 33.1], [-97.9, 33.1], [-98.0, 33.0]]]])]

    def write_geojson(self, path, rows=None):
        path.write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"id": i},
             "geometry": {"type": "MultiPolygon" if len(c) > 1 else "Polygon",
                          "coordinates": c if len(c) > 1 else c[0]}}
            for i, c in (rows or self.ROWS)]}))

    def build(self, tmp, row):
        with unittest.mock.patch.dict(blp.DATASET, {self.DS: {**{k: v for k, v in blp.DATASET[self.DS].items() if k != "file"}, **row}}), \
                unittest.mock.patch.object(blp, "BUILD_DIR", tmp / "data" / "build"), \
                unittest.mock.patch.object(blp, "OUT_DIR", tmp / "analysis"), \
                unittest.mock.patch.object(blp.log, "info"):
            blp.main(["--only", self.DS])
        return json.loads((tmp / "analysis" / "index.json").read_text())["datasets"][self.DS]

    def test_a_row_naming_both_or_neither_is_refused(self):
        base = blp.DATASET[self.DS]
        for name, row in (("both", {**base, "path": "x.geojson"}),
                          ("neither", {k: v for k, v in base.items() if k != "file"})):
            with self.subTest(name), self.assertRaises(SystemExit) as cm:
                blp.check_rows({self.DS: row})
            self.assertIn("exactly one of `file` and `path`", str(cm.exception))
        with self.assertRaises(SystemExit) as cm:
            blp.check_rows({self.DS: {**{k: v for k, v in base.items() if k != "file"},
                                      "path": "data/x.geojson", "exact": False}})
        self.assertIn("exact", str(cm.exception))

    @unittest.skipUnless(HAVE_STACK and shutil.which("ogr2ogr"), "needs the stack and ogr2ogr")
    def test_a_path_row_and_a_file_row_build_the_same_geometry_files(self):
        import check_geometry_parquet as cg
        import pyarrow.parquet as pq
        out = {}
        for name in ("path", "file"):
            with tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                (tmp / "data" / "build").mkdir(parents=True)
                src = tmp / "data" / "build" / "regions.geojson"
                self.write_geojson(src)
                base = {k: v for k, v in blp.DATASET[self.DS].items() if k != "file"}
                if name == "path":
                    m = self.build(tmp, {"path": "data/build/regions.geojson"})
                else:
                    gpkg = tmp / "data" / "build" / "regions.gpkg"
                    subprocess.run(["ogr2ogr", "-f", "GPKG", str(gpkg), str(src), "-nln", "regions",
                                    "-lco", "FID=ogc_fid"], check=True)
                    m = self.build(tmp, {"file": "regions"})
                d = tmp / "analysis" / self.DS
                idx = pq.read_table(d / m["idx"]["name"]).to_pydict()
                geo = pq.read_table(d / m["geo"][0]["name"]).to_pydict()
                out[name] = (m["rows"], m["fid_type"], idx, geo["fid"], geo["geometry"])
                if name == "path":
                    self.assertEqual(sorted(idx["fid"]), ["A1", "B2", "C3"])
                    with unittest.mock.patch.dict(cg.GPKG_INPUT, {self.DS: "data/build/regions.geojson"}):
                        src_ref = cg.kept_input(self.DS, tmp / "data" / "build" / "world")
                        self.assertEqual(src_ref, src)
                        ok, c, text = cg.reference1(self.DS, m, tmp / "analysis", src_ref)
                    self.assertTrue(ok, text)
                    self.assertEqual((c["IDX rows"], c["geometry mismatches"], c["input not EPSG:4326 2D"]), (3, 0, 0))
                    moved = tmp / "moved.geojson"
                    ring = [list(pt) for pt in self.ROWS[0][1][0][0]]
                    ring[1][0] += 1e-6
                    self.write_geojson(moved, [(self.ROWS[0][0], [[ring]]), *self.ROWS[1:]])
                    ok, c, _ = cg.reference1(self.DS, m, tmp / "analysis", moved)
                    self.assertFalse(ok)
                    self.assertEqual(c["geometry mismatches"], 1)
        self.assertEqual(out["path"], out["file"])

    @unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
    def test_path_resolves_against_the_build_root_not_the_cwd_and_reads_no_live_data(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as elsewhere:
            tmp = Path(tmp)
            (tmp / "data" / "build").mkdir(parents=True)
            self.write_geojson(tmp / "data" / "build" / "regions.geojson")
            cwd = os.getcwd()
            os.chdir(elsewhere)
            try:
                m = self.build(tmp, {"path": "data/build/regions.geojson"})
            finally:
                os.chdir(cwd)
            self.assertEqual(m["rows"], 3)
            with unittest.mock.patch.object(blp, "BUILD_DIR", tmp / "data" / "build"):
                self.assertEqual(blp.Inputs().gpkg_input("padus"), tmp / "data" / "build" / "padus.gpkg")
                with unittest.mock.patch.dict(blp.DATASET, {"padus": {**blp.DATASET["padus"], "path": "data/x.geojson"}}):
                    self.assertEqual(blp.Inputs().gpkg_input("padus"), tmp / "data" / "x.geojson")

    @unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
    def test_a_mixed_geojson_with_z_is_refused_by_the_builder_and_reference_1(self):
        import check_geometry_parquet as cg
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "data" / "build").mkdir(parents=True)
            good = tmp / "data" / "build" / "good.geojson"
            self.write_geojson(good)
            m = self.build(tmp, {"path": "data/build/good.geojson"})
            z = tmp / "data" / "build" / "z.geojson"
            doc = json.loads(good.read_text())
            g = doc["features"][1]["geometry"]
            g["coordinates"] = [[[pt + [10.0] for pt in ring] for ring in poly] for poly in g["coordinates"]]
            z.write_text(json.dumps(doc))
            with self.assertRaises(SystemExit) as cm:
                self.build(tmp, {"path": "data/build/z.geojson"})
            self.assertIn("Z coordinates", str(cm.exception))
            ok, c, _ = cg.reference1(self.DS, m, tmp / "analysis", z)
            self.assertFalse(ok)
            self.assertEqual(c["input not EPSG:4326 2D"], 1)

    def test_builder_path_rows_equal_the_checkers_and_gz_is_refused(self):
        import check_geometry_parquet as cg
        mine = {ds: r["path"] for ds, r in blp.DATASET.items() if "path" in r}
        theirs = {ds: v for ds, v in cg.GPKG_INPUT.items() if "/" in v}
        self.assertEqual(mine, theirs)
        base = {k: v for k, v in blp.DATASET[self.DS].items() if k != "file"}
        for bad in ("data/x.geojson.gz", "x.geojson"):
            with self.subTest(bad), self.assertRaises(SystemExit):
                blp.check_rows({self.DS: {**base, "path": bad}})


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestGeoRowGroups(unittest.TestCase):
    """A few very large polygons: GEO row groups close on a WKB byte budget, so parts stay under the hard cap."""

    def test_large_polygons_make_several_row_groups_and_parts_under_the_hard_cap(self):
        import numpy as np
        import pyarrow as pa
        import pyarrow.parquet as pq
        import shapely
        import geoparquet_common as gc
        rng = np.random.default_rng(7)
        n, nv = 14, 600_000        # ~9.6 MB of WKB each, incompressible coordinates
        geoms = []
        for i in range(n):
            ang = np.sort(rng.uniform(0, 2 * np.pi, nv))
            r = 1 + rng.uniform(0, 0.3, nv)
            ring = np.c_[i * 3 + r * np.cos(ang), r * np.sin(ang)]
            geoms.append(shapely.Polygon(np.vstack([ring, ring[:1]])))
        geoms = np.array(geoms, dtype=object)
        table = pa.table({"fid": pa.array(np.arange(n, dtype=np.int64)),
                          "bbox": gc.bbox_array(shapely.bounds(geoms)),
                          "geometry": pa.array(shapely.to_wkb(geoms), pa.binary())})
        with tempfile.TemporaryDirectory() as tmp, unittest.mock.patch.object(blp.log, "info"):
            out = Path(tmp)
            entries = blp.write_geo(table, ["Polygon"], out, "big", "b", out)
            files = [out / e["name"] for e in entries]
            self.assertGreater(len(files), 1)
            self.assertTrue(all(f.stat().st_size <= gc.PART_HARD_BYTES for f in files))
            groups = [pq.ParquetFile(f).metadata.row_group(i).num_rows
                      for f in files for i in range(pq.ParquetFile(f).metadata.num_row_groups)]
            self.assertEqual(sum(groups), n)
            self.assertGreater(len(groups), 1)
            self.assertEqual(sum(e["rows"] for e in entries), n)
            self.assertEqual([e["row_offset"] for e in entries], list(np.cumsum([0] + [e["rows"] for e in entries[:-1]])))


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy not installed")
class TestFixtureBuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        inp = Path(cls.tmp) / "input"
        inp.mkdir()
        with open(inp / "transmission_world.geojsonl", "w") as f:
            for fid, kv, circ, coords in LINES:
                f.write(_feature({"fid": fid, "nominal_kv": kv, "circuits": circ}, coords) + "\n")
        ring = [[-0.001, -0.001], [0.001, -0.001], [0.001, 0.001], [-0.001, 0.001], [-0.001, -0.001]]
        (inp / "substation_polygons.geojsonl").write_text(
            _feature({"fid": SUB_POLY_FID}, [ring], "Polygon") + "\n")
        # ~60 m north of F
        (inp / "substation_points.csv").write_text(f"fid,lon,lat\n{SUB_POINT_FID},0.030011,0.010559\n")
        with open(inp / "transmission_hifld.geojsonl", "w") as f:
            f.write(_feature({"ID": "160421"}, [[[-157.1, 21.9], [-157.2, 22.0]],
                                                [[-157.3, 22.1], [-157.31, 22.11]]],
                             "MultiLineString") + "\n")
            f.write(_feature({"ID": "99"}, [[[-120.000001, 35.5], [-120.1, 35.6]]],
                             "MultiLineString") + "\n")
        write_polygon_input(inp / f"{blp.SUBS_POLY}.geojsonl")
        with unittest.mock.patch.object(blp.log, "info"):
            blp.main(["--fixture", cls.tmp])
        cls.out = Path(cls.tmp) / "analysis"
        cls.index = json.loads((cls.out / "index.json").read_text())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def _read(self, ds, entry):
        import pyarrow.parquet as pq
        return pq.read_table(self.out / ds / entry["name"])

    def _geo(self, ds):
        import pyarrow as pa
        m = self.index["datasets"][ds]
        return pa.concat_tables([self._read(ds, e) for e in m["geo"]])

    def test_index_lists_every_dataset_with_one_pinned_build_id(self):
        ds = self.index["datasets"]
        self.assertEqual(set(ds), {blp.OSM, blp.HIFLD, blp.SUBS_POLY})
        self.assertEqual({m["build_id"] for m in ds.values()}, {blp.FIXTURE_BUILD_ID})
        self.assertEqual({k: m["geometry"] for k, m in ds.items()},
                         {blp.OSM: "line", blp.HIFLD: "line", blp.SUBS_POLY: "polygon"})

    def test_polygon_dataset_has_idx_and_geo_only_and_no_line_facts(self):
        import shapely
        m = self.index["datasets"][blp.SUBS_POLY]
        self.assertIsNone(m["chains"])
        for k in ("total_km", "length", "chain_stats"):
            self.assertNotIn(k, m)
        self.assertEqual((m["fid_type"], m["rows"]), ("int64", len(POLYGONS)))
        self.assertEqual(m["attribution"], "© OpenStreetMap contributors")
        idx = self._read(blp.SUBS_POLY, m["idx"])
        self.assertEqual(idx.column_names, ["fid", "row"])
        geo = self._geo(blp.SUBS_POLY)
        self.assertEqual(geo.column_names, ["fid", "bbox", "geometry"])
        rows = idx.to_pydict()
        self.assertEqual(rows["fid"], sorted(f for f, _, _ in POLYGONS))
        self.assertIn(BIG_FID, rows["fid"])
        want = {fid: shapely.from_geojson(json.dumps({"type": kind, "coordinates": c}))
                for fid, kind, c in POLYGONS}
        got = geo.to_pydict()
        for fid, row in zip(rows["fid"], rows["row"]):
            self.assertEqual(got["fid"][row], fid)
            g = shapely.from_wkb(got["geometry"][row])
            self.assertTrue(shapely.equals_exact(g, want[fid], 0))
            bb = got["bbox"][row]
            x0, y0, x1, y1 = shapely.bounds(g)
            self.assertTrue(bb["xmin"] <= x0 and bb["ymin"] <= y0 and bb["xmax"] >= x1 and bb["ymax"] >= y1)
        types = {shapely.get_type_id(shapely.from_wkb(w)) for w in got["geometry"]}
        self.assertEqual(types, {3, 6})
        self.assertEqual(len(shapely.from_wkb(got["geometry"][rows["row"][rows["fid"].index(103)]]).interiors), 1)

    def test_a_missing_substation_input_stops_a_whole_build_and_leaves_a_true_index(self):
        def names(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if k == "name":
                        yield v
                    else:
                        yield from names(v)
            elif isinstance(o, list):
                for v in o:
                    yield from names(v)
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(self.tmp, tmp, dirs_exist_ok=True)
            (Path(tmp) / "input" / f"{blp.SUBS_POLY}.geojsonl").unlink()
            with unittest.mock.patch.object(blp.log, "info"), self.assertRaises(SystemExit):
                blp.main(["--fixture", tmp])
            out = Path(tmp) / "analysis"
            index = json.loads((out / "index.json").read_text())
            for ds, m in index["datasets"].items():
                for n in names(m):
                    self.assertTrue((out / ds / n).exists(), (ds, n))

    def test_a_missing_polygon_input_stops_the_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(self.tmp, tmp, dirs_exist_ok=True)
            (Path(tmp) / "input" / f"{blp.SUBS_POLY}.geojsonl").unlink()
            with unittest.mock.patch.object(blp.log, "info"), self.assertRaises(SystemExit):
                blp.main(["--fixture", tmp, "--only", blp.SUBS_POLY])

    def test_every_file_carries_the_manifest_build_id_and_facts(self):
        import pyarrow.parquet as pq
        from geoparquet_common import footer_len, sha256_file
        for ds, m in self.index["datasets"].items():
            entries = [m["idx"], *m["geo"], *([m["chains"]] if m["chains"] else [])]
            for e in entries:
                p = self.out / ds / e["name"]
                self.assertEqual(pq.ParquetFile(p).schema_arrow.metadata[b"build_id"].decode(),
                                 m["build_id"])
                self.assertEqual((e["bytes"], e["sha256"], e["footer_len"]),
                                 (p.stat().st_size, sha256_file(p), footer_len(p)))
                self.assertIn(e["sha256"][:8], e["name"])
                self.assertLessEqual(e["bytes"], 95 * 2**20)
            self.assertEqual(sorted(os.listdir(self.out / ds)),
                             sorted([e["name"] for e in entries] + ["_manifest.json"]))

    def test_idx_rows_point_at_their_geo_rows(self):
        for ds in (blp.OSM, blp.HIFLD):
            idx = self._read(ds, self.index["datasets"][ds]["idx"]).to_pydict()
            geo_fid = self._geo(ds).column("fid").to_pylist()
            self.assertEqual(idx["fid"], sorted(idx["fid"]))
            self.assertEqual(len(set(idx["fid"])), len(idx["fid"]))
            for fid, row in zip(idx["fid"], idx["row"]):
                self.assertEqual(geo_fid[row], fid)

    def test_geo_coordinates_equal_the_input_exactly(self):
        import shapely
        geo = self._geo(blp.OSM).to_pydict()
        want = {fid: coords for fid, _, _, coords in LINES}
        for fid, wkb in zip(geo["fid"], geo["geometry"]):
            self.assertEqual(shapely.get_coordinates(shapely.from_wkb(wkb)).tolist(), want[fid])

    def test_bbox_covers_the_geometry(self):
        import shapely
        geo = self._geo(blp.HIFLD).to_pydict()
        for bb, wkb in zip(geo["bbox"], geo["geometry"]):
            x0, y0, x1, y1 = shapely.bounds(shapely.from_wkb(wkb))
            self.assertTrue(bb["xmin"] <= x0 and bb["ymin"] <= y0 and bb["xmax"] >= x1 and bb["ymax"] >= y1)

    def test_osm_idx_carries_length_chain_and_circuits(self):
        idx = self._read(blp.OSM, self.index["datasets"][blp.OSM]["idx"]).to_pydict()
        by = {f: i for i, f in enumerate(idx["fid"])}
        self.assertEqual(idx["circuits"][by[11]], 2)
        self.assertEqual(idx["circuits"][by[31]], -1)
        # 31 runs C → D along the equator: 0.010004° of longitude.
        self.assertAlmostEqual(idx["length_km"][by[31]], 0.010004 * 3.141592653589793 / 180 * 6371.0088,
                               places=4)
        chain = {f: idx["chain"][by[f]] for f in by}
        self.assertEqual(len({chain[11], chain[21], chain[31]}), 1)
        self.assertGreaterEqual(chain[11], 0)
        self.assertGreaterEqual(chain[51], 0)            # alone, but ends at a substation
        self.assertEqual([chain[41], chain[61], chain[71]], [-1, -1, -1])

    def test_chains_in_order_with_rev_and_end_substations(self):
        m = self.index["datasets"][blp.OSM]
        ch = self._read(blp.OSM, m["chains"]).to_pylist()
        geo_fid = self._geo(blp.OSM).column("fid").to_pylist()
        for r in ch:
            self.assertEqual(geo_fid[r["row"]], r["fid"])
        three = [r for r in ch if r["fid"] in (11, 21, 31)]
        self.assertEqual([r["seq"] for r in three], [0, 1, 2])
        got = [(r["fid"], r["rev"], r["start_sub"], r["end_sub"]) for r in three]
        self.assertIn(got, ([(11, False, SUB_POLY_FID, None), (21, True, None, None), (31, False, None, None)],
                            [(31, True, None, None), (21, False, None, None), (11, True, None, SUB_POLY_FID)]))
        tap = [r for r in ch if r["fid"] == 51]
        self.assertEqual(len(tap), 1)
        self.assertEqual({tap[0]["start_sub"], tap[0]["end_sub"]}, {None, SUB_POINT_FID})
        self.assertNotIn(71, [r["fid"] for r in ch])

    def test_hifld_fid_keeps_the_tile_type_and_has_no_chains(self):
        m = self.index["datasets"][blp.HIFLD]
        self.assertIsNone(m["chains"])
        idx = self._read(blp.HIFLD, m["idx"])
        self.assertEqual(str(idx.schema.field("fid").type), "string")
        self.assertEqual(idx.column_names, ["fid", "row", "length_km"])

    def test_geo_is_geoparquet_with_a_bbox_covering(self):
        import pyarrow.parquet as pq
        e = self.index["datasets"][blp.OSM]["geo"][0]
        meta = json.loads(pq.ParquetFile(self.out / blp.OSM / e["name"]).schema_arrow.metadata[b"geo"])
        self.assertEqual(meta["version"], "1.1.0")
        self.assertEqual(meta["columns"]["geometry"]["covering"]["bbox"]["ymax"], ["bbox", "ymax"])

    def test_geopandas_reads_geo_as_geoparquet(self):
        if not importlib.util.find_spec("geopandas"):
            self.skipTest("geopandas not installed")
        import geopandas
        e = self.index["datasets"][blp.HIFLD]["geo"][0]
        df = geopandas.read_parquet(self.out / blp.HIFLD / e["name"])
        self.assertEqual(len(df), 2)
        self.assertEqual(set(df.geometry.geom_type), {"MultiLineString"})
        self.assertTrue(df.crs.is_geographic)     # OGC:CRS84, the GeoParquet default

    def test_gdal_opens_geo(self):
        if not shutil.which("ogrinfo"):
            self.skipTest("ogrinfo not installed")
        formats = subprocess.run(["ogrinfo", "--formats"], capture_output=True, text=True).stdout
        if "Parquet" not in formats.replace("ADBC", ""):
            self.skipTest("GDAL built without the Parquet driver")
        e = self.index["datasets"][blp.HIFLD]["geo"][0]
        out = subprocess.run(["ogrinfo", "-so", "-al", str(self.out / blp.HIFLD / e["name"])],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("Feature Count: 2", out.stdout)
        self.assertIn("Multi Line String", out.stdout)

    def test_check_analysis_is_clean_then_catches_a_change_and_an_orphan(self):
        from geoparquet_common import check_analysis
        self.assertEqual(check_analysis(self.out), [])
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(self.out, tmp, dirs_exist_ok=True)
            e = self.index["datasets"][blp.HIFLD]["idx"]
            with open(Path(tmp) / blp.HIFLD / e["name"], "ab") as f:
                f.write(b"x")
            (Path(tmp) / blp.OSM / "stray.parquet").write_bytes(b"")
            problems = "\n".join(check_analysis(tmp))
            self.assertIn("sha256 differs", problems)
            self.assertIn("stray.parquet is not in the manifest", problems)

    def test_stable_ids_lines_agrees_with_tiles_built_from_the_same_input(self):
        if not (shutil.which("tippecanoe") and shutil.which("tippecanoe-decode")
                and importlib.util.find_spec("yaml")):
            self.skipTest("tippecanoe or PyYAML not installed")
        import contextlib
        import io
        import stable_ids
        with tempfile.TemporaryDirectory() as tmp:
            layers = Path(tmp) / "layers"
            layers.mkdir()
            inp = Path(self.tmp) / "input"
            # stable_ids --lines measures lines only: hold the polygon dataset out of its index
            lines_only = Path(tmp) / "analysis"
            shutil.copytree(self.out, lines_only)
            index = json.loads((lines_only / "index.json").read_text())
            del index["datasets"][blp.SUBS_POLY]
            (lines_only / "index.json").write_text(json.dumps(index))

            def tile(src, out, extra=()):
                subprocess.run(["tippecanoe", "-q", "-o", str(layers / out), "-z11", "-Z2",
                                "--force", *extra, str(src)], check=True)

            tile(inp / "transmission_world.geojsonl", "osm_transmission_lines.pmtiles",
                 ["--use-attribute-for-id=fid", "-Tfid:int"])
            tile(inp / "transmission_hifld.geojsonl", "hifld_transmission_lines.pmtiles")
            manifest = Path(tmp) / "m.yaml"
            manifest.write_text("layers:\n"
                                "  - {id: osm_transmission_lines, id_field: fid, native_id: true}\n"
                                "  - {id: hifld_transmission_lines, id_field: ID}\n")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                ok = stable_ids.check_lines(lines_only, layers, manifest, sample=50)
            self.assertTrue(ok, out.getvalue())
            self.assertIn("missing 0", out.getvalue())

            # a tile id IDX lacks is a failure
            stray = Path(tmp) / "stray.geojsonl"
            stray.write_text(_feature({"ID": "777"}, [[[-100.0, 40.0], [-100.1, 40.1]]],
                                      "MultiLineString") + "\n")
            tile(stray, "hifld_transmission_lines.pmtiles")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(stable_ids.check_lines(lines_only, layers, manifest, sample=50))

    def test_a_rebuild_removes_the_old_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(self.tmp, tmp, dirs_exist_ok=True)
            out = Path(tmp) / "analysis"
            before = set(os.listdir(out / blp.HIFLD))
            with unittest.mock.patch.object(blp.log, "info"):
                blp.main(["--fixture", tmp, "--only", blp.HIFLD])
            after = json.loads((out / "index.json").read_text())
            self.assertEqual(len(os.listdir(out / blp.HIFLD)), len(before))
            self.assertEqual(after["datasets"][blp.HIFLD], self.index["datasets"][blp.HIFLD])
            # --only keeps the other dataset's entry as it was
            self.assertEqual(after["datasets"][blp.OSM], self.index["datasets"][blp.OSM])

    def test_a_rebuild_of_the_fixture_is_byte_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(self.tmp, tmp, dirs_exist_ok=True)
            shutil.rmtree(Path(tmp) / "analysis")
            with unittest.mock.patch.object(blp.log, "info"):
                blp.main(["--fixture", tmp])
            for f in sorted((self.out).rglob("*")):
                if f.is_file():
                    self.assertEqual((Path(tmp) / "analysis" / f.relative_to(self.out)).read_bytes(),
                                     f.read_bytes(), f.name)

if __name__ == "__main__":
    unittest.main()
