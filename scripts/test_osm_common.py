"""Smoke tests for osm_common.py's pure helpers used by the OSM extract
scripts: osm_fid/osm_ref/add_fid (the stable feature id), parse_output_mw
(unit-aware MW parsing) and normalise_plant_source (plant:source -> canonical
fuel string mapping).
"""
import unittest

import re
from pathlib import Path

from osm_common import (add_fid, normalise_plant_source, osm_fid, osm_ref, output_cap,
                        parse_output_mw)


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

    def test_decimal_comma(self):
        self.assertEqual(parse_output_mw("1,5 MW"), 1.5)
        self.assertEqual(parse_output_mw("2,25 MW"), 2.25)
        self.assertEqual(parse_output_mw("1,5"), 1.5)

    def test_cap(self):
        self.assertIsNone(parse_output_mw("3000 MW", 2000))
        self.assertEqual(parse_output_mw("1750 MW", 2000), 1750.0)
        self.assertIsNone(parse_output_mw("2.5 GW", 2000))
        self.assertEqual(parse_output_mw("1.5 GW", 2000), 1500.0)

    def test_unitless_above_cap_is_none(self):
        self.assertIsNone(parse_output_mw("411000000", 2000))
        self.assertIsNone(parse_output_mw("5000", 2000))

    def test_no_cap_keeps_value(self):
        self.assertEqual(parse_output_mw("411000000"), 411000000.0)


class TestOutputCap(unittest.TestCase):
    def test_boundary(self):
        for kind, source, cap in (("generator", "wind", 30), ("generator", "gas", 2000),
                                  ("plant", "solar", 5000), ("plant", "coal", 25000)):
            c = output_cap(kind, source)
            self.assertEqual(c, cap)
            self.assertEqual(parse_output_mw(str(cap), c), float(cap))
            self.assertIsNone(parse_output_mw(str(cap + 0.001), c))

    def test_wind_turbine_in_kw_is_none(self):
        self.assertIsNone(parse_output_mw("2000", output_cap("generator", "wind")))
        self.assertEqual(parse_output_mw("1500", output_cap("generator", "gas")), 1500.0)

    def test_solar_plant_in_kw_is_none(self):
        self.assertIsNone(parse_output_mw("7000", output_cap("plant", "solar")))
        self.assertEqual(parse_output_mw("7000", output_cap("plant", "coal")), 7000.0)

    def test_source_is_trimmed_and_lowercased(self):
        self.assertEqual(output_cap("generator", " Wind "), 30)
        self.assertEqual(output_cap("generator", None), 2000)

    def test_unknown_kind_raises(self):
        with self.assertRaises(ValueError):
            output_cap("line", "wind")

    def test_extract_call_sites_pass_a_cap(self):
        # The row builders need OSM data to run, so check the source text:
        # every parse_output_mw call names output_cap.
        for name in ("extract_osm_generators.py", "extract_osm_plants.py",
                     "osm_plant_polygons.py"):
            text = (Path(__file__).parent / name).read_text()
            calls = re.findall(r"parse_output_mw\((.{0,160})", text, re.S)
            self.assertTrue(calls, name)
            for args in calls:
                self.assertIn("output_cap(", args, name)


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
