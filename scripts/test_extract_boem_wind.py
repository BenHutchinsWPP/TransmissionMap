#!/usr/bin/env python3
"""Tests for extract_boem_wind.py's content id (stdlib only; no data/ or network)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_boem_wind as B

def raw(lease, kind, company, project, date):
    return {"LEASE_NUMB": lease, "LEASE_TYPE": kind, "COMPANY": company, "PROJECT_NA": project,
            "LEASE_DATE": date, "STATE": "Massachusetts", "ACRES": 100.0, "LEASE_TERM": "33 Years"}


E1 = (raw("OCS-A 0501", "Easement", "Acme Wind", "Line 1", "01/01/2020"), (-70.0, 40.0, -69.5, 40.5), 12)
E2 = (raw("OCS-A 0498", "Easement", "Acme Wind", "Line 2", "01/01/2020"), (-71.0, 41.0, -70.5, 41.5), 8)
C1 = (raw("OCS-A 0506", "Commercial", "Beta Power", None, "12/01/2014"), (-72.0, 39.0, -71.0, 40.0), 30)


def rows():
    return [E1, E1, E2, C1]


class TestBoemFid(unittest.TestCase):
    def test_form(self):
        f = B.boem_fid(*E1)
        self.assertEqual(len(f), 12)
        int(f, 16)

    def test_identical_pair_takes_one_suffix(self):
        ids = B.assign_fids(B.boem_fid(*r) for r in rows())
        base = B.boem_fid(*E1)
        self.assertEqual(ids[0], base)
        self.assertEqual(ids[1], f"{base}-1")
        self.assertEqual(len(set(ids)), 4)
        self.assertEqual(sum("-" in i for i in ids), 1)

    def test_stable_across_row_order(self):
        a = dict(zip(["e1", "e1b", "e2", "c1"], B.assign_fids(B.boem_fid(*r) for r in rows())))
        b = B.assign_fids(B.boem_fid(*r) for r in [C1, E2, E1, E1])
        self.assertEqual(b[0], a["c1"])
        self.assertEqual(b[1], a["e2"])
        self.assertEqual({b[2], b[3]}, {a["e1"], a["e1b"]})

    def test_grid_absorbs_sub_micro_degree_noise_only(self):
        same = (E1[0], (-70.0000000004, 40.0, -69.5, 40.5), 12)
        moved = (E1[0], (-70.00001, 40.0, -69.5, 40.5), 12)
        self.assertEqual(B.boem_fid(*E1), B.boem_fid(*same))
        self.assertNotEqual(B.boem_fid(*E1), B.boem_fid(*moved))

    def test_each_key_field_moves_the_id(self):
        base = B.boem_fid(*E1)
        for k in B.KEY_FIELDS:
            self.assertNotEqual(base, B.boem_fid({**E1[0], k: "x"}, *E1[1:]), k)
        self.assertNotEqual(base, B.boem_fid(E1[0], E1[1], 13))

    def test_reassignment_rename_and_other_fields_keep_the_id(self):
        base = B.boem_fid(*E1)
        for k in ("COMPANY", "PROJECT_NA", "STATE", "ACRES", "LEASE_TERM"):
            self.assertEqual(base, B.boem_fid({**E1[0], k: "changed"}, *E1[1:]), k)

    def test_whitespace_and_missing_values_hash_alike(self):
        self.assertEqual(B.boem_fid(*E1), B.boem_fid({**E1[0], "LEASE_NUMB": " OCS-A 0501\r\n"}, *E1[1:]))
        a, b, c = ({**E1[0], "LEASE_DATE": v} for v in (None, float("nan"), ""))
        self.assertEqual(B.boem_fid(a, *E1[1:]), B.boem_fid(b, *E1[1:]))
        self.assertEqual(B.boem_fid(a, *E1[1:]), B.boem_fid(c, *E1[1:]))

    def test_clean_strips_strings_only(self):
        self.assertEqual(B.clean("Ocean Wind LLC\r\n"), "Ocean Wind LLC")
        self.assertIsNone(B.clean(float("nan")))
        self.assertEqual(B.clean(5.0), 5.0)

    def test_duplicate_after_suffixing_is_refused(self):
        # An id that equals another row's suffixed form can only collide by
        # hash accident; the check still refuses it.
        with self.assertRaises(ValueError):
            B.assign_fids(["aaa", "aaa", "aaa-1"])
        with self.assertRaises(ValueError):
            B.check_unique(["a", "b", "a"])


if __name__ == "__main__":
    unittest.main()
