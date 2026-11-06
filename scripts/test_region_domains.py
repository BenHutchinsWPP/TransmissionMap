"""Checks the committed region domain tables (src/registry/region-codes.ts and
region-labels.json, written by build_region_domains.py) against the admin-1
code table and the patterns the frontend validates the large kinds by.
Stdlib only; reads no data/.

    python3 -m unittest scripts/test_region_domains.py
"""
import csv
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CODES_TS = (ROOT / "src" / "registry" / "region-codes.ts").read_text()
LABELS = json.loads((ROOT / "src" / "registry" / "region-labels.json").read_text())
with open(ROOT / "scripts" / "admin1_codes.csv", newline="") as f:
    ADMIN1 = list(csv.DictReader(f))

FIELD_SCHEMA_TS = (ROOT / "src" / "registry" / "field-schema.ts").read_text()


def schema_pattern(const):
    """The `pattern: /…/` of a shared *_FIELD const in field-schema.ts."""
    m = re.search(rf"const {const} = region\(.*?pattern: /(.+?)/ \}}\)", FIELD_SCHEMA_TS)
    return re.compile(m.group(1))


COUNTY_RE = schema_pattern("COUNTIES_FIELD")
ADMIN1_RE = schema_pattern("ADMIN1_FIELD")
RETAIL_RE = schema_pattern("RETAIL_FIELD")
KINDS = {"states", "counties", "ba", "nerc", "retail", "countries", "admin1"}


def ts_const(name):
    return json.loads(re.search(rf"export const {name}: [^=]+= (.+?);\n", CODES_TS).group(1))


class RegionDomainsTest(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(set(LABELS) - {"_generated"}, KINDS)

    def test_states(self):
        self.assertEqual(len(ts_const("STATE_CODES")), 56)
        self.assertEqual(LABELS["states"]["TX"], "Texas")

    def test_state_to_admin1_is_a_bijection_onto_us_rows(self):
        mapping = ts_const("STATE_TO_ADMIN1")
        us = {r["code"] for r in ADMIN1 if r["iso3"] == "USA" and r["current"] == "1"}
        self.assertEqual(set(mapping), set(ts_const("STATE_CODES")))
        self.assertEqual(sorted(mapping.values()), sorted(us))
        self.assertEqual(mapping["TX"], "USAB")

    def test_admin1_labels_cover_every_code(self):
        self.assertEqual(set(LABELS["admin1"]), {r["code"] for r in ADMIN1})
        for code in LABELS["admin1"]:
            self.assertTrue(ADMIN1_RE.fullmatch(code), code)

    def test_counties_match_their_pattern(self):
        self.assertEqual(len(LABELS["counties"]), 3235)
        self.assertTrue(all(COUNTY_RE.fullmatch(k) for k in LABELS["counties"]))
        self.assertEqual(LABELS["counties"]["48201"], "Harris County, TX")

    def test_retail_matches_its_pattern(self):
        keys = list(LABELS["retail"])
        self.assertEqual(len(keys), 2931)
        bad = [k for k in keys if not RETAIL_RE.fullmatch(k)]
        self.assertEqual(bad, [])
        self.assertEqual(sum(k.startswith("NA") for k in keys), 12)

    def test_every_eager_code_has_a_label(self):
        for const, kind in (("STATE_CODES", "states"), ("BA_CODES", "ba"), ("COUNTRY_CODES", "countries")):
            self.assertEqual(sorted(ts_const(const)), sorted(LABELS[kind]), const)

    def test_ba_codes_include_the_eia_only_codes(self):
        self.assertLessEqual({"EPE", "GRIS", "HECO", "NWMT"}, set(ts_const("BA_CODES")))

    def test_country_codes_include_every_admin1_parent(self):
        self.assertLessEqual({r["iso3"] for r in ADMIN1}, set(ts_const("COUNTRY_CODES")))

    def test_nerc_labels(self):
        self.assertEqual(set(LABELS["nerc"]), {"FRCC", "MRO", "NPCC", "RFC", "SERC", "SPP", "TRE", "WECC"})


if __name__ == "__main__":
    unittest.main()
