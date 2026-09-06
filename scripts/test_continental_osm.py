"""Smoke tests for process_continental_osm.py's continental region mappings and codes."""
import json
import unittest
from pathlib import Path

from process_continental_osm import (
    CONTINENTAL_REGIONS,
    get_region_code,
    resolve_region,
)
from build_global_tiles import TRANSMISSION_ZOOM_LADDER

MANIFEST = Path(__file__).resolve().parent / "tile_manifest.yaml"


def _admits(clause, zoom, minz):
    """Evaluate one Mapbox-GL-style comparison from the transmission ladder."""
    op, key, value = clause[0], clause[1], clause[2]
    if op == "all":
        return all(_admits(c, zoom, minz) for c in clause[1:])
    actual = zoom if key == "$zoom" else minz
    return actual <= value if op == "<=" else actual >= value


class TestContinentalOsmMappings(unittest.TestCase):
    def test_all_eight_continents_present(self):
        expected_continents = {
            "antarctica",
            "central-america",
            "oceania",
            "south-america",
            "africa",
            "north-america",
            "asia",
            "europe",
        }
        self.assertEqual(set(CONTINENTAL_REGIONS.keys()), expected_continents)

    def test_region_resolutions_by_name_and_codes(self):
        self.assertEqual(resolve_region("europe"), "europe")
        self.assertEqual(resolve_region("eu"), "europe")
        self.assertEqual(resolve_region("eur"), "europe")

        self.assertEqual(resolve_region("oceania"), "oceania")
        self.assertEqual(resolve_region("oc"), "oceania")
        self.assertEqual(resolve_region("oce"), "oceania")

        self.assertEqual(resolve_region("north-america"), "north-america")
        self.assertEqual(resolve_region("na"), "north-america")
        self.assertEqual(resolve_region("nam"), "north-america")

        self.assertEqual(resolve_region("central-america"), "central-america")
        self.assertEqual(resolve_region("ca"), "central-america")
        self.assertEqual(resolve_region("cam"), "central-america")

    def test_get_region_code_2letter_and_3letter(self):
        self.assertEqual(get_region_code("europe", "2letter"), "eu")
        self.assertEqual(get_region_code("europe", "3letter"), "eur")

        self.assertEqual(get_region_code("asia", "2letter"), "as")
        self.assertEqual(get_region_code("asia", "3letter"), "asi")

        self.assertEqual(get_region_code("africa", "2letter"), "af")
        self.assertEqual(get_region_code("africa", "3letter"), "afr")

        self.assertEqual(get_region_code("south-america", "2letter"), "sa")
        self.assertEqual(get_region_code("south-america", "3letter"), "sam")

        self.assertEqual(get_region_code("antarctica", "2letter"), "an")
        self.assertEqual(get_region_code("antarctica", "3letter"), "ant")


class TestTransmissionZoomLadder(unittest.TestCase):
    """The ladder replaces tippecanoe's byte-budget thinning, so a rung that
    goes missing silently empties a zoom rather than failing the build."""

    def test_ladder_admits_exactly_the_features_at_or_below_the_zoom(self):
        clauses = json.loads(TRANSMISSION_ZOOM_LADDER)["*"][1:]
        for zoom in range(2, 12):
            for minz in range(2, 9):
                admitted = any(_admits(c, zoom, minz) for c in clauses)
                self.assertEqual(
                    admitted, minz <= zoom,
                    f"zoom {zoom} / minz {minz}: got {admitted}")

    def test_manifest_carries_the_same_ladder(self):
        text = MANIFEST.read_text()
        self.assertIn(TRANSMISSION_ZOOM_LADDER, text)
        # minz is what the filter reads; tippecanoe evaluates -j against the
        # emitted properties, so dropping it from `select` matches nothing.
        self.assertIn("is_undergrnd, is_dc, minz]", text)


if __name__ == "__main__":
    unittest.main()
