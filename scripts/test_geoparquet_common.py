"""Tests for geoparquet_common.py — the line geometry Parquet layout rules.

Stdlib tests run under `python3 -S`; the numpy/pyarrow ones skip without them.
"""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

import geoparquet_common as gc

HAVE_NUMPY = importlib.util.find_spec("numpy") is not None
HAVE_ARROW = HAVE_NUMPY and importlib.util.find_spec("pyarrow") is not None
MiB = 2**20


def _varint(b, i):
    n = shift = 0
    while True:
        c = b[i]
        i += 1
        n |= (c & 0x7F) << shift
        if not c & 0x80:
            return n, i
        shift += 7


def _skip_value(b, i, t):
    if t in (1, 2):
        return i
    if t == 3:
        return i + 1
    if t in (4, 5, 6):
        return _varint(b, i)[1]
    if t == 7:
        return i + 8
    if t == 8:
        n, i = _varint(b, i)
        return i + n
    if t in (9, 10):
        h = b[i]
        i += 1
        n, et = h >> 4, h & 15
        if n == 15:
            n, i = _varint(b, i)
        for _ in range(n):
            i = _skip_value(b, i, et)
        return i
    if t == 12:
        return _struct(b, i)[0]
    raise ValueError(t)


def _struct(b, i):
    """(end, {field id: int}) of a Thrift compact struct at b[i]."""
    out, fid = {}, 0
    while b[i]:
        h = b[i]
        i += 1
        t = h & 15
        if h >> 4:
            fid += h >> 4
        else:
            z, i = _varint(b, i)
            fid = z >> 1 ^ -(z & 1)
        if t in (4, 5, 6):
            z, j = _varint(b, i)
            out[fid] = z >> 1 ^ -(z & 1)
            i = j
        else:
            i = _skip_value(b, i, t)
    return i + 1, out


def page_sizes(path, column):
    """Compressed data-page bytes of `column` in each row group (no dictionary pages)."""
    import pyarrow.parquet as pq
    md = pq.ParquetFile(str(path)).metadata
    b = Path(path).read_bytes()
    out = []
    for g in range(md.num_row_groups):
        for j in range(md.row_group(g).num_columns):
            c = md.row_group(g).column(j)
            if c.path_in_schema != column:
                continue
            assert c.dictionary_page_offset is None
            i, end = c.data_page_offset, c.data_page_offset + c.total_compressed_size
            while i < end:
                i2, hdr = _struct(b, i)
                out.append(hdr[3])
                i = i2 + hdr[3]
    return out


class TestPlanParts(unittest.TestCase):
    def test_one_part_under_the_target(self):
        self.assertEqual(gc.plan_parts([10 * MiB, 20 * MiB]), [(0, 2)])

    def test_cuts_near_an_even_split_on_group_boundaries(self):
        parts = gc.plan_parts([16 * MiB] * 21)          # ~336 MiB → 6 parts
        self.assertEqual(len(parts), 6)
        self.assertEqual(parts[0][0], 0)
        self.assertEqual(parts[-1][1], 21)
        for (a, b), (c, _) in zip(parts, parts[1:]):
            self.assertEqual(b, c)
        sizes = [(b - a) * 16 for a, b in parts]
        self.assertTrue(all(48 <= s <= 64 for s in sizes), sizes)

    def test_every_part_under_the_hard_stop(self):
        for groups in ([15 * MiB] * 40, [1 * MiB] * 3 + [60 * MiB] + [1 * MiB] * 5):
            for a, b in gc.plan_parts(groups):
                self.assertLessEqual(sum(groups[a:b]), gc.PART_HARD_BYTES)

    def test_a_group_over_the_hard_stop_raises(self):
        with self.assertRaises(ValueError):
            gc.plan_parts([10 * MiB, 96 * MiB, 10 * MiB])

    def test_empty(self):
        self.assertEqual(gc.plan_parts([]), [])


class TestFileFacts(unittest.TestCase):
    def test_footer_len_and_content_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "x.parquet"
            p.write_bytes(b"PAR1" + b"x" * 10 + (10).to_bytes(4, "little") + b"PAR1")
            self.assertEqual(gc.footer_len(p), 10)
            dest, digest = gc.content_name(p, "ds.idx")
            self.assertEqual(dest.name, f"ds.idx.{digest[:8]}.parquet")
            self.assertFalse(p.exists())
            entry = gc.file_entry(dest, "idx", 3, digest)
            self.assertEqual((entry["bytes"], entry["footer_len"], entry["rows"]), (22, 10, 3))

    def test_footer_len_refuses_a_non_parquet_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "x.bin"
            p.write_bytes(b"0" * 16)
            with self.assertRaises(ValueError):
                gc.footer_len(p)

    def test_write_json_leaves_no_part_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            gc.write_json(Path(tmp) / "m.json", {"a": 1})
            self.assertEqual(os.listdir(tmp), ["m.json"])
            self.assertEqual(json.loads((Path(tmp) / "m.json").read_text()), {"a": 1})

    def test_geo_metadata_is_geoparquet_1_1_with_a_bbox_covering(self):
        m = gc.geo_metadata(["MultiLineString", "LineString"], [0, 1, 2, 3])
        self.assertEqual(m["version"], "1.1.0")
        col = m["columns"]["geometry"]
        self.assertEqual(col["encoding"], "WKB")
        self.assertEqual(col["geometry_types"], ["LineString", "MultiLineString"])
        self.assertEqual(col["covering"]["bbox"]["xmin"], ["bbox", "xmin"])


@unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
class TestNumpyHelpers(unittest.TestCase):
    def test_hilbert_order_1_visits_the_quadrants_in_a_u(self):
        import numpy as np
        # order 1: lower-left, upper-left, upper-right, lower-right
        x = np.array([-90.0, -90.0, 90.0, 90.0])
        y = np.array([-45.0, 45.0, 45.0, -45.0])
        self.assertEqual(gc.hilbert_key(x, y, order=1).tolist(), [0, 1, 2, 3])

    def test_f32_outward_still_covers(self):
        import numpy as np
        lo = np.array([-104.123456789, 0.1, 33.3])
        hi = np.array([-104.123450001, 0.1, 33.30000001])
        lo32, hi32 = gc.f32_outward(lo, hi)
        self.assertTrue((lo32.astype(float) <= lo).all())
        self.assertTrue((hi32.astype(float) >= hi).all())
        self.assertEqual(lo32.dtype, np.float32)


@unittest.skipUnless(HAVE_ARROW, "pyarrow not installed")
class TestWriter(unittest.TestCase):
    def _table(self):
        import numpy as np
        import pyarrow as pa
        n = 5000
        bounds = np.c_[np.arange(n), np.arange(n), np.arange(n) + 1, np.arange(n) + 1].astype(float)
        return pa.table({"fid": pa.array(np.arange(n, dtype=np.int64) * 7),
                         "kind": pa.array(["a", "b"] * (n // 2)),
                         "bbox": gc.bbox_array(bounds),
                         "geometry": pa.array([b"\x01\x02\x00\x00\x00" + bytes([i % 251]) * 40
                                               for i in range(n)], pa.binary())})

    def test_no_dictionary_page_on_unique_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "g.parquet"
            gc.write_parquet(self._table(), p, gc.GEO_PRESET, metadata={"build_id": "b1"})
            enc = gc.dictionary_encoded(p)
            self.assertNotIn("fid", enc)
            self.assertNotIn("geometry", enc)
            self.assertFalse({c for c in enc if c.startswith("bbox")})
            self.assertIn("kind", enc)     # a repeating string may take one

    def test_geo_preset_writes_256_row_pages_and_a_page_index(self):
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "g.parquet"
            gc.write_parquet(self._table(), p, gc.GEO_PRESET, metadata={"build_id": "b1"})
            f = pq.ParquetFile(p)
            md = f.metadata
            self.assertEqual(f.schema_arrow.metadata[b"build_id"], b"b1")
            col = md.row_group(0).column(0)
            self.assertTrue(col.has_offset_index)
            self.assertIsNone(md.row_group(0).column(6).statistics)   # no stats on WKB
            self.assertIsNotNone(md.row_group(0).column(0).statistics)
            self.assertTrue(md.row_group(0).column(2).has_column_index)  # bbox.xmin

    def test_statistics_columns(self):
        t = self._table()
        self.assertEqual(gc.statistics_columns(t.schema),
                         ["fid", "bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax"])


HAVE_SHAPELY = importlib.util.find_spec("shapely") is not None


def _sq(x, y, s):
    return [(x, y), (x + s, y), (x + s, y + s), (x, y + s), (x, y)]


@unittest.skipUnless(HAVE_SHAPELY, "shapely not installed")
class TestSphereArea(unittest.TestCase):
    # Literals printed by assets/sandbox/geo-kit.ts `areaKm2` under node (tsx).
    def _poly(self, *rings):
        from shapely.geometry import Polygon
        return Polygon(rings[0], list(rings[1:]))

    def test_sphere_area_matches_geo_kit(self):
        from shapely.geometry import MultiPolygon
        self.assertAlmostEqual(gc.sphere_area_km2(self._poly(_sq(0, 0, 1))), 12363.718145179933, places=6)
        self.assertAlmostEqual(gc.sphere_area_km2(self._poly(_sq(-100, 40, 2))), 37324.066125366095, places=6)
        mp = MultiPolygon([self._poly(_sq(0, 0, 1)), self._poly(_sq(-100, 40, 2))])
        self.assertAlmostEqual(gc.sphere_area_km2(mp), 49687.78427054603, places=6)

    def test_sphere_area_holes_subtract(self):
        poly = self._poly(_sq(-100, 40, 2), _sq(-99.5, 40.5, 1))
        self.assertAlmostEqual(gc.sphere_area_km2(poly), 27992.69428397777, places=6)

    def test_sphere_area_of_a_line_is_zero(self):
        from shapely.geometry import LineString
        self.assertEqual(gc.sphere_area_km2(LineString([(0, 0), (1, 1)])), 0)


@unittest.skipUnless(HAVE_SHAPELY, "shapely not installed")
class TestPointOnFeature(unittest.TestCase):
    def test_point_line_polygon(self):
        from shapely.geometry import LineString, MultiLineString, Point, Polygon
        self.assertEqual(gc.point_on_feature(Point(3, 4)), (3, 4))
        x, y = gc.point_on_feature(LineString([(0, 0), (1, 0), (3, 0)]))
        self.assertAlmostEqual(x, 1.5, places=3)
        self.assertAlmostEqual(y, 0, places=6)
        x, y = gc.point_on_feature(MultiLineString([[(0, 0), (1, 0)], [(1, 0), (4, 0)]]))
        self.assertAlmostEqual(x, 2.0, places=3)
        poly = Polygon([(0, 0), (4, 0), (4, 4), (0, 4)], [[(1, 1), (3, 1), (3, 3), (1, 3)]])
        pt = gc.point_on_feature(poly)
        self.assertTrue(poly.contains(Point(pt)))


def _pmtiles(path, meta, compression=2):
    raw = json.dumps(meta).encode()
    if compression == 2:
        import gzip
        raw = gzip.compress(raw)
    head = bytearray(127)
    head[:7] = b"PMTiles"
    head[7] = 3
    head[24:32] = (127).to_bytes(8, "little")
    head[32:40] = len(raw).to_bytes(8, "little")
    head[97] = compression
    Path(path).write_bytes(bytes(head) + raw)


class TestPmtilesFields(unittest.TestCase):
    def test_reads_the_layer_fields(self):
        meta = {"vector_layers": [{"id": "a", "fields": {"x": "Number"}},
                                  {"id": "b", "fields": {"name": "String", "kv": "Number"}}]}
        with tempfile.TemporaryDirectory() as tmp:
            for comp in (1, 2):
                p = Path(tmp) / f"t{comp}.pmtiles"
                _pmtiles(p, meta, comp)
                self.assertEqual(gc.pmtiles_fields(p, "b"), {"name": "String", "kv": "Number"})
            with self.assertRaises(KeyError):
                gc.pmtiles_fields(p, "zzz")
            (Path(tmp) / "bad").write_bytes(b"nope" * 40)
            with self.assertRaises(ValueError):
                gc.pmtiles_fields(Path(tmp) / "bad", "a")


@unittest.skipUnless(HAVE_ARROW, "pyarrow not installed")
class TestColumnsFiles(unittest.TestCase):
    def _build(self, tmp, archive_bytes=b"archive"):
        import pyarrow as pa
        root, layers = Path(tmp) / "analysis", Path(tmp) / "layers"
        (root / "columns").mkdir(parents=True)
        layers.mkdir()
        (layers / "ds.pmtiles").write_bytes(archive_bytes)
        t = pa.table({"fid": pa.array([1, 2, 3], pa.int64()), "kind": ["a", "b", "a"]})
        tmpf = root / "columns" / "ds.parquet"
        gc.write_parquet(t, tmpf, gc.COLUMNS_PRESET, metadata={"build_id": "b1"})
        dest, digest = gc.content_name(tmpf, "ds")
        entry = gc.file_entry(dest, "columns", 3, digest)
        gc.write_json(root / "index.json", {"columns": {"ds": {
            "path": "columns/", "build_id": "b1", "file": entry,
            "archive_sha256": gc.sha256_file(layers / "ds.pmtiles")}}})
        return root, layers

    def test_columns_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, layers = self._build(tmp)
            self.assertEqual(gc.check_analysis(root, layers), [])

    def test_archive_sha_mismatch_orphan_and_build_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, layers = self._build(tmp)
            (layers / "ds.pmtiles").write_bytes(b"another archive")
            self.assertIn("archive_sha256", "\n".join(gc.check_analysis(root, layers)))
            (root / "columns" / "stray.parquet").write_bytes(b"x")
            self.assertIn("orphan", "\n".join(gc.check_analysis(root, layers)))
            idx = json.loads((root / "index.json").read_text())
            idx["columns"]["ds"]["build_id"] = "b2"
            (root / "index.json").write_text(json.dumps(idx))
            self.assertIn("build_id", "\n".join(gc.check_analysis(root, layers)))

    def test_no_dictionary_and_string_fid_statistics(self):
        import pyarrow as pa
        t = pa.table({"fid": ["a", "b"], "kind": ["x", "y"], "px": pa.array([1.0, 2.0], pa.float32())})
        self.assertEqual(gc.statistics_columns(t.schema), ["px"])
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "c.parquet"
            gc.write_parquet(t, p, gc.COLUMNS_PRESET, no_dictionary=["kind"])
            self.assertNotIn("kind", gc.dictionary_encoded(p))


@unittest.skipUnless(HAVE_ARROW, "numpy/pyarrow not installed")
class TestGeoPages(unittest.TestCase):
    def sizes(self, rows):
        import numpy as np
        import pyarrow as pa
        t = pa.table({"fid": pa.array(np.arange(len(rows))), "geometry": pa.array(rows, pa.binary())})
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "g.parquet"
            gc.write_parquet(t, p, gc.GEO_PRESET)
            return page_sizes(p, "geometry")

    def test_geo_pages_close_at_about_one_mib_whatever_the_row_count(self):
        import numpy as np
        rng = np.random.default_rng(1)
        small = self.sizes([rng.bytes(20_000) for _ in range(600)])      # 256 rows would be 5 MB
        self.assertGreater(len(small), 8)
        self.assertLessEqual(max(small), 1 * MiB + 16 * 20_000 + 4096)   # size is checked every write_batch_size (16) rows
        big = 3_000_000
        mixed = self.sizes([rng.bytes(big) if i % 100 == 7 else rng.bytes(2000) for i in range(600)])
        self.assertLessEqual(max(mixed), 1 * MiB + big + 16 * 2000 + 4096)   # at most the batch that crossed the size
        self.assertGreater(len(mixed), 5)


if __name__ == "__main__":
    unittest.main()
