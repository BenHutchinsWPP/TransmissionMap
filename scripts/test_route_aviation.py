"""Tests for route_aviation.py: 14 CFR 77.9 / 77.19 / 77.21 surfaces per runway end.

Needs numpy/shapely/pyproj (venv); skips under `python3 -S`. Acceptance runs
`venv/bin/python -m unittest scripts/test_route_aviation.py -v`. Synthetic records only; no data/, no network.
Expected numbers are the eCFR dimensions quoted in route_aviation.py's docstring, worked by hand in feet.
The NAS Fallon fixture keeps the alignments and site number recorded in national-aviation.plan.md §2
(SITE_NO "13057.", ownership MN, blank FAR_PART_77_CODE, 07/25 at 88/268, 13L/31R and 13R/31L at 145/325);
its end positions, lengths and elevations are placed by hand around the field, not read from NTAD.
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import numpy as np
    from pyproj import Geod, Transformer
    import route_aviation as A
    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False

FT = 0.3048
LON, LAT = -100.0, 40.0
GEOD = Geod(ellps="WGS84") if HAVE else None
TO5070 = Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True) if HAVE else None


def at(lon, lat, bearing, metres):
    """EPSG:5070 (x, y) of the point `metres` from (lon, lat) at a true bearing."""
    lo, la, _ = GEOD.fwd(lon, lat, bearing, metres)
    return TO5070.transform(lo, la)


def ends_of(site, rwy_id, lon, lat, align_a, length_ft, elev_a, elev_b, **kw):
    """Two end records of a runway centred on (lon, lat); end A lands on heading align_a."""
    ida, idb = rwy_id.split("/")
    la = GEOD.fwd(lon, lat, (align_a + 180) % 360, length_ft * FT / 2)
    lb = GEOD.fwd(lon, lat, align_a, length_ft * FT / 2)
    base = {"SITE_NO": site, "RWY_ID": rwy_id, "FAR_PART_77_CODE": "", "ILS_TYPE": ""}
    a = dict(base, RWY_END_ID=ida, LONG_DECIMAL=la[0], LAT_DECIMAL=la[1], RWY_END_ELEV=elev_a,
             TRUE_ALIGNMENT=align_a, **kw.get("a", {}))
    b = dict(base, RWY_END_ID=idb, LONG_DECIMAL=lb[0], LAT_DECIMAL=lb[1], RWY_END_ELEV=elev_b,
             TRUE_ALIGNMENT=(align_a + 180) % 360, **kw.get("b", {}))
    return [a, b], (la[0], la[1]), (lb[0], lb[1])


def civil(code_a="", code_b="", length_ft=6000.0, surface="ASPH", owner="PU", use="PU", ils_a="", iap=0,
          elev=1000.0, single=False):
    """One E-W runway 09/27 centred on (LON, LAT); end 09 (west) lands east, so its approach lies west."""
    fac = {"SITE_NO": "00001.", "ARPT_ID": "TST", "SITE_TYPE_CODE": "A", "FACILITY_USE_CODE": use,
           "OWNERSHIP_TYPE_CODE": owner, "ARPT_STATUS": "O", "LAT_DECIMAL": LAT, "LONG_DECIMAL": LON,
           "ELEV": elev, "IAPEXISTS": iap}
    rw = {"SITE_NO": "00001.", "RWY_ID": "09/27", "RWY_LEN": length_ft, "RWY_WIDTH": 100.0,
          "SURFACE_TYPE_CODE": surface}
    ends, pa, pb = ends_of("00001.", "09/27", LON, LAT, 90.0, length_ft, elev, elev,
                           a={"FAR_PART_77_CODE": code_a, "ILS_TYPE": ils_a}, b={"FAR_PART_77_CODE": code_b})
    if single:
        ends = ends[:1]
    return A.facility_surfaces(fac, [rw], ends), pa, pb


def one(fs, kind, end_id=None, rwy_id=None):
    hits = [s for s in fs.surfaces if s.kind == kind and (end_id is None or s.end_id == end_id)
            and (rwy_id is None or s.rwy_id == rwy_id)]
    assert len(hits) == 1, (kind, end_id, [(s.kind, s.end_id) for s in fs.surfaces])
    return hits[0]


def h_at(surface, xy):
    return float(surface.height_m(np.array([xy[0]]), np.array([xy[1]]))[0])


def lateral(end_ll, along_bearing, along_m, side_m):
    """Point `along_m` from an end at along_bearing, then `side_m` to its right (90 deg clockwise)."""
    if not along_m:
        lo, la, az = end_ll[0], end_ll[1], along_bearing
    else:
        lo, la, back = GEOD.fwd(end_ll[0], end_ll[1], along_bearing, along_m)
        az = back + 180  # the geodesic's heading at the far point
    return at(lo, la, (az + 90) % 360, side_m) if side_m else TO5070.transform(lo, la)


@unittest.skipUnless(HAVE, "needs numpy, shapely, pyproj (venv)")
class CivilTables(unittest.TestCase):
    E = 1000.0 * FT  # runway-end elevation, m

    def approach_case(self, code, inner_ft, outer_ft, length_ft, slope):
        fs, pa, _ = civil(code, code)
        ap = one(fs, "approach", "09")
        start = 200.0  # 77.19(c): primary ends 200 ft beyond a hard-surfaced runway end
        # 77.19(d)(2): rise along the extended centreline, from the end elevation.
        x = 1000.0
        self.assertAlmostEqual(h_at(ap, lateral(pa, 270, (start + x) * FT, 0)), self.E + x / slope * FT, delta=0.02)
        # 77.19(d)(1): inner edge = primary width, outer edge = the table width, linear between.
        frac = 0.9
        half = (inner_ft + (outer_ft - inner_ft) * frac) / 2
        d = (start + frac * length_ft) * FT
        tol = 5 + 5e-4 * (start + frac * length_ft)  # ft: a test geodesic drifts ~1e-4 off the local straight line
        self.assertFalse(np.isnan(h_at(ap, lateral(pa, 270, d, (half - tol) * FT))))
        self.assertTrue(np.isnan(h_at(ap, lateral(pa, 270, d, (half + tol) * FT))))
        # Length: inside just before its end, outside just after.
        self.assertFalse(np.isnan(h_at(ap, lateral(pa, 270, (start + length_ft - 10) * FT, 0))))
        self.assertTrue(np.isnan(h_at(ap, lateral(pa, 270, (start + length_ft + 10) * FT, 0))))
        # Never on the runway side of the end.
        self.assertTrue(np.isnan(h_at(ap, lateral(pa, 90, 1000 * FT, 0))))
        return fs

    def primary_width(self, fs, pa, width_ft):
        pr = one(fs, "primary")
        self.assertFalse(np.isnan(h_at(pr, lateral(pa, 90, 1000 * FT, (width_ft / 2 - 3) * FT))))
        self.assertTrue(np.isnan(h_at(pr, lateral(pa, 90, 1000 * FT, (width_ft / 2 + 3) * FT))))

    def test_utility_visual(self):  # A(V): (c)(1) 250, (d)(1)(i) 1,250, (d)(2)(i) 5,000 @ 20:1
        fs = self.approach_case("A(V)", 250, 1250, 5000, 20)
        self.primary_width(fs, civil("A(V)", "A(V)")[1], 250)

    def test_other_visual(self):  # B(V): (c)(3)(i) 500, (d)(1)(ii) 1,500, 5,000 @ 20:1
        fs = self.approach_case("B(V)", 500, 1500, 5000, 20)
        self.primary_width(fs, civil("B(V)", "B(V)")[1], 500)

    def test_utility_nonprecision(self):  # A(NP): (c)(2) 500, (d)(1)(iii) 2,000, 5,000 @ 20:1
        fs = self.approach_case("A(NP)", 500, 2000, 5000, 20)
        self.primary_width(fs, civil("A(NP)", "A(NP)")[1], 500)

    def test_nonprecision_over_three_quarter(self):  # C: (c)(3)(ii) 500, (d)(1)(iv) 3,500, (d)(2)(ii) 10,000 @ 34:1
        fs = self.approach_case("C", 500, 3500, 10000, 34)
        self.primary_width(fs, civil("C", "C")[1], 500)

    def test_nonprecision_three_quarter(self):  # D: (c)(3)(iii) 1,000, (d)(1)(v) 4,000, 10,000 @ 34:1
        fs = self.approach_case("D", 1000, 4000, 10000, 34)
        self.primary_width(fs, civil("D", "D")[1], 1000)

    def test_precision(self):  # PIR: (c)(3)(iii) 1,000, (d)(1)(vi) 16,000, (d)(2)(iii) 10,000 @ 50 + 40,000 @ 40
        fs = self.approach_case("PIR", 1000, 16000, 50000, 50)
        pa = civil("PIR", "PIR")[1]
        ap = one(fs, "approach", "09")
        # 30,000 ft from the primary end: 10,000/50 + 20,000/40 = 200 + 500 = 700 ft.
        self.assertAlmostEqual(h_at(ap, lateral(pa, 270, (200 + 30000) * FT, 0)), self.E + 700 * FT, delta=0.05)

    def test_primary_most_precise_end(self):  # (c)(3)(iv): PIR on one end widens the whole primary to 1,000
        fs, pa, _ = civil("PIR", "B(V)")
        self.primary_width(fs, pa, 1000)
        # (d)(3): each end keeps its own approach: 27 stays visual (1,500 ft outer, 5,000 ft long).
        ap27 = one(fs, "approach", "27")
        _, _, pb = civil("PIR", "B(V)")
        self.assertTrue(np.isnan(h_at(ap27, lateral(pb, 90, (200 + 5010) * FT, 0))))

    def test_primary_extension_hard_vs_turf(self):  # 77.19(c): 200 ft beyond hard ends, at the end otherwise
        for surface, ext in (("ASPH", 200), ("CONC-TURF", 200), ("TURF", 0)):
            fs, pa, _ = civil("B(V)", "B(V)", surface=surface)
            pr, ap = one(fs, "primary"), one(fs, "approach", "09")
            if ext:
                self.assertFalse(np.isnan(h_at(pr, lateral(pa, 270, (ext - 5) * FT, 0))), surface)
            self.assertTrue(np.isnan(h_at(pr, lateral(pa, 270, (ext + 5) * FT, 0))), surface)
            self.assertAlmostEqual(h_at(ap, lateral(pa, 270, (ext + 100) * FT, 0)), self.E + 5 * FT, delta=0.02)

    def test_primary_elevation_nearest_centreline(self):  # 77.19(c): elevation of the nearest centreline point
        fac = {"SITE_NO": "2.", "SITE_TYPE_CODE": "A", "FACILITY_USE_CODE": "PU", "OWNERSHIP_TYPE_CODE": "PU",
               "ARPT_STATUS": "O", "LAT_DECIMAL": LAT, "LONG_DECIMAL": LON, "ELEV": 1100.0}
        ends, pa, pb = ends_of("2.", "09/27", LON, LAT, 90.0, 6000.0, 1000.0, 1100.0)
        fs = A.facility_surfaces(fac, [{"SITE_NO": "2.", "RWY_ID": "09/27", "RWY_LEN": 6000.0}], ends)
        pr = one(fs, "primary")
        self.assertAlmostEqual(h_at(pr, lateral(pa, 90, 3000 * FT, 100 * FT)), 1050 * FT, delta=0.05)
        self.assertAlmostEqual(h_at(pr, lateral(pb, 90, 100 * FT, 0)), 1100 * FT, delta=0.05)

    def test_feet_to_metres_once(self):
        fs, pa, _ = civil("B(V)", "B(V)", elev=3934.0)
        self.assertAlmostEqual(h_at(one(fs, "primary"), lateral(pa, 90, 100 * FT, 0)), 3934.0 * 0.3048, delta=0.01)

    def test_horizontal_and_conical(self):
        # (a)(1) 5,000 ft for visual; (a)(2) 10,000 ft otherwise; 150 ft above airport elevation; (b) 20:1, 4,000 ft.
        for code, radius in (("B(V)", 5000), ("C", 10000)):
            fs, pa, _ = civil(code, code)
            hz, cn = one(fs, "horizontal"), one(fs, "conical")
            south = lambda d: lateral(pa, 270, 200 * FT, d * FT)  # noqa: E731
            self.assertAlmostEqual(h_at(hz, south(radius - 20)), self.E + 150 * FT, delta=0.01)
            self.assertTrue(np.isnan(h_at(hz, south(radius + 20))))
            self.assertAlmostEqual(h_at(cn, south(radius + 2000)), self.E + (150 + 100) * FT, delta=0.3)
            self.assertTrue(np.isnan(h_at(cn, south(radius + 4020))))

    def test_horizontal_radius_highest_end(self):  # (a)(2): the radius is the highest of either end
        fs, pa, _ = civil("B(V)", "C")
        self.assertFalse(np.isnan(h_at(one(fs, "horizontal"), lateral(pa, 270, 200 * FT, 9900 * FT))))

    def test_transitional_seven_to_one(self):  # 77.19(e): 7:1 at right angles from the primary's sides
        fs, pa, _ = civil("B(V)", "B(V)")
        tr = one(fs, "transitional")
        p = lateral(pa, 90, 3000 * FT, (250 + 700) * FT)  # 700 ft beyond the 500-ft primary's side
        self.assertAlmostEqual(h_at(tr, p), self.E + 100 * FT, delta=0.02)
        low, ground = A.lowest_m(fs, *map(np.array, ([p[0]], [p[1]])))
        self.assertAlmostEqual(float(low[0]), self.E + 100 * FT, delta=0.02)  # below the 150-ft horizontal
        self.assertFalse(ground[0])
        q = lateral(pa, 90, 3000 * FT, 2000 * FT)  # transitional above the horizontal here: horizontal binds
        self.assertAlmostEqual(float(A.lowest_m(fs, np.array([q[0]]), np.array([q[1]]))[0][0]),
                               self.E + 150 * FT, delta=0.02)

    def test_precision_transitional_past_conical(self):  # 77.19(e): 5,000 ft beside the precision approach
        fs, pa, _ = civil("PIR", "PIR")
        tr = one(fs, "transitional")
        d = (200 + 30000) * FT
        half = (1000 + 15000 * 30000 / 50000) / 2
        self.assertFalse(np.isnan(h_at(tr, lateral(pa, 270, d, (half + 4900) * FT))))
        self.assertTrue(np.isnan(h_at(tr, lateral(pa, 270, d, (half + 5100) * FT))))

    def test_blank_code_fallback(self):  # ILS -> precision, else IAP -> non-precision, else visual
        self.assertEqual(A.end_class({"ILS_TYPE": "ILS"}, 6000, False)[:2], (False, A.P))
        self.assertEqual(A.end_class({"ILS_TYPE": "ILS/DME"}, 6000, False)[:2], (False, A.P))
        self.assertEqual(A.end_class({"ILS_TYPE": "LOC/GS"}, 6000, False)[:2], (False, A.P))
        for loc in ("LOC/DME", "LOCALIZER", "LDA", "LDA/DME", "SDF"):
            self.assertEqual(A.end_class({"ILS_TYPE": loc}, 6000, False)[:2], (False, A.NPL), loc)
            self.assertEqual(A.end_class({"ILS_TYPE": loc}, 3000, False)[:2], (True, A.NP), loc)
        self.assertEqual(A.end_class({}, 6000, True)[:2], (False, A.NPL))
        self.assertEqual(A.end_class({}, 3000, True)[:2], (True, A.NP))
        self.assertEqual(A.end_class({}, 3200, False)[:2], (True, A.V))
        self.assertEqual(A.end_class({}, 3201, False)[:2], (False, A.V))
        self.assertEqual(A.end_class({"FAR_PART_77_CODE": " c "}, 3000, False)[:2], (False, A.NP))
        fs, pa, _ = civil(ils_a="ILS/DME")  # blank codes, ILS on 09: a 50,000-ft precision approach
        self.assertFalse(np.isnan(h_at(one(fs, "approach", "09"), lateral(pa, 270, 40000 * FT, 0))))

    def test_single_end_uses_true_alignment(self):  # bearings clockwise from true north
        fs, pa, _ = civil("B(V)", "B(V)", single=True)
        self.assertTrue(any("TRUE_ALIGNMENT" in n for n in fs.notes))
        self.assertFalse(np.isnan(h_at(one(fs, "primary"), lateral(pa, 90, 3000 * FT, 0))))
        self.assertFalse(np.isnan(h_at(one(fs, "approach", "09"), lateral(pa, 270, 3000 * FT, 0))))
        self.assertTrue(np.isnan(h_at(one(fs, "approach", "09"), lateral(pa, 90, 3000 * FT, 0))))


@unittest.skipUnless(HAVE, "needs numpy, shapely, pyproj (venv)")
class Notice(unittest.TestCase):
    def test_long_runway_100_to_1(self):  # 77.9(b)(1): longest > 3,200 ft -> 100:1 for 20,000 ft
        fs, pa, _ = civil("B(V)", "B(V)", length_ft=3201)
        n = one(fs, "notice")
        self.assertEqual(n.cite, "14 CFR 77.9(b)(1)")
        p = lateral(pa, 90, 1000 * FT, (50 + 10000) * FT)  # 10,000 ft beyond the 100-ft runway's edge
        self.assertAlmostEqual(h_at(n, p), (1000 + 100) * FT, delta=0.05)
        self.assertFalse(np.isnan(h_at(n, lateral(pa, 90, 1000 * FT, (50 + 19980) * FT))))
        self.assertTrue(np.isnan(h_at(n, lateral(pa, 90, 1000 * FT, (50 + 20020) * FT))))

    def test_short_runway_50_to_1(self):  # 77.9(b)(2): longest <= 3,200 ft -> 50:1 for 10,000 ft
        fs, pa, _ = civil("A(V)", "A(V)", length_ft=3200)
        n = one(fs, "notice")
        self.assertEqual(n.cite, "14 CFR 77.9(b)(2)")
        self.assertAlmostEqual(h_at(n, lateral(pa, 90, 1000 * FT, (50 + 5000) * FT)), (1000 + 100) * FT, delta=0.05)
        self.assertTrue(np.isnan(h_at(n, lateral(pa, 90, 1000 * FT, (50 + 10020) * FT))))

    def test_heliport_circle(self):  # 77.9(b)(3) 25:1 for 5,000 ft; heliports get the circle only
        fac = {"SITE_NO": "9.", "SITE_TYPE_CODE": "H", "FACILITY_USE_CODE": "PR", "OWNERSHIP_TYPE_CODE": "PR",
               "ARPT_STATUS": "O", "LAT_DECIMAL": LAT, "LONG_DECIMAL": LON, "ELEV": 500.0, "IAPEXISTS": 1}
        fs = A.facility_surfaces(fac, [{"SITE_NO": "9.", "RWY_ID": "H1", "RWY_LEN": 60}], [])
        self.assertEqual(fs.rule, "77.9(b)")
        self.assertEqual([s.kind for s in fs.surfaces], ["notice"])
        n = fs.surfaces[0]
        self.assertAlmostEqual(h_at(n, at(LON, LAT, 45, 2500 * FT)), (500 + 100) * FT, delta=0.05)
        self.assertTrue(np.isnan(h_at(n, at(LON, LAT, 45, 5020 * FT))))

    def test_notice_basis(self):  # 77.9(d)
        base = {"ARPT_STATUS": "O", "FACILITY_USE_CODE": "PR", "OWNERSHIP_TYPE_CODE": "PR"}
        self.assertEqual(A.notice_basis(base, []), [])
        self.assertEqual(A.notice_basis(dict(base, FACILITY_USE_CODE="PU"), []), ["77.9(d)(1)"])
        self.assertEqual(A.notice_basis(dict(base, OWNERSHIP_TYPE_CODE="MN"), []), ["77.9(d)(3)"])
        self.assertEqual(A.notice_basis(dict(base, OWNERSHIP_TYPE_CODE="CG"), []), ["77.9(d)(3)"])
        self.assertEqual(A.notice_basis(dict(base, IAPEXISTS="1"), []), ["77.9(d)(4)"])
        self.assertEqual(A.notice_basis(base, [{"FAR_PART_77_CODE": "C"}]), ["77.9(d)(4)"])
        self.assertEqual(A.notice_basis(base, [{"ILS_TYPE": "LOC"}]), ["77.9(d)(4)"])
        self.assertEqual(A.notice_basis(base, [{"FAR_PART_77_CODE": "B(V)"}]), [])
        self.assertEqual(A.notice_basis(dict(base, FACILITY_USE_CODE="PU", ARPT_STATUS="CI"), []), [])


def nfl():
    """NAS Fallon as recorded in national-aviation.plan.md §2 (positions placed by hand)."""
    lon, lat = -118.7010, 39.4166
    site = "13057."
    fac = {"SITE_NO": site, "ARPT_ID": "NFL", "SITE_TYPE_CODE": "A", "FACILITY_USE_CODE": "PR",
           "OWNERSHIP_TYPE_CODE": "MN", "ARPT_STATUS": "O", "LAT_DECIMAL": lat, "LONG_DECIMAL": lon,
           "ELEV": 3934.0, "IAPEXISTS": 1}
    specs = [("07/25", 88.0, 7000.0, GEOD.fwd(lon, lat, 0, 2500)[:2], 3925.0, 3930.0),
             ("13L/31R", 145.0, 11000.0, GEOD.fwd(lon, lat, 55, 400)[:2], 3934.0, 3925.0),
             ("13R/31L", 145.0, 14000.0, GEOD.fwd(lon, lat, 235, 400)[:2], 3933.0, 3920.0)]
    runways, ends, pos = [], [], {}
    for rid, align, length, (clon, clat), ea, eb in specs:
        runways.append({"SITE_NO": site, "RWY_ID": rid, "RWY_LEN": length, "RWY_WIDTH": 200.0,
                        "SURFACE_TYPE_CODE": "CONC"})
        es, pa, pb = ends_of(site, rid, clon, clat, align, length, ea, eb)
        ends += es
        ida, idb = rid.split("/")
        pos[ida], pos[idb] = (pa, align), (pb, (align + 180) % 360)
    return fac, runways, ends, pos


@unittest.skipUnless(HAVE, "needs numpy, shapely, pyproj (venv)")
class NasFallon(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fac, runways, ends, cls.pos = nfl()
        cls.fs = A.facility_surfaces(fac, runways, ends)

    def test_fixture_shape(self):
        self.assertEqual(self.fs.site_no, "13057.")  # string, trailing dot kept
        self.assertEqual(self.fs.rule, "77.21")       # MN with a blank FAR_PART_77_CODE
        self.assertEqual(len(self.pos), 6)
        self.assertEqual(len([s for s in self.fs.surfaces if s.kind == "approach"]), 6)
        self.assertEqual(self.fs.notes, [])

    def test_13L_acceptance(self):  # the two literal points
        ap = one(self.fs, "approach", "13L")
        p13l, _ = self.pos["13L"]
        p31r, _ = self.pos["31R"]
        self.assertFalse(np.isnan(h_at(ap, at(*p13l, 325, 3000))))
        self.assertTrue(np.isnan(h_at(ap, at(*p31r, 145, 3000))))

    def test_every_end_both_sides(self):  # each approach lies behind its end, never ahead of it
        opposite = {"07": "25", "25": "07", "13L": "31R", "31R": "13L", "13R": "31L", "31L": "13R"}
        for eid, (ll, align) in self.pos.items():
            ap = one(self.fs, "approach", eid)
            self.assertFalse(np.isnan(h_at(ap, at(*ll, (align + 180) % 360, 3000))), eid)
            far, _ = self.pos[opposite[eid]]
            self.assertTrue(np.isnan(h_at(ap, at(*far, align, 3000))), eid)
            self.assertTrue(np.isnan(h_at(ap, at(*ll, align, 1000))), eid)  # over its own runway

    def test_dod_approach(self):  # 77.21(b)(3): from 200 ft beyond the end, 50:1, level at +500 ft
        ap = one(self.fs, "approach", "13L")
        p13l, _ = self.pos["13L"]
        e = 3934.0 * FT
        self.assertAlmostEqual(h_at(ap, at(*p13l, 325, (200 + 5000) * FT)), e + 100 * FT, delta=0.05)
        self.assertTrue(np.isnan(h_at(ap, at(*p13l, 325, 100 * FT))))  # inside the first 200 ft: clear zone only
        self.assertAlmostEqual(h_at(ap, at(*p13l, 325, (200 + 40000) * FT)), e + 500 * FT, delta=0.05)
        # 16,000 ft wide at 50,000 ft: 7,900 ft off the centreline is in, 8,100 out (just short of the end).
        self.assertFalse(np.isnan(h_at(ap, lateral(p13l, 325, (200 + 49900) * FT, 7900 * FT))))
        self.assertTrue(np.isnan(h_at(ap, lateral(p13l, 325, (200 + 49900) * FT, 8100 * FT))))
        self.assertTrue(np.isnan(h_at(ap, at(*p13l, 325, (200 + 50100) * FT))))

    def test_dod_primary_clear_zone(self):  # 77.21(b)(1) 2,000 ft wide, runway length; (b)(2) 1,000 ft clear zone
        p13l, _ = self.pos["13L"]
        pr = one(self.fs, "primary", rwy_id="13L/31R")
        cz = one(self.fs, "clear_zone", "13L")
        self.assertFalse(np.isnan(h_at(pr, lateral(p13l, 145, 1000 * FT, 990 * FT))))
        self.assertTrue(np.isnan(h_at(pr, lateral(p13l, 145, 1000 * FT, 1010 * FT))))
        self.assertTrue(np.isnan(h_at(pr, at(*p13l, 325, 20 * FT))))
        self.assertAlmostEqual(h_at(cz, at(*p13l, 325, 900 * FT)), 3934.0 * FT, delta=0.01)
        self.assertTrue(np.isnan(h_at(cz, at(*p13l, 325, 1020 * FT))))
        low, ground = A.lowest_m(self.fs, *[np.array([v]) for v in at(*p13l, 325, 900 * FT)])
        self.assertTrue(ground[0])

    def test_dod_airport_surfaces(self):  # 77.21(a): 150 ft at 7,500 ft, 20:1 for 7,000 ft, 500 ft for 30,000 ft
        p07, _ = self.pos["07"]
        e = 3934.0 * FT
        ih, cn, oh = (one(self.fs, k) for k in ("inner_horizontal", "conical", "outer_horizontal"))
        # North of runway 07/25's midpoint (the northern runway): the hull edge is the 7,500-ft tangent there.
        north = lambda d: lateral(p07, 88, 3500 * FT, -d * FT)  # noqa: E731
        self.assertAlmostEqual(h_at(ih, at(*p07, 268, 7400 * FT)), e + 150 * FT, delta=0.01)
        self.assertAlmostEqual(h_at(ih, north(7400)), e + 150 * FT, delta=0.01)
        self.assertTrue(np.isnan(h_at(ih, north(7600))))
        self.assertAlmostEqual(h_at(cn, north(7500 + 3500)), e + 325 * FT, delta=0.3)
        self.assertAlmostEqual(h_at(oh, north(7500 + 7000 + 29000)), e + 500 * FT, delta=0.01)
        self.assertTrue(np.isnan(h_at(oh, north(7500 + 7000 + 30100))))

    def test_dod_transitional(self):  # 77.21(b)(4): 7:1 at right angles from the primary's sides
        p13r, _ = self.pos["13R"]
        tr = one(self.fs, "transitional", rwy_id="13R/31L")
        # 700 ft past the primary's SW side (away from 13L), 3,000 ft along 13R: centreline elevation + 100 ft.
        p = lateral(p13r, 145, 3000 * FT, (1000 + 700) * FT)
        cl = (3933.0 + (3920.0 - 3933.0) * 3000 / 14000) * FT
        self.assertAlmostEqual(h_at(tr, p), cl + 100 * FT, delta=0.05)


@unittest.skipUnless(HAVE, "needs numpy, shapely, pyproj (venv)")
class Output(unittest.TestCase):
    def test_polygons_epsg5070_and_cited(self):
        fac, runways, ends, pos = nfl()
        fs = A.facility_surfaces(fac, runways, ends)
        for s in fs.surfaces:
            self.assertTrue(s.polygon.is_valid and not s.polygon.is_empty, s.kind)
            self.assertRegex(s.cite, r"^14 CFR 77\.(9|19|21)\(")
            x, y = s.polygon.representative_point().coords[0]
            self.assertTrue(-2.5e6 < x < 2.5e6 and 0 < y < 3.5e6, (s.kind, x, y))  # CONUS Albers metres
        ap = one(fs, "approach", "13L")
        p = at(*pos["13L"][0], 325, 3000)
        import shapely
        self.assertTrue(shapely.contains_xy(ap.polygon, *p))

    def test_wording(self):  # screening wording only
        src = (Path(__file__).resolve().parent / "route_aviation.py").read_text()
        self.assertIn("exceeds an obstruction standard — screening", src)
        self.assertIn("notice zone (14 CFR 77.9)", src)
        self.assertIsNone(re.search(r"(?i)\b(clearance|hazard|approved|safe|compliant)\b", src))


if __name__ == "__main__":
    unittest.main()
