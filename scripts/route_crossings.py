#!/usr/bin/env python3
"""Crossing report for a routed line (dev tool).

    venv/bin/python scripts/route_crossings.py <route.geojson>

Reads a LineString (or a Feature / FeatureCollection holding one; lng/lat) and
reports, from the local GeoParquet files in data/route/report/ (written by
build_route_report_data.py): airports by FAA Part 77 radius (5,000 / 10,000 / 20,000 ft from
the airport reference point), WSR and NHT/NST lines crossed or within 2,500 ft,
pipelines within 2,500 ft, named major roads (motorway/trunk/primary) and rivers
(waterway=river) crossed, railroads crossed, existing transmission lines crossed
(kV, operator), and PAD-US / tribal / critical-habitat miles by agency and GAP.
Coastal zone and NRHP are reported "not checked" (no input files).
Writes <route>.crossings.json and <route>.crossings.csv beside the input.

Stdlib-only core: everything above `# --- CLI read path` works on plain
coordinate lists and is what test_route_crossings.py imports. Geometry runs in
EPSG:5070 (CONUS Albers, GRS80, the route cube's CRS), metres; `albers()` is
implemented here from Snyder's ellipsoidal equations, no pyproj. Albers metres run up
to ~1 % under ground distance in mid-latitudes (scale 0.991 near 40N), so miles and feet here are
projected, as in the route cube. pyarrow is
imported lazily inside the CLI read path. WKB geometry is decoded by `decode_wkb`.

Scope notes: crossings are counted per named group, with crossing points
within 100 m of each other merged (divided carriageways, a shared vertex between
two feature rows, a meander) and listed by route mile. Polygon miles are the
union of the route's stretches inside any polygon of the category, so
overlapping polygons of one category are not double counted; categories do
overlap one another. Airport radii are measured to the reference point; the
runway-surface Part 77 imaginary surfaces are not modelled.
"""
import csv
import json
import math
import struct
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "data/route/report"
RAW = ROOT / "data/raw/route"

FT = 0.3048
MI = 1609.344
PART77_FT = (5000, 10000, 20000)
NEAR_FT = 2500
MARGIN_M = 2000          # corridor = route bbox +/- this, at least (layers needing more widen it)
MERGE_M = 100            # crossing points of one group closer than this are one crossing
CELL_M = 5000            # route-segment grid cell

# --- projection --------------------------------------------------------------

_A, _F = 6378137.0, 1 / 298.257222101  # GRS80
_E2 = _F * (2 - _F)
_E = math.sqrt(_E2)


def _m(phi):
    s = math.sin(phi)
    return math.cos(phi) / math.sqrt(1 - _E2 * s * s)


def _q(phi):
    s = math.sin(phi)
    return (1 - _E2) * (s / (1 - _E2 * s * s) - math.log((1 - _E * s) / (1 + _E * s)) / (2 * _E))


_P1, _P2, _P0, _L0 = (math.radians(v) for v in (29.5, 45.5, 23.0, -96.0))
_N = (_m(_P1) ** 2 - _m(_P2) ** 2) / (_q(_P2) - _q(_P1))
_C = _m(_P1) ** 2 + _N * _q(_P1)
_RHO0 = _A * math.sqrt(_C - _N * _q(_P0)) / _N


def albers(lon, lat):
    """EPSG:5070 (x, y) metres from lng/lat degrees."""
    rho = _A * math.sqrt(_C - _N * _q(math.radians(lat))) / _N
    th = _N * (math.radians(lon) - _L0)
    return (rho * math.sin(th), _RHO0 - rho * math.cos(th))


# --- WKB ---------------------------------------------------------------------

WKB_SKIPPED = {"collections": 0}


def decode_wkb(b):
    """WKB -> (kind, parts): 'point' [(x, y)], 'line' [[(x, y)..]..], 'poly' [[ring..]..] (ring = [(x, y)..]).
    A GeometryCollection is skipped: ('none', []), counted in WKB_SKIPPED."""
    kind, parts, _ = _wkb(memoryview(b), 0)
    return kind, parts


def _wkb(b, o):
    end = "<" if b[o] == 1 else ">"
    t = struct.unpack_from(end + "I", b, o + 1)[0]
    o += 5
    dims = 2
    if t >= 1000:           # ISO Z/M/ZM
        dims = 2 + (1 if t // 1000 in (1, 3) else 0) + (1 if t // 1000 in (2, 3) else 0)
        t %= 1000
    elif t & 0xE0000000:    # EWKB flags
        dims = 2 + (1 if t & 0x80000000 else 0) + (1 if t & 0x40000000 else 0)
        if t & 0x20000000:
            o += 4
        t &= 0xFF

    def pts(o):
        n = struct.unpack_from(end + "I", b, o)[0]
        o += 4
        out = []
        for _ in range(n):
            out.append(struct.unpack_from(end + "dd", b, o))
            o += 8 * dims
        return out, o

    if t == 1:
        return "point", [struct.unpack_from(end + "dd", b, o)], o + 8 * dims
    if t == 2:
        p, o = pts(o)
        return "line", [p], o
    if t == 3:
        n = struct.unpack_from(end + "I", b, o)[0]
        o += 4
        rings = []
        for _ in range(n):
            p, o = pts(o)
            rings.append(p)
        return "poly", [rings], o
    if t == 7:
        WKB_SKIPPED["collections"] += 1
        return "none", [], len(b)
    if t in (4, 5, 6):
        n = struct.unpack_from(end + "I", b, o)[0]
        o += 4
        kind, parts = {4: "point", 5: "line", 6: "poly"}[t], []
        for _ in range(n):
            _, p, o = _wkb(b, o)
            parts.extend(p)
        return kind, parts, o
    raise ValueError(f"unsupported WKB type {t}")


# --- plane geometry ------------------------------------------------------------

def bbox_of(coords):
    xs = [p[0] for p in coords]
    ys = [p[1] for p in coords]
    return min(xs), min(ys), max(xs), max(ys)


def seg_intersect(a, b, c, d):
    """(t, u) along a->b and c->d where the segments meet, else None. Parallel/collinear: None."""
    rx, ry = b[0] - a[0], b[1] - a[1]
    sx, sy = d[0] - c[0], d[1] - c[1]
    den = rx * sy - ry * sx
    if den == 0:
        return None
    qx, qy = c[0] - a[0], c[1] - a[1]
    t = (qx * sy - qy * sx) / den
    u = (qx * ry - qy * rx) / den
    return (t, u) if 0 <= t <= 1 and 0 <= u <= 1 else None


def pt_seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    dd = dx * dx + dy * dy
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / dd)) if dd else 0.0
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def seg_seg_dist(a, b, c, d):
    if seg_intersect(a, b, c, d):
        return 0.0
    return min(pt_seg_dist(a, c, d), pt_seg_dist(b, c, d), pt_seg_dist(c, a, b), pt_seg_dist(d, a, b))


def in_polygon(p, rings):
    """Even-odd over all rings (outer + holes)."""
    x, y = p
    inside = False
    for ring in rings:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


def merge_intervals(iv):
    out = []
    for a, b in sorted(iv):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def interval_length(iv):
    return sum(b - a for a, b in merge_intervals(iv))


def dedupe_points(pts, tol=MERGE_M):
    """Keep one of any points within tol of an earlier kept point; pts = [(along, x, y)]."""
    kept = []
    for p in sorted(pts):
        if not any(math.hypot(p[1] - k[1], p[2] - k[2]) < tol for k in kept):
            kept.append(p)
    return kept


class Route:
    """A routed polyline in EPSG:5070 metres, with a grid over its segments for near-neighbour tests."""

    def __init__(self, lonlat):
        self.ll = [tuple(p[:2]) for p in lonlat]
        self.xy = [albers(*p) for p in self.ll]
        self.segs = list(zip(self.xy, self.xy[1:]))
        self.cum = [0.0]
        for a, b in self.segs:
            self.cum.append(self.cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        self.length_m = self.cum[-1]
        self.bbox = bbox_of(self.xy)
        self._grids = {}

    def _grid(self, buf):
        g = self._grids.get(buf)
        if g is None:
            g = self._grids[buf] = {}
            for i, (a, b) in enumerate(self.segs):
                x0, y0, x1, y1 = bbox_of((a, b))
                for cx in range(int((x0 - buf) // CELL_M), int((x1 + buf) // CELL_M) + 1):
                    for cy in range(int((y0 - buf) // CELL_M), int((y1 + buf) // CELL_M) + 1):
                        g.setdefault((cx, cy), []).append(i)
        return g

    def _candidates(self, buf, a, b):
        g = self._grid(buf)
        x0, y0, x1, y1 = bbox_of((a, b))
        out = set()
        for cx in range(int(x0 // CELL_M), int(x1 // CELL_M) + 1):
            for cy in range(int(y0 // CELL_M), int(y1 // CELL_M) + 1):
                out.update(g.get((cx, cy), ()))
        return out

    def near_bbox(self, bb, buf=0.0):
        x0, y0, x1, y1 = self.bbox
        return not (bb[2] < x0 - buf or bb[0] > x1 + buf or bb[3] < y0 - buf or bb[1] > y1 + buf)

    def line_hits(self, lines, buf=0.0):
        """Lines (lists of xy) vs the route. -> (crossings [(along_m, x, y)], min distance m or None when > buf and none cross)."""
        cross, best = [], None
        for line in lines:
            if len(line) < 2 or not self.near_bbox(bbox_of(line), buf):
                continue
            for c, d in zip(line, line[1:]):
                for i in self._candidates(buf, c, d):
                    a, b = self.segs[i]
                    hit = seg_intersect(a, b, c, d)
                    if hit:
                        t = hit[0]
                        cross.append((self.cum[i] + t * (self.cum[i + 1] - self.cum[i]),
                                      a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
                        best = 0.0
                    elif buf:
                        dist = seg_seg_dist(a, b, c, d)
                        if dist <= buf and (best is None or dist < best):
                            best = dist
        return cross, best

    def point_dist(self, p):
        return min(pt_seg_dist(p, a, b) for a, b in self.segs)

    def inside_intervals(self, rings):
        """Along-route [start, end] metre intervals inside a polygon (rings = outer + holes, xy)."""
        pb = bbox_of(rings[0])
        if not self.near_bbox(pb):
            return []
        out = []
        for i, (a, b) in enumerate(self.segs):
            sb = bbox_of((a, b))
            if sb[2] < pb[0] or sb[0] > pb[2] or sb[3] < pb[1] or sb[1] > pb[3]:
                continue
            ts = [0.0, 1.0]
            for ring in rings:
                for c, d in zip(ring, ring[1:]):
                    if max(c[0], d[0]) < sb[0] or min(c[0], d[0]) > sb[2] or max(c[1], d[1]) < sb[1] or min(c[1], d[1]) > sb[3]:
                        continue
                    hit = seg_intersect(a, b, c, d)
                    if hit:
                        ts.append(hit[0])
            ts.sort()
            seglen = self.cum[i + 1] - self.cum[i]
            for t0, t1 in zip(ts, ts[1:]):
                if t1 - t0 <= 1e-12:
                    continue
                tm = (t0 + t1) / 2
                if in_polygon((a[0] + tm * (b[0] - a[0]), a[1] + tm * (b[1] - a[1])), rings):
                    out.append((self.cum[i] + t0 * seglen, self.cum[i] + t1 * seglen))
        return out


def project_parts(kind, parts):
    if kind == "point":
        return [albers(*p[:2]) for p in parts]
    if kind == "line":
        return [[albers(*p[:2]) for p in ln] for ln in parts]
    return [[[albers(*p[:2]) for p in ring] for ring in poly] for poly in parts]


# --- corridor filter (lng/lat) -----------------------------------------------------

class Corridor:
    """Does a lng/lat bbox come within `margin_m` of the route? Cells of 0.1 deg over padded segment boxes."""

    CELL = 0.1

    def __init__(self, route_ll, margin_m):
        lat = max(abs(p[1]) for p in route_ll)
        dy = margin_m / 111000.0
        dx = margin_m / (111000.0 * math.cos(math.radians(min(lat + 1, 89))))
        self.boxes, self.cells = [], {}
        c = self.CELL
        for i, (p, q) in enumerate(zip(route_ll, route_ll[1:])):
            bb = (min(p[0], q[0]) - dx, min(p[1], q[1]) - dy, max(p[0], q[0]) + dx, max(p[1], q[1]) + dy)
            self.boxes.append(bb)
            for cx in range(math.floor(bb[0] / c), math.floor(bb[2] / c) + 1):
                for cy in range(math.floor(bb[1] / c), math.floor(bb[3] / c) + 1):
                    self.cells.setdefault((cx, cy), []).append(i)
        self.rect = (min(b[0] for b in self.boxes), min(b[1] for b in self.boxes),
                     max(b[2] for b in self.boxes), max(b[3] for b in self.boxes))

    def rect_hits(self, x0, y0, x1, y1):
        r = self.rect
        return not (x1 < r[0] or x0 > r[2] or y1 < r[1] or y0 > r[3])

    def hits(self, x0, y0, x1, y1):
        if not self.rect_hits(x0, y0, x1, y1):
            return False
        c = self.CELL
        nx, ny = math.floor(x1 / c) - math.floor(x0 / c) + 1, math.floor(y1 / c) - math.floor(y0 / c) + 1
        if nx * ny > 400:
            ids = range(len(self.boxes))
        else:
            ids = {i for cx in range(math.floor(x0 / c), math.floor(x1 / c) + 1)
                   for cy in range(math.floor(y0 / c), math.floor(y1 / c) + 1) for i in self.cells.get((cx, cy), ())}
        return any(not (x1 < b[0] or x0 > b[2] or y1 < b[1] or y0 > b[3]) for b in (self.boxes[i] for i in ids))


# --- analysis -----------------------------------------------------------------------

def _mi(m):
    return m / MI


def _clean(v):
    return None if v is None or (isinstance(v, float) and v != v) or str(v).strip() in ("", "None", "nan") else str(v).strip()


def _row(item, detail="", count=None, value=None, unit="", at_mi="", source=""):
    return {"item": item, "detail": detail, "count": count, "value": value, "unit": unit, "at_mi": at_mi, "source": source}


def _group_lines(route, feats, key, buf=0.0, detail=None):
    """Features [{'geom': [lines xy], 'props': {}}] -> rows per key(props): crossings (merged), min distance."""
    groups = {}
    for f in feats:
        cross, dist = route.line_hits(f["geom"], buf)
        if dist is None:
            continue
        g = groups.setdefault(key(f["props"]), {"pts": [], "dist": None, "detail": detail(f["props"]) if detail else ""})
        g["pts"].extend(cross)
        if g["dist"] is None or dist < g["dist"]:
            g["dist"] = dist
    rows = []
    for k, g in sorted(groups.items(), key=lambda kv: (min((p[0] for p in kv[1]["pts"]), default=1e12), kv[0])):
        pts = dedupe_points(g["pts"])
        miles = ", ".join(f"{_mi(p[0]):.0f}" for p in pts[:8]) + (" ..." if len(pts) > 8 else "")
        rows.append(_row(k, g["detail"], len(pts), None if g["dist"] is None else round(g["dist"] / FT), "ft" if buf else "", miles))
    return rows


def _group_polys(route, feats, key):
    groups = {}
    for f in feats:
        for poly in f["geom"]:
            iv = route.inside_intervals(poly)
            if iv:
                g = groups.setdefault(key(f["props"]), {"iv": [], "n": 0})
                g["iv"].extend(iv)
                g["n"] += 1
    rows = [_row(k, f"{g['n']} polygon(s)", g["n"], round(_mi(interval_length(g["iv"])), 2), "mi",
                 ", ".join(f"{_mi(a):.0f}-{_mi(b):.0f}" for a, b in merge_intervals(g["iv"])[:6]))
            for k, g in groups.items()]
    rows.sort(key=lambda r: -r["value"])
    return rows


def analyse(route_ll, layers):
    """route_ll: [[lng, lat]..]. layers: name -> [{'geom': projected parts, 'props': {...}}] (absent = no input).

    Layer names: airports (points), wsr, nht_nst, pipelines (lines; props 'name', 'operator', '_src'), roads,
    rivers, rail, lines (transmission; props '_src', 'kv', 'operator', 'name'), padus, tribal, crithab (polygons).
    -> {'route': {...}, 'sections': {name: {'status', 'rows'|'note'}}}
    """
    r = Route(route_ll)
    out = {}

    def need(name, fn):
        out[name] = {"status": "ok", "rows": fn(layers[name])} if name in layers else {"status": "not checked", "note": "no input"}

    def airports(feats):
        rows = []
        for f in feats:
            d = r.point_dist(f["geom"][0])
            ft = d / FT
            band = next((b for b in PART77_FT if ft <= b), None)
            if band:
                p = f["props"]
                rows.append(_row(f"{_clean(p.get('IDENT')) or ''} {_clean(p.get('NAME')) or ''}".strip(),
                                 f"within {band:,} ft; {_clean(p.get('TYPE_CODE')) or ''} {_clean(p.get('STATE')) or ''}"
                                 f"{' private' if p.get('PRIVATEUSE') in (1, '1', True) else ''}", 1, round(ft), "ft", source="airports"))
        rows.sort(key=lambda x: x["value"])
        return rows

    def line_layer(name, key, buf=0.0, detail=None):
        need(name, lambda feats: _group_lines(r, feats, key, buf, detail))

    need("airports", airports)
    line_layer("wsr", lambda p: _clean(p.get("wsr_river_name")) or "(unnamed)", NEAR_FT * FT,
               lambda p: f"WSR {_clean(p.get('agency')) or ''}".strip())
    line_layer("nht_nst", lambda p: _clean(p.get("trail")) or "(unnamed)", NEAR_FT * FT)
    line_layer("pipelines", lambda p: f"{_clean(p.get('name')) or _clean(p.get('operator')) or '(unnamed)'}",
               NEAR_FT * FT, lambda p: f"{_clean(p.get('substance') or p.get('pipe_type')) or ''} [{p.get('_src', '')}]".strip())
    line_layer("roads", lambda p: f"{_clean(p.get('name')) or _clean(p.get('ref')) or '(unnamed)'}"
               + (f" ({_clean(p.get('ref'))})" if _clean(p.get("name")) and _clean(p.get("ref")) else ""),
               0.0, lambda p: _clean(p.get("highway")) or "")
    line_layer("rivers", lambda p: _clean(p.get("name")) or _clean(p.get("ref")) or "(unnamed)", 0.0, lambda p: "waterway=river")
    line_layer("rail", lambda p: _clean(p.get("RROWNER1")) or "(unknown owner)", 0.0,
               lambda p: f"tracks={_clean(p.get('TRACKS')) or '?'}")
    line_layer("lines", lambda p: f"{p.get('_src', '')} {_clean(p.get('kv')) or '?'} kV {_clean(p.get('operator')) or '(unknown)'}",
               0.0, lambda p: _clean(p.get("name")) or "")
    need("padus", lambda feats: _group_polys(r, feats, lambda p: f"{_clean(p.get('mng_agency')) or '?'} / GAP {_clean(p.get('gap')) or '?'}"))
    need("tribal", lambda feats: _group_polys(r, feats, lambda p: _clean(p.get("name") or p.get("LARNAME")) or "(unnamed)"))
    need("crithab", lambda feats: _group_polys(r, feats, lambda p: f"{_clean(p.get('comname')) or '?'} ({_clean(p.get('status')) or '?'})"))
    for k in ("coastal_zone", "nrhp"):
        out[k] = {"status": "not checked", "note": "no input"}
    return {"route": {"length_mi": round(_mi(r.length_m), 2), "points": len(route_ll)}, "sections": out}


def format_table(rep, read_mib=None):
    L = [f"Route: {rep['route']['length_mi']:.1f} mi, {rep['route']['points']} points"]
    for name, s in rep["sections"].items():
        if s["status"] != "ok":
            L.append(f"\n[{name}] not checked ({s['note']})")
            continue
        L.append(f"\n[{name}] {len(s['rows'])} row(s)" + (f", read {read_mib[name]:.2f} MiB" if read_mib and name in read_mib else ""))
        for x in s["rows"]:
            v = "" if x["value"] is None else f"{x['value']:,} {x['unit']}"
            L.append(f"  {x['item'][:52]:<52} {'' if x['count'] is None else x['count']:>4} {v:>14}  {x['detail'][:44]}"
                     + (f"  @mi {x['at_mi']}" if x["at_mi"] else ""))
    return "\n".join(L)


def write_outputs(rep, base):
    base = Path(base)
    jp, cp = base.with_suffix(".crossings.json"), base.with_suffix(".crossings.csv")
    jp.write_text(json.dumps(rep, indent=1))
    with cp.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["section", "item", "detail", "count", "value", "unit", "at_mi", "source"])
        for name, s in rep["sections"].items():
            if s["status"] != "ok":
                w.writerow([name, "not checked", s["note"], "", "", "", "", ""])
            for x in s.get("rows", []):
                w.writerow([name, x["item"], x["detail"], x["count"], x["value"], x["unit"], x["at_mi"], x["source"]])
    return jp, cp


def route_coords(gj):
    while gj.get("type") == "FeatureCollection":
        gj = gj["features"][0]
    g = gj["geometry"] if gj.get("type") == "Feature" else gj
    if g["type"] != "LineString":
        raise ValueError("route must be a LineString")
    return g["coordinates"]


# --- CLI read path (pyarrow imported lazily) ---------------------------------------------------

# layer -> (files, columns kept, margin_m, kind)
PARQUET = {
    "airports": (["airports"], ["IDENT", "NAME", "TYPE_CODE", "STATE", "PRIVATEUSE"], PART77_FT[-1] * FT + 100, "point"),
    "pipelines": (["pipelines_hifld_natgas", "pipelines_osm", "pipelines_eia_crude", "pipelines_eia_product"],
                  ["name", "operator", "substance", "pipe_type"], NEAR_FT * FT + 100, "line"),
    "roads": (["roads_motorway_trunk", "roads_primary"], ["name", "ref", "highway"], MARGIN_M, "line"),
    "rivers": (["rivers"], ["name", "ref"], MARGIN_M, "line"),
    "rail": (["railroads"], ["RROWNER1", "TRACKS"], MARGIN_M, "line"),
    "lines": (["transmission_osm_us", "transmission_hifld"],
              ["name", "operator", "nominal_kv", "OWNER", "VOLTAGE", "is_undergrnd"], MARGIN_M, "line"),
    "wsr": (["wsr"], ["wsr_river_name", "agency"], NEAR_FT * FT + 100, "line"),
    "nht_nst": (["nht_nst"], ["trail"], NEAR_FT * FT + 100, "line"),
    "padus": (["padus_conus.p1", "padus_conus.p2"], ["mng_agency", "gap"], MARGIN_M, "poly"),
    "tribal": (["tribal_tiger", "tribal_bia"], ["name", "LARNAME"], MARGIN_M, "poly"),
    "crithab": (["crithab"], ["comname", "status"], MARGIN_M, "poly"),
}


def _read_parquet(layer, route_ll):
    import pyarrow.parquet as pq
    files, cols, margin, kind = PARQUET[layer]
    cor = Corridor(route_ll, margin)
    feats, mib = [], 0.0
    skipped0 = WKB_SKIPPED["collections"]
    for stem in files:
        pf = pq.ParquetFile(REPORT / f"{stem}.parquet")
        if pf.metadata.num_row_groups == 0:
            continue
        names = pf.schema_arrow.names
        keep = [c for c in cols if c in names]
        md = pf.metadata
        paths = {md.row_group(0).column(i).path_in_schema: i for i in range(md.row_group(0).num_columns)}
        for g in range(md.num_row_groups):
            rg = md.row_group(g)
            st = [rg.column(paths[f"bbox.{k}"]).statistics for k in ("xmin", "ymin", "xmax", "ymax")]
            if all(s is not None and s.has_min_max for s in st) and not cor.hits(st[0].min, st[1].min, st[2].max, st[3].max):
                continue
            want = keep + ["bbox", "geometry"]
            mib += sum(rg.column(i).total_compressed_size for p, i in paths.items() if p.split(".")[0] in want) / 2**20
            t = pf.read_row_group(g, columns=want)
            bb = t.column("bbox").to_pylist()
            idx = [i for i, b in enumerate(bb) if cor.hits(b["xmin"], b["ymin"], b["xmax"], b["ymax"])]
            if not idx:
                continue
            sub = t.take(idx)
            geoms = sub.column("geometry").to_pylist()
            props = {c: sub.column(c).to_pylist() for c in keep}
            for j, wkb in enumerate(geoms):
                k, parts = decode_wkb(wkb)
                if k == "none":
                    continue
                p = {c: props[c][j] for c in keep}
                p["_src"] = stem
                if "nominal_kv" in p or "VOLTAGE" in p:
                    p["kv"] = p.get("nominal_kv") if p.get("nominal_kv") is not None else p.get("VOLTAGE")
                    p["operator"] = p.get("operator") or p.get("OWNER")
                    if p.get("is_undergrnd") in (1, True, "yes", "1"):
                        p["name"] = f"{p.get('name') or ''} (underground)".strip()
                feats.append({"geom": project_parts(k, parts), "props": p})
    if WKB_SKIPPED["collections"] > skipped0:
        print(f"warning: {layer}: skipped {WKB_SKIPPED['collections'] - skipped0} GeometryCollection feature(s)", file=sys.stderr)
    return feats, mib


def main(argv):
    if len(argv) != 2:
        print(__doc__.split("\n\n")[0])
        return 2
    src = Path(argv[1])
    ll = route_coords(json.loads(src.read_text()))
    layers, mib, secs = {}, {}, {}
    for layer in PARQUET:
        t0 = time.time()
        try:
            layers[layer], mib[layer] = _read_parquet(layer, ll)
        except FileNotFoundError as e:
            print(f"[{layer}] input missing: {e}", file=sys.stderr)
        secs[layer] = time.time() - t0
    t0 = time.time()
    rep = analyse(ll, layers)
    t_an = time.time() - t0
    rep["read_mib"] = {k: round(v, 3) for k, v in mib.items()}
    print(format_table(rep, mib))
    jp, cp = write_outputs(rep, src)
    print("\nMiB read per layer (compressed bytes of the row groups touched):")
    for k in mib:
        print(f"  {k:<10} {mib[k]:8.2f} MiB  read+decode {secs[k]:6.1f} s  features {len(layers[k])}")
    print(f"total {sum(mib.values()):.1f} MiB; read {sum(secs.values()):.1f} s; analyse {t_an:.1f} s")
    print(f"wrote {jp} and {cp}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
