#!/usr/bin/env python3
"""Tests for stable_ids.py: synthetic decode streams and features, plus a real
tippecanoe round trip when it is installed. No data/ or network needed."""
import contextlib
import gzip
import importlib.util
import io
import json
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stable_ids  # noqa: E402
import tile_inputs  # noqa: E402

MANIFEST = Path(__file__).resolve().parent / "tile_manifest.yaml"


def tile(z, x, y, *features):
    """One tile of tippecanoe-decode output, laid out the way it prints it."""
    out = [f'{{ "type": "FeatureCollection", "properties": {{ "zoom": {z}, "x": {x}, "y": {y} }}, "features": [',
           '{ "type": "FeatureCollection", "properties": { "layer": "lyr", "version": 2, "extent": 4096 }, "features": [']
    for i, f in enumerate(features):
        if i:
            out.append(",")
        out.append(json.dumps(f).replace('{"type": "Feature"', '{ "type": "Feature"', 1))
    return out + ["] }", "] }", ","]


def feat(props, fid=None):
    f = {"type": "Feature"}
    if fid is not None:
        f["id"] = fid
    f.update({"properties": props, "geometry": {"type": "Point", "coordinates": [0, 0]}})
    return f


class TestScanDecode(unittest.TestCase):
    def test_a_feature_split_across_tiles_is_not_a_duplicate(self):
        lines = tile(3, 3, 4, feat({}, 45)) + tile(3, 4, 4, feat({}, 45))
        st = stable_ids.scan_decode(lines, "fid", native=True)
        self.assertEqual((st.tiles, st.features, st.missing, st.dups), (2, 2, 0, 0))
        self.assertEqual(st.ids, {"45"})

    def test_the_same_id_twice_in_one_tile_is_a_duplicate(self):
        lines = tile(3, 3, 4, feat({}, 45), feat({}, 45), feat({}, 46))
        st = stable_ids.scan_decode(lines, "fid", native=True)
        self.assertEqual(st.dups, 1)
        self.assertEqual(st.examples, ["45 in 3/3/4"])

    def test_native_mode_reads_the_feature_id_not_the_property(self):
        lines = tile(3, 0, 0, feat({"fid": 7}), feat({}, 8))
        st = stable_ids.scan_decode(lines, "fid", native=True)
        self.assertEqual((st.missing, st.ids), (1, {"8"}))

    def test_property_mode_counts_absent_null_and_empty_as_missing(self):
        lines = tile(3, 0, 0, feat({"ID": "303622"}), feat({"ID": None}), feat({"ID": ""}),
                     feat({}), feat({"ID": 303623.0}))
        st = stable_ids.scan_decode(lines, "ID", native=False)
        self.assertEqual((st.features, st.missing, st.dups), (5, 3, 0))
        self.assertEqual(st.ids, {"303622", "303623"})

    def test_max_tiles_stops_early_and_marks_the_pass_sampled(self):
        lines = tile(3, 0, 0, feat({}, 1)) + tile(3, 1, 0, feat({}, 2)) + tile(3, 2, 0, feat({}, 3))
        st = stable_ids.scan_decode(lines, "fid", native=True, max_tiles=2)
        self.assertEqual((st.tiles, st.features, st.complete), (2, 2, False))
        self.assertTrue(stable_ids.scan_decode(lines, "fid", native=True).complete)


class TestScanFeatures(unittest.TestCase):
    def test_whole_features_count_any_repeat(self):
        st = stable_ids.scan_features([feat({"fid": "ng:1"}), feat({"fid": "ng:1"}),
                                       feat({"fid": "hgl:1"}), feat({})], "fid")
        self.assertEqual((st.features, st.missing, st.dups, st.examples), (4, 1, 1, ["ng:1"]))


class TestFiles(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)

    def test_max_zoom_comes_from_the_pmtiles_header(self):
        p = self.dir / "a.pmtiles"
        head = bytearray(127)
        head[:8] = b"PMTiles\x03"
        head[101] = 13
        p.write_bytes(bytes(head))
        self.assertEqual(stable_ids.pmtiles_max_zoom(p), 13)
        p.write_bytes(b"not an archive")
        with self.assertRaises(ValueError):
            stable_ids.pmtiles_max_zoom(p)

    def test_geojson_artifact_and_csv_input(self):
        with gzip.open(self.dir / "mines.geojson.gz", "wt") as f:
            json.dump({"type": "FeatureCollection",
                       "features": [feat({"mine_id": "0100003"}), feat({"mine_id": "0100004"})]}, f)
        rows = stable_ids.check_layer({"id": "mines", "id_field": "mine_id"}, self.dir)
        [(name, _, st)] = rows
        self.assertEqual((name, st.missing, st.dups, st.ids), ("mines.geojson.gz", 0, 0,
                                                              {"0100003", "0100004"}))
        src = self.dir / "in.csv"
        src.write_text("lon,lat,mine_id\n0,0,0100003\n0,0,0100003\n0,0,\n")
        self.assertEqual(stable_ids.read_input_ids(src, "mine_id"), ["0100003", "0100003", None])

    def test_a_plain_geojson_beside_its_gz_is_not_read_twice(self):
        fc = {"type": "FeatureCollection", "features": [feat({"mine_id": "1"})]}
        with gzip.open(self.dir / "mines.geojson.gz", "wt") as f:
            json.dump(fc, f)
        (self.dir / "mines.geojson").write_text(json.dumps(fc))
        [(name, _, st)] = stable_ids.check_layer({"id": "mines", "id_field": "mine_id"}, self.dir)
        self.assertEqual((name, st.dups), ("mines.geojson.gz", 0))

    def test_a_layer_with_nothing_built_has_no_rows(self):
        self.assertEqual(stable_ids.check_layer({"id": "x", "id_field": "fid"}, self.dir), [])


@unittest.skipUnless(shutil.which("tippecanoe") and shutil.which("tippecanoe-decode"),
                     "tippecanoe is not installed")
class TestTippecanoeRoundTrip(unittest.TestCase):
    """A long line crosses many tiles under one id; a true duplicate does not hide."""

    def build(self, d, name, rows):
        src = d / f"{name}.geojsonl"
        src.write_text("".join(json.dumps(r) + "\n" for r in rows))
        out = d / f"{name}.pmtiles"
        # Same native-id flags build_tiles.py adds; fid arrives as a string, as from a CSV.
        subprocess.run(["tippecanoe", "-q", "-o", str(out), "-l", name, "-z5", "-Z0",
                        "--use-attribute-for-id=fid", "-Tfid:int", "--force", str(src)], check=True)
        return out

    def line(self, fid, y=1.0):
        return {"type": "Feature", "properties": {"fid": fid, "name": "x"},
                "geometry": {"type": "LineString", "coordinates": [[-20, y], [20, y]]}}

    def test_round_trip(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        layer = {"id": "t_kv", "id_field": "fid", "native_id": True}
        self.build(d, "t_kv", [self.line("4535892832"), self.line("12")])
        [(_, z, st)] = stable_ids.check_layer(layer, d)
        self.assertEqual(z, 5)
        self.assertGreater(st.tiles, 2)
        self.assertGreater(st.features, st.tiles)       # the lines are cut into pieces
        self.assertEqual((st.missing, st.dups, st.ids), (0, 0, {"4535892832", "12"}))

        # A duplicate row tiles into the same tiles as the original.
        self.build(d, "t_kv", [self.line("12"), self.line("12", y=1.5)])
        [(_, _, st)] = stable_ids.check_layer(layer, d)
        self.assertEqual(st.dups, st.tiles)


class TestAttrs(unittest.TestCase):
    """--attrs: sampled tile features held to their input rows by id."""

    def sample(self, lines, id_field="ID", native=False, max_tiles=0):
        return stable_ids.sample_tiles(lines, id_field, native, max_tiles, random.Random(1))

    def check(self, lines, rows, id_field="ID", native=False, extra=()):
        feats = self.sample(lines, id_field, native)[0]
        found = stable_ids.index_rows(iter(rows), set(feats), id_field)
        return stable_ids.compare_attrs(feats, found, id_field, extra)

    def test_pieces_of_one_feature_are_counted_once_per_piece(self):
        lines = tile(3, 0, 0, feat({"ID": "1", "SUB_1": "A"})) + tile(3, 1, 0, feat({"ID": "1", "SUB_1": "A"}))
        feats, tiles, kept, no_id = self.sample(lines)
        self.assertEqual((feats, tiles, kept, no_id), ({"1": {'{"SUB_1": "A"}': 2}}, 2, 2, 0))

    def test_a_string_from_another_feature_is_a_mismatch(self):
        lines = tile(3, 0, 0, feat({"ID": "1", "SUB_1": "B"}), feat({"ID": "2", "SUB_1": "B"}))
        checked, bad, by_field, examples = self.check(
            lines, [{"ID": "1", "SUB_1": "A"}, {"ID": "2", "SUB_1": "B"}])
        self.assertEqual((checked, bad, by_field), (2, 1, {"SUB_1": 1}))
        self.assertEqual(examples, ["ID=1 SUB_1: tile 'B', input 'A'"])

    def test_an_id_no_input_row_has_is_a_mismatch(self):
        lines = tile(3, 0, 0, feat({"ID": "|MN|", "SUB_1": "A"}))
        _, bad, by_field, _ = self.check(lines, [{"ID": "1", "SUB_1": "A"}])
        self.assertEqual((bad, by_field), (1, {"(id not in input)": 1}))

    def test_values_compare_by_value_and_nulls_the_tile_drops_are_fine(self):
        lines = tile(3, 0, 0, feat({"ID": 7, "kv": 345, "name": "x"}))
        rows = [{"ID": "7", "kv": 345.0, "name": "x", "owner": None, "minz": 4}]
        self.assertEqual(self.check(lines, rows)[1], 0)
        self.assertEqual(self.check(tile(3, 0, 0, feat({"ID": 7, "kv": "345"})), rows)[1], 1)

    def test_a_repeated_input_id_matches_any_of_its_rows(self):
        lines = tile(3, 0, 0, feat({"ID": "1", "SUB_1": "B"}))
        rows = [{"ID": "1", "SUB_1": "A"}, {"ID": "1", "SUB_1": "B"}]
        self.assertEqual(self.check(lines, rows)[1], 0)

    def test_native_ids_and_the_region_fields_a_world_build_adds(self):
        lines = tile(3, 0, 0, feat({"name": "x", "countries": "|US|"}, 45))
        rows = [{"fid": "45", "name": "x"}]
        self.assertEqual(self.check(lines, rows, "fid", True, {"countries"})[1], 0)
        self.assertEqual(self.check(lines, rows, "fid", True)[2], {"countries": 1})
        self.assertEqual(self.check(tile(3, 0, 0, feat({"name": "x"})), rows, "fid", True)[0], 0)

    def test_the_tile_sample_is_capped(self):
        lines = [ln for i in range(50) for ln in tile(5, i, 0, feat({"ID": str(i)}))]
        feats, tiles, kept, _ = self.sample(lines, max_tiles=10)
        self.assertEqual((len(feats), tiles, kept), (10, 50, 10))
        self.assertGreater(max(map(int, feats)), 10)     # not just the first ten

    def test_a_world_layer_reads_the_continental_inputs_in_dedupe_order(self):
        self.kept_fixture([]).joinpath("world", "osm_generators.geojsonl.gz").unlink()   # no kept file
        srcs, select, fields = tile_inputs.world_spec("osm_generators")
        self.assertEqual([p.name for p in srcs][:2], ["generator_osm_na.csv", "generator_osm_eu.csv"])
        self.assertIn("fid", select)
        self.assertIn("countries", fields)
        self.assertIsNone(tile_inputs.world_spec("hifld_transmission_lines"))

    def kept_fixture(self, rows):
        import build_global_tiles as g
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        (d / "world").mkdir()
        with gzip.open(d / "world" / "osm_generators.geojsonl.gz", "wt") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        p = mock.patch.object(g, "BUILD_DIR", d)
        p.start()
        self.addCleanup(p.stop)
        return d

    GEN = [{"type": "Feature", "id": 7, "properties": {"fid": 7, "name": "a", "countries": "|US|"},
            "geometry": {"type": "Point", "coordinates": [1, 2]}}]

    def test_the_kept_file_is_preferred_when_present(self):
        d = self.kept_fixture(self.GEN)
        srcs, select, fields = tile_inputs.world_spec("osm_generators")
        self.assertEqual(srcs, [d / "world" / "osm_generators.geojsonl.gz"])
        self.assertEqual(tuple(fields), ())
        self.assertIn("fid", select)

    def test_without_a_kept_file_the_continental_inputs_are_read(self):
        import build_global_tiles as g
        with mock.patch.object(g, "BUILD_DIR", Path(tempfile.mkdtemp())):
            srcs, _, fields = tile_inputs.world_spec("osm_generators")
        self.assertEqual(srcs[0].name, "generator_osm_na.csv")
        self.assertIn("countries", fields)

    def test_geometry_is_yielded_on_request(self):
        d = self.kept_fixture(self.GEN)
        src = d / "world" / "osm_generators.geojsonl.gz"
        self.assertNotIn("__geometry", next(tile_inputs.stream_rows(src, [])))
        row = next(tile_inputs.stream_rows(src, [], geometry=True))
        self.assertEqual(row["__geometry"], {"type": "Point", "coordinates": [1, 2]})
        self.assertEqual(row["fid"], 7)

    def attrs_mismatches(self, region):
        self.kept_fixture(self.GEN)
        srcs, _, extra = tile_inputs.input_rows({"id": "osm_generators"})
        found = stable_ids.index_rows((r for s in srcs for r in tile_inputs.stream_rows(s, [])),
                                      {"7"}, "fid")
        feats = {"7": {json.dumps({"fid": 7, "name": "a", "countries": region}): 1}}
        return stable_ids.compare_attrs(feats, found, "fid", extra)[1]

    def test_attrs_from_a_kept_file_compares_the_region_fields(self):
        self.assertEqual(self.attrs_mismatches("|US|"), 0)
        self.assertEqual(self.attrs_mismatches("|MX|"), 1)

    @unittest.skipUnless(shutil.which("tippecanoe") and shutil.which("tippecanoe-decode"),
                         "tippecanoe is not installed")
    def test_round_trip_through_tippecanoe(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        rows = [{"type": "Feature", "properties": {"ID": str(i), "SUB_1": f"UNKNOWN{i}", "kv": 115.0},
                 "geometry": {"type": "LineString", "coordinates": [[-20, i / 10], [20, i / 10]]}}
                for i in range(200)]
        src, out = d / "in.geojsonl", d / "t.pmtiles"
        src.write_text("".join(json.dumps(r) + "\n" for r in rows))
        subprocess.run(["tippecanoe", "-q", "-o", str(out), "-l", "t", "-z4", "-Z0", "--force",
                        str(src)], check=True)
        proc = subprocess.run(["tippecanoe-decode", "-z", "4", "-Z", "4", str(out)],
                              capture_output=True, text=True, check=True)
        lines = proc.stdout.splitlines()
        props = list(tile_inputs.stream_rows(src, []))
        self.assertEqual(self.check(lines, props)[:2], (self.check(lines, props)[0], 0))
        self.assertGreater(self.check(lines, props)[0], 200)
        props[3]["SUB_1"] = "UNKNOWN4"
        self.assertGreater(self.check(lines, props)[1], 0)


HAVE_STACK = all(importlib.util.find_spec(m) for m in
                 ("numpy", "pyarrow", "shapely", "pyogrio", "scipy", "yaml"))
FIXTURES = Path(__file__).resolve().parent.parent / "assets" / "lines" / "fixtures"


@unittest.skipUnless(HAVE_STACK, "numpy/pyarrow/shapely/pyogrio/scipy/PyYAML not installed")
class TestGeometryKinds(unittest.TestCase):
    """--lines dispatches on each dataset's manifest `geometry`; without
    tippecanoe these fail rather than skip."""

    def setUp(self):
        self.assertTrue(shutil.which("tippecanoe") and shutil.which("tippecanoe-decode"),
                        "tippecanoe and tippecanoe-decode are needed (not a skip)")
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)

    def square(self, x, y, w):
        import shapely
        return shapely.box(x, y, x + w, y + w)

    def test_polygon_distance_opens_each_side_and_clips_to_the_tile(self):
        import shapely
        z, where = 12, "12/2104/1473"
        x0, y0, _, _ = stable_ids.tile_box(where)
        ll = lambda g: shapely.transform(g, lambda xy: stable_ids.lonlat(xy, z))  # noqa: E731
        geo = ll(self.square(x0 + 100, y0 + 100, 200))
        self.assertAlmostEqual(stable_ids.polygon_vs_geo_units(geo, geo, z, where), 0, places=6)
        # one corner moved 5 units outward
        moved = ll(shapely.Polygon([(x0 + 100, y0 + 100), (x0 + 300, y0 + 100), (x0 + 305, y0 + 305),
                                    (x0 + 100, y0 + 300)]))
        self.assertAlmostEqual(stable_ids.polygon_vs_geo_units(moved, geo, z, where), 6.62, places=1)
        # a GEO part 0.5 units thin and 50 long that the piece lacks is opened away
        sliver = shapely.box(x0 + 1000, y0 + 100, x0 + 1050, y0 + 100.5)
        geo2 = ll(shapely.MultiPolygon([self.square(x0 + 100, y0 + 100, 200), sliver]))
        piece = ll(self.square(x0 + 100, y0 + 100, 200))
        self.assertLessEqual(stable_ids.polygon_vs_geo_units(piece, geo2, z, where), 2.5)
        # a polygon over the tile edge: only the part inside the box is compared
        geo = ll(self.square(x0 - 300, y0 + 100, 400))
        piece = ll(shapely.box(x0 - 20, y0 + 100, x0 + 100, y0 + 500))   # cut 20 units into the buffer
        self.assertAlmostEqual(stable_ids.polygon_vs_geo_units(piece, geo, z, where), 0, places=4)
        # a piece only in the buffer, its polygon reaching 6 units into the tile
        geo = ll(self.square(x0 - 300, y0 + 100, 306))
        piece = ll(shapely.box(x0 - 20, y0 + 100, x0 - 1, y0 + 402))
        d = stable_ids.polygon_vs_geo_units(piece, geo, z, where)
        self.assertTrue(6 < d < 8, d)

    def test_line_vertices_are_held_to_the_interior_and_edge_limits(self):
        import shapely
        z, where = 12, "12/2104/1473"
        x0, y0, _, _ = stable_ids.tile_box(where)
        ll = lambda g: shapely.transform(g, lambda xy: stable_ids.lonlat(xy, z))  # noqa: E731
        geo = ll(shapely.LineString([(x0 - 500, y0 + 1000), (x0 + 3000, y0 + 1000)]))
        line = lambda *pts: ll(shapely.LineString(pts))  # noqa: E731
        inner, edge = stable_ids.tile_vs_geo_units(line((x0 + 100, y0 + 1000), (x0 + 500, y0 + 1000)), geo, z, where)
        self.assertAlmostEqual(inner, 0, places=4)
        self.assertIsNone(edge)
        # an interior vertex 1.0 off exceeds INTERIOR; the same offset 0.5 does not
        inner, edge = stable_ids.tile_vs_geo_units(line((x0 + 100, y0 + 1001), (x0 + 500, y0 + 1000)), geo, z, where)
        self.assertAlmostEqual(inner, 1.0, places=3)
        self.assertGreater(inner, stable_ids.INTERIOR_TOLERANCE_UNITS)
        # edge vertices (on the box edge, in the buffer): 2.0 passes, 3.0 fails
        for off, ok in ((2.0, True), (3.0, False)):
            inner, edge = stable_ids.tile_vs_geo_units(
                line((x0, y0 + 1000 + off), (x0 + 500, y0 + 1000)), geo, z, where)
            self.assertAlmostEqual(edge, off, places=3)
            self.assertAlmostEqual(inner, 0, places=3)
            self.assertEqual(edge <= stable_ids.EDGE_TOLERANCE_UNITS, ok)
        # a point is always interior, wherever it lies
        pt = ll(shapely.Point(x0 + 0.5, y0 + 1001.0))
        inner, edge = stable_ids.tile_vs_geo_units(pt, geo, z)
        self.assertAlmostEqual(inner, 1.0, places=3)
        self.assertIsNone(edge)

    def test_polygon_compare_rules(self):
        import shapely
        z, where = 12, "12/2104/1473"
        x0, y0, _, _ = stable_ids.tile_box(where)
        ll = lambda g: shapely.transform(g, lambda xy: stable_ids.lonlat(xy, z))  # noqa: E731
        # both opened sides empty: thinner than 2 units
        a, b = ll(shapely.box(x0 + 100, y0 + 100, x0 + 600, y0 + 101.5)), ll(shapely.box(x0 + 100, y0 + 700, x0 + 600, y0 + 701.5))
        self.assertEqual(stable_ids.polygon_compare(a, b, z, where), (None, "thin"))
        self.assertIsNone(stable_ids.polygon_vs_geo_units(a, b, z, where))
        # both clipped empty: outside the tile
        out = ll(self.square(x0 - 500, y0 + 100, 100))
        self.assertEqual(stable_ids.polygon_compare(out, out, z, where), (None, "empty"))
        # one side empty after clipping: measured against the other, unclipped
        geo = ll(self.square(x0 - 300, y0 + 100, 306))
        piece = ll(shapely.box(x0 - 20, y0 + 100, x0 - 1, y0 + 402))
        self.assertIsNotNone(stable_ids.polygon_vs_geo_units(piece, geo, z, where))
        # a missing part wider than the opening is still caught
        part = self.square(x0 + 1000, y0 + 100, 10)
        geo = ll(shapely.MultiPolygon([self.square(x0 + 100, y0 + 100, 200), part]))
        piece = ll(self.square(x0 + 100, y0 + 100, 200))
        self.assertGreater(stable_ids.polygon_vs_geo_units(piece, geo, z, where), 2.5)

    def test_the_fixture_index_with_its_polygons(self):
        from test_check_geometry_parquet import build_polygon_archive
        layers = self.dir / "layers"
        build_polygon_archive(FIXTURES / "build" / "world" / "osm_substations_polygons.geojsonl.gz",
                              layers / "osm_substations_polygons.pmtiles")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertTrue(stable_ids.check_lines(FIXTURES / "analysis", layers, MANIFEST,
                                                   only={"osm_substations_polygons"}))
        self.assertIn("osm_substations_polygons (polygon): tiles z12 5 ids", out.getvalue())
        self.assertIn("missing 0", out.getvalue())
        # the whole index: the line datasets have no archive here, which fails, never crashes
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertFalse(stable_ids.check_lines(FIXTURES / "analysis", layers, MANIFEST))
        text = out.getvalue()
        self.assertIn("osm_transmission_lines: [FAIL] no served archive", text)
        self.assertRegex(text, r"osm_substations_polygons \(polygon\).*· OK")

    def write_dataset(self, ds, kind, fids, geoms, fid_type=None):
        """A minimal IDX + GEO pair and its index.json entry."""
        import pyarrow as pa
        import pyarrow.parquet as pq
        import shapely
        d = self.dir / "analysis" / ds
        d.mkdir(parents=True)
        pq.write_table(pa.table({"fid": pa.array(fids, fid_type or pa.int64()), "row": list(range(len(fids)))}),
                       d / "i.parquet")
        pq.write_table(pa.table({"fid": pa.array(fids, fid_type or pa.int64()),
                                 "geometry": shapely.to_wkb(geoms).tolist()}), d / "g.parquet")
        m = {"path": f"{ds}/", "dataset": ds, "idx": {"name": "i.parquet"},
             "geo": [{"name": "g.parquet", "rows": len(fids), "row_offset": 0}], "chains": None}
        if kind:
            m["geometry"] = kind
        return m

    def test_a_moved_line_vertex_fails_the_check_on_its_own_limit(self):
        self.moved_line_vertex("osm_pipelines_lines", "fid")

    def test_railroads_are_held_to_the_line_rule_on_their_native_int_id(self):
        import yaml
        layer = next(L for L in yaml.safe_load(MANIFEST.read_text())["layers"] if L["id"] == "railroads")
        self.assertEqual((layer["id_field"], layer["native_id"]), ("FRAARCID", True))
        self.assertNotIn("railroads", stable_ids.POLYGON_TOLERANCE_BY_DATASET)
        self.assertNotIn("railroads", stable_ids.GEOJSON_AREA_DIFF_BY_DATASET)
        self.moved_line_vertex("railroads", "FRAARCID")

    def moved_line_vertex(self, ds, field):
        import numpy as np
        import shapely
        z = 12
        x0, y0, _, _ = stable_ids.tile_box("12/2104/1473")
        ll = lambda pts: shapely.LineString(stable_ids.lonlat(np.array(pts, float), z))  # noqa: E731
        # fid 1 stays inside one tile; fid 2 crosses into the next, so its clip points sit on the buffer
        tile = {1: [(x0 + 500, y0 + 1000), (x0 + 2000, y0 + 1500), (x0 + 3500, y0 + 1000)],
                2: [(x0 + 1000, y0 + 2000), (x0 + 7096, y0 + 2000)]}
        src = self.dir / "l.geojsonl"
        src.write_text("".join(json.dumps({"type": "Feature", "properties": {field: f}, "geometry": {
            "type": "LineString", "coordinates": [list(c) for c in ll(pts).coords]}}) + "\n"
            for f, pts in tile.items()))
        layers = self.dir / "layers"
        layers.mkdir()
        subprocess.run(["tippecanoe", "-q", "-o", str(layers / f"{ds}.pmtiles"), "-z12", "-Z2",
                        f"--use-attribute-for-id={field}", f"-T{field}:int", "--force", str(src)], check=True)
        layer = {"id": ds, "id_field": field, "native_id": True}

        def run(geo):
            d = self.dir / "analysis"
            shutil.rmtree(d, ignore_errors=True)
            m = self.write_dataset(ds, "line", [1, 2], [ll(geo[1]), ll(geo[2])])
            return stable_ids.check_dataset(ds, m, d, layer, layers)

        r = run(tile)
        self.assertTrue(r["ok"], r["text"])
        self.assertIn("edge max", r["text"])
        # an interior vertex 1.5 units off: only the interior half can catch it
        moved = {**tile, 1: [tile[1][0], (tile[1][1][0], tile[1][1][1] + 1.5), tile[1][2]]}
        r = run(moved)
        self.assertFalse(r["ok"], r["text"])
        self.assertGreater(r["geo_max"], stable_ids.INTERIOR_TOLERANCE_UNITS)
        self.assertLessEqual(r["edge_max"], stable_ids.EDGE_TOLERANCE_UNITS)
        # the line bent 6 units where the next tile's buffer starts: only the edge half can catch it
        bent = {**tile, 2: [tile[2][0], (tile[2][0][0] + 3176, y0 + 2006), tile[2][1]]}
        r = run(bent)
        self.assertFalse(r["ok"], r["text"])
        self.assertLessEqual(r["geo_max"], stable_ids.INTERIOR_TOLERANCE_UNITS)
        self.assertGreater(r["edge_max"], stable_ids.EDGE_TOLERANCE_UNITS)

    def test_the_geojson_area_limit_is_per_dataset(self):
        import pyarrow as pa
        import shapely
        geoms = [self.square(10 + 3 * i, 10, 1) for i in range(2)]
        # 8 % of each polygon's area differs: past 0.05, inside control_areas' 0.10
        wide = [shapely.Polygon([(x + (0.08 if x > g.bounds[0] + 0.5 else 0), y) for x, y in g.exterior.coords]) for g in geoms]
        for ds, field, ok in (("control_areas", "id", True), ("eia_ba", "abbrev", False)):
            with self.subTest(ds):
                ids = ["A", "B"]
                layers = self.dir / ds
                layers.mkdir()
                (layers / f"{ds}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
                    {"type": "Feature", "properties": {field: n}, "geometry": json.loads(shapely.to_geojson(g))}
                    for n, g in zip(ids, wide)]}))
                m = self.write_dataset(ds, "polygon", ids, geoms, pa.string())
                r = stable_ids.check_dataset(ds, m, self.dir / "analysis", {"id": ds, "id_field": field}, layers)
                self.assertEqual(r["ok"], ok, r["text"])
                self.assertGreater(r["geo_max"], 0.05)
                self.assertLess(r["geo_max"], 0.10)

    def test_simplified_geojson_regions_are_judged_on_ids_only_and_tribal_lands_bia_boem_by_area(self):
        import pyarrow as pa
        import shapely
        geoms = [self.square(10 + 3 * i, 10, 1) for i in range(2)]
        # served outlines half the GEO area: an area difference of 0.5
        half = [shapely.Polygon([(x - (0.5 if x > g.bounds[0] + 0.5 else 0), y) for x, y in g.exterior.coords]) for g in geoms]
        cases = (("us_states", "stusps", ["WA", "OR"]), ("countries", "iso_a3", ["NZL", "115"]),
                 ("admin1_boundaries", "code", ["1", "2"]), ("tribal_lands", "geoid", ["4075T", "0010R"]),
                 ("bia_tribal_lands", "LARID", ["LAR0001", "LAR0335"]), ("boem_wind_leases", "fid", ["0a1b2c3d4e5f", "ffeeddccbbaa"]))
        by_area = ("tribal_lands", "bia_tribal_lands", "boem_wind_leases")
        for ds, field, ids in cases:
            m = self.write_dataset(ds, "polygon", ids, geoms, pa.string())
            for served_ids, ok in ((ids, ds not in by_area), ([ids[0], "ZZ"], False)):
                with self.subTest(ds=ds, served=served_ids[-1]):
                    layers = self.dir / f"{ds}-{served_ids[-1]}"
                    layers.mkdir()
                    (layers / f"{ds}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
                        {"type": "Feature", "properties": {field: n}, "geometry": json.loads(shapely.to_geojson(g))}
                        for n, g in zip(served_ids, half)]}))
                    r = stable_ids.check_dataset(ds, m, self.dir / "analysis", {"id": ds, "id_field": field}, layers)
                    self.assertEqual(r["ok"], ok, r["text"])
                    self.assertGreater(r["geo_max"], 0.3)
                    self.assertEqual(r["tolerance"], None if ds not in by_area else stable_ids.GEOJSON_AREA_DIFF)

    def test_a_dataset_served_as_geojson_is_checked_for_ids_and_area(self):
        import pyarrow as pa
        import shapely
        ds = "nerc_regions"
        ids = ["CA-MX US", "NWPP", "ERCOT"]
        layers = self.dir / "layers"
        layers.mkdir()
        geoms = [self.square(10 + 3 * i, 10, 1) for i in range(3)]

        def served(names, shapes=geoms):
            (layers / f"{ds}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {"sub_nm": n}, "geometry": json.loads(shapely.to_geojson(g))}
                for n, g in zip(names, shapes)]}))
        layer = {"id": ds, "id_field": "sub_nm"}
        m = self.write_dataset(ds, "polygon", ids, geoms, pa.string())
        d = self.dir / "analysis"
        # an outline off by 0.4 % of the area passes
        served(ids, [shapely.Polygon([(x + 0.004, y) for x, y in g.exterior.coords]) for g in geoms])
        r = stable_ids.check_dataset(ds, m, d, layer, layers)
        self.assertTrue(r["ok"], r["text"])
        self.assertIn("served GeoJSON vs GEO 3 features", r["text"])
        self.assertIn("GeoJSON 3 ids", r["text"])
        self.assertIn("missing 0", r["text"])
        self.assertEqual(r["tolerance"], stable_ids.GEOJSON_AREA_DIFF)
        self.assertIn("area difference max", r["text"])
        self.assertIn("(≤ 0.05)", r["text"])
        self.assertEqual(r["pieces"], [])
        # a feature shifted by more than its own width fails; so do two features with swapped shapes
        served(ids, [geoms[0], geoms[1], shapely.Polygon([(x + 2, y) for x, y in geoms[2].exterior.coords])])
        r = stable_ids.check_dataset(ds, m, d, layer, layers)
        self.assertFalse(r["ok"], r["text"])
        self.assertGreater(r["geo_max"], r["tolerance"])
        served(ids, [geoms[1], geoms[0], geoms[2]])
        r = stable_ids.check_dataset(ds, m, d, layer, layers)
        self.assertFalse(r["ok"], r["text"])
        self.assertGreater(r["geo_max"], 1)
        served(ids)
        # a served id IDX lacks fails; so does a repeated one
        served(ids + ["NEW"], geoms + [geoms[0]])
        r = stable_ids.check_dataset(ds, m, d, layer, layers)
        self.assertFalse(r["ok"], r["text"])
        self.assertEqual(r["missing"], 1)
        served(ids + ["NWPP"], geoms + [geoms[1]])
        r = stable_ids.check_dataset(ds, m, d, layer, layers)
        self.assertFalse(r["ok"], r["text"])
        self.assertIn("tile dups 1", r["text"])
        # a feature without an id fails
        (layers / f"{ds}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {}, "geometry": None}]}))
        r = stable_ids.check_dataset(ds, m, d, layer, layers)
        self.assertFalse(r["ok"], r["text"])
        self.assertIn("without an id 1", r["text"])
        # an IDX row pointing at another fid's GEO row fails
        served(ids)
        shutil.rmtree(d)
        m = self.write_dataset(ds, "polygon", ids, geoms, pa.string())
        import pyarrow.parquet as pq
        p = d / ds / "i.parquet"
        t = pq.read_table(p).to_pydict()
        t["row"] = [1, 0, 2]
        pq.write_table(pa.table(t), p)
        r = stable_ids.check_dataset(ds, m, d, layer, layers)
        self.assertFalse(r["ok"], r["text"])
        self.assertIn("pointer errors 2/3", r["text"])
        # no served file at all fails, never crashes
        (layers / f"{ds}.geojson").unlink()
        self.assertFalse(stable_ids.check_dataset(ds, m, d, layer, layers)["ok"])

    def test_retail_territories_are_held_to_a_placement_ceiling_and_none_judges_ids_only(self):
        import numpy as np
        import shapely
        z, ds = 12, "retail_territories"
        x0, y0, _, _ = stable_ids.tile_box("12/2104/1473")
        ll = lambda g: shapely.transform(g, lambda xy: stable_ids.lonlat(np.asarray(xy, float), z))  # noqa: E731
        tile = shapely.box(x0 + 500, y0 + 500, x0 + 1500, y0 + 1500)
        src = self.dir / "r.geojsonl"
        src.write_text(json.dumps({"type": "Feature", "properties": {"id": "40429"},
                                   "geometry": json.loads(shapely.to_geojson(ll(tile)))}) + "\n")
        layers = self.dir / "layers"
        layers.mkdir()
        subprocess.run(["tippecanoe", "-q", "-o", str(layers / f"{ds}.pmtiles"), "-z12", "-Z2", "--force", str(src)],
                       check=True)
        layer = {"id": ds, "id_field": "id"}

        def run(geo, fid="40429"):
            import pyarrow as pa
            shutil.rmtree(self.dir / "analysis", ignore_errors=True)
            m = self.write_dataset(ds, "polygon", [fid], [ll(geo)], pa.string())
            return stable_ids.check_dataset(ds, m, self.dir / "analysis", layer, layers)

        near = shapely.box(x0 + 500, y0 + 500, x0 + 1500, y0 + 1520)       # 20 units off: simplification-sized
        far = shapely.box(x0 + 500, y0 + 2000, x0 + 1500, y0 + 3000)       # a shifted feature
        self.assertEqual(stable_ids.POLYGON_TOLERANCE_BY_DATASET[ds], 400.0)
        r = run(near)
        self.assertTrue(r["ok"], r["text"])
        self.assertEqual(r["tolerance"], 400.0)
        self.assertTrue(run(tile)["ok"])
        r = run(far)
        self.assertFalse(r["ok"], r["text"])
        self.assertGreater(r["geo_max"], 400)
        # None reports the measure and judges ids only
        with mock.patch.dict(stable_ids.POLYGON_TOLERANCE_BY_DATASET, {ds: None}):
            r = run(far)
            self.assertTrue(r["ok"], r["text"])
            self.assertIsNone(r["tolerance"])
            self.assertIn("geometry not judged", r["text"])
            r = run(far, fid="other")
            self.assertFalse(r["ok"], r["text"])
            self.assertEqual(r["missing"], 1)
        # a number in the table sets the limit
        with mock.patch.dict(stable_ids.POLYGON_TOLERANCE_BY_DATASET, {ds: 2.5}):
            self.assertFalse(run(near)["ok"])
        # a dataset not in the table keeps the default
        self.assertEqual(stable_ids.geometry_tolerance("osm_plants_polygons", {"geometry": "polygon"}, "pmtiles"),
                         stable_ids.POLYGON_TOLERANCE_UNITS)

    def test_a_point_dataset_and_an_unknown_kind_do_not_crash(self):
        import shapely
        pts = [(10.000001, 50.000003), (10.5, 50.25), (-3.123457, 40.0)]
        fids = [7, 8, 9]
        m = self.write_dataset("osm_substations_points", "point", fids, shapely.points(pts))
        src = self.dir / "p.geojsonl"
        src.write_text("".join(json.dumps({"type": "Feature", "properties": {"fid": f},
                                           "geometry": {"type": "Point", "coordinates": list(p)}}) + "\n"
                               for f, p in zip(fids, pts)))
        layers = self.dir / "layers"
        layers.mkdir()
        subprocess.run(["tippecanoe", "-q", "-o", str(layers / "osm_substations_points.pmtiles"),
                        "-z13", "-Z0", "-r1", "--use-attribute-for-id=fid", "-Tfid:int", "--force",
                        str(src)], check=True)
        bad = dict(m, geometry="raster")
        (self.dir / "analysis" / "index.json").write_text(json.dumps(
            {"version": 1, "datasets": {"osm_substations_points": m}}))
        layer = {"id": "osm_substations_points", "id_field": "fid", "native_id": True}
        r = stable_ids.check_dataset("osm_substations_points", m, self.dir / "analysis", layer, layers)
        self.assertTrue(r["ok"], r["text"])
        self.assertEqual((r["missing"], len(r["pieces"])), (0, 3))
        self.assertLess(r["geo_max"], 1)
        r = stable_ids.check_dataset("osm_substations_points", bad, self.dir / "analysis", layer, layers)
        self.assertFalse(r["ok"])
        self.assertIn("unknown geometry 'raster'", r["text"])
        # a dataset without `geometry` is read as lines; a point is a degenerate line here
        self.assertEqual(stable_ids.check_dataset(
            "osm_substations_points", {k: v for k, v in m.items() if k != "geometry"},
            self.dir / "analysis", layer, layers)["tolerance"], stable_ids.INTERIOR_TOLERANCE_UNITS)


class TestManifestIds(unittest.TestCase):
    """Every declared id is tiled: it sits in `select` whenever one is given."""

    def test_id_fields_are_selected(self):
        try:
            import yaml
        except ImportError:  # the stdlib-only CI runners; `make test-pipeline` has it
            self.skipTest("PyYAML is not installed")
        doc = yaml.safe_load(MANIFEST.read_text())
        for L in doc["layers"] + doc.get("built_elsewhere", []):
            with self.subTest(layer=L["id"]):
                if L.get("native_id"):
                    self.assertIn("id_field", L)
                if L.get("id_field") and L.get("select"):
                    self.assertIn(L["id_field"], L["select"])


if __name__ == "__main__":
    unittest.main()
