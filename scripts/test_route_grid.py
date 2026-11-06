"""Tests for route_grid.py — the 250 m route grid and band code tables (stdlib only)."""
import json
import unittest

import route_grid as g


# `SELECT abbrev FROM eia_ba` on data/build/eia_ba.gpkg (85 BAs), pasted so the test reads no data/.
EIA_BA_ABBREVS = [
    "AEC", "AECI", "AESO", "AMPL", "AVA", "AVRN", "AZPS", "BANC", "BCHA", "BCTC",
    "BPAT", "CEA", "CFE", "CHPD", "CISO", "CPLE", "CPLW", "DEAA", "DOPD", "DUK",
    "EEI", "EKPC", "ELE", "ERCO", "FMPP", "FPC", "FPL", "GCPD", "GLHB", "GRID",
    "GRIF", "GRMA", "GVL", "GWA", "HEC", "HGMA", "HQT", "HST", "IESO", "IID",
    "IPCO", "ISNE", "JEA", "LDWP", "LGEE", "MHEB", "MISO", "MPCO", "NBSO", "NEVP",
    "NMISA", "NSB", "NSPI", "NYIS", "OVEC", "PACE", "PACW", "PGE", "PJM", "PNM",
    "POWX", "PSCO", "PSEI", "RC", "SC", "SCEG", "SCL", "SEC", "SEPA", "SOCO",
    "SPA", "SPC", "SRP", "SWPP", "TAL", "TEC", "TEPC", "TIDC", "TPWR", "TVA",
    "WACM", "WALC", "WAUW", "WWA", "YAD",
]


class GridTests(unittest.TestCase):
    def test_origin_and_transform(self):
        self.assertEqual(g.transform(), (-2493045.0, 250.0, 0.0, 3310005.0, 0.0, -250.0))
        self.assertEqual(g.CRS, "EPSG:5070")
        # origin sits on the legacy NLCD 30 m lattice (NLCD x0 = -2493045, y0 = 3310005)
        self.assertEqual((g.X0 + 2493045) % 30, 0)
        self.assertEqual((3310005 - g.Y0) % 30, 0)

    def test_covers_nlcd_extent(self):
        self.assertGreaterEqual(g.X0 + g.COLS * g.CELL, 2342655)
        self.assertLessEqual(g.Y0 - g.ROWS * g.CELL, 177285)
        # and no whole spare column/row beyond it
        self.assertLess(g.X0 + (g.COLS - 1) * g.CELL, 2342655)
        self.assertGreater(g.Y0 - (g.ROWS - 1) * g.CELL, 177285)

    def test_super_tiles(self):
        st = g.super_tiles()
        self.assertEqual(len(st), 20)
        self.assertEqual(sum(t[4] * t[5] for t in st), g.COLS * g.ROWS)
        self.assertEqual({t[4] for t in st}, {4096, 19343 - 4 * 4096})
        self.assertEqual({t[5] for t in st}, {4096, 12531 - 3 * 4096})
        self.assertEqual(12531 - 3 * 4096, 243)
        self.assertEqual(19343 - 4 * 4096, 2959)
        last = st[-1]
        self.assertEqual(last, (4, 3, 4 * 4096, 3 * 4096, 2959, 243))

    def test_super_tiles_bbox(self):
        x, y = g.xy_of(10, 10)
        self.assertEqual([t[:2] for t in g.super_tiles((x, y, x + 1, y + 1))], [(0, 0)])
        x, y = g.xy_of(g.COLS - 1, g.ROWS - 1)
        self.assertEqual([t[:2] for t in g.super_tiles((x, y, x, y))], [(4, 3)])
        c, r = g.cell_of(0, 1000000)
        self.assertEqual([t[:2] for t in g.super_tiles((0, 1000000, 1, 1000001))], [(c // 4096, r // 4096)])
        self.assertEqual(g.super_tiles((0, 0, 1, 1)), [])

    def test_cell_xy_round_trip(self):
        for col, row in [(0, 0), (1, 2), (19342, 12530), (9000, 5000)]:
            self.assertEqual(g.cell_of(*g.xy_of(col, row)), (col, row))
            self.assertEqual(g.cell_of(*g.xy_of(col, row, center=False)), (col, row))
        self.assertEqual(g.xy_of(0, 0, center=False), (g.X0, g.Y0))
        self.assertEqual(g.cell_of(g.X0 - 1, g.Y0 + 1), (-1, -1))

    def test_windows_reject_bad_size(self):
        for bad in (0, -750, 1000, 30001, 7500.5):
            with self.assertRaises(ValueError):
                list(g.windows(bad))

    def test_windows_tile_grid(self):
        for wm in (30000, 60000, 7500):
            seen = 0
            prev_end = None
            for col_off, row_off, w, h, (x0, y0, x1, y1) in g.windows(wm):
                seen += w * h
                self.assertLessEqual(w, wm // 250)
                self.assertEqual(col_off % (wm // 250), 0)
                self.assertEqual(row_off % (wm // 250), 0)
                # 30 m bounds cover the 250 m window and sit on the 30 m lattice
                cx0, cy1 = g.xy_of(col_off, row_off, center=False)
                cx1, cy0 = g.xy_of(col_off + w, row_off + h, center=False)
                self.assertEqual((x0, y1), (cx0, cy1))
                self.assertGreaterEqual(x1, cx1)
                self.assertLessEqual(y0, cy0)
                self.assertEqual((x1 - g.X0) % 30, 0)
                self.assertEqual((g.Y0 - y0) % 30, 0)
                if wm == 30000 and w == 120:
                    self.assertEqual(x1 - x0, 30000)
            self.assertEqual(seen, g.COLS * g.ROWS)

    def test_windows_no_overlap(self):
        cells = set()
        for col_off, row_off, w, h, _ in g.windows(60000):
            key = (col_off, row_off)
            self.assertNotIn(key, cells)
            cells.add(key)
        self.assertEqual(len(cells), -(-g.COLS // 240) * -(-g.ROWS // 240))

    def test_code_tables(self):
        self.assertEqual(len(g.PD_BANDS), 19)
        self.assertEqual(len(g.OSM_BANDS), 3)
        self.assertEqual(sorted(g.PD_BANDS), list(range(1, 20)))
        self.assertEqual(sorted(g.AVIATION_CODES), list(range(1, 7)))
        self.assertEqual(sorted(g.NFHL_CODES), list(range(1, 4)))
        self.assertEqual(len(g.SLOPE_CODES), 8)
        self.assertEqual(g.AGENCY_CODES[1], "private/none")
        self.assertEqual(sorted(g.AGENCY_CODES), list(range(1, 14)))
        self.assertTrue(set(g.AGENCY_BY_MANG_NAME.values()) <= set(g.AGENCY_CODES))
        self.assertTrue(set(g.AGENCY_BY_MANG_TYPE.values()) <= set(g.AGENCY_CODES))
        self.assertEqual(sorted(g.WHP_CLASSES), list(range(1, 8)))
        self.assertEqual(sorted(g.OSM_FLAGS), list(range(8)))

    def test_grid_json(self):
        j = g.grid_json({"whp_cnt_max": 123, "cols": 1})
        for k in ("crs", "origin", "cell", "cols", "rows", "super", "block", "pd_bands",
                  "osm_bands", "slope_bins", "protect_bits", "agency", "whp_classes",
                  "pd_flags", "osm_flags", "osm_maxkv", "whp_cnt_max", "desig_bits", "flags2_bits",
                  "adj", "isoreg", "landval", "bldg", "wetland", "building_footprints", "aviation", "nfhl"):
            self.assertIn(k, j)
        self.assertEqual(j["cols"], 1)  # extra wins
        self.assertEqual(g.grid_json()["cols"], g.COLS)
        self.assertEqual(j["version"], 8)
        self.assertEqual(j["aviation"]["1"], "evaluated: outside the notice extent, no surface below 61 m AGL")
        self.assertEqual(j["aviation"]["6"], "primary surface (primary / clear zone)")
        self.assertEqual(j["nfhl"]["2"][:4], "SFHA")
        self.assertNotIn("0", j["aviation"])
        self.assertNotIn("0", j["nfhl"])
        self.assertEqual(j["bldg"], {"offset": 1, "cap": 254, "occ_cls": "Residential"})
        self.assertEqual(j["wetland"]["offset"], 1)
        self.assertEqual(j["wetland"]["scale"], 100)
        self.assertEqual(j["adj"]["class_100_shift"], 5)
        self.assertEqual(j["adj"]["class_100_mask"], 0b1100000)
        self.assertEqual(j["flags2_bits"]["2"], "100-yr floodplain")
        self.assertIn("7", j["pd_flags"])
        json.dumps(j)

    def test_landval_round_trip(self):
        self.assertEqual(g.landval_encode(0), 0)
        self.assertEqual(g.landval_encode(None), 0)
        self.assertIsNone(g.landval_decode(0))
        self.assertEqual(g.landval_encode(100), 1)
        self.assertEqual(g.landval_encode(1), 1)  # clamps low
        self.assertEqual(g.landval_encode(1e9), 255)  # clamps high
        self.assertAlmostEqual(g.landval_decode(255) / 6.01e6, 1, delta=0.005)
        v = 100.0
        while v < 6.0e6:
            self.assertLessEqual(abs(g.landval_decode(g.landval_encode(v)) / v - 1), 0.022, v)
            v *= 1.0137
        for code in range(1, 256):
            self.assertEqual(g.landval_encode(g.landval_decode(code)), code)

    def test_adj(self):
        self.assertEqual([g.adj_encode(c) for c in range(4)], [16, 17, 18, 19])
        self.assertEqual([g.adj_decode(g.adj_encode(c)) for c in range(4)],
                         [(c, 0) for c in range(4)])
        self.assertEqual(g.adj_decode(16 + 1 + (2 << 5)), (1, 2))
        self.assertEqual(g.adj_encode(1, 2), 16 + 1 + (2 << 5))
        self.assertEqual(g.adj_encode(3, 3), 115)
        self.assertLessEqual(g.ADJ_MAX, 255)
        self.assertEqual(g.ADJ100_MASK & (g.ADJ_CLASS_MASK | g.ADJ_RESERVED_MASK | 16), 0)
        self.assertEqual(g.adj_encode(3, 3) & g.ADJ_RESERVED_MASK, 0)
        self.assertIsNone(g.adj_decode(0))
        self.assertEqual(g.adj_encode(3) & g.ADJ_RESERVED_MASK, 0)
        with self.assertRaises(ValueError):
            g.adj_encode(4)
        with self.assertRaises(ValueError):
            g.adj_encode(0, 4)

    def test_bit_tables(self):
        self.assertTrue(set(g.DESIG_BITS) <= set(range(8)))
        self.assertEqual(sorted(g.FLAGS2_BITS), list(range(8)))
        self.assertEqual(g.FLAGS2_BITS[5], "Superfund NPL")
        self.assertIn("floodplain", g.FLAGS2_BITS[2])
        self.assertIn("occupied", g.FLAGS2_BITS[3])
        self.assertIn("NRHP", g.FLAGS2_BITS[4])
        self.assertIn("CBRS", g.FLAGS2_BITS[6])
        self.assertIn("FUDS", g.FLAGS2_BITS[7])
        self.assertEqual(sorted(g.PD_FLAGS), [0, 1, 2, 3, 4, 5, 6, 7])
        self.assertIn("park", g.PD_FLAGS[6])
        self.assertIn("tall structure", g.PD_FLAGS[7])

    def test_protect_bit7_disjoint(self):
        b = g.PROTECT_BITS
        self.assertEqual(b["nps_preserve_bit"], 7)
        bit = 1 << b["nps_preserve_bit"]
        self.assertEqual(bit & (b["gap_mask"] << b["gap_shift"]), 0)
        self.assertEqual(bit & (b["tnc_mask"] << b["tnc_shift"]), 0)
        self.assertEqual(bit & (1 << b["outside_popwest_bit"]), 0)

    def test_preserve_where(self):
        self.assertEqual(g.NPS_PRESERVE_WHERE, "Mang_Name = 'NPS' AND Unit_Nm LIKE '%Preserve%'")

    def test_merge_preserve(self):
        try:
            import numpy as np
            import build_route_bands as b
        except ImportError as e:
            self.skipTest(str(e))
        rng = np.random.default_rng(0)
        protect = rng.integers(0, 256, (50, 60), dtype=np.uint8)
        protect[0, :] |= 0xC0
        mask = rng.random((50, 60)) < 0.4
        out = b.merge_preserve(protect, mask)
        self.assertEqual(out.dtype, np.uint8)
        self.assertTrue(np.array_equal(out & 0x7F, protect & 0x7F))
        self.assertTrue(np.array_equal((out >> 7) > 0, mask))

    def test_band_order_pinned(self):
        self.assertEqual(list(g.PD_BANDS.values()), [
            "landcover", "slope", "protect", "agency", "wildfire", "whpclass", "flags",
            "state", "desig", "flags2", "isoreg", "landval", "bldg", "wetland", "built", "nonres", "bldgunk",
            "aviation", "nfhl"])
        self.assertEqual(list(g.PD_BANDS), list(range(1, 20)))

    def test_wetland_encode(self):
        self.assertEqual([g.wetland_encode(x) for x in (0, 0.004, 0.006, 0.25, 0.5, 1, 1.2)], [1, 1, 2, 26, 51, 101, 101])

    def test_observed_footprint_bounds_preserve_presence(self):
        self.assertEqual([g.footprint_encode(x) for x in (0, 1e-12, .01, .01001, .25, 1, 1.2)],
                         [1, 2, 2, 3, 26, 101, 101])
        self.assertEqual(g.footprint_encode(0, observed=False), 0)
        for invalid in (-.1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                g.footprint_encode(invalid)

    def test_bldg_encode(self):
        self.assertEqual([g.bldg_encode(n) for n in (0, 1, 2, 9, 253, 254, 255, 10**6)],
                         [1, 2, 3, 10, 254, 255, 255, 255])
        self.assertEqual(g.OSM_BANDS, {1: "flags", 2: "maxkv", 3: "adj"})

    def test_isoreg_table(self):
        self.assertEqual(sorted(g.ISO_CODES), list(range(1, 10)))
        self.assertEqual(len(EIA_BA_ABBREVS), len(set(EIA_BA_ABBREVS)))
        self.assertEqual(set(g.BA_TO_ISO), set(EIA_BA_ABBREVS))
        self.assertTrue(set(g.BA_TO_ISO.values()) <= set(g.ISO_CODES.values()))
        self.assertEqual(g.BA_TO_ISO["CISO"], "CAISO")
        self.assertEqual(g.ISO_CODE_BY_NAME[g.BA_TO_ISO["BPAT"]], 1)
        # RTO beats non-RTO even when larger; then smaller area wins
        self.assertLess(g.iso_overlap_key(6, 9e9), g.iso_overlap_key(1, 1.0))
        self.assertLess(g.iso_overlap_key(1, 1.0), g.iso_overlap_key(9, 2.0))
        self.assertLess(g.iso_overlap_key(3, 1.0), g.iso_overlap_key(2, 2.0))


if __name__ == "__main__":
    unittest.main()
