"""Tests for build_route_restrict.py's pure rules (stdlib only; the geo stack loads in main())."""
import unittest

import build_route_restrict as r
import route_grid as G


class StatusFilterTests(unittest.TestCase):
    def test_public_schools_status_string_one(self):
        self.assertTrue(r.public_school_open("1"))
        self.assertTrue(r.public_school_open(" 1 "))
        self.assertTrue(r.public_school_open(1))
        for v in ("2", "3", "6", "", None, float("nan")):
            self.assertFalse(r.public_school_open(v), v)

    def test_hospitals_open_only(self):
        self.assertTrue(r.hospital_open("OPEN"))
        self.assertTrue(r.hospital_open("open"))
        self.assertFalse(r.hospital_open("CLOSED"))
        self.assertFalse(r.hospital_open(None))

    def test_nursing_homes_drop_closed_only(self):
        self.assertTrue(r.nursing_home_open("OPEN"))
        self.assertTrue(r.nursing_home_open(None))
        self.assertFalse(r.nursing_home_open("CLOSED"))
        self.assertFalse(r.nursing_home_open("closed "))

    def test_private_schools_and_child_care_keep_all(self):
        for name in ("private_schools", "child_care"):
            keep = r.FACILITIES[name][1]
            for v in ("1", "OPEN", "CLOSED", None):
                self.assertTrue(keep(v), (name, v))

    def test_facility_sources(self):
        self.assertEqual(set(r.FACILITIES),
                         {"public_schools", "private_schools", "hospitals", "child_care", "nursing_homes"})
        self.assertIs(r.FACILITIES["public_schools"][1], r.public_school_open)
        self.assertIs(r.FACILITIES["hospitals"][1], r.hospital_open)
        self.assertIs(r.FACILITIES["nursing_homes"][1], r.nursing_home_open)

    def test_nrhp_drops_removed(self):
        for v in ("Removed", "removed", " REMOVED "):
            self.assertFalse(r.nrhp_keep(v), v)
        for v in ("Listed", None, float("nan"), ""):
            self.assertTrue(r.nrhp_keep(v), v)

    def test_nrhp_polygon_size_filter(self):
        self.assertEqual(r.NRHP_MAX_POLY_KM2, 10.0)
        self.assertTrue(r.nrhp_polygon_kept(0.0))
        self.assertTrue(r.nrhp_polygon_kept(10e6))
        self.assertFalse(r.nrhp_polygon_kept(10e6 + 1))
        self.assertFalse(r.nrhp_polygon_kept(11488.95e6))  # Arnold Trail to Quebec outline

    def test_fuds_drops_response_complete_any_case(self):
        for v in ("responseComplete", "responseCompleteSiteCloseout", "RESPONSECOMPLETE", " responsecomplete"):
            self.assertFalse(r.fuds_keep(v), v)
        for v in ("investigation", "Investigation", "cleanup", None, float("nan"), "notResponseComplete"):
            self.assertTrue(r.fuds_keep(v), v)

    def test_cbrs_keeps_both_unit_types(self):
        self.assertEqual(set(r.CBRS_UNIT_TYPES), {"System Unit", "Otherwise Protected Area"})


class CheckTests(unittest.TestCase):
    def test_gated_and_share_bits_partition_flags2(self):
        acre, share = set(r.ACREAGE_FLAGS2_BITS), set(r.SHARE_BOUNDS)
        self.assertEqual(acre, {0, 1, 5})
        self.assertEqual(share, {2, 3, 4, 6, 7})
        self.assertFalse(acre & share)
        self.assertEqual(acre | share, set(G.FLAGS2_BITS))

    def test_share_bounds(self):
        self.assertEqual(r.SHARE_BOUNDS[2], (0.03, 0.30))
        self.assertEqual(r.SHARE_BOUNDS[3][1], 0.02)
        for b in (4, 6, 7):
            self.assertEqual(r.SHARE_BOUNDS[b][1], 0.005)

    def test_share_ok(self):
        self.assertTrue(r.share_ok(2, 124, 1000))
        self.assertFalse(r.share_ok(2, 29, 1000))
        self.assertFalse(r.share_ok(2, 301, 1000))
        self.assertTrue(r.share_ok(3, 20, 1000))
        self.assertFalse(r.share_ok(3, 21, 1000))
        self.assertTrue(r.share_ok(4, 5, 1000))
        self.assertFalse(r.share_ok(4, 6, 1000))
        for b in (3, 4, 6, 7):
            self.assertFalse(r.share_ok(b, 0, 1000), b)  # an empty bit fails
        self.assertFalse(r.share_ok(6, 1, 0))

    def test_acreage_gate(self):
        self.assertTrue(r.acreage_ok(1.049, 5000))
        self.assertTrue(r.acreage_ok(0.951, 5000))
        self.assertFalse(r.acreage_ok(1.051, 5000))
        self.assertFalse(r.acreage_ok(0.94, r.MIN_REF_KM2))
        self.assertTrue(r.acreage_ok(3.0, r.MIN_REF_KM2 - 1))  # small references are not gated

    def test_site_buffer_is_300_ft(self):
        self.assertAlmostEqual(r.SITE_BUFFER_M, 300 * 0.3048)

    def test_temp_names(self):
        self.assertEqual(r.tmp_path("flags2.tif").name, "flags2.tmp.tif")
        self.assertEqual(r.tmp_path("restrict_meta.json").name, "restrict_meta.tmp.json")


if __name__ == "__main__":
    unittest.main()
