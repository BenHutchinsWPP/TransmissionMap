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


if __name__ == "__main__":
    unittest.main()
