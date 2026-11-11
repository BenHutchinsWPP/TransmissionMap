"""Chain and blend math of build_escalation_index.py on synthetic numbers (no network)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_escalation_index as b


def rows(year, vals, kind='M'):
    return [{'year': str(year), 'period': f'{kind}{i + 1:02d}', 'value': str(v)} for i, v in enumerate(vals)]


class EscalationIndex(unittest.TestCase):
    def test_annual_average_of_months_and_quarters(self):
        r = rows(2000, [10] * 6 + [20] * 6) + rows(2001, [1, 2, 3, 6], 'Q')
        a = b.annual(r, {2000, 2001})
        self.assertEqual(a, {2000: 15.0, 2001: 3.0})

    def test_published_annual_wins_and_gap_is_dropped(self):
        r = rows(2000, [1, 2]) + [{'year': '2000', 'period': 'M13', 'value': '7'}] + rows(2001, [1] * 11)
        a = b.annual(r, {2000, 2001})
        self.assertEqual(a, {2000: 7.0})

    def test_chain_rescales_at_first_primary_year(self):
        primary = {2002: 200.0, 2003: 220.0}
        fallback = {2001: 50.0, 2002: 100.0, 2003: 110.0}
        out, y0 = b.chain(primary, fallback, [2001, 2002, 2003])
        self.assertEqual(y0, 2002)
        self.assertEqual(out, {2001: 100.0, 2002: 200.0, 2003: 220.0})

    def test_chain_needs_fallback_at_y0(self):
        with self.assertRaises(ValueError):
            b.chain({2002: 1.0}, {2001: 1.0}, [2001, 2002])

    def test_blend_is_one_at_to_year(self):
        lab = {2000: 50.0, 2001: 100.0}
        mat = {2000: 10.0, 2001: 20.0}
        idx = b.blend(lab, mat, 2001)
        self.assertAlmostEqual(idx[2001], 1.0)
        self.assertAlmostEqual(idx[2000], 0.5)


if __name__ == '__main__':
    unittest.main()
