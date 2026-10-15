"""Smoke tests for osm_common.py's pure helpers used by the OSM extract
scripts: osm_fid/osm_ref/add_fid (the stable feature id), parse_output_mw
(unit-aware MW parsing) and normalise_plant_source (plant:source -> canonical
fuel string mapping).
"""
import unittest

from osm_common import add_fid, normalise_plant_source, osm_fid, osm_ref, parse_output_mw


class TestOsmFid(unittest.TestCase):
    def test_type_is_the_last_digit(self):
        self.assertEqual(osm_fid(453589283, "way"), 4535892832)
        self.assertEqual(osm_fid("123", "node"), 1231)
        self.assertEqual(osm_fid(123, "relation"), 1233)

    def test_same_number_different_type_gives_distinct_ids(self):
        fids = {osm_fid(123, t) for t in ("node", "way", "relation")}
        self.assertEqual(len(fids), 3)

    def test_round_trip(self):
        for t in ("node", "way", "relation"):
            self.assertEqual(osm_ref(osm_fid(14_270_000_000, t)), (t, 14_270_000_000))

    def test_largest_ids_stay_exact_in_javascript(self):
        # Node ids reach ~1.4e10; a JS number is exact below 2**53.
        self.assertLess(osm_fid(10**12, "relation"), 2**53)

    def test_unknown_type_raises(self):
        with self.assertRaises(KeyError):
            osm_fid(1, "area")

    def test_add_fid_on_a_frame(self):
        try:
            import pandas as pd
        except ImportError:  # the stdlib-only CI runners
            self.skipTest("pandas is not installed")
        df = add_fid(pd.DataFrame({"osm_id": ["5", 5, 5], "osm_type": ["node", "way", "relation"]}))
        self.assertEqual(df["fid"].tolist(), [51, 52, 53])
        self.assertEqual(str(df["fid"].dtype), "Int64")


class TestParseOutputMw(unittest.TestCase):
    def test_plain_mw(self):
        self.assertEqual(parse_output_mw("5 MW"), 5.0)

    def test_kw_converted_to_mw(self):
        self.assertEqual(parse_output_mw("500 kW"), 0.5)

    def test_gw_converted_to_mw(self):
        self.assertEqual(parse_output_mw("1.2 GW"), 1200.0)

    def test_no_unit_defaults_to_mw(self):
        self.assertEqual(parse_output_mw("10"), 10.0)

    def test_garbage_returns_none(self):
        self.assertIsNone(parse_output_mw("garbage"))

    def test_none_returns_none(self):
        self.assertIsNone(parse_output_mw(None))

    def test_yes_no_return_none(self):
        self.assertIsNone(parse_output_mw("yes"))
        self.assertIsNone(parse_output_mw("no"))

    def test_comma_thousands_separator(self):
        self.assertEqual(parse_output_mw("1,200 kW"), 1.2)


class TestNormalisePlantSource(unittest.TestCase):
    def test_direct_mappings(self):
        self.assertEqual(normalise_plant_source("wind"), "wind")
        self.assertEqual(normalise_plant_source("solar"), "solar")
        self.assertEqual(normalise_plant_source("natural_gas"), "gas")
        self.assertEqual(normalise_plant_source("water"), "hydro")
        self.assertEqual(normalise_plant_source("storage"), "battery")

    def test_multi_fuel_picks_first(self):
        self.assertEqual(normalise_plant_source("coal;gas"), "coal")

    def test_case_insensitive(self):
        self.assertEqual(normalise_plant_source("WIND"), "wind")

    def test_unknown_passthrough(self):
        self.assertEqual(normalise_plant_source("tidal"), "tidal")

    def test_none_returns_empty_string(self):
        self.assertEqual(normalise_plant_source(None), "")


if __name__ == "__main__":
    unittest.main()
