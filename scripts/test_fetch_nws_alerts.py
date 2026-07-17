"""Smoke tests for fetch_nws_alerts.py's pure parsing/curation logic:
UGC->FIPS derivation, zone-URL parsing, coordinate rounding, and curate()'s
polygon/zone-join split. Guards the malformed-SAME-code regression (a 5-char
SAME code must never leak into a joined FIPS list).
"""
import unittest

from fetch_nws_alerts import (
    _county_ugc_to_fips,
    _parse_zone_url,
    _round_coords,
    curate,
)


class TestCountyUgcToFips(unittest.TestCase):
    def test_valid_county_ugc(self):
        # TXC201 -> Texas (48) county 201.
        self.assertEqual(_county_ugc_to_fips("TXC201"), "48201")

    def test_zone_ugc_returns_none(self):
        # 'Z' in position 2 means forecast zone, not county.
        self.assertIsNone(_county_ugc_to_fips("TXZ211"))

    def test_malformed_short_string_returns_none(self):
        self.assertIsNone(_county_ugc_to_fips("TX1"))

    def test_unknown_state_prefix_returns_none(self):
        self.assertIsNone(_county_ugc_to_fips("ZZC201"))

    def test_non_digit_county_part_returns_none(self):
        self.assertIsNone(_county_ugc_to_fips("TXCabc"))


class TestParseZoneUrl(unittest.TestCase):
    def test_forecast_zone_url(self):
        self.assertEqual(
            _parse_zone_url("https://api.weather.gov/zones/forecast/TXZ211"),
            ("forecast", "TXZ211"),
        )

    def test_county_zone_url(self):
        self.assertEqual(
            _parse_zone_url("https://api.weather.gov/zones/county/TXC201"),
            ("county", "TXC201"),
        )

    def test_marine_prefixed_ugc_reclassified(self):
        # Served under /zones/forecast/ but AM is a marine prefix -> "marine".
        self.assertEqual(
            _parse_zone_url("https://api.weather.gov/zones/forecast/AMZ150"),
            ("marine", "AMZ150"),
        )

    def test_junk_url_returns_none(self):
        self.assertIsNone(_parse_zone_url("https://example.com/foo"))

    def test_too_short_path_returns_none(self):
        self.assertIsNone(_parse_zone_url("https://api.weather.gov/zones"))


class TestRoundCoords(unittest.TestCase):
    def test_nested_coords_rounded(self):
        coords = [[[-97.123456789, 32.987654321], [-97.0, 33.0]]]
        rounded = _round_coords(coords)
        self.assertEqual(rounded, [[[-97.1235, 32.9877], [-97.0, 33.0]]])

    def test_flat_number_rounded(self):
        self.assertEqual(_round_coords(1.123456), 1.1235)


def _alert(event, geometry=None, same=None, zones=None, alert_id="id-1"):
    props = {
        "event": event,
        "severity": "Moderate",
        "certainty": "Likely",
        "urgency": "Expected",
        "headline": f"{event} headline",
        "onset": "2026-07-16T00:00:00Z",
        "ends": None,
        "expires": "2026-07-16T06:00:00Z",
        "areaDesc": "Somewhere",
        "senderName": "NWS",
        "id": alert_id,
    }
    if same is not None:
        props["geocode"] = {"SAME": same}
    if zones is not None:
        props["affectedZones"] = zones
    return {"type": "Feature", "geometry": geometry, "properties": props}


class TestCurate(unittest.TestCase):
    def test_curate_polygon_zone_join_and_malformed_same(self):
        generated_utc = "2026-07-16T12:00:00Z"
        features = [
            # (a) polygon geometry -> kept.
            _alert(
                "Tornado Warning",
                geometry={"type": "Point", "coordinates": [-97.123456, 32.654321]},
                alert_id="polygon-1",
            ),
            # (b) geometry-null, valid SAME county code (6 chars: portion+FIPS).
            _alert(
                "Heat Advisory",
                geometry=None,
                same=["148201"],
                zones=["https://api.weather.gov/zones/forecast/TXZ211"],
                alert_id="zone-valid",
            ),
            # (c) geometry-null, MALFORMED SAME code (5 chars, not 6) alongside
            # a valid zone url so the alert isn't fully dropped -- regression
            # guard: the malformed code must not appear in the joined fips list.
            _alert(
                "Heat Advisory",
                geometry=None,
                same=["48201"],
                zones=["https://api.weather.gov/zones/forecast/TXZ212"],
                alert_id="zone-malformed-same",
            ),
        ]

        kept, zone_alerts, kept_counts, zone_joined_counts, stats = curate(
            features, generated_utc
        )

        # (a) polygon alert kept with rounded coords + curated props.
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["properties"]["id"], "polygon-1")
        self.assertEqual(kept[0]["geometry"]["coordinates"], [-97.1235, 32.6543])
        self.assertEqual(kept[0]["properties"]["_group"], "convective")
        self.assertEqual(kept[0]["properties"]["country"], "US")
        self.assertEqual(kept_counts.get("convective"), 1)

        # (b) + (c) both zone-joined (each carried a valid affectedZones url).
        self.assertEqual(len(zone_alerts), 2)
        self.assertEqual(zone_joined_counts.get("heat"), 2)

        valid_entry = next(z for z in zone_alerts if z["id"] == "zone-valid")
        malformed_entry = next(z for z in zone_alerts if z["id"] == "zone-malformed-same")

        # Valid SAME code "148201" -> fips "48201" present.
        self.assertIn("48201", valid_entry["fips"])

        # Malformed SAME code "48201" (5 chars) must be dropped entirely --
        # it must NOT show up in the joined fips output for that entry.
        self.assertEqual(malformed_entry["fips"], [])
        self.assertEqual(stats["malformed_same"], 1)

    def test_curate_skips_unallowlisted_event(self):
        features = [_alert("Some Random Statement", geometry=None)]
        kept, zone_alerts, kept_counts, zone_joined_counts, stats = curate(
            features, "2026-07-16T12:00:00Z"
        )
        self.assertEqual(kept, [])
        self.assertEqual(zone_alerts, [])

    def test_curate_drops_when_no_zones_and_no_fips(self):
        features = [_alert("Heat Advisory", geometry=None)]
        kept, zone_alerts, kept_counts, zone_joined_counts, stats = curate(
            features, "2026-07-16T12:00:00Z"
        )
        self.assertEqual(kept, [])
        self.assertEqual(zone_alerts, [])
        self.assertEqual(stats["dropped"], 1)


if __name__ == "__main__":
    unittest.main()
