"""Tests for route_asbuilt_lines.py step 1: segment joining and the chain search.

Needs numpy/shapely/pyproj (venv); skips under `python3 -S`. Synthetic segments only; no data/.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import route_asbuilt_lines as A
    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False


def edge(a, b):
    return {"id": "x", "a": a, "b": b, "len": ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5}


@unittest.skipUnless(HAVE, "needs numpy/shapely/pyproj")
class Chain(unittest.TestCase):
    def test_join_and_path(self):
        es = [edge((0, 0), (50_000, 0)), edge((50_040, 0), (100_000, 0)), edge((0, 5000), (0, 90_000))]
        na, nb, xy = A.nodes_of(es)
        self.assertEqual(nb[0], na[1])          # ends 40 m apart are one node
        self.assertNotEqual(na[2], na[0])
        r = A.shortest(es, na, nb, {na[0]}, {nb[1]}, 100_000)
        self.assertEqual(r[1], [0, 1])

    def test_length_band(self):
        es = [edge((0, 0), (50_000, 0))]
        na, nb, _ = A.nodes_of(es)
        self.assertIsNone(A.shortest(es, na, nb, {na[0]}, {nb[0]}, 200_000))   # 50 km < 0.5 x 200
        self.assertIsNotNone(A.shortest(es, na, nb, {na[0]}, {nb[0]}, 80_000))


@unittest.skipUnless(HAVE, "needs numpy/shapely/pyproj")
class Neutraliser(unittest.TestCase):
    def test_polygon_round_trip_hits_exactly_the_cells(self):
        cells = {(5000 + i, 9000 + j) for i in range(3) for j in range(40)} | {(5100, 9100)}
        self.assertEqual(A.polygon_cells(A.cells_polygon(cells)), cells)

    def test_n1_reads_adj_class_in_the_target_class(self):
        import numpy as np
        small = {(10, 10)}
        arr = np.zeros((A.G.ROWS, A.G.COLS), dtype=np.uint8)
        arr[10, 10] = A.G.adj_encode(1)                     # >= 230 kV class 1 on the cell
        arr[10, 12] = A.G.adj_encode(2)
        arr[10, 13] = A.G.adj_encode(3)                     # class 3 is not N1
        arr[11, 10] = A.G.adj_encode(0, class_100=1)        # only a 100-229 kV class
        self.assertEqual(A.build_n1(arr, small, 345.0, None), {(10, 10), (10, 12)})
        self.assertEqual(A.build_n1(arr, small, 138.0, None), {(11, 10)})


if __name__ == "__main__":
    unittest.main()
