"""Tests for osm_common.dedup_points: a way/relation row is returned when its
nearest node lies within 1.5 x the radius; nodes are never returned; rows
without both coordinates are kept; the answer is labels in frame order.
Skips where numpy/scipy/pandas are absent (the stdlib-only passes)."""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import numpy  # noqa: F401
    import pandas as pd
    import scipy  # noqa: F401
except ImportError:
    raise unittest.SkipTest("numpy/scipy/pandas are not installed")

from osm_common import dedup_points

M_PER_DEG = 6_371_000.0 * math.pi / 180.0


def frame(rows):
    return pd.DataFrame(rows, columns=["osm_type", "lat", "lon"])


class TestDedupPoints(unittest.TestCase):
    def test_bound_is_one_and_a_half_radii(self):
        for dm, expect in ((749.5, True), (750.5, False)):
            df = frame([("node", 10.0, 20.0), ("way", 10.0 + dm / M_PER_DEG, 20.0)])
            self.assertEqual(list(dedup_points(df, 500)), [1] if expect else [], dm)

    def test_node_never_dropped(self):
        df = frame([("node", 1.0, 1.0), ("node", 1.0, 1.0), ("way", 1.0, 1.0)])
        self.assertEqual(list(dedup_points(df, 100)), [2])

    def test_relation_counts_as_polygon(self):
        df = frame([("node", 1.0, 1.0), ("relation", 1.0, 1.0)])
        self.assertEqual(list(dedup_points(df, 100)), [1])

    def test_relation_is_never_a_node(self):
        df = frame([("node", 50.0, 50.0), ("relation", 1.0, 1.0), ("way", 1.0, 1.0)])
        self.assertEqual(list(dedup_points(df, 100)), [])

    def test_empty_sides(self):
        self.assertEqual(len(dedup_points(frame([("way", 1.0, 1.0)]), 100)), 0)
        self.assertEqual(len(dedup_points(frame([("node", 1.0, 1.0)]), 100)), 0)
        self.assertEqual(len(dedup_points(frame([]), 100)), 0)

    def test_paired_nan_kept(self):
        nan = float("nan")
        df = frame([("node", 1.0, 1.0), ("way", nan, nan), ("way", 1.0, 1.0)])
        self.assertEqual(list(dedup_points(df, 100)), [2])

    def test_one_sided_nan_kept_without_error(self):
        nan = float("nan")
        df = frame([("node", 1.0, 1.0), ("way", 1.0, nan), ("way", 1.0, 1.0)])
        self.assertEqual(list(dedup_points(df, 100)), [2])

    def test_order_and_labels_preserved(self):
        df = frame([("way", 5.0, 5.0), ("node", 1.0, 1.0), ("way", 1.0, 1.0),
                    ("way", 9.0, 9.0), ("relation", 1.0, 1.0)])
        df.index = [30, 20, 10, 5, 1]
        self.assertEqual(list(dedup_points(df, 100)), [10, 1])

    def test_antimeridian(self):
        df = frame([("node", 0.0, 179.9999), ("way", 0.0, -179.9999)])
        self.assertEqual(list(dedup_points(df, 100)), [1])

    def test_pole(self):
        df = frame([("node", 89.9999, 10.0), ("way", 89.9999, -170.0), ("way", 89.99, 10.0)])
        self.assertEqual(list(dedup_points(df, 100)), [1])


if __name__ == "__main__":
    unittest.main()
