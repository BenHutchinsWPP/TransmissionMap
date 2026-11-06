"""Tests for build_route_constraints.py's stdlib helpers (no data/, no rasterio/numpy/PIL):
rule -> code mapping and precedence, palette build, TMS row flip, tile maths, the
staleness check, and that every concern in route_constraints.json plans cleanly.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

import build_route_constraints as B

SPEC = {
    "overview": [
        {"id": "tribal", "code": 9, "colour": "#7c3aed", "rules": [{"band": "flags", "bit": 0}]},
        {"id": "gap", "code": 6, "colour": "#5bbe71", "rules": [{"band": "protect", "values": [1, 2], "mask": 7}]},
        {"id": "sites", "code": 3, "colour": "#7f2502",
         "rules": [{"band": "flags2", "bit": 3}, {"band": "flags2", "bit": 4}]},
    ],
    "landManager": [
        {"id": "tribal", "code": 3, "colour": "#7c3aed",
         "rules": [{"band": "flags", "bit": 0}, {"band": "agency", "values": [12]}]},
        {"id": "dod", "code": 2, "colour": "#dc2626",
         "rules": [{"band": "flags", "bit": 1}, {"band": "agency", "values": [6]}]},
        {"id": "blm", "code": 1, "colour": "#ca8a04", "rules": [{"band": "agency", "values": [2]}]},
    ],
    "concerns": [
        {"id": "what-constrains", "kind": "overview"},
        {"id": "land-manager", "kind": "categorical"},
        {"id": "wild", "kind": "classes", "resampling": "max", "classes": [
            {"id": "hi", "code": 2, "colour": "#b91c1c", "rules": [{"band": "whpclass", "values": [5]}]},
            {"id": "lo", "code": 1, "colour": "#f97316", "rules": [{"band": "whpclass", "values": [4]}]}]},
        {"id": "cover", "kind": "classes", "resampling": "mode", "classes": [
            {"id": "w", "code": 2, "colour": "#466b9f", "rules": [{"band": "landcover", "values": [11]}]},
            {"id": "f", "code": 1, "colour": "#38814e", "rules": [{"band": "landcover", "values": [41, 42]}]}]},
        {"id": "gap-3", "kind": "mask", "rule": {"band": "protect", "values": [3], "mask": 7}, "colour": "#84cc16"},
    ],
}
CONCERN = {c["id"]: c for c in SPEC["concerns"]}


class Plans(unittest.TestCase):
    def test_overview_precedence_highest_code_wins(self):
        p = B.concern_plan(SPEC, CONCERN["what-constrains"])
        self.assertEqual([c[0] for c in p["classes"]], [3, 6, 9])
        self.assertEqual(p["bands"], ["flags", "flags2", "protect"])
        self.assertEqual(p["overview_resampling"], "max")
        cell = {"flags": 1, "protect": 2, "flags2": 8}
        self.assertEqual(B.cell_code(p, cell), 9)
        self.assertEqual(B.cell_code(p, {"flags": 0, "protect": 0b10001, "flags2": 0}), 6)  # mask drops TNC bits
        self.assertEqual(B.cell_code(p, {"flags": 2, "protect": 3, "flags2": 16}), 3)  # second sites rule (OR)
        self.assertEqual(B.cell_code(p, {"flags": 0, "protect": 4, "flags2": 0}), 0)

    def test_categorical_codes_and_mode(self):
        p = B.concern_plan(SPEC, CONCERN["land-manager"])
        self.assertEqual(p["overview_resampling"], "mode")
        self.assertEqual([(c[0], c[2]) for c in p["classes"]], [(1, "blm"), (2, "dod"), (3, "tribal")])
        self.assertEqual(B.cell_code(p, {"flags": 0, "agency": 2}), 1)
        self.assertEqual(B.cell_code(p, {"flags": 1, "agency": 9}), 3)   # tribal flag beats the agency
        self.assertEqual(B.cell_code(p, {"flags": 2, "agency": 10}), 2)  # DOD flag
        self.assertEqual(B.cell_code(p, {"flags": 3, "agency": 6}), 3)   # tribal over DOD
        self.assertEqual(B.cell_code(p, {"flags": 0, "agency": 12}), 3)
        self.assertEqual(B.cell_code(p, {"flags": 0, "agency": 1}), 0)  # private/none -> transparent

    def test_mask(self):
        p = B.concern_plan(SPEC, CONCERN["gap-3"])
        self.assertEqual(B.cell_code(p, {"protect": 3}), 1)
        self.assertEqual(B.cell_code(p, {"protect": 0b100011}), 1)
        self.assertEqual(B.cell_code(p, {"protect": 2}), 0)

    def test_bad_specs_refused(self):
        with self.assertRaises(ValueError):
            B.concern_plan(SPEC, {"id": "x", "kind": "mask", "rule": {"band": "a", "bit": 1, "values": [1]},
                                  "colour": "#000000"})
        with self.assertRaises(ValueError):
            B.concern_plan(SPEC, {"id": "x", "kind": "mask", "rule": {"band": "a", "bit": 1}, "colour": "red"})
        with self.assertRaises(ValueError):
            B.concern_plan(SPEC, {"id": "x", "kind": "heat"})
        dup = dict(SPEC, overview=SPEC["overview"] + [dict(SPEC["overview"][0], id="dup")])
        with self.assertRaises(ValueError):
            B.concern_plan(dup, CONCERN["what-constrains"])

    def test_classes_codes_precedence_and_resampling(self):
        p = B.concern_plan(SPEC, CONCERN["wild"])
        self.assertEqual(p["overview_resampling"], "max")
        self.assertEqual([(c[0], c[2]) for c in p["classes"]], [(1, "lo"), (2, "hi")])
        self.assertEqual(B.cell_code(p, {"whpclass": 5}), 2)
        self.assertEqual(B.cell_code(p, {"whpclass": 4}), 1)
        self.assertEqual(B.cell_code(p, {"whpclass": 3}), 0)
        self.assertEqual(B.concern_plan(SPEC, CONCERN["cover"])["overview_resampling"], "mode")

    def test_classes_bad_resampling_refused(self):
        for bad in ("average", None, "nearest"):
            c = dict(CONCERN["wild"], resampling=bad)
            with self.assertRaises(ValueError):
                B.concern_plan(SPEC, c)

    def test_classes_overlap_refused(self):
        c = dict(CONCERN["wild"], classes=[
            {"id": "a", "code": 2, "colour": "#b91c1c", "rules": [{"band": "whpclass", "values": [4, 5]}]},
            {"id": "b", "code": 1, "colour": "#f97316", "rules": [{"band": "whpclass", "values": [5]}]}])
        with self.assertRaises(ValueError):
            B.concern_plan(SPEC, c)
        # a mask makes the overlap visible too: values [1] mask 7 vs bit 0
        c = dict(CONCERN["wild"], classes=[
            {"id": "a", "code": 2, "colour": "#b91c1c", "rules": [{"band": "protect", "values": [1], "mask": 7}]},
            {"id": "b", "code": 1, "colour": "#f97316", "rules": [{"band": "protect", "bit": 0}]}])
        with self.assertRaises(ValueError):
            B.concern_plan(SPEC, c)

    def test_band_families(self):
        self.assertEqual(B.band_ref("osm_flags"), ("osm", 1))
        self.assertEqual(B.band_ref("osm_maxkv"), ("osm", 2))
        self.assertEqual(B.band_ref("adj"), ("osm", 3))
        self.assertEqual(B.band_ref("flags"), ("pd", 7))
        self.assertEqual(B.band_ref("landcover"), ("pd", 1))
        with self.assertRaises(ValueError):
            B.band_ref("nope")
        with self.assertRaises(ValueError):
            B.concern_plan(SPEC, {"id": "x", "kind": "mask", "colour": "#000000",
                                  "rule": {"band": "bogus", "bit": 1}})

    def test_plan_reads_osm(self):
        lake = {"id": "l", "kind": "mask", "colour": "#2563eb", "rule": {"band": "osm_flags", "bit": 0}}
        self.assertTrue(B.plan_reads_osm(B.concern_plan(SPEC, lake)))
        self.assertFalse(B.plan_reads_osm(B.concern_plan(SPEC, CONCERN["gap-3"])))
        self.assertIn("OpenStreetMap", B.attribution(B.concern_plan(SPEC, lake)))
        self.assertNotIn("OpenStreetMap", B.attribution(B.concern_plan(SPEC, CONCERN["gap-3"])))
        self.assertNotIn("public-domain", B.ATTRIBUTION)

    def test_band_credits(self):
        real = json.loads(B.SPEC.read_text())
        by = {c["id"]: c for c in real["concerns"]}
        for cid, credit in (("aviation", "FAA NTAD (EFF_DATE 2026/10/29)"), ("fema-flood", "FEMA National Flood Hazard Layer (202610)"),
                            ("isoreg", "EIA balancing authority"), ("landval", "USDA NASS")):
            self.assertIn(credit, B.attribution(B.concern_plan(real, by[cid])))
        self.assertNotIn("FAA", B.attribution(B.concern_plan(real, by["gap-3"])))

    def test_overview_and_land_manager_refuse_osm_band(self):
        bad = dict(SPEC, overview=SPEC["overview"] + [
            {"id": "lake", "code": 1, "colour": "#2563eb", "rules": [{"band": "osm_flags", "bit": 0}]}])
        with self.assertRaises(ValueError):
            B.concern_plan(bad, CONCERN["what-constrains"])
        bad = dict(SPEC, landManager=SPEC["landManager"] + [
            {"id": "adj", "code": 4, "colour": "#2563eb", "rules": [{"band": "adj", "values": [1]}]}])
        with self.assertRaises(ValueError):
            B.concern_plan(bad, CONCERN["land-manager"])

    def test_grids_equal(self):
        g = (100, 200, (250.0, 0.0, -2e6, 0.0, -250.0, 3e6), "EPSG:5070")
        B.grids_equal(g, tuple(g))
        for other in ((101,) + g[1:], (g[0], 201) + g[2:],
                      g[:2] + ((251.0,) + g[2][1:],) + g[3:], g[:3] + ("EPSG:4326",)):
            with self.assertRaises(ValueError):
                B.grids_equal(g, other)

    def test_sets_match_ts_export(self):
        spec = json.loads(B.SPEC.read_text())
        sets = json.loads((B.ROOT / "scripts" / "route_constraints_sets.json").read_text())
        for c in spec["concerns"]:
            if c["kind"] in ("overview", "categorical"):
                continue
            plan = B.concern_plan(spec, c)
            got = {("mask" if c["kind"] == "mask" else key):
                   [v for v in range(256) if any(B.rule_match(r, v) for r in rules)]
                   for _, _, key, rules in plan["classes"]}
            self.assertEqual(got, sets[c["id"]], c["id"])
        self.assertEqual({c["id"] for c in spec["concerns"]
                          if c["kind"] not in ("overview", "categorical")}, set(sets))

    def test_real_spec_plans(self):
        spec = json.loads(B.SPEC.read_text())
        ids = [c["id"] for c in spec["concerns"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ids), 51)
        self.assertTrue({"buildings", "nonresidential", "building-unknown", "building-coverage"} <= set(ids))
        for c in spec["concerns"]:
            p = B.concern_plan(spec, c)
            self.assertTrue(p["classes"], c["id"])

    def test_select_concerns(self):
        self.assertEqual(len(B.select_concerns(SPEC, None)), len(SPEC["concerns"]))
        self.assertEqual([c["id"] for c in B.select_concerns(SPEC, "gap-3,land-manager")], ["land-manager", "gap-3"])
        with self.assertRaises(SystemExit):
            B.select_concerns(SPEC, "nope")


class Palette(unittest.TestCase):
    def test_palette_indexes_by_code(self):
        p = B.concern_plan(SPEC, CONCERN["what-constrains"])
        pal = B.palette(p)
        self.assertEqual(len(pal), 768)
        self.assertEqual(pal[0:3], [0, 0, 0])
        self.assertEqual(pal[27:30], [0x7c, 0x3a, 0xed])
        self.assertEqual(pal[9:12], [0x7f, 0x25, 0x02])
        self.assertEqual(B.allowed_rgba(p), {(0x7c, 0x3a, 0xed, 255), (0x5b, 0xbe, 0x71, 255), (0x7f, 0x25, 0x02, 255)})

    def test_hex(self):
        self.assertEqual(B.hex_rgb("#0891b2"), (8, 145, 178))
        with self.assertRaises(ValueError):
            B.hex_rgb("#fff")


class Tiles(unittest.TestCase):
    def test_tms_flip(self):
        self.assertEqual(B.tms_row(0, 0), 0)
        self.assertEqual(B.tms_row(3, 0), 7)
        self.assertEqual(B.tms_row(9, 202), 309)
        self.assertEqual(B.tms_row(9, B.tms_row(9, 17)), 17)

    def test_lonlat_tile_round_trip(self):
        x, y, px, py = B.lonlat_tile_pixel(-116.6, 35.35, 9)
        self.assertEqual((x, y), (90, 202))
        w, n = B.tile_lonlat(9, x, y)
        e, s = B.tile_lonlat(9, x + 1, y + 1)
        self.assertTrue(w <= -116.6 < e and s < 35.35 <= n)
        self.assertTrue(0 <= px < 256 and 0 <= py < 256)

    def test_bounds(self):
        w, s, e, n = B.tiles_bounds(1, [0, 1], [0, 1])
        self.assertAlmostEqual(w, -180)
        self.assertAlmostEqual(e, 180)
        self.assertAlmostEqual(n, 85.0511, places=3)
        self.assertAlmostEqual(s, -85.0511, places=3)

    def test_zoom_res_aligns_to_origin(self):
        r = B.zoom_res(9)
        self.assertAlmostEqual(r, 305.748113, places=5)
        self.assertAlmostEqual(B.WEB_MERCATOR_HALF / r, 65536)


class Staleness(unittest.TestCase):
    def test_is_stale(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d, "in"), Path(d, "out")
            src.write_text("x")
            self.assertTrue(B.is_stale(out, [src]))
            out.write_text("y")
            os.utime(src, (1000, 1000))
            os.utime(out, (2000, 2000))
            self.assertFalse(B.is_stale(out, [src]))
            self.assertTrue(B.is_stale(out, [src], force=True))
            os.utime(src, (3000, 3000))
            self.assertTrue(B.is_stale(out, [src]))


if __name__ == "__main__":
    unittest.main()
