"""Tests for build_route_flood.py's pure rules (stdlib only)."""
import unittest

import build_route_flood as f


class FloodRuleTests(unittest.TestCase):
    def test_threshold(self):
        self.assertEqual(f.is_flood(0.5), 1)
        self.assertEqual(f.is_flood(0.4999), 0)
        self.assertEqual(f.is_flood(1.0), 1)
        self.assertEqual(f.is_flood(0.0), 0)
        self.assertEqual(f.is_flood(-1.0), 0)  # no valid pixel

    def test_share_bounds(self):
        self.assertTrue(f.share_ok(0.124))
        self.assertFalse(f.share_ok(0.02))
        self.assertFalse(f.share_ok(0.31))

    def test_points_cover_expected_both_ways(self):
        self.assertEqual(sorted({p[3] for p in f.POINTS}), [0, 1])


if __name__ == "__main__":
    unittest.main()
