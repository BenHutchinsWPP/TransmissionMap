"""Tests for check_columns_parquet.py — the columns Parquet held to the tiles and IDX.

The decode-parsing tests are stdlib. The fixture runs need tippecanoe and pyarrow
(the venv) and skip without them.
"""
import contextlib
import importlib.util
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import check_columns_parquet as ccp

HAVE_PYARROW = importlib.util.find_spec("pyarrow") is not None
HAVE_TIPPECANOE = shutil.which("tippecanoe") and shutil.which("tippecanoe-decode")
DS = "osm_transmission_lines"

ROWS = [  # fid, kv, name, admin1, length_km, lon
    (101, 345.0, "A", "|USAB|", 80.5, -100.0),
    (102, 138, "7", "|USAB|USA1|", 60.25, -98.0),
    (103, 69, "C", "|USA1|", 5.0, -90.0),      # not in the tiles
]


def feature(fid, kv, name, admin1, lon):
    return {"type": "Feature", "properties": {"fid": fid, "nominal_kv": kv, "name": name, "admin1": admin1},
            "geometry": {"type": "LineString", "coordinates": [[lon, 31.0], [lon + 1, 31.5]]}}


class DecodeParsing(unittest.TestCase):
    LINES = [
        '{ "type": "Feature", "id": 101, "properties": { "nominal_kv": 345, "name": "A" }, "geometry": {} }\n',
        ',\n',
        '{ "type": "Feature", "id": 101, "properties": { "name": "A", "nominal_kv": 345.0 }, "geometry": {} }\n',
        '{ "type": "Feature", "id": 102, "properties": { "name": "B", "x": null }, "geometry": {} }\n',
    ]

    def test_pieces_dedupe_and_agree_by_value(self):
        tiles, st = ccp.read_tiles(None, "fid", True, lines=iter(self.LINES))
        self.assertEqual(set(tiles), {"101", "102"})
        self.assertEqual(st["features"], 3)
        self.assertEqual(st["disagree"], [])

    def test_disagreeing_pieces_reported(self):
        lines = self.LINES[:1] + ['{ "type": "Feature", "id": 101, "properties": { "nominal_kv": 138, "name": "A" }, "geometry": {} }\n']
        _, st = ccp.read_tiles(None, "fid", True, lines=iter(lines))
        self.assertEqual(st["disagree"], ["101"])

    def test_string_is_not_a_number(self):
        self.assertNotEqual(ccp.digest({"a": "345"}), ccp.digest({"a": 345}))
        self.assertEqual(ccp.digest({"a": 345.0}), ccp.digest({"a": 345}))


@unittest.skipUnless(HAVE_PYARROW and HAVE_TIPPECANOE, "needs pyarrow and tippecanoe")
class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.layers = self.tmp / "layers"
        self.analysis = self.tmp / "analysis"
        self.layers.mkdir()
        (self.analysis / "columns").mkdir(parents=True)
        (self.analysis / DS).mkdir()
        src = self.tmp / "in.geojsonl"
        src.write_text("".join(json.dumps(feature(f, kv, n, a, lon)) + "\n" for f, kv, n, a, _, lon in ROWS[:2]))
        subprocess.run(["tippecanoe", "-q", "-f", "-o", str(self.layers / f"{DS}.pmtiles"), "-l", DS,
                        "-z6", "-Z6", "--use-attribute-for-id=fid", "-T", "fid:int", str(src)], check=True)
        self.write_parquet(ROWS)
        self.write_idx({r[0]: r[4] for r in ROWS})

    def write_parquet(self, rows):
        import pyarrow as pa
        import pyarrow.parquet as pq
        t = pa.table({
            "fid": pa.array([r[0] for r in rows], pa.int64()),
            "nominal_kv": pa.array([r[1] for r in rows], pa.float64()),
            "name": pa.array([r[2] for r in rows]),
            "admin1": pa.array([r[3] for r in rows]),
            "length_km": pa.array([r[4] for r in rows], pa.float32()),
            "px": pa.array([round(r[5] * 1e6) for r in rows], pa.int32()),
            "py": pa.array([31_200_000] * len(rows), pa.int32()),
        })
        pq.write_table(t, self.analysis / "columns" / "c.parquet")
        self.rewrite_index(columns={DS: {"path": "columns/", "file": {"name": "c.parquet"},
                                         "id": {"field": "fid", "native": True}, "tiles_missing": None}})

    def write_idx(self, lengths):
        import pyarrow as pa
        import pyarrow.parquet as pq
        t = pa.table({"fid": pa.array(list(lengths), pa.int64()),
                      "length_km": pa.array(list(lengths.values()), pa.float32())})
        pq.write_table(t, self.analysis / DS / "i.parquet")
        self.rewrite_index(datasets={DS: {"path": DS + "/", "idx": {"name": "i.parquet"}}})

    def rewrite_index(self, **sections):
        p = self.analysis / "index.json"
        index = json.loads(p.read_text()) if p.exists() else {"version": 1, "other": {"keep": 1}}
        index.update(sections)
        p.write_text(json.dumps(index))

    def run_check(self, *extra):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ccp.main(["--only", DS, "--analysis-dir", str(self.analysis),
                           "--layers-dir", str(self.layers), "--manifest", "", *extra])
        return rc, buf.getvalue()

    def index(self):
        return json.loads((self.analysis / "index.json").read_text())

    def test_match_passes_and_reports_parquet_only(self):
        rc, out = self.run_check()
        self.assertEqual(rc, 0, out)
        self.assertIn("1 Parquet-only", out)
        idx = self.index()
        self.assertEqual(idx["columns"][DS]["tiles_missing"]["count"], 1)
        self.assertAlmostEqual(idx["columns"][DS]["tiles_missing"]["share"], 1 / 3, places=5)
        self.assertEqual(idx["other"], {"keep": 1})

    def test_attribute_mismatch_fails(self):
        rows = list(ROWS)
        rows[1] = (102, 139, "7", "|USAB|USA1|", 60.25, -98.0)
        self.write_parquet(rows)
        rc, out = self.run_check()
        self.assertEqual(rc, 1, out)
        self.assertIn("differing attributes", out)

    def test_string_where_tile_has_a_number_fails(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        p = self.analysis / "columns" / "c.parquet"
        t = pq.read_table(p)
        t = t.set_column(1, "nominal_kv", pa.array(["345", "138", "69"]))
        pq.write_table(t, p)
        rc, out = self.run_check()
        self.assertEqual(rc, 1, out)

    def test_tile_id_missing_from_parquet_fails(self):
        self.write_parquet(ROWS[1:])
        self.write_idx({r[0]: r[4] for r in ROWS[1:]})
        rc, out = self.run_check()
        self.assertEqual(rc, 1, out)
        self.assertIn("not in the Parquet", out)

    def test_float_px_is_refused(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        p = self.analysis / "columns" / "c.parquet"
        t = pq.read_table(p)
        t = t.set_column(t.column_names.index("px"), "px", pa.array([-100.0, -98.0, -90.0], pa.float32()))
        pq.write_table(t, p)
        with self.assertRaises(SystemExit):
            self.run_check()

    def test_idx_length_mismatch_fails(self):
        self.write_idx({101: 80.5, 102: 61.0, 103: 5.0})
        rc, out = self.run_check()
        self.assertEqual(rc, 1, out)
        self.assertIn("differs from IDX", out)

    def test_mutate_exits_zero_and_leaves_index(self):
        before = (self.analysis / "index.json").read_text()
        rc, out = self.run_check("--mutate")
        self.assertEqual(rc, 0, out)
        self.assertIn("caught", out)
        self.assertNotIn("MISSED", out)
        self.assertEqual((self.analysis / "index.json").read_text(), before)

    def test_emit_reference_splits_region_lists(self):
        out_dir = self.tmp / "ref"
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ccp.main(["--only", DS, "--analysis-dir", str(self.analysis),
                           "--layers-dir", str(self.layers), "--emit-reference", str(out_dir)])
        self.assertEqual(rc, 0)
        ref = json.loads((out_dir / "columns-reference.json").read_text())[DS]
        self.assertEqual(ref["admin1_all"]["USAB"], {"count": 2, "sum": 140.75})
        self.assertEqual(ref["admin1_all"]["USA1"], {"count": 2, "sum": 65.25})
        self.assertEqual(ref["admin1_US-TX"]["USA1"], {"count": 1, "sum": 60.25})


PTS = [  # fid, name, lon, lat (on the 1e-6 grid)
    (201, "P", -97.123457, 31.654321),
    (202, "Q", -96.5, 32.25),
]


@unittest.skipUnless(HAVE_PYARROW and HAVE_TIPPECANOE, "needs pyarrow and tippecanoe")
class PointFixture(unittest.TestCase):
    DSP = "osm_substations_points"

    def setUp(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.layers, self.analysis = self.tmp / "layers", self.tmp / "analysis"
        (self.analysis / "columns").mkdir(parents=True)
        self.layers.mkdir()
        src = self.tmp / "in.geojsonl"
        src.write_text("".join(json.dumps({"type": "Feature", "properties": {"fid": f, "name": n, "kv": 69.0},
                                           "geometry": {"type": "Point", "coordinates": [x, y]}}) + "\n"
                               for f, n, x, y in PTS))
        (self.tmp / "input").mkdir()
        shutil.copy(src, self.tmp / "input" / f"{self.DSP}.geojsonl")
        subprocess.run(["tippecanoe", "-q", "-f", "-o", str(self.layers / f"{self.DSP}.pmtiles"), "-l", self.DSP,
                        "-z13", "-Z13", "--use-attribute-for-id=fid", "-T", "fid:int", str(src)], check=True)
        self.write(0)

    def write(self, shift):
        import pyarrow as pa
        import pyarrow.parquet as pq
        pq.write_table(pa.table({
            "fid": pa.array([p[0] for p in PTS], pa.int64()),
            "name": pa.array([p[1] for p in PTS]),
            "kv": pa.array([69.0, 69.0], pa.float64()),
            "px": pa.array([round(p[2] * 1e6) + (shift if i == 0 else 0) for i, p in enumerate(PTS)], pa.int32()),
            "py": pa.array([round(p[3] * 1e6) for p in PTS], pa.int32()),
        }), self.analysis / "columns" / "c.parquet")
        (self.analysis / "index.json").write_text(json.dumps({"version": 1, "columns": {
            self.DSP: {"path": "columns/", "file": {"name": "c.parquet"},
                       "id": {"field": "fid", "native": True}, "geometry": "point",
                       "tiles_missing": None}}}))

    def run_check(self, *extra):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ccp.main(["--only", self.DSP, "--fixture", str(self.tmp), "--analysis-dir", str(self.analysis),
                           "--layers-dir", str(self.layers), "--manifest", "", *extra])
        return rc, buf.getvalue()

    def test_point_within_a_tile_unit_passes(self):
        rc, out = self.run_check()
        self.assertEqual(rc, 0, out)
        self.assertIn("2 compared exactly, 0 mismatches", out)

    def test_one_micro_degree_off_the_input_fails_the_input_comparison_only(self):
        self.write(1)
        rc, out = self.run_check()
        self.assertEqual(rc, 1, out)
        self.assertIn("1 mismatches", out)
        self.assertNotIn("px/py differ from the tile", out)

    def test_moved_point_fails(self):
        self.write(500)
        rc, out = self.run_check()
        self.assertEqual(rc, 1, out)
        self.assertIn("px/py differ", out)

    def test_mutate_catches_a_moved_point(self):
        rc, out = self.run_check("--mutate")
        self.assertEqual(rc, 0, out)
        self.assertIn("moved px of point id", out)
        self.assertIn("tile comparison: caught; input comparison: caught", out)
        self.assertNotIn("MISSED", out)


if __name__ == "__main__":
    unittest.main()
