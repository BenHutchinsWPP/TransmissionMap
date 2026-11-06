"""Tests for build_route_nfhl.py (plan routing-all, task W-NFHL).

Needs numpy/rasterio/shapely (venv); skips under `python3 -S`. Acceptance runs
`venv/bin/python -m unittest scripts/test_build_route_nfhl.py -v`. Synthetic polygons only; no data/, no network.
`ref_ge` is the independent reference: a naive per-cell loop over the exact shapely union area (the
`area_share_vector` rule of the validation harness), which shares no code with the supersample + exact step under test.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import numpy as np
    import shapely
    from shapely import box
    from shapely.geometry import MultiPolygon, Polygon
    import build_route_nfhl as B
    HAVE = B.HAVE
except ImportError:  # pragma: no cover
    HAVE = False

C = 250.0
X0, YT = 1000.0, 5000.0  # window corner in the test frame (any metres; only the cell lattice matters)


def cell(c, r):
    return box(X0 + c * C, YT - (r + 1) * C, X0 + (c + 1) * C, YT - r * C)


def ref_ge(geoms, w, h, thr=0.5):
    u = shapely.union_all([shapely.make_valid(g) for g in geoms]) if geoms else None
    out = np.zeros((h, w), bool)
    if u is None:
        return out
    for r in range(h):
        for c in range(w):
            out[r, c] = u.intersection(cell(c, r)).area >= thr * C * C
    return out


@unittest.skipUnless(HAVE, "needs numpy, rasterio, shapely (venv)")
class CodeTable(unittest.TestCase):
    def test_classify(self):
        # columns: off land, land/no panel/no sfha, land/no panel/sfha, panel/no sfha, panel/sfha, off land with both
        land = np.array([[0, 1, 1, 1, 1, 0]], bool)
        pan = np.array([[0, 0, 0, 1, 1, 1]], bool)
        sf = np.array([[0, 0, 1, 0, 1, 1]], bool)
        self.assertEqual(B.classify(pan, sf, land).tolist(), [[0, 3, 3, 1, 2, 0]])

    def test_every_land_cell_has_a_code_and_off_land_none(self):
        rng = np.random.default_rng(1)
        land, pan, sf = (rng.random((50, 50)) < p for p in (0.6, 0.5, 0.4))
        out = B.classify(pan, sf, land)
        self.assertTrue(((out > 0) == land).all())
        self.assertTrue(set(np.unique(out)) <= {0, 1, 2, 3})


@unittest.skipUnless(HAVE, "needs numpy, rasterio, shapely (venv)")
class SfhaValues(unittest.TestCase):
    def test_allowed_set_and_unknown_fails(self):
        self.assertEqual(B.sfha_bad_values({"T": 1, "F": 2, "U": 3, "None": 4}), [])
        self.assertEqual(B.sfha_bad_values({"T": 1, "X": 2}), ["X"])

    def test_only_t_is_sfha(self):
        g = [box(0, 0, 1, 1)] * 4
        self.assertEqual(len(B.only_sfha(g, ["T", "F", "U", "None"])), 1)
        # a cell covered by panels with only U/null/F polygons around is code 1, not 2
        land = np.array([[1]], bool)
        sfha_ge = B.share_ge(B.only_sfha([box(X0, YT - C, X0 + C, YT)] * 3, ["U", "None", "F"]), X0, YT, 1, 1)[0]
        self.assertEqual(B.classify(np.array([[1]], bool), sfha_ge, land).tolist(), [[1]])


@unittest.skipUnless(HAVE, "needs numpy, rasterio, shapely (venv)")
class Shares(unittest.TestCase):
    def check(self, geoms, w=6, h=5):
        got, n = B.share_ge(geoms, X0, YT, w, h)
        want = ref_ge(geoms, w, h)
        self.assertEqual(got.tolist(), want.tolist())
        return got, n

    def test_empty(self):
        self.assertFalse(B.share_ge([], X0, YT, 3, 3)[0].any())

    def test_exactly_half_counts(self):
        left = box(X0, YT - C, X0 + C / 2, YT)  # left half of cell (0, 0): share exactly 0.5
        got, n = self.check([left])
        self.assertTrue(got[0, 0])
        self.assertGreater(n, 0)

    def test_just_under_half_does_not(self):
        got, _ = self.check([box(X0, YT - C, X0 + C / 2 - 0.01, YT)])
        self.assertFalse(got[0, 0])

    def test_just_over_half_does(self):
        got, _ = self.check([box(X0, YT - C, X0 + C / 2 + 0.01, YT)])
        self.assertTrue(got[0, 0])

    def test_sliver_with_many_edges_near_threshold(self):
        # a comb: 5 teeth of 25 m with 25 m gaps cover exactly half; supersampling alone could misjudge it
        teeth = [box(X0 + k * 50, YT - C, X0 + k * 50 + 25.3, YT) for k in range(5)]
        self.check(teeth)

    def test_polygon_cut_by_window_edges(self):
        big = box(X0 - 900, YT - 5 * C - 700, X0 + 6 * C + 400, YT + 800)
        got, _ = self.check([big])
        self.assertTrue(got.all())
        edge = box(X0 + 5.5 * C, YT - 3 * C, X0 + 9 * C, YT + 2 * C)  # half of the last column, beyond the window
        self.check([edge])

    def test_overlapping_pieces_are_a_union_not_a_sum(self):
        a = box(X0, YT - C, X0 + 0.4 * C, YT)
        b = box(X0 + 0.1 * C, YT - C, X0 + 0.45 * C, YT)  # union 0.45, sum 0.75
        got, _ = self.check([a, b])
        self.assertFalse(got[0, 0])
        got, _ = self.check([a, box(X0 + 0.3 * C, YT - C, X0 + 0.55 * C, YT)])  # union 0.55
        self.assertTrue(got[0, 0])

    def test_multipolygon_and_invalid_bowtie(self):
        mp = MultiPolygon([box(X0, YT - C, X0 + 0.3 * C, YT), box(X0 + 0.6 * C, YT - C, X0 + 0.9 * C, YT)])
        self.check([mp])
        bow = Polygon([(X0 + 2 * C, YT), (X0 + 3 * C, YT - C), (X0 + 3 * C, YT), (X0 + 2 * C, YT - C)])
        self.assertFalse(bow.is_valid)
        self.check([bow])

    def test_random_polygons_match_reference(self):
        rng = np.random.default_rng(7)
        geoms = []
        for _ in range(12):
            cx, cy = X0 + rng.random() * 6 * C, YT - rng.random() * 5 * C
            n = int(rng.integers(3, 9))
            ang = np.sort(rng.random(n) * 2 * np.pi)
            rad = (0.2 + rng.random(n)) * C
            geoms.append(Polygon(np.column_stack([cx + rad * np.cos(ang), cy + rad * np.sin(ang)])))
        self.check(geoms, 8, 7)


if __name__ == "__main__":
    unittest.main()
