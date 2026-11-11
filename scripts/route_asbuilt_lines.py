#!/usr/bin/env python3
"""As-built line set for the routing review (E1).

Role: step 1 (`--check-presence`) looks for each candidate line of local/reviews/route-review/R2.json in
the frozen HIFLD copy (data/build/transmission_hifld.gpkg, data/build/substation_hifld.csv): in-service
segments at the line's kV, joined end to end, from a substation within 1.5 km of one end to a substation
within 1.5 km of the other. R2's endpoint coordinates are approximate (place names), so end substations are
searched within SEARCH_KM of them and refined from the substation data. A line with no such chain is
dropped with its reason; nothing is approximated.
Writes local/reviews/route-review/E1-presence.json.
Step 2 (no flag) routes each kept line between the ends of its matched chain and builds, for the E set and the
300 holdout lines, the neutralisers: N1 = the cube's own `adj` cells in the target line's class (bits 0-1 for
>= 230 kV, bits 5-6 below) with class 1-2 within 3 cells (Chebyshev) of a cell the reference passes through (D1);
N2 = N1 on `protect` GAP 3 (D3). Writes assets/route/fixtures/asbuilt-lines.json (tracked: per-feature sha256,
counts, checks) and data/build/route/validate/asbuilt-lines.geojson (lines, N1, N2; WGS84).
Checks printed: (a) every N1 cell has adj class 1-2 (cells recovered from the written polygon, not from the
builder); (b) share of the reference's 250 m samples whose cell is in N1 (>= 0.9, else the line is dropped from
the evidence set); (c) per line N1, N1 > 1 km from the reference, N2, N2 leak bound, over-neutralised cells.
`--mutate shift|hifld-burn` plant the two faults the checks must catch (nothing is written).
All lengths are metres in EPSG:5070. HIFLD is frozen: files are read, never fetched.
Deps: numpy, shapely >= 2, pyproj, geopandas (venv); scripts/route_holdout_lines.py (chain assembly, projection).
Run: systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 venv/bin/python scripts/route_asbuilt_lines.py --check-presence
"""
import hashlib
import heapq
import json
import sys
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402
import route_holdout_lines as H  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
R2_JSON = ROOT / "local/reviews/route-review/R2.json"
OUT_JSON = ROOT / "local/reviews/route-review/E1-presence.json"

END_SUB_M = 1500.0
JOIN_M = 100.0          # segment ends closer than this are one node
SEARCH_KM = 30.0        # end substations are searched this far from R2's approximate end
KV_TOL = 0.08           # segment VOLTAGE within this share of the line's kV
LEN_BAND = (0.5, 1.6)   # chain length / R2's length
MI_KM = 1.609344
STATUS_OK = ("IN SERVICE", "NOT AVAILABLE")  # unknown status is not evidence of an outage; reported per match


def edges_of(rows):
    """rows: {id, voltage, status, owner, sub1, sub2, geom (4326)} -> edges {id, kv, a, b (EPSG:5070 xy), len, geom5070}."""
    out = []
    for r in rows:
        g = r["geom"]
        if g is None or g.is_empty:
            continue
        parts = [g] if isinstance(g, LineString) else list(linemerge(g).geoms) if isinstance(linemerge(g), MultiLineString) else [linemerge(g)]
        for p in parts:
            if not isinstance(p, LineString) or len(p.coords) < 2:
                continue
            l5 = H.to5070(p)
            c = list(l5.coords)
            out.append({"id": str(r["id"]), "kv": r["voltage"], "status": r.get("status"), "owner": r.get("owner"),
                        "sub1": r.get("sub1"), "sub2": r.get("sub2"), "a": c[0], "b": c[-1], "len": l5.length, "line": l5})
    return out


def nodes_of(edges):
    """Union-find the segment ends within JOIN_M. Returns node index per edge end: (na[i], nb[i]), and node xy list."""
    pts = np.array([e["a"] for e in edges] + [e["b"] for e in edges])
    n = len(edges)
    tree = STRtree(shapely.points(pts))
    parent = list(range(len(pts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    a, b = tree.query(shapely.points(pts), predicate="dwithin", distance=JOIN_M)
    for i, j in zip(a, b):
        ri, rj = find(int(i)), find(int(j))
        if ri != rj:
            parent[ri] = rj
    roots = {}
    ids = [roots.setdefault(find(i), len(roots)) for i in range(len(pts))]
    xy = np.zeros((len(roots), 2))
    cnt = np.zeros(len(roots))
    for i, k in enumerate(ids):
        xy[k] += pts[i]
        cnt[k] += 1
    return ids[:n], ids[n:], xy / cnt[:, None]


def shortest(edges, na, nb, sources, targets, want_m):
    """Dijkstra from every source node; of the targets reached, the chain whose length is closest to want_m inside
    LEN_BAND. Returns (length, [edge index]) or None."""
    adj = {}
    for i, (u, v) in enumerate(zip(na, nb)):
        if u == v:
            continue
        adj.setdefault(u, []).append((v, edges[i]["len"], i))
        adj.setdefault(v, []).append((u, edges[i]["len"], i))
    best = None
    for s in sources:
        dist, prev = {s: 0.0}, {}
        pq = [(0.0, s)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, 1e18) or d > want_m * LEN_BAND[1]:
                continue
            for v, w, i in adj.get(u, ()):
                nd = d + w
                if nd < dist.get(v, 1e18):
                    dist[v], prev[v] = nd, (u, i)
                    heapq.heappush(pq, (nd, v))
        for t in targets:
            if t == s or t not in dist or not (want_m * LEN_BAND[0] <= dist[t] <= want_m * LEN_BAND[1]):
                continue
            score = abs(dist[t] - want_m)
            if best is None or score < best[0]:
                path, u = [], t
                while u != s:
                    u, i = prev[u]
                    path.append(i)
                best = (score, dist[t], path[::-1], s, t)
    return None if best is None else best[1:]


def near_subs(sub_xy, sub_ok, pt, radius):
    d = np.hypot(sub_xy[:, 0] - pt[0], sub_xy[:, 1] - pt[1])
    return np.where(sub_ok & (d <= radius))[0], d


def check_line(ln, edges, na, nb, node_xy, sub_xy, sub_kv, sub_name):
    """One R2 line (kv, want_m, end_a/end_b with lat/lon) over its local edges -> result dict {present, reason, ...}."""
    kv, want = float(ln["kv"]), ln["want_m"]
    ends = [H._TO_5070.transform(ln[k]["lon"], ln[k]["lat"]) for k in ("end_a", "end_b")]
    ok = sub_kv >= kv * (1 - KV_TOL)
    sel = [i for i, e in enumerate(edges) if abs(e["kv"] - kv) <= kv * KV_TOL and str(e["status"]).strip().upper() in STATUS_OK]
    if not sel:
        return {"present": False, "reason": "no segment at this kV (in service or status unknown) near the line"}
    sub_edges = [edges[i] for i in sel]
    sna, snb = [na[i] for i in sel], [nb[i] for i in sel]
    nodes = sorted(set(sna) | set(snb))
    sets = []
    for end in ends:
        cand = np.where(ok & (np.hypot(sub_xy[:, 0] - end[0], sub_xy[:, 1] - end[1]) <= SEARCH_KM * 1000))[0]
        ns = set()
        if len(cand):
            t = STRtree(shapely.points(sub_xy[cand]))
            for n in nodes:
                if np.hypot(*(node_xy[n] - end)) <= SEARCH_KM * 1000 and len(t.query(shapely.points(node_xy[n]), predicate="dwithin", distance=END_SUB_M)):
                    ns.add(n)
        sets.append(ns)
    for name, ns in zip("AB", sets):
        if not ns:
            return {"present": False, "reason": f"no segment end at this kV within {END_SUB_M:g} m of a substation near end {name} (search {SEARCH_KM:g} km)"}
    r = shortest(sub_edges, sna, snb, sets[0], sets[1], want)
    if r is None:
        return {"present": False, "reason": f"no chain of segments at this kV between the two end groups, length {LEN_BAND[0]}-{LEN_BAND[1]} x {want/1000:.0f} km"}
    length, path, s, t = r
    es = [sub_edges[i] for i in path]
    coords, cur = [], s
    for i in path:
        c = list(sub_edges[i]["line"].coords)
        if sna[i] != cur:
            c = c[::-1]
        coords += c if not coords else c[1:]
        cur = snb[i] if sna[i] == cur else sna[i]
    res = {"_chain5070": coords, "present": True, "chain_km": round(length / 1000, 1), "r2_km": round(want / 1000, 1), "segments": len(es),
           "hifld_ids": [e["id"] for e in es], "kv": sorted({e["kv"] for e in es}),
           "owners": sorted({str(e["owner"]) for e in es}), "statuses": sorted({str(e["status"]) for e in es}), "sub_labels": sorted({str(x) for e in es for x in (e["sub1"], e["sub2"])}), "ends": []}
    for n in (s, t):
        d = np.hypot(sub_xy[:, 0] - node_xy[n][0], sub_xy[:, 1] - node_xy[n][1])
        j = int(np.argmin(np.where(ok, d, 1e18)))
        res["ends"].append({"substation_name": sub_name[j], "substation_dist_m": round(float(d[j])),
                            "substation_max_kv": float(sub_kv[j]),
                            "from_r2_end_km": [round(float(np.hypot(*(node_xy[n] - e))) / 1000, 1) for e in ends]})
    return res


def load_all():
    import pandas as pd
    import geopandas as gpd
    g = gpd.read_file(H.LINES_GPKG)
    kv = pd.to_numeric(g["VOLTAGE"], errors="coerce")
    kv = kv.where(kv > 0)
    rows = [{"id": i, "voltage": float(v), "status": s, "owner": o, "sub1": s1, "sub2": s2, "geom": ge}
            for i, v, s, o, s1, s2, ge in zip(g["ID"], kv, g["STATUS"], g["OWNER"], g["SUB_1"], g["SUB_2"], g.geometry)
            if not pd.isna(v)]
    s = pd.read_csv(H.SUBS_CSV, usecols=["lat", "lon", "name", "max_kv"]).dropna(subset=["lat", "lon"])
    x, y = H._TO_5070.transform(s["lon"].to_numpy(), s["lat"].to_numpy())
    return rows, np.column_stack([x, y]), s["max_kv"].fillna(0).to_numpy(float), s["name"].fillna("").astype(str).tolist()


# R2's length_miles_source is free text; these are its figures (miles), the whole line where it gives several
R2_MILES = {"sunrise-powerlink": 117, "ten-west-link": 125, "mona-oquirrh": 100, "pawnee-daniels-park": 125,
            "harry-allen-eldorado": 60, "v-plan": 122, "prairie-wind": 108, "hitchland-woodward": 130,
            "crez-clear-crossing-dermott": 90.1, "crez-edith-clarke-cottonwood": 88.4,
            "crez-edith-clarke-clear-crossing": 79.2, "cardinal-hickory-creek": 102, "big-stone-south-brookings": 70,
            "bemidji-grand-rapids": 70, "greentown-reynolds": 70, "thomson-vogtle": 55}


def main():
    chains = {}
    rows, sub_xy, sub_kv, sub_name = load_all()
    lines = json.loads(R2_JSON.read_text())["lines"]
    results = {}
    for ln in lines:
        kv = float(ln["kv"])
        ln["want_m"] = R2_MILES[ln["id"]] * MI_KM * 1000
        pts = [(ln[k]["lon"], ln[k]["lat"]) for k in ("end_a", "end_b")]
        pad = (ln["want_m"] + SEARCH_KM * 1000) / 70000.0
        x0, x1 = min(p[0] for p in pts) - pad, max(p[0] for p in pts) + pad
        y0, y1 = min(p[1] for p in pts) - pad, max(p[1] for p in pts) + pad
        near = [r for r in rows if abs(r["voltage"] - kv) <= kv * KV_TOL and r["geom"] is not None and not r["geom"].is_empty
                and r["geom"].bounds[0] <= x1 and r["geom"].bounds[2] >= x0 and r["geom"].bounds[1] <= y1 and r["geom"].bounds[3] >= y0]
        edges = edges_of(near)
        res = {"name": ln["name"], "kv": kv, "in_service_year": ln["in_service_year"], "segments_in_window": len(edges)}
        if edges:
            na, nb, node_xy = nodes_of(edges)
            res.update(check_line(ln, edges, na, nb, node_xy, sub_xy, sub_kv, sub_name))
        else:
            res.update(present=False, reason="no segment at this kV in the search window")
        results[ln["id"]] = res
        res.pop("_chain5070", None) if "--check-presence" in sys.argv else chains.__setitem__(ln["id"], res.pop("_chain5070", None))
        print(ln["id"], "PRESENT" if res["present"] else "ABSENT", res.get("reason", ""),
              res.get("hifld_ids", ""), res.get("chain_km", ""), flush=True)
    if "--check-presence" not in sys.argv:
        return step2(results, chains, rows, sub_xy, sub_kv, sub_name)
    OUT_JSON.write_text(json.dumps(results, indent=1, sort_keys=True) + "\n")
    kept = [k for k, v in results.items() if v["present"]]
    print(f"kept {len(kept)} of {len(results)}: {kept}")


# ---------------------------------------------------------------- step 2

FIXTURE = ROOT / "assets/route/fixtures/asbuilt-lines.json"
GEO_OUT = ROOT / "data/build/route/validate/asbuilt-lines.geojson"
HOLDOUT_FX = ROOT / "assets/route/fixtures/holdout-lines.json"
HOLDOUT_GEO = ROOT / "data/build/route/validate/holdout-lines.geojson"
CUBE = ROOT / "data/build/route/250m"
N1_REACH = 3            # Chebyshev cells (D1)
N1_SHARE_MIN = 0.9      # check (b)
FAR_M = 1000.0
OTHER_LINE_M = 400.0    # a cell this near another same-class line also gets its adj discount
SHIFT_M = 2000.0
MAX_PARTS, MAX_POSITIONS = 5000, 250_000
SEGMENTIZE_M = 2000.0   # keeps long straight polygon edges on the 250 m grid after the round trip through lon/lat
GAP_MASK, GAP3 = 0b111, 3
SEC368_BIT = 4
E_NOTES = {"ten-west-link": "may include pre-existing segments"}


def class_shift(kv):
    """adj bits of the target line's own class: >= 230 kV bits 0-1, 100-229 kV bits 5-6."""
    return 0 if kv >= 230 else G.ADJ100_SHIFT


def cell_of(x, y):
    return (np.floor((G.Y0 - np.asarray(y)) / G.CELL).astype(np.int64), np.floor((np.asarray(x) - G.X0) / G.CELL).astype(np.int64))


def centre_of(r, c):
    return G.X0 + (np.asarray(c) + 0.5) * G.CELL, G.Y0 - (np.asarray(r) + 0.5) * G.CELL


def ref_cells(l5, shift=(0.0, 0.0)):
    """Cells the line passes through (sampled every 50 m, ends included), as a set of (row, col)."""
    n = max(1, int(np.ceil(l5.length / 50.0)))
    pts = shapely.get_coordinates(shapely.line_interpolate_point(l5, np.append(np.arange(n) * 50.0, l5.length)))
    r, c = cell_of(pts[:, 0] + shift[0], pts[:, 1] + shift[1])
    return set(zip(r.tolist(), c.tolist()))


def dilate(cells, k):
    return {(r + dr, c + dc) for r, c in cells for dr in range(-k, k + 1) for dc in range(-k, k + 1)}


def build_n1(adj, cells, kv, mutate):
    """N1: cells within N1_REACH of the reference whose adj class (target class) is 1 or 2."""
    if mutate == "hifld-burn":
        return dilate(cells, 2)
    shift = class_shift(kv)
    cand = np.array(sorted(dilate(cells, N1_REACH)), dtype=np.int64)
    ok = (cand[:, 0] >= 0) & (cand[:, 0] < G.ROWS) & (cand[:, 1] >= 0) & (cand[:, 1] < G.COLS)
    cand = cand[ok]
    v = adj[cand[:, 0], cand[:, 1]]
    cls = (v >> shift) & G.ADJ_CLASS_MASK
    keep = ((v & G.ADJ_COMPUTED_BIT) != 0) & ((cls == 1) | (cls == 2))
    return set(map(tuple, cand[keep].tolist()))


def cells_polygon(cells):
    """Union of the cell squares as a shapely geometry in WGS84 (vertices kept every SEGMENTIZE_M)."""
    if not cells:
        return None
    a = np.array(sorted(cells), dtype=np.int64)
    x, y = centre_of(a[:, 0], a[:, 1])
    h = G.CELL / 2
    u = shapely.union_all(shapely.box(x - h, y - h, x + h, y + h))
    u = shapely.segmentize(u, SEGMENTIZE_M)
    inv = H.Transformer.from_crs("EPSG:5070", "EPSG:4326", always_xy=True)
    return shapely.transform(u, lambda co: np.column_stack(inv.transform(co[:, 0], co[:, 1])).round(6) if len(co) else co)


def polygon_cells(poly4326):
    """The cells whose centre is inside the written polygon (centre-inside rule of upload-layer.ts)."""
    if poly4326 is None:
        return set()
    p5 = shapely.transform(poly4326, lambda co: np.column_stack(H._TO_5070.transform(co[:, 0], co[:, 1])))
    x0, y0, x1, y1 = p5.bounds
    r0, c0 = cell_of(x0, y1)
    r1, c1 = cell_of(x1, y0)
    rr, cc = np.meshgrid(np.arange(r0, r1 + 1), np.arange(c0, c1 + 1), indexing="ij")
    rr, cc = rr.ravel(), cc.ravel()
    x, y = centre_of(rr, cc)
    inside = shapely.contains_xy(p5, x, y)
    return set(zip(rr[inside].tolist(), cc[inside].tolist()))


def count_parts_positions(poly):
    if poly is None:
        return 0, 0
    parts = list(poly.geoms) if hasattr(poly, "geoms") else [poly]
    pos = sum(len(p.exterior.coords) + sum(len(i.coords) for i in p.interiors) for p in parts)
    return len(parts), pos


def coords_json(geom):
    return json.dumps(shapely.geometry.mapping(geom)["coordinates"], separators=(",", ":"))


def sha(t):
    return hashlib.sha256(t.encode()).hexdigest()


def class_lines(rows, lo, hi):
    """Projected HIFLD lines with voltage in [lo, hi): (STRtree, id array)."""
    sel = [r for r in rows if lo <= r["voltage"] < hi and r["geom"] is not None and not r["geom"].is_empty]
    g = shapely.transform(np.array([r["geom"] for r in sel], dtype=object),
                          lambda co: np.column_stack(H._TO_5070.transform(co[:, 0], co[:, 1])))
    return STRtree(g), np.array([str(r["id"]) for r in sel])


def over_other(tree, ids, own, x, y):
    """How many of the cell centres are within OTHER_LINE_M of a same-class line that is not the target's own."""
    q, t = tree.query(shapely.points(x, y), predicate="dwithin", distance=OTHER_LINE_M)
    hit = np.unique(q[~np.isin(ids[t], list(own))])
    return set(hit.tolist())


def analyse(item, arrs, trees, mutate):
    """item: {id, kv, own (ids), l5}. Returns the stats dict and the geometry (n1, n2 polygons in WGS84)."""
    adj, prot, desig, flags = arrs
    kv, l5 = item["kv"], item["l5"]
    true_cells = ref_cells(l5)
    shift = (SHIFT_M, 0.0) if mutate == "shift" else (0.0, 0.0)
    n1 = build_n1(adj, ref_cells(l5, shift), kv, mutate)
    n1_poly = cells_polygon(n1)
    rec = polygon_cells(n1_poly)                       # cells the polygon really hits, independent of the builder
    arr = np.array(sorted(rec), dtype=np.int64).reshape(-1, 2)
    sh = class_shift(kv)
    v = adj[arr[:, 0], arr[:, 1]] if len(arr) else np.zeros(0, np.uint8)
    cls = (v >> sh) & G.ADJ_CLASS_MASK
    bad = int((~(((v & G.ADJ_COMPUTED_BIT) != 0) & ((cls == 1) | (cls == 2)))).sum()) + len(rec ^ n1)
    sp = shapely.get_coordinates(H.samples(l5))
    sr, sc = cell_of(sp[:, 0], sp[:, 1])
    share = float(np.mean([(int(a), int(b)) in rec for a, b in zip(sr, sc)]))
    x, y = centre_of(arr[:, 0], arr[:, 1]) if len(arr) else (np.zeros(0), np.zeros(0))
    far = int((shapely.distance(shapely.points(x, y), l5) > FAR_M).sum()) if len(arr) else 0
    g = prot[arr[:, 0], arr[:, 1]] if len(arr) else np.zeros(0, np.uint8)
    m2 = (g & GAP_MASK) == GAP3
    n2 = set(map(tuple, arr[m2].tolist()))
    leak = int((desig[arr[m2, 0], arr[m2, 1]] != 0).sum()) if len(arr) else 0
    f368 = ((flags[arr[:, 0], arr[:, 1]] >> SEC368_BIT) & 1).astype(bool) if len(arr) else np.zeros(0, bool)
    tree, ids = trees[0 if kv >= 230 else 1]
    oth = over_other(tree, ids, item["own"], x, y) if len(arr) else set()
    over = set(np.nonzero(f368)[0].tolist()) | oth
    n1p, n1pos = count_parts_positions(n1_poly)
    n2_poly = cells_polygon(n2)
    n2p, n2pos = count_parts_positions(n2_poly)
    stats = {"n1Cells": len(rec), "n1CellsOver1km": far, "n2Cells": len(n2), "n2LeakBoundCells": leak,
             "overNeutralisedCells": len(over), "overOtherLineCells": len(oth), "overSection368Cells": int(f368.sum()),
             "refCells": len(true_cells), "refSampleShareInN1": round(share, 4), "aViolations": bad,
             "n1Parts": n1p, "n1Positions": n1pos, "n2Parts": n2p, "n2Positions": n2pos}
    return stats, n1_poly, n2_poly


def trim_to(chain, name_sub, sub_xy, sub_kv, sub_name, start_xy):
    """Ten West: cut the chain at the named 500 kV substation (within END_SUB_M of the chain), keeping the part
    away from start_xy. Returns the trimmed LineString or None."""
    from shapely.ops import substring
    ok = [i for i, n in enumerate(sub_name) if name_sub in n.upper() and sub_kv[i] >= 460]
    for i in ok:
        pt = shapely.Point(sub_xy[i])
        if chain.distance(pt) <= END_SUB_M:
            d = chain.project(pt)
            d0 = chain.project(shapely.Point(start_xy))
            return substring(chain, d, chain.length) if d0 < d else substring(chain, 0, d)
    return None


def step2(results, chains, rows, sub_xy, sub_kv, sub_name):
    import rasterio
    mutate = None
    if "--mutate" in sys.argv:
        mutate = sys.argv[sys.argv.index("--mutate") + 1]
        assert mutate in ("shift", "hifld-burn"), mutate
    r2 = {l["id"]: l for l in json.loads(R2_JSON.read_text())["lines"]}
    items, notes = [], []
    for k, v in results.items():
        if not v["present"]:
            notes.append({"id": k, "name": v["name"], "dropped": "absent from the frozen HIFLD copy: " + v["reason"]})
            continue
        chain = LineString(chains[k])
        flag = E_NOTES.get(k)
        ln = r2[k]
        if k == "ten-west-link":
            a = H._TO_5070.transform(ln["end_a"]["lon"], ln["end_a"]["lat"])
            c0 = chain.coords[0]
            if np.hypot(c0[0] - a[0], c0[1] - a[1]) > np.hypot(chain.coords[-1][0] - a[0], chain.coords[-1][1] - a[1]):
                chain = LineString(list(chain.coords)[::-1])
            t = trim_to(chain, "DELANEY", sub_xy, sub_kv, sub_name, chain.coords[0])
            if t is not None:
                chain, flag = t, "chain trimmed to start at the Delaney 500 kV substation"
        items.append({"id": k, "name": v["name"], "set": "E", "kv": float(ln["kv"]), "own": set(v["hifld_ids"]), "l5": chain,
                      "hifldIds": v["hifld_ids"], "chainKm": round(chain.length / 1000, 1), "r2Km": v["r2_km"],
                      "owners": v["owners"], "statuses": v["statuses"], "note": flag})
    hx = json.loads(HOLDOUT_FX.read_text())
    if HOLDOUT_GEO.exists():
        geo_text = HOLDOUT_GEO.read_text()
    else:  # rebuilt in memory by the holdout script's own code, then held to the tracked fixture's hashes
        hrows, known = H.load_rows()
        res = H.build(hrows, H.load_subs(), H.built_sampler(), known)
        _, geo_text = H.outputs(res, known)
        del hrows, res
    assert hashlib.sha256(geo_text.encode()).hexdigest() == hx["geometrySha256"], "holdout geometry differs from the fixture"
    hg = {f["properties"]["id"]: f for f in json.loads(geo_text)["features"]}
    for l in hx["lines"]:
        co = hg[l["id"]]["geometry"]["coordinates"]
        items.append({"id": l["id"], "set": l["split"], "kv": l["voltage"], "own": {l["id"]},
                      "l5": H.to5070(LineString(co)), "chainKm": l["lengthKm"]})
    print(f"{len(items)} lines ({sum(i['set'] == 'E' for i in items)} E)", flush=True)
    arrs = []
    for n in ("adj", "protect", "desig", "flags"):
        with rasterio.open(CUBE / f"{n}.tif") as r:
            assert (r.width, r.height) == (G.COLS, G.ROWS)
            arrs.append(r.read(1))
    trees = [class_lines(rows, 230, 1e9), class_lines(rows, 100, 230)]
    out, feats, fails = [], [], []
    for it in items:
        st, p1, p2 = analyse(it, arrs, trees, mutate)
        reasons = []
        if st["aViolations"]:
            reasons.append(f"(a) {st['aViolations']} N1 cells without adj class 1-2")
        if st["refSampleShareInN1"] < N1_SHARE_MIN:
            reasons.append(f"(b) {st['refSampleShareInN1']:.2f} of reference samples in N1")
        if st["n1Parts"] > MAX_PARTS or st["n1Positions"] > MAX_POSITIONS or st["n2Parts"] > MAX_PARTS or st["n2Positions"] > MAX_POSITIONS:
            reasons.append("polygon over the upload caps")
        if not st["n1Cells"]:
            reasons.append("N1 empty")
        co = round_ll(it["l5"])
        rec = {"id": it["id"], "set": it["set"], "voltage": it["kv"], "lineType": H.line_type_of(it["kv"]),
               "targetClassBits": "0-1" if it["kv"] >= 230 else "5-6", "lengthKm": it["chainKm"],
               "ends": [co[0], co[-1]], "geometrySha256": sha(json.dumps(co, separators=(",", ":"))),
               "n1Sha256": sha(coords_json(p1)) if p1 is not None else None,
               "n2Sha256": sha(coords_json(p2)) if p2 is not None else None,
               "evidence": not reasons, "dropReasons": reasons, **st}
        for k in ("name", "hifldIds", "r2Km", "owners", "statuses", "note"):
            if k in it:
                rec[k] = it[k]
        out.append(rec)
        for kind, g in (("line", LineString(co)), ("n1", p1), ("n2", p2)):
            if g is not None:
                feats.append({"type": "Feature", "properties": {"id": it["id"], "kind": kind, "set": it["set"]},
                              "geometry": shapely.geometry.mapping(g)})
        if reasons:
            fails.append((it["id"], it["set"], reasons))
    print_checks(out, fails, mutate)
    nb = sum(1 for o in out if o["aViolations"])
    nbf = sum(1 for o in out if o["refSampleShareInN1"] < N1_SHARE_MIN)
    caught = nb > 0 or nbf > 0.1 * len(out)
    if mutate:
        print(f"MUTATION {mutate}: (a) failing lines {nb}, (b) failing lines {nbf} of {len(out)}: " + ("CAUGHT" if caught else "NOT CAUGHT"))
        sys.exit(1 if caught else 0)   # a caught mutation fails the check, as the plan requires
    if nb:
        sys.exit("check (a) violated")
    geo = json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"), sort_keys=True) + "\n"
    GEO_OUT.parent.mkdir(parents=True, exist_ok=True)
    GEO_OUT.write_text(geo)
    fx = {"set": "asbuilt-lines", "source": hx["source"], "licence": hx["licence"],
          "rules": {"n1ReachCells": N1_REACH, "n1ShareMin": N1_SHARE_MIN, "farM": FAR_M, "otherLineM": OTHER_LINE_M,
                    "uploadMaxParts": MAX_PARTS, "uploadMaxPositions": MAX_POSITIONS, "crs": "EPSG:5070",
                    "classBits": {">=230": "0-1", "100-229": "5-6"}},
          "geometryFile": "data/build/route/validate/asbuilt-lines.geojson", "geometrySha256": hashlib.sha256(geo.encode()).hexdigest(),
          "notes": notes, "lines": out}
    FIXTURE.write_text(json.dumps(fx, indent=1, sort_keys=True) + "\n")
    print("wrote", FIXTURE, GEO_OUT)


def round_ll(l5):
    inv = H.Transformer.from_crs("EPSG:5070", "EPSG:4326", always_xy=True)
    return [[round(a, 6), round(b, 6)] for a, b in zip(*inv.transform(*zip(*l5.coords)))]


def print_checks(out, fails, mutate):
    tot = lambda k, s: sum(o[k] for o in out if o["set"] in s)
    print(f"(a) N1 cells without adj class 1-2: {sum(o['aViolations'] for o in out)} violations over {len(out)} lines")
    low = [o for o in out if o["refSampleShareInN1"] < N1_SHARE_MIN]
    print(f"(b) reference samples in N1 below {N1_SHARE_MIN}: {len(low)} lines: " + ", ".join(f"{o['id']}={o['refSampleShareInN1']}" for o in low[:40]))
    print("(c) id set n1 n1>1km n2 n2leak over(other,368) share")
    for o in out:
        if o["set"] == "E" or mutate is None and o["id"] in {f[0] for f in fails}:
            print(f"  {o['id']} {o['set']} {o['n1Cells']} {o['n1CellsOver1km']} {o['n2Cells']} {o['n2LeakBoundCells']} "
                  f"{o['overNeutralisedCells']}({o['overOtherLineCells']},{o['overSection368Cells']}) {o['refSampleShareInN1']}")
    for s in ({"E"}, {"CAL", "HOLD"}):
        print(f"  totals {sorted(s)}: n1 {tot('n1Cells', s)} over1km {tot('n1CellsOver1km', s)} n2 {tot('n2Cells', s)} "
              f"leak {tot('n2LeakBoundCells', s)} over {tot('overNeutralisedCells', s)}")
    print("dropped from the evidence set:", [(i, s, r) for i, s, r in fails])


if __name__ == "__main__":
    main()
