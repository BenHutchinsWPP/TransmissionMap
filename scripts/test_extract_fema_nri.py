"""Smoke tests for extract_fema_nri.py's pure table builder, build_snapshot()
(no network, no data/).
"""
import unittest

from extract_fema_nri import HAZARDS, build_snapshot, fields_for


def _row(fips, **overrides):
    row = {"STCOFIPS": fips, "NRI_VER": "December 2025"}
    for h in HAZARDS:
        sf, rf = fields_for(h)
        row[sf], row[rf] = 50.0, "Relatively Moderate"
    row.update(overrides)
    return row


class TestBuildSnapshot(unittest.TestCase):
    def test_layout_and_codes(self):
        snap = build_snapshot([_row("08123", RISK_SCORE=97.36005, RISK_RATNG="Very High",
                                    HRCN_RISKS=None, HRCN_RISKR="Not Applicable",
                                    AVLN_RISKR="Insufficient Data", TSUN_RISKR="No Rating")],
                              "2026-09-26T00:00:00Z")
        vals = snap["counties"]["08123"]
        self.assertEqual(len(vals), 2 * len(HAZARDS))
        at = lambda h: vals[2 * HAZARDS.index(h): 2 * HAZARDS.index(h) + 2]
        self.assertEqual(at("RISK"), [97.4, 5])
        self.assertEqual(at("HRCN"), [None, 0])
        self.assertEqual(at("AVLN")[1], 6)
        self.assertEqual(at("TSUN")[1], 0)
        self.assertEqual(at("WFIR"), [50.0, 3])
        self.assertEqual(snap["version"], "December 2025")
        self.assertEqual(snap["hazards"][0], "RISK")
        self.assertEqual(len(snap["ratings"]), 7)

    def test_fips_kept_as_zero_padded_string(self):
        snap = build_snapshot([_row("01001"), _row("1001"), _row(None)], "t")
        self.assertEqual(list(snap["counties"]), ["01001"])


if __name__ == "__main__":
    unittest.main()
