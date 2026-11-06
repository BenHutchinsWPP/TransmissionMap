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

    def test_hifld_options_match_the_tile_build(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML not installed")
        doc = yaml.safe_load((Path(blp.__file__).parent / "tile_manifest.yaml").read_text())
        entry = next(L for L in doc["layers"] if L["id"] == blp.HIFLD)
        self.assertEqual(entry["id_field"], blp.HIFLD_ID)
        self.assertIn(f"COORDINATE_PRECISION={entry['precision']}", blp.HIFLD_OGR_OPTIONS)


def _feature(props, coords, kind="LineString"):
    return json.dumps({"type": "Feature", "properties": props,
                       "geometry": {"type": kind, "coordinates": coords}})


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

    def test_index_lists_both_datasets_with_one_build_id(self):
        ds = self.index["datasets"]
        self.assertEqual(set(ds), {blp.OSM, blp.HIFLD})
        self.assertEqual(len({m["build_id"] for m in ds.values()}), 1)

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

            def tile(src, out, extra=()):
                subprocess.run(["tippecanoe", "-q", "-o", str(layers / out), "-z11", "-Z2",
                                "--force", *extra, str(src)], check=True)

            tile(inp / "transmission_world.geojsonl", "osm_transmission_lines_kv0.pmtiles",
                 ["--use-attribute-for-id=fid", "-Tfid:int"])
            tile(inp / "transmission_hifld.geojsonl", "hifld_transmission_lines.pmtiles")
            manifest = Path(tmp) / "m.yaml"
            manifest.write_text("layers:\n"
                                "  - {id: osm_transmission_lines, id_field: fid, native_id: true,"
                                " split_voltage_bands: true}\n"
                                "  - {id: hifld_transmission_lines, id_field: ID}\n")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                ok = stable_ids.check_lines(self.out, layers, manifest, sample=50)
            self.assertTrue(ok, out.getvalue())
            self.assertIn("missing 0", out.getvalue())

            # a tile id IDX lacks is a failure
            stray = Path(tmp) / "stray.geojsonl"
            stray.write_text(_feature({"ID": "777"}, [[[-100.0, 40.0], [-100.1, 40.1]]],
                                      "MultiLineString") + "\n")
            tile(stray, "hifld_transmission_lines.pmtiles")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(stable_ids.check_lines(self.out, layers, manifest, sample=50))

    def test_a_rebuild_removes_the_old_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(self.tmp, tmp, dirs_exist_ok=True)
            out = Path(tmp) / "analysis"
            before = set(os.listdir(out / blp.HIFLD))
            with unittest.mock.patch.object(blp.log, "info"):
                blp.main(["--fixture", tmp, "--only", blp.HIFLD])
            after = json.loads((out / "index.json").read_text())
            self.assertEqual(len(os.listdir(out / blp.HIFLD)), len(before))
            self.assertNotEqual(after["datasets"][blp.HIFLD]["build_id"],
                                self.index["datasets"][blp.HIFLD]["build_id"])
            # --only keeps the other dataset's entry as it was
            self.assertEqual(after["datasets"][blp.OSM], self.index["datasets"][blp.OSM])

if __name__ == "__main__":
    unittest.main()
