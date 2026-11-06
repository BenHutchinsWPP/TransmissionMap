#!/usr/bin/env python3
"""Tests for stable_ids.py: synthetic decode streams and features, plus a real
tippecanoe round trip when it is installed. No data/ or network needed."""
import gzip
import json
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stable_ids  # noqa: E402

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
        layer = {"id": "t_kv", "id_field": "fid", "native_id": True, "split_voltage_bands": True}
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

        # Two band archives must not share an id.
        self.build(d, "t_kv", [self.line("12")])
        self.build(d, "t_kv_kv300", [self.line("12")])
        rows = stable_ids.check_layer(layer, d)
        self.assertEqual(rows[-1][0], "(across archives)")
        self.assertEqual(rows[-1][2].dups, 1)


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
        srcs, select, fields = stable_ids.world_spec("osm_generators")
        self.assertEqual([p.name for p in srcs][:2], ["generator_osm_na.csv", "generator_osm_eu.csv"])
        self.assertIn("fid", select)
        self.assertIn("countries", fields)
        self.assertIsNone(stable_ids.world_spec("hifld_transmission_lines"))

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
        props = list(stable_ids.stream_rows(src, []))
        self.assertEqual(self.check(lines, props)[:2], (self.check(lines, props)[0], 0))
        self.assertGreater(self.check(lines, props)[0], 200)
        props[3]["SUB_1"] = "UNKNOWN4"
        self.assertGreater(self.check(lines, props)[1], 0)


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
