"""Tests for build_route_flags.py's pure rules (skipped without numpy/geopandas/rasterio)."""
import unittest

try:
    import numpy as np
    import build_route_flags as f
except ImportError as e:  # stdlib-only pass
    f = None
    SKIP = str(e)


@unittest.skipIf(f is None, "heavy geo deps not installed")
class FlagRuleTests(unittest.TestCase):
    def test_mirta_status_kept(self):
        self.assertEqual(set(f.MIRTA_STATUS_KEPT), {"act", "semi", "care"})

    def test_dam_hazard(self):
        for v in ("High", "high", " SIGNIFICANT ", "Significant"):
            self.assertTrue(f.is_hazardous_dam(v), v)
        for v in ("Low", "Undetermined", "", None):
            self.assertFalse(f.is_hazardous_dam(v), v)

    def test_tower_height_metres(self):
        self.assertEqual(f.TOWER_MIN_HEIGHT_M, 61.0)
        self.assertTrue(f.is_tall_tower(61.0))
        self.assertTrue(f.is_tall_tower("120.5"))
        self.assertFalse(f.is_tall_tower(60.99))
        self.assertFalse(f.is_tall_tower(None))
        self.assertFalse(f.is_tall_tower("n/a"))

    def test_merge_meta_keeps_other_keys(self):
        old = {"osm_b1_flags": 1, "osm_b3_adj": 2, "flags_pd_b7": "old", "built": "a"}
        new = {"flags_pd_b7": "new", "built": "b"}
        m = f.merge_meta(old, new)
        self.assertEqual(m, {"osm_b1_flags": 1, "osm_b3_adj": 2, "flags_pd_b7": "new", "built": "b"})
        self.assertEqual(old["flags_pd_b7"], "old")

    def test_ring_class(self):
        line = np.zeros((11, 11), bool)
        line[5, 5] = True
        c = f.ring_class(line)
        self.assertEqual(c[5, 5], 1)
        self.assertEqual(c[4, 4], 2)
        self.assertEqual(c[5, 8], 3)
        self.assertEqual(c[8, 8], 0)  # sqrt(18) > 3

    def test_adj_encoding_fits(self):
        self.assertEqual(f.G.adj_encode(3, 3), 115)


if __name__ == "__main__":
    unittest.main()
