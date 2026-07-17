"""Smoke tests for fetch_odin_outages.py's pure aggregation: build_snapshot()
(county/utility rollup from per-incident rows) and the module's own built-in
_self_check() invariant suite (no network in either).
"""
import unittest
from datetime import datetime, timezone

from fetch_odin_outages import _self_check, build_snapshot


def _rec(fips, name, out, since=None, cause=None, status=None):
    return {
        "communitydescriptor": fips,
        "name": name,
        "metersaffected": out,
        "reportedstarttime": since,
        "cause": cause,
        "causekind": None,
        "customersrestored": None,
        "estimatedrestorationtime": None,
        "statuskind": status,
    }


class TestBuildSnapshot(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)

    def test_basic_rollup(self):
        results = [
            _rec("48201", "CENTERPOINT ENERGY,8901", 3000, "2026-07-16T10:00:00+00:00"),
            _rec("48201", "CENTERPOINT ENERGY,8901", 500, "2026-07-16T11:00:00+00:00"),
            _rec("41033", "PACIFIC POWER,456", 200, "2026-07-16T09:00:00+00:00"),
        ]
        snap = build_snapshot(results, "2026-07-16T11:45:00Z", self.now)

        self.assertEqual(snap["county_count"], 2)
        self.assertEqual(snap["total_customers_out"], 3700)
        self.assertEqual(snap["dropped"], 0)
        self.assertIn("generated_utc", snap)
        self.assertEqual(snap["source_modified"], "2026-07-16T11:45:00Z")

        county = snap["counties"]["48201"]
        self.assertEqual(county[0], 3500)  # summed out
        self.assertEqual(county[1], 2)  # incident count
        self.assertEqual(county[2][0][0], "CENTERPOINT ENERGY")

        self.assertEqual(list(snap["records"].keys()), sorted(snap["records"].keys()))
        self.assertEqual(len(snap["records"]["48201"]), 2)

    def test_invalid_fips_dropped(self):
        results = [_rec("bad", "SOMEUTIL,1", 999)]
        snap = build_snapshot(results, None, self.now)
        self.assertEqual(snap["dropped"], 1)
        self.assertNotIn("bad", snap["counties"])

    def test_legacy_fips_kept_but_flagged(self):
        results = [_rec("09001", "LEGACY UTIL,1", 12)]
        snap = build_snapshot(results, None, self.now)
        self.assertEqual(snap["legacy_fips"], 1)
        self.assertIn("09001", snap["counties"])

    def test_empty_results_raises_value_error(self):
        with self.assertRaises(ValueError):
            build_snapshot([], "2026-07-16T11:45:00Z", self.now)

    def test_none_name_becomes_unknown_utility(self):
        results = [_rec("06001", None, 50)]
        snap = build_snapshot(results, None, self.now)
        self.assertEqual(snap["counties"]["06001"][2][0][0], "Unknown utility")


class TestSelfCheck(unittest.TestCase):
    def test_self_check_does_not_raise(self):
        _self_check()  # asserts internally; failure raises AssertionError


if __name__ == "__main__":
    unittest.main()
