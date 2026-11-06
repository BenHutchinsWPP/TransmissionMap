"""Tests for build_columns_parquet.py — attribute-only Parquet of tiled datasets.

The index-safety tests are stdlib and run under `python3 -S`. The fixture builds
need numpy, pyarrow and shapely (the venv) and skip without them.
"""
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import build_columns_parquet as bcp
import build_line_parquet as blp

HAVE_STACK = all(importlib.util.find_spec(m) for m in ("numpy", "pyarrow", "shapely"))
BIG = 2 ** 33 + 7


def point(x, y):
    return {"type": "Point", "coordinates": [x, y]}


def line_row(fid, kv, name, x, countries="|USA|", counties="|48001|", geom=None):
    props = {"fid": fid, "nominal_kv": kv, "name": name, "countries": countries, "counties": counties}
    return {"type": "Feature", "properties": props,
            "geometry": geom or {"type": "LineString", "coordinates": [[x, 0.0], [x + 1.0, 0.0]]}}


LINE_FIELDS = {"nominal_kv": "Number", "name": "String", "countries": "String", "counties": "String"}


def write_fixture(root, ds, rows, fields, extra_fields=None):
    inp = Path(root) / "input"
    inp.mkdir(parents=True, exist_ok=True)
    (inp / f"{ds}.geojsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    fp = inp / "fields.json"
    allf = json.loads(fp.read_text()) if fp.exists() else {}
    allf[ds] = fields
    fp.write_text(json.dumps(allf))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = self.tmp / "analysis"

    def build(self, *extra):
        return bcp.main(["--fixture", str(self.tmp), *extra])

    def index(self):
        return json.loads((self.out / "index.json").read_text())

    def table(self, ds):
        import pyarrow.parquet as pq
        name = self.index()["columns"][ds]["file"]["name"]
        return pq.read_table(self.out / "columns" / name)


@unittest.skipUnless(HAVE_STACK, "needs numpy, pyarrow, shapely")
class TestBuild(Base):
    def test_null_and_empty(self):
        rows = [line_row(1, 230, "A", 0), line_row(2, None, "", 10), line_row(3, 115, None, 20)]
        write_fixture(self.tmp, "osm_transmission_lines", rows, LINE_FIELDS)
        self.build()
        t = self.table("osm_transmission_lines").to_pydict()
        by = {f: (k, n) for f, k, n in zip(t["fid"], t["nominal_kv"], t["name"])}
        self.assertEqual(by[1], (230.0, "A"))
        self.assertEqual(by[2], (None, ""))       # null stays null, "" stays ""
        self.assertEqual(by[3], (115.0, None))
        self.assertEqual(set(t), {"fid", "nominal_kv", "name", "countries", "counties",
                                  "length_km", "px", "py"})

    def test_int64_fid_round_trip(self):
        rows = [line_row(BIG, 230, "A", 0), line_row(BIG + 1, 230, "B", 5)]
        write_fixture(self.tmp, "osm_transmission_lines", rows, LINE_FIELDS)
        self.build()
        t = self.table("osm_transmission_lines")
        self.assertEqual(str(t.schema.field("fid").type), "int64")
        self.assertEqual(sorted(t["fid"].to_pylist()), [BIG, BIG + 1])
        e = self.index()["columns"]["osm_transmission_lines"]
        self.assertEqual(e["id"], {"field": "fid", "native": True})

    def test_measures_and_points(self):
        rows = [line_row(1, 230, "A", 0)]
        write_fixture(self.tmp, "osm_transmission_lines", rows, LINE_FIELDS)
        self.build()
        t = self.table("osm_transmission_lines").to_pydict()
        self.assertAlmostEqual(t["length_km"][0], 111.195, delta=0.01)   # 1 degree on the sphere
        self.assertEqual(t["px"][0], 500_000)
        self.assertEqual(str(self.table("osm_transmission_lines").schema.field("px").type), "int32")
        self.assertEqual(str(self.table("osm_transmission_lines").schema.field("py").type), "int32")

    def test_point_is_the_rounded_micro_degree(self):
        rows = [{"type": "Feature", "properties": {"fid": 5, "name": "P"},
                 "geometry": {"type": "Point", "coordinates": [-97.1234564, 31.6543216]}}]
        write_fixture(self.tmp, "osm_substations_points", rows, {"name": "String"})
        self.build()
        t = self.table("osm_substations_points").to_pydict()
        self.assertEqual((t["px"][0], t["py"][0]), (-97123456, 31654322))

    def test_polygon_with_string_id_is_a_property(self):
        sq = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}
        rows = [{"type": "Feature", "properties": {"id": "a1", "type": "IOU", "customers": 5},
                 "geometry": sq}]
        write_fixture(self.tmp, "retail_territories", rows,
                      {"id": "String", "type": "String", "customers": "Number"})
        self.build()
        t = self.table("retail_territories")
        self.assertNotIn("fid", t.column_names)
        self.assertEqual(t["id"].to_pylist(), ["a1"])
        self.assertAlmostEqual(t["area_km2"][0].as_py(), 12364, delta=60)
        self.assertEqual(self.index()["columns"]["retail_territories"]["id"],
                         {"field": "id", "native": False})

    def test_native_id_falls_back_to_the_feature_id(self):
        sq = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}
        rows = [{"type": "Feature", "id": 77, "properties": {"acres": 3}, "geometry": sq}]
        write_fixture(self.tmp, "padus", rows, {"acres": "Number"})
        self.build()
        self.assertEqual(self.table("padus")["fid"].to_pylist(), [77])

    def test_mixed_type_fails(self):
        rows = [line_row(1, 230, "A", 0), line_row(2, "230", "B", 5)]
        write_fixture(self.tmp, "osm_transmission_lines", rows, LINE_FIELDS)
        with self.assertRaises(SystemExit) as cm:
            self.build()
        self.assertIn("mixes", str(cm.exception))
        self.assertFalse((self.out / "index.json").exists())

    def test_duplicate_id_fails(self):
        rows = [line_row(1, 230, "A", 0), line_row(1, 115, "B", 5)]
        write_fixture(self.tmp, "osm_transmission_lines", rows, LINE_FIELDS)
        with self.assertRaises(SystemExit) as cm:
            self.build()
        self.assertIn("duplicate id", str(cm.exception))

    def test_archive_field_missing_from_every_row_fails(self):
        rows = [line_row(1, 230, "A", 0)]
        write_fixture(self.tmp, "osm_transmission_lines", rows, {**LINE_FIELDS, "operator": "String"})
        with self.assertRaises(SystemExit) as cm:
            self.build()
        self.assertIn("'operator' is missing from every input row", str(cm.exception))

    def test_name_clash_fails(self):
        rows = [line_row(1, 230, "A", 0)]
        write_fixture(self.tmp, "osm_transmission_lines", rows, {**LINE_FIELDS, "px": "Number"})
        with self.assertRaises(SystemExit) as cm:
            self.build()
        self.assertIn("clash", str(cm.exception))

    def test_row_without_geometry_left_out(self):
        rows = [line_row(1, 230, "A", 0), line_row(2, 345, "B", 1)]
        rows[0]["geometry"] = None
        write_fixture(self.tmp, "osm_transmission_lines", rows, LINE_FIELDS)
        self.assertEqual(self.build(), 0)
        self.assertEqual(self.table("osm_transmission_lines").column("fid").to_pylist(), [2])

    def test_scan_types_writes_nothing(self):
        write_fixture(self.tmp, "osm_transmission_lines", [line_row(1, 230, "A", 0)], LINE_FIELDS)
        self.assertEqual(self.build("--scan-types"), 0)
        self.assertFalse(self.out.exists())

    def test_region_codes_per_row_group(self):
        rows = [line_row(i, 230, "n", float(i) * 40 - 120,
                         countries="|USA|" if i < 3 else "|CAN|USA|",
                         counties="|48001|48003|" if i % 2 else "")
                for i in range(1, 7)]
        rows[0]["properties"]["counties"] = None
        write_fixture(self.tmp, "osm_transmission_lines", rows, LINE_FIELDS)
        self.build("--row-group-size", "2")
        import pyarrow.parquet as pq
        name = self.index()["columns"]["osm_transmission_lines"]["file"]["name"]
        pf = pq.ParquetFile(self.out / "columns" / name)
        codes = json.loads(pf.schema_arrow.metadata[b"region_codes"])
        self.assertEqual(len(codes), pf.num_row_groups)
        self.assertEqual(pf.num_row_groups, 3)
        for g in range(pf.num_row_groups):
            t = pf.read_row_group(g).to_pydict()
            want = {"countries": set(), "counties": set()}
            for f in want:
                for v in t[f]:
                    want[f] |= {c for c in v.split("|") if c} if v else {"none"}
            self.assertEqual({f: set(v) for f, v in codes[g].items()}, want)
        self.assertEqual(pf.schema_arrow.metadata[b"build_id"], b"fixture")

    def test_sorted_by_hilbert_and_stats(self):
        import pyarrow.parquet as pq
        rows = [line_row(i, 230, "n", x) for i, x in enumerate([100, -100, 0, 50, -50, 10], 1)]
        write_fixture(self.tmp, "osm_transmission_lines", rows, LINE_FIELDS)
        self.build()
        t = self.table("osm_transmission_lines")
        import geoparquet_common as gc
        keys = gc.hilbert_key(t["px"].to_numpy() / 1e6, t["py"].to_numpy() / 1e6).tolist()
        self.assertEqual(keys, sorted(keys))
        name = self.index()["columns"]["osm_transmission_lines"]["file"]["name"]
        st = pq.ParquetFile(self.out / "columns" / name).metadata.row_group(0).column(0).statistics
        self.assertTrue(st.has_min_max)       # fid carries statistics

    def test_index_columns_section_and_datasets_untouched(self):
        self.out.mkdir(parents=True)
        before = {"version": 1, "datasets": {"hifld_transmission_lines": {"rows": 5, "x": [1, 2]}},
                  "other": {"keep": True}}
        (self.out / "index.json").write_text(json.dumps(before))
        write_fixture(self.tmp, "osm_transmission_lines", [line_row(1, 230, "A", 0)], LINE_FIELDS)
        (self.tmp / "input" / "osm_transmission_lines.pmtiles").write_bytes(b"archive")
        self.build()
        idx = self.index()
        self.assertEqual(idx["datasets"], before["datasets"])
        self.assertEqual(idx["other"], before["other"])
        e = idx["columns"]["osm_transmission_lines"]
        self.assertEqual(set(e), {"path", "build_id", "file", "geometry", "id", "columns",
                                  "archive_sha256", "snapshot", "tiles_missing"})
        self.assertEqual(set(e["file"]), {"name", "bytes", "sha256", "footer_len", "rows"})
        self.assertEqual(e["archive_sha256"], __import__("hashlib").sha256(b"archive").hexdigest())
        self.assertIsNone(e["tiles_missing"])
        self.assertEqual(e["build_id"], "fixture")

    def test_archive_sha_null_without_archive(self):
        write_fixture(self.tmp, "osm_transmission_lines", [line_row(1, 230, "A", 0)], LINE_FIELDS)
        self.build()
        self.assertIsNone(self.index()["columns"]["osm_transmission_lines"]["archive_sha256"])
        import geoparquet_common as gc
        self.assertEqual(gc.check_analysis(self.out), [])

    def test_deletes_only_rebuilt_datasets_files(self):
        cdir = self.out / "columns"
        cdir.mkdir(parents=True)
        for n in ("osm_transmission_lines.00000000.parquet", "osm_generators.11111111.parquet",
                  "osm_transmission_lines_extra.22222222.parquet"):
            (cdir / n).write_bytes(b"x")
        write_fixture(self.tmp, "osm_transmission_lines", [line_row(1, 230, "A", 0)], LINE_FIELDS)
        self.build()
        names = {p.name for p in cdir.iterdir()}
        self.assertNotIn("osm_transmission_lines.00000000.parquet", names)
        self.assertIn("osm_generators.11111111.parquet", names)
        self.assertIn("osm_transmission_lines_extra.22222222.parquet", names)
        self.assertEqual(len(names), 3)

    def test_unparseable_index_refused_and_kept(self):
        self.out.mkdir(parents=True)
        (self.out / "index.json").write_text("{not json")
        write_fixture(self.tmp, "osm_transmission_lines", [line_row(1, 230, "A", 0)], LINE_FIELDS)
        with self.assertRaises(SystemExit):
            self.build()
        self.assertEqual((self.out / "index.json").read_text(), "{not json")
        self.assertFalse((self.out / "columns").exists())


class TestIndexSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_line_writer_refuses_an_unparseable_index(self):
        (self.tmp / "index.json").write_text("[1, 2")
        with self.assertRaises(SystemExit):
            blp.write_index(self.tmp, [{"dataset": "x"}])
        self.assertEqual((self.tmp / "index.json").read_text(), "[1, 2")

    def test_columns_writer_refuses_an_unparseable_index(self):
        (self.tmp / "index.json").write_text("nope")
        with self.assertRaises(SystemExit):
            bcp.write_columns_index(self.tmp, {"padus": {}})
        self.assertEqual((self.tmp / "index.json").read_text(), "nope")

    def test_line_writer_keeps_columns(self):
        (self.tmp / "index.json").write_text(json.dumps({"version": 1, "datasets": {},
                                                          "columns": {"padus": {"a": 1}}}))
        idx = blp.write_index(self.tmp, [{"dataset": "x"}])
        self.assertEqual(idx["columns"], {"padus": {"a": 1}})
        self.assertIn("x", idx["datasets"])

    def test_row_group_size_needs_a_fixture(self):
        with self.assertRaises(SystemExit):
            bcp.main(["--row-group-size", "10"])

    def test_specs_cover_eleven(self):
        self.assertEqual(len(bcp.DATASETS), 11)
        self.assertNotIn("railroads", bcp.DATASETS)


    def test_registry_parity(self):
        import re
        src = (Path(__file__).resolve().parent.parent / "src" / "registry" / "columns.ts").read_text()
        literals = set(re.findall(r'"([a-z_]+)"', src))
        self.assertEqual(literals, set(bcp.DATASETS))


if __name__ == "__main__":
    unittest.main()
