"""Tests for build_route_aviation.py.

Needs numpy/rasterio/shapely/pyproj (venv); skips under `python3 -S`. Acceptance runs
`venv/bin/python -m unittest scripts/test_build_route_aviation.py -v`. Synthetic records and a flat synthetic DEM;
no data/, no network. The expected codes are worked by hand in the comments of RunwayCodes.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import numpy as np
    import build_route_aviation as B
    import route_aviation as A
    from test_route_aviation import at, civil
    HAVE = B.HAVE
except ImportError:  # pragma: no cover
    HAVE = False

GROUND = 100.0  # m, flat synthetic DEM; the runway elevation equals it (328.084 ft)


@unittest.skipUnless(HAVE, "needs numpy, rasterio, shapely, pyproj (venv)")
class RunwayCodes(unittest.TestCase):
    """A 2,000 m E-W utility-visual hard runway (A(V)) at elevation 100 m; end 09 (west) has its approach to the west.

    Hand numbers (77.19, feet worked to metres): primary ends 200 ft = 60.96 m beyond the end; the approach rises
    20:1 from the end elevation for 5,000 ft = 1,524 m starting there; the horizontal surface is 150 ft = 45.72 m
    above the airport (145.72 m MSL) out to 5,000 ft from the centre of each primary end; the conical rises 20:1
    beyond it for 4,000 ft. s = metres west of the primary end, on the extended centreline:
      s = 300   approach 100 + 300/20 = 115.00 -> AGL 115 - 100 - 5 = 10.00 -> code 5
      s = 800   approach 140.00 -> AGL 35.00 -> code 4
      s = 1200  horizontal 145.72 is lower than the approach (160) -> AGL 40.72 -> code 4
      s = 1874  past the approach (1524) and the horizontal arc (1524): conical 145.72 + 350/20 = 163.22 -> AGL 58.22 -> code 3
                (with a 0 m margin AGL 63.22 -> code 2)
    On the runway: primary -> 6. 4 km north of the runway: inside the 20,000 ft notice reach, under no 77.19 surface -> 2.
    """
    NX = 534  # 16 km of 30 m pixels = 64 cells of 250 m

    @classmethod
    def setUpClass(cls):
        cls.fs, cls.pa, cls.pb = civil("A(V)", "A(V)", length_ft=2000 / A.FT, elev=GROUND / A.FT)
        ax, ay = at(cls.pa[0], cls.pa[1], 270, 0)
        cls.xa = round((ax - 8000) / 30) * 30.0
        cls.yt = round((ay + 8000) / 30) * 30.0
        cls.g = B.Grid(cls.xa, cls.yt, cls.NX, cls.NX)
        cls.layers = B.new_layers(cls.g)
        B.paint(cls.fs, cls.g, cls.layers)
        cls.dem = np.full((cls.NX, cls.NX), GROUND, np.float32)

    def px(self, xy):
        return int((self.yt - xy[1]) // 30), int((xy[0] - self.xa) // 30)

    def west(self, s):
        return at(self.pa[0], self.pa[1], 270, 60.96 + s)

    def test_pixel_codes_on_the_extended_centreline(self):
        code = B.pixel_codes(self.layers, self.dem)
        for s, want in ((300, 5), (800, 4), (1200, 4), (1874, 3)):
            self.assertEqual(int(code[self.px(self.west(s))]), want, s)

    def test_on_the_runway_is_primary(self):
        code = B.pixel_codes(self.layers, self.dem)
        mid = at(self.pa[0], self.pa[1], 90, 1000)
        self.assertEqual(int(code[self.px(mid)]), 6)

    def test_notice_only_is_code_2(self):
        code = B.pixel_codes(self.layers, self.dem)
        mid = at(self.pa[0], self.pa[1], 90, 1000)
        north = (mid[0], mid[1] + 4000)
        self.assertEqual(int(code[self.px(north)]), 2)

    def test_code_2_only_inside_the_notice_extent(self):
        low = np.full((2, 2), GROUND + 100.0)   # AGL 95 m: code 2 by height
        notice = np.array([[True, False], [True, False]])
        code = B.pixel_codes((low, np.zeros((2, 2), bool), notice), np.full((2, 2), GROUND, np.float32))
        self.assertEqual(code.tolist(), [[2, 0], [2, 0]])
        low[1, 1] = GROUND + 50.0               # AGL 45 m: a lower class keeps its code outside the extent
        code = B.pixel_codes((low, np.zeros((2, 2), bool), notice), np.full((2, 2), GROUND, np.float32))
        self.assertEqual(int(code[1, 1]), 4)

    def test_margin_is_subtracted_before_binning(self):
        p = self.px(self.west(1874))
        self.assertEqual(int(B.pixel_codes(self.layers, self.dem)[p]), 3)       # AGL 58.22 with 5 m
        self.assertEqual(int(B.pixel_codes(self.layers, self.dem, margin=0.0)[p]), 2)  # 63.22 with 0 m
        self.assertEqual(B.MARGIN_M, 5.0)

    def test_margin_changes_a_cell(self):
        w = h = 64
        valid = np.isfinite(self.dem)
        c5, _ = B.to_cells(B.pixel_codes(self.layers, self.dem), valid, w, h)
        c0, _ = B.to_cells(B.pixel_codes(self.layers, self.dem, margin=0.0), valid, w, h)
        self.assertTrue((c5 != c0).any())
        self.assertGreater(int((c5 != c0).sum()), 0)

    def test_cell_takes_the_worst_class(self):
        w = h = 64
        cells, valid = B.to_cells(B.pixel_codes(self.layers, self.dem), np.isfinite(self.dem), w, h)
        mid = at(self.pa[0], self.pa[1], 90, 1000)
        self.assertEqual(int(cells[int((self.yt - mid[1]) // 250), int((mid[0] - self.xa) // 250)]), 6)
        # a cell 6.5 km north of the runway holds only pixels with no surface (notice reach is 6.1 km)
        far = (mid[0], mid[1] + 6500)
        self.assertEqual(int(cells[int((self.yt - far[1]) // 250), int((far[0] - self.xa) // 250)]), 0)

    def test_land_cell_without_surface_is_1_and_off_land_is_0(self):
        w = h = 64
        cells, valid = B.to_cells(B.pixel_codes(self.layers, self.dem), np.isfinite(self.dem), w, h)
        mid = at(self.pa[0], self.pa[1], 90, 1000)
        far = (int((self.yt - (mid[1] + 6500)) // 250), int((mid[0] - self.xa) // 250))
        on = (int((self.yt - mid[1]) // 250), int((mid[0] - self.xa) // 250))
        land = np.ones(cells.shape, bool)
        out = B.finalize(cells, valid, land, np.zeros(cells.shape, bool))
        self.assertEqual(int(out[far]), 1)
        self.assertEqual(int(out[on]), 6)
        land[far] = False
        land[on] = False
        out = B.finalize(cells, valid, land, np.zeros(cells.shape, bool))
        self.assertEqual(int(out[far]), 0)
        self.assertEqual(int(out[on]), 0)  # a surface off land is dropped

    def test_land_cell_without_dem_stays_0(self):
        dem = self.dem.copy()
        dem[:] = np.nan
        cells, valid = B.to_cells(B.pixel_codes(self.layers, dem), np.isfinite(dem), 64, 64)
        self.assertEqual(int(cells.max()), 0)
        land = np.ones(cells.shape, bool)
        self.assertEqual(int(B.finalize(cells, valid, land, np.zeros(cells.shape, bool)).max()), 0)
        # the slope band's own valid-DEM test can rescue a window the warp did not read
        self.assertEqual(int(B.finalize(cells, valid, land, np.ones(cells.shape, bool)).min()), 1)

    def test_pixels_without_dem_get_no_code(self):
        dem = self.dem.copy()
        p = self.px(self.west(300))
        dem[p] = np.nan
        self.assertEqual(int(B.pixel_codes(self.layers, dem)[p]), 0)

    def test_cell_assignment_uses_pixel_centres(self):
        code = np.zeros((534, 534), np.uint8)
        code[8, 8] = 3   # pixel 8 spans 240-270 m, centre 255 m -> cell 1
        code[7, 7] = 4   # centre 225 m -> cell 0
        cells, _ = B.to_cells(code, np.ones(code.shape, bool), 64, 64)
        self.assertEqual((int(cells[0, 0]), int(cells[1, 1])), (4, 3))
        self.assertEqual(cells.shape, (64, 64))


@unittest.skipUnless(HAVE, "needs numpy, rasterio, shapely, pyproj (venv)")
class NtadJoin(unittest.TestCase):
    def write(self, d, name, rows):
        (Path(d) / f"{name}.jsonl").write_text("\n".join(json.dumps({"attributes": r}) for r in rows) + "\n")

    def test_join_on_ident_then_icao_and_coverage(self):
        fac = lambda sid, arpt, **kw: dict({"SITE_NO": sid, "ARPT_ID": arpt, "SITE_TYPE_CODE": "A", "ARPT_STATUS": "O",
                                            "FACILITY_USE_CODE": "PR", "OWNERSHIP_TYPE_CODE": "PR",
                                            "LAT_DECIMAL": 40.0, "LONG_DECIMAL": -100.0}, **kw)
        with tempfile.TemporaryDirectory() as d:
            self.write(d, "facilities", [fac("1.", " abc "), fac("2.", "XYZ", ICAO_ID="KXYZ"), fac("3.", "NOPE"),
                                         fac("4.", "CLS", ARPT_STATUS="CI", FACILITY_USE_CODE="PU"),
                                         fac("5.", "PUB", FACILITY_USE_CODE="PU"),
                                         fac("6.", "MIL", OWNERSHIP_TYPE_CODE="MN")])
            self.write(d, "runways", [])
            self.write(d, "runway_ends", [])
            self.write(d, "adds_airports", [{"IDENT": "ABC", "ICAO_ID": None, "IAPEXISTS": 1},
                                            {"IDENT": "ZZZ", "ICAO_ID": "kxyz", "IAPEXISTS": 1}])
            old = B.NTAD_DIR
            B.NTAD_DIR = Path(d)
            try:
                f, r, e, js = B.load_ntad()
            finally:
                B.NTAD_DIR = old
        iap = {x["SITE_NO"]: x["IAPEXISTS"] for x in f}
        self.assertEqual((iap["1."], iap["2."], iap["3."]), (1, 1, None))
        self.assertEqual(js["via_icao"], 1)
        self.assertEqual([x["SITE_NO"] for x in js["unmatched"]], ["3.", "4.", "5.", "6."])
        used = sorted(x["SITE_NO"] for x in B.covered(f, e))
        # 1 and 2 by IAP, 5 public use, 6 DoD; 3 private without IAP and 4 closed are out
        self.assertEqual(used, ["1.", "2.", "5.", "6."])


@unittest.skipUnless(HAVE, "needs numpy, rasterio, shapely, pyproj (venv)")
class PastTheNoticeExtent(unittest.TestCase):
    """A 6,000 ft precision (PIR) runway at 100 m: 77.19(d) approach runs 50,000 ft from the primary end, the 77.9(b)(1)
    notice extent 20,000 ft (6,096 m) from the runway. 12 km west of end 09 on the centreline the approach is
    3048/50 + (12000 - 3048)/40 = 284.8 m above the end -> AGL 279.8 m (code 2 by height), outside the notice extent -> 0.
    4 km west it is inside the extent: 3048/50 + 952/40 = 84.8 m -> AGL 79.8 m -> 2."""

    def code_at(self, xy):
        fs, _, _ = civil("PIR", "PIR", elev=GROUND / A.FT)
        xa, yt = round(xy[0] / 30) * 30.0 - 300, round(xy[1] / 30) * 30.0 + 300
        g = B.Grid(xa, yt, 20, 20)
        layers = B.new_layers(g)
        B.paint(fs, g, layers)
        code = B.pixel_codes(layers, np.full((20, 20), GROUND, np.float32))
        return int(code[int((yt - xy[1]) // 30), int((xy[0] - xa) // 30)])

    def test_approach_outside_the_notice_extent_is_not_code_2(self):
        pa = civil("PIR", "PIR", elev=GROUND / A.FT)[1]
        self.assertEqual(self.code_at(at(pa[0], pa[1], 270, 60.96 + 12000)), 0)
        self.assertEqual(self.code_at(at(pa[0], pa[1], 270, 60.96 + 4000)), 2)


if __name__ == "__main__":
    unittest.main()
