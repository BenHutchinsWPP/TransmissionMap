#!/usr/bin/env python3
"""Tests for stable_ids.py: synthetic decode streams and features, plus a real
tippecanoe round trip when it is installed. No data/ or network needed."""
import gzip
import json
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
