"""Tests for build_route_bands.py: empty-chunk rasterize guard and which outputs check_outputs verifies.

Needs numpy/rasterio/fiona/geopandas (venv); skips under `python3 -S`. No data/ or network.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import numpy as np
    import build_route_bands as B
    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False

SQ = {"type": "Polygon", "coordinates": [[(0, 0), (1, 0), (1, 1), (0, 0)]]}


class Src:
    def __init__(self, feats):
        self.f = feats

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        return iter(self.f)


@unittest.skipUnless(HAVE, "needs the repo venv (numpy, rasterio, fiona, geopandas)")
class RouteBands(unittest.TestCase):
    def test_raster_shapes_drops_null_and_empty(self):
        got = B.raster_shapes([(None, 1), ({"type": "Polygon", "coordinates": []}, 2), (SQ, 3)])
        self.assertEqual(got, [(SQ, 3)])

    def test_padus_chunk_without_gap_features_does_not_raise(self):
        feats = [{"geometry": None, "properties": {"GAP_Sts": "1", "Mang_Name": "x", "Mang_Type": "FED"}},
                 {"geometry": SQ, "properties": {"GAP_Sts": "9", "Mang_Name": "x", "Mang_Type": "PVT"}}]
        orig, saved, real = B.fiona.open, (B.SHAPE, B.AFF), B.rasterize

        def strict(shapes, **kw):  # rasterio's "No valid geometry objects found" on an empty list
            shapes = list(shapes)
            if not shapes:
                raise ValueError("No valid geometry objects found for rasterize")
            return real(shapes, **kw)
        B.rasterize = strict
        B.fiona.open = lambda *a, **k: Src(feats)
        B.SHAPE, B.AFF = (4, 4), B.Affine(1, 0, 0, 0, -1, 4)
        try:
            gap, ag = B.build_padus()
        finally:
            B.fiona.open = orig
            B.rasterize = real
            B.SHAPE, B.AFF = saved
        self.assertEqual(int(gap.sum()), 0)

    def test_checked_outputs_protect_after_every_writer(self):
        for step in ("protect", "agency", "easement", "preserve"):
            self.assertIn("protect", B.checked_outputs([step]), step)

    def test_checked_outputs_easement_does_not_check_agency(self):
        self.assertEqual(B.checked_outputs(["easement"]), ["protect", "state"])

    def test_checked_outputs_protect_also_checks_agency(self):
        self.assertEqual(B.checked_outputs(["protect"]), ["protect", "agency", "state"])

    def test_checked_outputs_skips_missing_files(self):
        self.assertEqual(B.checked_outputs(["easement"], lambda n: n == "state"), ["state"])


if __name__ == "__main__":
    unittest.main()
