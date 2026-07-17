"""Smoke tests for osm_common.py's pure value parsers used by the OSM extract
scripts: parse_output_mw (unit-aware MW parsing) and normalise_plant_source
(plant:source -> canonical fuel string mapping).
"""
import unittest

from osm_common import normalise_plant_source, parse_output_mw


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
