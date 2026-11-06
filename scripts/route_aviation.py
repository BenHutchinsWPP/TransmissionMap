#!/usr/bin/env python3
"""Route-optimizer aviation surfaces: 14 CFR Part 77 imaginary surfaces per runway end.

Role: pure geometry, no I/O. From NTAD-shaped facility, runway and runway-end records (fetched by the fetch_route_inputs.py `ntad`
step; field names in FIELDS) it builds, for one facility, the 77.9(b) notice extent and either the 77.19 civil
surfaces (by runway class) or the 77.21 DoD surfaces, each a `Surface`: a polygon in EPSG:5070 metres plus a
height function (metres above mean sea level). `lowest_m` gives the lowest surface at points, which
build_route_aviation.py turns into the `aviation` band codes. Screening only: a structure above a surface
"exceeds an obstruction standard — screening"; inside the notice extent is a "notice zone (14 CFR 77.9)";
FAA Form 7460-1 / OE/AAA decides.
Units: NASR elevations and every CFR dimension are feet; they are converted to metres once (FT) and all
geometry is metres. Bearings are TRUE_ALIGNMENT, degrees clockwise from true north: an end's alignment is the
landing heading onto that end, so its approach lies behind it, at alignment + 180 deg. Each facility is built
in a local azimuthal-equidistant frame on its reference point (true distances and bearings), and polygons are
projected to EPSG:5070 densified at 100 m; heights are evaluated in the local frame.
Class: OWNERSHIP_TYPE_CODE MA/MN/MR take 77.21 (no runway code needed); other airports take 77.19 by
FAR_PART_77_CODE, or when it is blank: ILS_TYPE with a glide path -> precision, else an IAP or any ILS_TYPE -> non-precision, else visual; a
runway is utility when its length is <= 3,200 ft (the 77.9(b) split). Heliports, seaplane bases and the other
site types get the notice circle only (77.9(b)). Combination: a point exceeds an obstruction standard when it is
above any surface (77.17(a)(5)), so the binding one is the lowest; surfaces that the CFR ends where they meet
another surface (transitional) are drawn generously and the minimum trims them.

eCFR text used (https://www.ecfr.gov/current/title-14/chapter-I/subchapter-E/part-77, fetched 2026-11-03):
  77.9(b)(1) "100 to 1 for a horizontal distance of 20,000 ft. from the nearest point of the nearest runway of
    each airport ... with its longest runway more than 3,200 ft. in actual length, excluding heliports."
  77.9(b)(2) "50 to 1 for a horizontal distance of 10,000 ft. ... no more than 3,200 ft. in actual length"
  77.9(b)(3) "25 to 1 for a horizontal distance of 5,000 ft. from the nearest point of the nearest landing and
    takeoff area of each heliport"
  77.19(a) horizontal: "150 feet above the established airport elevation ... arcs ... from the center of each end
    of the primary surface"; (a)(1) "5,000 feet for all runways designated as utility or visual"; (a)(2) "10,000
    feet for all other runways ... the highest determined for either end of the runway".
  77.19(b) conical: "slope of 20 to 1 for a horizontal distance of 4,000 feet".
  77.19(c) primary: "extends 200 feet beyond each end of that runway" when hard-surfaced, "ends at each end" when
    not; elevation "the same as the elevation of the nearest point on the runway centerline"; width (c)(1) 250 ft
    utility visual, (c)(2) 500 ft utility non-precision, (c)(3)(i) 500 ft other visual, (c)(3)(ii) 500 ft
    non-precision > 3/4 mile, (c)(3)(iii) 1,000 ft non-precision as low as 3/4 mile and precision, (c)(3)(iv) the
    most precise approach of either end.
  77.19(d)(1) approach outer width: (i) 1,250 ft utility visual, (ii) 1,500 ft other visual, (iii) 2,000 ft
    utility non-precision, (iv) 3,500 ft non-precision other > 3/4 mile, (v) 4,000 ft as low as 3/4 mile,
    (vi) 16,000 ft precision; (d)(2) length (i) "5,000 feet at a slope of 20 to 1 for all utility and visual
    runways", (ii) "10,000 feet at a slope of 34 to 1 for all non-precision instrument runways other than
    utility", (iii) "10,000 feet at a slope of 50 to 1 with an additional 40,000 feet at a slope of 40 to 1 for
    all precision instrument runways".
  77.19(e) transitional: "slope of 7 to 1 from the sides of the primary surface and from the sides of the approach
    surfaces"; beyond the conical, a precision approach's transitional extends "5,000 feet measured horizontally
    from the edge of the approach surface".
  77.21(a)(1) inner horizontal "150 feet above the established airfield elevation ... arc with a radius of 7,500
    feet about the centerline at the end of each runway"; (a)(2) conical "20 to 1 for a horizontal distance of
    7,000 feet to a height of 500 feet"; (a)(3) outer horizontal "500 feet ... for a horizontal distance of 30,000
    feet".
  77.21(b)(1) primary "same length as the runway. The width ... is 2,000 feet"; (b)(2) clear zone "a length of
    1,000 feet and the same width as the primary surface"; (b)(3) approach "beginning 200 feet beyond each end of
    the primary surface at the centerline elevation of the runway end and extending for 50,000 feet ... 50 to 1
    ... until it reaches an elevation of 500 feet above the established airport elevation. It then continues
    horizontally ... the width at 50,000 is 16,000 feet"; (b)(4) transitional "7 to 1 outward and upward at right
    angles to the runway centerline" from the primary, the first 200 ft of the clear zone and the approach.
Deps: numpy, shapely >= 2, pyproj (venv). Callers: build_route_aviation.py. Tests: test_route_aviation.py.
"""
import math
import re
from dataclasses import dataclass, field

import numpy as np
import shapely
from pyproj import CRS, Geod, Transformer
from shapely.geometry import Point, Polygon

FT = 0.3048  # metres per international foot; the one ft -> m conversion
CRS_OUT = "EPSG:5070"
DENSIFY_M = 100.0
GEOD = Geod(ellps="WGS84")

# NTAD field names this module reads (the ntad step writes records with these keys; strings kept as strings).
FIELDS = {
    "facility": ("SITE_NO", "ARPT_ID", "SITE_TYPE_CODE", "FACILITY_USE_CODE", "OWNERSHIP_TYPE_CODE",
                 "ARPT_STATUS", "LAT_DECIMAL", "LONG_DECIMAL", "ELEV", "IAPEXISTS"),
    "runway": ("SITE_NO", "RWY_ID", "RWY_LEN", "RWY_WIDTH", "SURFACE_TYPE_CODE"),
    "end": ("SITE_NO", "RWY_ID", "RWY_END_ID", "LAT_DECIMAL", "LONG_DECIMAL", "RWY_END_ELEV", "TRUE_ALIGNMENT",
            "FAR_PART_77_CODE", "ILS_TYPE"),
}
DOD_OWNERS = {"MA", "MN", "MR"}             # Air Force, Navy, Army -> 77.21
FEDERAL_OWNERS = DOD_OWNERS | {"CG"}        # 77.9(d)(3) "operated by a Federal agency or the DOD"
HARD_SURFACES = ("CONC", "ASPH", "PEM")     # 77.19(c) "specially prepared hard surface"
UTILITY_MAX_FT = 3200.0                     # 77.9(b)(1)/(2) split, used as the utility proxy
GROUND_KINDS = {"primary", "clear_zone"}    # surfaces on the ground (code 6, primary surface)
TRANSITIONAL_REACH_FT = 5000.0              # 77.19(e) 5,000 ft; also the drawn reach before the minimum trims it

# Approach categories, least to most precise: visual, non-precision > 3/4 mile, non-precision as low as 3/4 mile,
# precision. NASR FAR_PART_77_CODE -> (utility, category).
V, NP, NPL, P = 0, 1, 2, 3
PART77_CODES = {"A(V)": (True, V), "A(NP)": (True, NP), "B(V)": (False, V), "C": (False, NP), "D": (False, NPL),
                "PIR": (False, P)}


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _str(v):
    return "" if v is None else str(v).strip()


def _truthy(v):
    return _str(v).upper() in {"1", "Y", "YES", "TRUE", "T"} or v is True


# 77.3: a precision instrument runway has an ILS, MLS or PAR, i.e. a glide-path aid. Localizer-only ends (LOC, LOCALIZER, LOC/DME, LDA, SDF and their /DME forms) are non-precision.
GLIDE_PATH_ILS = {"ILS", "ILS/DME", "MLS", "ISMLS", "PAR", "LOC/GS"}


def end_class(end, rwy_len_ft, iap):
    """(utility, category, source) for one runway end: the NASR code, else the fallback."""
    code = re.sub(r"\s+", "", _str(end.get("FAR_PART_77_CODE")).upper())
    if code in PART77_CODES:
        u, c = PART77_CODES[code]
        return u, c, "FAR_PART_77_CODE"
    utility = rwy_len_ft is not None and rwy_len_ft <= UTILITY_MAX_FT
    ils = re.sub(r"\s+", "", _str(end.get("ILS_TYPE")).upper())
    if ils in GLIDE_PATH_ILS:
        return False, P, "ILS_TYPE"
    if iap or ils:
        # Non-precision other-than-utility is taken as "as low as 3/4 mile" (NASR gives no minimums).
        return utility, (NP if utility else NPL), "IAP"
    return utility, V, "visual"


def has_iap(facility, ends):
    """77.9(d)(4): ADDS IAPEXISTS, or a runway end with a non-visual Part 77 code or an ILS."""
    if _truthy(facility.get("IAPEXISTS")):
        return True
    for e in ends:
        code = re.sub(r"\s+", "", _str(e.get("FAR_PART_77_CODE")).upper())
        if (code in PART77_CODES and PART77_CODES[code][1] != V) or _str(e.get("ILS_TYPE")):
            return True
    return False


def notice_basis(facility, ends):
    """The 77.9(d) paragraphs that make an operational facility's notice surfaces apply; [] = not covered."""
    if _str(facility.get("ARPT_STATUS")).upper() != "O":
        return []
    out = []
    if _str(facility.get("FACILITY_USE_CODE")).upper() == "PU":
        out.append("77.9(d)(1)")
    if _str(facility.get("OWNERSHIP_TYPE_CODE")).upper() in FEDERAL_OWNERS:
        out.append("77.9(d)(3)")
    if has_iap(facility, ends):
        out.append("77.9(d)(4)")
    return out


class Frame:
    """Local azimuthal-equidistant frame (metres, x east, y north) on one facility's reference point."""

    def __init__(self, lon, lat):
        local = CRS.from_proj4(f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m +no_defs")
        self.from_ll = Transformer.from_crs("EPSG:4326", local, always_xy=True)
        self.to_out = Transformer.from_crs(local, CRS_OUT, always_xy=True)
        self.from_out = Transformer.from_crs(CRS_OUT, local, always_xy=True)

    def project(self, poly):
        def f(c):
            x, y = self.to_out.transform(c[:, 0], c[:, 1])
            return np.column_stack([x, y])
        return shapely.transform(shapely.segmentize(poly, DENSIFY_M), f)


@dataclass
class Surface:
    kind: str           # notice, primary, approach, transitional, horizontal, conical, clear_zone,
    #                     inner_horizontal, outer_horizontal
    cite: str           # the CFR paragraph that defines it
    site_no: str
    rwy_id: str | None
    end_id: str | None
    local: Polygon      # in the facility frame
    frame: Frame
    _h: object          # (x, y) local arrays -> metres MSL
    polygon: Polygon = field(init=False)  # EPSG:5070

    def __post_init__(self):
        self.polygon = self.frame.project(self.local)

    def height_local(self, x, y):
        x, y = np.asarray(x, float), np.asarray(y, float)
        h = np.asarray(self._h(x, y), float) * np.ones_like(x)
        return np.where(shapely.contains_xy(self.local, x, y), h, np.nan)

    def height_m(self, x, y):
        """Surface elevation (m MSL) at EPSG:5070 points; NaN outside the surface."""
        lx, ly = self.frame.from_out.transform(np.asarray(x, float), np.asarray(y, float))
        return self.height_local(lx, ly)


@dataclass
class FacilitySurfaces:
    site_no: str
    rule: str                    # "77.21", "77.19" or "77.9(b)" (notice only)
    surfaces: list
    notes: list                  # fallbacks and skipped records, for build_route_aviation.py's log


def lowest_m(fs, x, y):
    """(lowest 77.19/77.21 surface m MSL or NaN, inside a ground-level surface) at EPSG:5070 points."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    low = np.full(x.shape, np.nan)
    ground = np.zeros(x.shape, bool)
    for s in fs.surfaces:
        if s.kind == "notice":
            continue
        h = s.height_m(x, y)
        low = np.fmin(low, h)
        if s.kind in GROUND_KINDS:
            ground |= ~np.isnan(h)
    return low, ground


@dataclass
class _Rwy:
    rwy_id: str
    a: np.ndarray        # end A position (local m)
    u: np.ndarray        # unit vector A -> B
    length: float        # m
    ea: float            # end elevations, m MSL
    eb: float
    id_a: str
    id_b: str
    cls_a: tuple
    cls_b: tuple
    hard: bool
    width: float         # runway width, m (notice distance)

    def sl(self, x, y):
        dx, dy = x - self.a[0], y - self.a[1]
        s = dx * self.u[0] + dy * self.u[1]
        l = -dx * self.u[1] + dy * self.u[0]
        return s, l

    def xy(self, s, l):
        return (self.a[0] + s * self.u[0] - l * self.u[1], self.a[1] + s * self.u[1] + l * self.u[0])

    def centre_elev(self, s):
        t = np.clip(np.asarray(s, float) / self.length, 0.0, 1.0)
        return self.ea + t * (self.eb - self.ea)


@dataclass
class _Piece:
    s0: float
    s1: float
    w0: float            # full width at s0 and s1 (linear between)
    w1: float
    h: object            # s -> m MSL

    def width(self, s):
        return self.w0 + (self.w1 - self.w0) * (s - self.s0) / (self.s1 - self.s0)

    def poly(self, r, extra=0.0):
        pts = [(self.s0, -self.w0 / 2 - extra), (self.s1, -self.w1 / 2 - extra),
               (self.s1, self.w1 / 2 + extra), (self.s0, self.w0 / 2 + extra)]
        return Polygon([r.xy(s, l) for s, l in pts])


def _ramp(x, segs, base):
    """Height base + piecewise slopes over x >= 0; segs = [(length m, run:rise)]."""
    x = np.asarray(x, float)
    h = np.full(x.shape, base)
    x0 = 0.0
    for length, slope in segs:
        h = h + np.clip(x - x0, 0.0, length) / slope
        x0 += length
    return h


def _approach_piece(r, at_a, start, inner_w, outer_w, segs, base, cap=None):
    """Approach trapezoid beyond end A (at_a) or B; `start` = s of its inner edge; segs from its inner edge."""
    length = sum(s for s, _ in segs)

    def h(s, start=start, sign=(-1.0 if at_a else 1.0)):
        v = _ramp(sign * (np.asarray(s, float) - start), segs, base)
        return v if cap is None else np.minimum(v, cap)

    if at_a:
        return _Piece(start - length, start, outer_w, inner_w, h)
    return _Piece(start, start + length, inner_w, outer_w, h)


def _core(pieces, s):
    """(height, full width) of the core surfaces (primary + approaches) along s; NaN outside."""
    s = np.asarray(s, float)
    h, w = np.full(s.shape, np.nan), np.full(s.shape, np.nan)
    for p in pieces:
        m = (s >= p.s0) & (s <= p.s1) & np.isnan(h)
        if m.any():
            h[m] = p.h(s[m])
            w[m] = p.width(s[m])
    return h, w


def _surface_from_piece(kind, cite, site, r, end_id, piece, frame):
    def h(x, y):
        s, _ = r.sl(x, y)
        return piece.h(s)
    return Surface(kind, cite, site, r.rwy_id, end_id, piece.poly(r), frame, h)


def _transitional(cite, site, r, pieces, allowed, frame):
    """7:1 at right angles to the centreline from the sides of `pieces` (77.19(e), 77.21(b)(4))."""
    reach = TRANSITIONAL_REACH_FT * FT
    strip = shapely.union_all([p.poly(r, reach) for p in pieces])
    core = shapely.union_all([p.poly(r) for p in pieces])
    poly = shapely.intersection(shapely.difference(strip, core), allowed)

    def h(x, y):
        s, l = r.sl(x, y)
        hc, wc = _core(pieces, s)
        return hc + (np.abs(l) - wc / 2) / 7.0  # 77.19(e) / 77.21(b)(4): 7 to 1
    return Surface("transitional", cite, site, r.rwy_id, None, poly, frame, h)


def _hull_of_arcs(centres, radii):
    return shapely.convex_hull(shapely.union_all([Point(c).buffer(rad, quad_segs=32) for c, rad in zip(centres, radii)]))


def _ring_surface(kind, cite, site, inner, reach, base, slope, frame):
    """Surface from the periphery of `inner` outward for `reach` m; slope None = level at base."""
    outer = inner.buffer(reach, quad_segs=32)
    poly = shapely.difference(outer, inner)

    def h(x, y):
        if slope is None:
            return np.full(np.shape(x), base)
        return base + shapely.distance(inner, shapely.points(x, y)) / slope
    return Surface(kind, cite, site, None, None, poly, frame, h), outer


def _runways(facility, runways, ends, frame, iap, notes):
    site = _str(facility.get("SITE_NO"))
    by_rwy = {}
    for e in ends:
        by_rwy.setdefault(_str(e.get("RWY_ID")), []).append(e)
    out = []
    for rw in runways:
        rid = _str(rw.get("RWY_ID"))
        if re.match(r"^H\d", rid):  # a helipad on an airport: no 77.19 runway surfaces
            notes.append(f"{site} {rid}: helipad, no runway surfaces")
            continue
        es = [e for e in by_rwy.get(rid, []) if _num(e.get("LAT_DECIMAL")) is not None
              and _num(e.get("LONG_DECIMAL")) is not None]
        es.sort(key=lambda e: _str(e.get("RWY_END_ID")))
        rlen = _num(rw.get("RWY_LEN"))
        if not es:
            notes.append(f"{site} {rid}: no end coordinates, skipped")
            continue
        pts = [np.array(frame.from_ll.transform(_num(e["LONG_DECIMAL"]), _num(e["LAT_DECIMAL"]))) for e in es]
        ea = es[0]
        if len(es) >= 2:
            eb = es[1]
            a, b = pts[0], pts[1]
            length = float(np.hypot(*(b - a)))
            if length <= 0:
                notes.append(f"{site} {rid}: ends coincide, skipped")
                continue
            u = (b - a) / length
            ta = _num(ea.get("TRUE_ALIGNMENT"))
            if ta is not None:
                diff = abs((math.degrees(math.atan2(u[0], u[1])) - ta + 180.0) % 360.0 - 180.0)
                if diff > 3.0:
                    notes.append(f"{site} {rid}: end coordinates differ from TRUE_ALIGNMENT by {diff:.1f} deg")
        else:
            ta = _num(ea.get("TRUE_ALIGNMENT"))
            if ta is None or rlen is None:
                notes.append(f"{site} {rid}: one end without TRUE_ALIGNMENT/RWY_LEN, skipped")
                continue
            # The alignment is the heading of a landing onto this end: the runway runs ahead of it.
            th = math.radians(ta)
            u = np.array([math.sin(th), math.cos(th)])
            a, length, eb = pts[0], rlen * FT, {}
            notes.append(f"{site} {rid}: one end, other placed by TRUE_ALIGNMENT and RWY_LEN")
        elev_a = _num(ea.get("RWY_END_ELEV"))
        elev_b = _num(eb.get("RWY_END_ELEV"))
        fe = _num(facility.get("ELEV"))
        if elev_a is None:
            elev_a = elev_b if elev_b is not None else fe
        if elev_b is None:
            elev_b = elev_a
        if elev_a is None:
            notes.append(f"{site} {rid}: no elevation, skipped")
            continue
        len_ft = rlen if rlen is not None else length / FT
        surf = _str(rw.get("SURFACE_TYPE_CODE")).upper()
        hard = (not surf) or any(k in surf for k in HARD_SURFACES)
        out.append(_Rwy(rid, a, u, length, elev_a * FT, elev_b * FT,
                        _str(ea.get("RWY_END_ID")), _str(eb.get("RWY_END_ID")) or None,
                        end_class(ea, len_ft, iap), end_class(eb, len_ft, iap) if eb else end_class(ea, len_ft, iap),
                        hard, (_num(rw.get("RWY_WIDTH")) or 0.0) * FT))
    return out


def _civil(site, rwys, apt_elev, frame):
    surfaces, prec = [], []
    centres, radii, per_rwy = [], [], []
    for r in rwys:
        utility = r.cls_a[0] and r.cls_b[0]
        best = max(r.cls_a[1], r.cls_b[1])
        # 77.19(c)(1)/(c)(2) utility, (c)(3)(i)-(iii) other; (c)(3)(iv) most precise end decides.
        if utility:
            wp = (250.0 if best == V else 500.0) * FT
        else:
            wp = (1000.0 if best >= NPL else 500.0) * FT
        e = 200.0 * FT if r.hard else 0.0  # 77.19(c): 200 ft beyond each hard-surfaced end, else at the end
        primary = _Piece(-e, r.length + e, wp, wp, r.centre_elev)  # 77.19(c): nearest centreline point
        pieces = [primary]
        ends = []
        for at_a, cls, base, eid in ((True, r.cls_a, r.ea, r.id_a), (False, r.cls_b, r.eb, r.id_b)):
            cat = cls[1]
            if cat == P:
                outer, segs = 16000.0, [(10000.0 * FT, 50.0), (40000.0 * FT, 40.0)]  # (d)(1)(vi), (d)(2)(iii)
            elif cat in (NP, NPL) and not utility:
                outer = 4000.0 if cat == NPL else 3500.0                              # (d)(1)(v), (d)(1)(iv)
                segs = [(10000.0 * FT, 34.0)]                                         # (d)(2)(ii)
            elif cat in (NP, NPL):
                outer, segs = 2000.0, [(5000.0 * FT, 20.0)]                           # (d)(1)(iii), (d)(2)(i)
            else:
                outer = 1250.0 if utility else 1500.0                                 # (d)(1)(i), (d)(1)(ii)
                segs = [(5000.0 * FT, 20.0)]                                          # (d)(2)(i)
            start = -e if at_a else r.length + e
            ap = _approach_piece(r, at_a, start, wp, outer * FT, segs, base)
            pieces.append(ap)
            ends.append((ap, eid, cat))
            surfaces.append(_surface_from_piece("approach", "14 CFR 77.19(d)", site, r, eid, ap, frame))
        surfaces.append(_surface_from_piece("primary", "14 CFR 77.19(c)", site, r, None, primary, frame))
        # 77.19(a)(1) 5,000 ft utility or visual, (a)(2) 10,000 ft other; the higher of the two ends.
        rad = max((5000.0 if (c[0] or c[1] == V) else 10000.0) for c in (r.cls_a, r.cls_b)) * FT
        for s in (-e, r.length + e):  # centre of each end of the primary surface
            centres.append(r.xy(s, 0.0))
            radii.append(rad)
        per_rwy.append((r, pieces))
        prec += [ap.poly(r, TRANSITIONAL_REACH_FT * FT) for ap, _, cat in ends if cat == P]
    horiz_poly = _hull_of_arcs(centres, radii)
    hz = apt_elev + 150.0 * FT  # 77.19(a): 150 ft above the established airport elevation
    surfaces.append(Surface("horizontal", "14 CFR 77.19(a)", site, None, None, horiz_poly, frame,
                            lambda x, y: np.full(np.shape(x), hz)))
    conical, outer = _ring_surface("conical", "14 CFR 77.19(b)", site, horiz_poly, 4000.0 * FT, hz, 20.0, frame)
    surfaces.append(conical)  # 77.19(b): 20 to 1 for 4,000 ft
    allowed = shapely.union_all([outer] + prec)  # 77.19(e): precision transitional runs 5,000 ft past the conical
    for r, pieces in per_rwy:
        surfaces.append(_transitional("14 CFR 77.19(e)", site, r, pieces, allowed, frame))
    return surfaces


def _dod(site, rwys, apt_elev, frame):
    surfaces, centres, per_rwy = [], [], []
    wp = 2000.0 * FT                    # 77.21(b)(1): primary 2,000 ft wide
    cap = apt_elev + 500.0 * FT         # 77.21(b)(3): level at 500 ft above the airport elevation
    for r in rwys:
        primary = _Piece(0.0, r.length, wp, wp, r.centre_elev)  # 77.21(b)(1): same length as the runway
        surfaces.append(_surface_from_piece("primary", "14 CFR 77.21(b)(1)", site, r, None, primary, frame))
        pieces = [primary]
        for at_a, base, eid in ((True, r.ea, r.id_a), (False, r.eb, r.id_b)):
            sgn = -1.0 if at_a else 1.0
            edge = 0.0 if at_a else r.length
            cz_len = 1000.0 * FT        # 77.21(b)(2): clear zone 1,000 ft, primary width, on the ground
            cz = _Piece(min(edge, edge + sgn * cz_len), max(edge, edge + sgn * cz_len), wp, wp,
                        lambda s, b=base: np.full(np.shape(s), b))
            surfaces.append(_surface_from_piece("clear_zone", "14 CFR 77.21(b)(2)", site, r, eid, cz, frame))
            g = 200.0 * FT              # 77.21(b)(4): transitional also from the first 200 ft of the clear zone
            first = _Piece(min(edge, edge + sgn * g), max(edge, edge + sgn * g), wp, wp,
                           lambda s, b=base: np.full(np.shape(s), b))
            # 77.21(b)(3): starts 200 ft beyond the primary end at the runway-end elevation, 50 to 1 for
            # 50,000 ft (level once at the cap), 2,000 ft wide flaring to 16,000 ft at 50,000 ft.
            ap = _approach_piece(r, at_a, edge + sgn * g, wp, 16000.0 * FT, [(50000.0 * FT, 50.0)], base, cap)
            surfaces.append(_surface_from_piece("approach", "14 CFR 77.21(b)(3)", site, r, eid, ap, frame))
            pieces += [first, ap]
        centres += [r.xy(0.0, 0.0), r.xy(r.length, 0.0)]  # 77.21(a)(1): about the centreline at each runway end
        per_rwy.append((r, pieces))
    inner = _hull_of_arcs(centres, [7500.0 * FT] * len(centres))  # 77.21(a)(1): 7,500 ft radius
    hz = apt_elev + 150.0 * FT                                     # 77.21(a)(1): 150 ft above airfield elevation
    surfaces.append(Surface("inner_horizontal", "14 CFR 77.21(a)(1)", site, None, None, inner, frame,
                            lambda x, y: np.full(np.shape(x), hz)))
    conical, c_out = _ring_surface("conical", "14 CFR 77.21(a)(2)", site, inner, 7000.0 * FT, hz, 20.0, frame)
    surfaces.append(conical)  # 77.21(a)(2): 20 to 1 for 7,000 ft, to 500 ft
    outer_h, outer = _ring_surface("outer_horizontal", "14 CFR 77.21(a)(3)", site, c_out, 30000.0 * FT, cap, None,
                                   frame)
    surfaces.append(outer_h)  # 77.21(a)(3): 500 ft for 30,000 ft beyond the conical
    for r, pieces in per_rwy:
        surfaces.append(_transitional("14 CFR 77.21(b)(4)", site, r, pieces, outer, frame))
    return surfaces


def _notice(facility, runways, rwys, frame, site):
    """77.9(b) notice extent and surface: from the nearest point of the nearest runway, or a circle."""
    lens = [x for x in (_num(rw.get("RWY_LEN")) for rw in runways) if x is not None]
    longest = max(lens) if lens else None
    stype = _str(facility.get("SITE_TYPE_CODE")).upper()
    if stype == "H":
        reach, slope, cite = 5000.0, 25.0, "14 CFR 77.9(b)(3)"   # 77.9(b)(3): 25 to 1 for 5,000 ft
    elif longest is None or longest > UTILITY_MAX_FT:
        reach, slope, cite = 20000.0, 100.0, "14 CFR 77.9(b)(1)"  # 77.9(b)(1): 100 to 1 for 20,000 ft
    else:
        reach, slope, cite = 10000.0, 50.0, "14 CFR 77.9(b)(2)"   # 77.9(b)(2): 50 to 1 for 10,000 ft
    reach *= FT
    if stype == "A" and rwys:
        poly = shapely.union_all([shapely.LineString([r.xy(0, 0), r.xy(r.length, 0)]).buffer(reach + r.width / 2,
                                                                                               quad_segs=32)
                                  for r in rwys])

        def h(x, y):
            best_d = np.full(np.shape(x), np.inf)
            best_h = np.full(np.shape(x), np.nan)
            for r in rwys:
                s, l = r.sl(x, y)
                sc = np.clip(s, 0.0, r.length)
                d = np.maximum(np.hypot(s - sc, l) - r.width / 2, 0.0)
                hv = r.centre_elev(sc) + d / slope
                m = d < best_d
                best_d, best_h = np.where(m, d, best_d), np.where(m, hv, best_h)
            return best_h
    else:
        fe = _num(facility.get("ELEV"))
        base = (fe if fe is not None else 0.0) * FT
        poly = Point(0.0, 0.0).buffer(reach, quad_segs=32)

        def h(x, y):
            return base + np.hypot(x, y) / slope
    return Surface("notice", cite, site, None, None, poly, frame, h)


def facility_surfaces(facility, runways, ends):
    """Every Part 77 surface of one facility. `runways`/`ends` are that facility's NTAD records (same SITE_NO)."""
    site = _str(facility.get("SITE_NO"))
    lon, lat = _num(facility.get("LONG_DECIMAL")), _num(facility.get("LAT_DECIMAL"))
    if lon is None or lat is None:
        raise ValueError(f"facility {site}: no reference point")
    frame = Frame(lon, lat)
    notes = []
    stype = _str(facility.get("SITE_TYPE_CODE")).upper()
    iap = has_iap(facility, ends)
    rwys = _runways(facility, runways, ends, frame, iap, notes) if stype == "A" else []
    surfaces = [_notice(facility, runways, rwys, frame, site)]
    if stype != "A" or not rwys:
        if stype == "A":
            notes.append(f"{site}: no usable runway, notice circle only")
        return FacilitySurfaces(site, "77.9(b)", surfaces, notes)
    fe = _num(facility.get("ELEV"))
    apt_elev = fe * FT if fe is not None else max(max(r.ea, r.eb) for r in rwys)
    if fe is None:
        notes.append(f"{site}: no ELEV, highest runway end used")
    if _str(facility.get("OWNERSHIP_TYPE_CODE")).upper() in DOD_OWNERS:
        return FacilitySurfaces(site, "77.21", surfaces + _dod(site, rwys, apt_elev, frame), notes)
    return FacilitySurfaces(site, "77.19", surfaces + _civil(site, rwys, apt_elev, frame), notes)
