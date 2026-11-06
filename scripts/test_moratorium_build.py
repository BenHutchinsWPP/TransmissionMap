"""Tests for the pure helpers of scripts/moratoriums/build.py (stdlib only).

build.py runs at import and needs pandas/geopandas, so the helpers are lifted from its source by name
and executed with the real textnorm.norm; the helpers must stay free of pandas.
"""
import ast
import io
import re
import sys
import unittest
from contextlib import redirect_stderr
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from moratoriums.refresh.textnorm import norm

SRC = Path(__file__).resolve().parent / "moratoriums" / "build.py"
NAMES = {"STATUS", "map_status", "expiry_from_duration", "county_lookup", "county_override"}


def load():
    tree = ast.parse(SRC.read_text())
    keep = [n for n in tree.body
            if (isinstance(n, ast.FunctionDef) and n.name in NAMES)
            or (isinstance(n, ast.Assign) and any(getattr(t, "id", None) in NAMES for t in n.targets))]
    ns = {"norm": norm, "sys": sys, "timedelta": timedelta, "re": re}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(SRC), "exec"), ns)
    return ns


H = load()
VA = [("VA", "Fairfax", "Fairfax city", "51600"), ("VA", "Fairfax", "Fairfax County", "51059"),
      ("VA", "Richmond", "Richmond city", "51760"), ("VA", "Richmond", "Richmond County", "51159"),
      ("NV", "Carson City", "Carson City", "32510"),
      ("MO", "St. Louis", "St. Louis city", "29510"), ("MO", "St. Louis", "St. Louis County", "29189")]


class CountyLookup(unittest.TestCase):
    def test_county_beats_city_in_either_order(self):
        for rows in (VA, VA[::-1]):
            lk = H["county_lookup"](rows)
            self.assertEqual(lk[("VA", norm("Fairfax"))], "51059")
            self.assertEqual(lk[("VA", norm("Richmond"))], "51159")

    def test_city_only_name_still_resolves(self):
        self.assertEqual(H["county_lookup"](VA)[("NV", norm("Carson City"))], "32510")

    def test_override_replaces_city_polygon(self):
        lk = H["county_lookup"](VA)
        self.assertEqual(H["county_override"]("VA", "VA", "51600", "Fairfax", lk), "51059")
        self.assertIsNone(H["county_override"]("VA", "VA", "51059", "Fairfax", lk))

    def test_city_named_row_keeps_independent_city(self):
        lk = H["county_lookup"](VA)
        self.assertIsNone(H["county_override"]("MO", "MO", "29510", "City of St. Louis", lk))
        self.assertEqual(H["county_override"]("MO", "", "", "City of St. Louis", lk), "29510")
        self.assertEqual(H["county_override"]("MO", "MO", "29510", "St. Louis County", lk), "29189")
        self.assertEqual(H["county_override"]("MO", "MO", "29510", "St. Louis", lk), "29189")
        self.assertEqual(H["county_override"]("VA", "VA", "51600", "Fairfax County", lk), "51059")
        self.assertEqual(H["county_override"]("VA", "VA", "51159", "Richmond city", lk), "51760")

    def test_override_other_state_and_missing_join(self):
        lk = H["county_lookup"](VA)
        self.assertEqual(H["county_override"]("VA", "MD", "24005", "Fairfax", lk), "51059")
        self.assertEqual(H["county_override"]("VA", "", "", "Fairfax", lk), "51059")
        self.assertIsNone(H["county_override"]("VA", "", "", "Nowhere", lk))


class Status(unittest.TestCase):
    def test_known(self):
        self.assertEqual(H["map_status"]("rescinded", "x"), "lifted")
        self.assertEqual(H["map_status"]("active", "x"), "active")

    def test_unknown_warns_and_survives(self):
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(H["map_status"]("suspended", "nm-1"), "suspended")
        self.assertIn("nm-1", err.getvalue())
        self.assertIn("suspended", err.getvalue())


class Expiry(unittest.TestCase):
    A = date(2026, 1, 1)

    def test_extended_publishes_no_computed_date(self):
        self.assertEqual(H["expiry_from_duration"](None, "", self.A, 90.0, True), (None, ""))

    def test_extended_keeps_explicit_date(self):
        e = date(2027, 1, 1)
        self.assertEqual(H["expiry_from_duration"](e, "upstream_end_date", self.A, 90.0, True), (e, "upstream_end_date"))

    def test_not_extended_computes(self):
        self.assertEqual(H["expiry_from_duration"](None, "", self.A, 90.0, False),
                         (date(2026, 4, 1), "computed_adopted_plus_duration"))


if __name__ == "__main__":
    unittest.main()
