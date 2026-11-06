#!/usr/bin/env python3
"""Built-line reference set for the routing sensitivity report.

Role: reads the HIFLD transmission-line intermediate (data/build/transmission_hifld.gpkg), the HIFLD
substation intermediate (data/build/substation_hifld.csv), the raw line parquet (VAL_METHOD only) and
the cube's 250 m `built` band (data/build/route/250m/built.tif), keeps in-service overhead AC lines
that were digitised from imagery, assembles each into one chain, puts parallel lines in corridor
groups, draws one line per group, stratifies (4 regions x 3 building-density terciles) and writes
  assets/route/fixtures/holdout-lines.json (tracked: ids, group, split, ends, voltage, line type,
  region, tercile, per-line geometry sha256, frozen counts and id-list sha256),
  data/build/route/validate/holdout-lines.geojson (geometry), data/build/route/validate/F2L.md (drop counts).
Split CAL/HOLD is by the parity of the first hex digit of sha256(group id), never by line id.
All lengths and distances are metres in EPSG:5070. HIFLD is frozen: files are read, never fetched.
Deps: numpy, shapely >= 2, pyproj, geopandas, rasterio (venv); scripts/route_grid.py (grid constants).
Run: systemd-run --user --scope -q -p MemoryMax=20G -p MemorySwapMax=0 venv/bin/python scripts/route_holdout_lines.py
"""
import bisect
import collections
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge, transform as shp_transform
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LINES_GPKG = ROOT / "data/build/transmission_hifld.gpkg"
SUBS_CSV = ROOT / "data/build/substation_hifld.csv"
RAW_FILE = ROOT / "data/raw/hifld/transmission_lines.parquet"  # extract_hifld_lines.py RAW_FILE
BUILT_TIF = ROOT / "data/build/route/250m/built.tif"
OUT_JSON = ROOT / "assets/route/fixtures/holdout-lines.json"
OUT_GEO = ROOT / "data/build/route/validate/holdout-lines.geojson"
OUT_MD = ROOT / "data/build/route/validate/F2L.md"

SEED = "F2L-v1"
KV_MIN, KV_MAX = 115, 500
LEN_MIN_KM, LEN_MAX_KM = 10.0, 80.0
END_SUB_M = 1000.0
MIN_VERTS_PER_KM = 0.5
MIN_SINUOSITY = 1.005
SAMPLE_M = 250.0
GROUP_M = 1000.0
GROUP_SHARE = 0.5
PER_STRATUM = 25
# BV_LINES classes (src/registry/route-presets.ts) by nominal kV
LINE_CLASSES = [(115, "ac115"), (138, "ac138"), (161, "ac161"), (230, "ac230"), (345, "ac345"), (500, "ac500")]
WEST = "WA OR CA ID NV MT WY UT CO AZ NM".split()
CENTRAL = "ND SD NE KS OK MN IA MO AR LA WI IL MI IN OH".split()
EAST = "ME NH VT MA RI CT NY NJ PA DE MD DC VA WV NC SC GA FL KY TN AL MS".split()
REGION_OF_STATE = {**{s: "West" for s in WEST}, "TX": "Texas",
                   **{s: "Central" for s in CENTRAL}, **{s: "East" for s in EAST}}
REGIONS = ["West", "Texas", "Central", "East"]
SOURCE = "HIFLD Electric Power Transmission Lines (DHS CISA / ORNL) via SeerAI on source.coop"
LICENCE = "Public domain (US federal work); SeerAI redistribution CC BY 4.0, credit SeerAI and source.coop"

RULES = [  # (key, text) in application order
    ("status", "STATUS not IN SERVICE"),
    ("type", 'TYPE does not contain "OVERHEAD" and start with "AC"'),
    ("voltage_missing", "VOLTAGE missing (-999999 sentinel or blank)"),
    ("voltage_range", f"VOLTAGE outside {KV_MIN}-{KV_MAX} kV"),
    ("val_method", "VAL_METHOD does not contain IMAGERY"),
    ("not_one_chain", "geometry empty or not one open assembled chain"),
    ("length", f"chain length outside {LEN_MIN_KM:g}-{LEN_MAX_KM:g} km"),
    ("end_substation", f"an end vertex farther than {END_SUB_M:g} m from every HIFLD substation"),
    ("sparse", "fewer vertices than length_km / 2"),
    ("straight", f"length / chord < {MIN_SINUOSITY}"),
    ("region", "states tag names no region of the 4, or more than one"),
    ("no_built", "no observed `built` cell along the straight A-B"),
]

_TO_5070 = Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True)


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def to5070(geom):
    return shp_transform(_TO_5070.transform, geom)


def split_of(group_id):
    """CAL when the first hex digit of sha256(group id) is even, HOLD when odd."""
    return "CAL" if int(sha(str(group_id))[0], 16) % 2 == 0 else "HOLD"


def line_type_of(kv):
    best = None
    for k, name in LINE_CLASSES:
        if kv >= k:
            best = name
    return best


def region_of(states):
    """states: '|TX|NM|' tag or iterable of codes -> region name, or None (none or several)."""
    codes = [s for s in (states.split("|") if isinstance(states, str) else states) if s]
    regs = {REGION_OF_STATE[s] for s in codes if s in REGION_OF_STATE}
    return next(iter(regs)) if len(regs) == 1 else None


def assemble(geom):
    """One open LineString from the (multipart) geometry, or None."""
    if geom is None or geom.is_empty:
        return None
    line = geom if isinstance(geom, LineString) else linemerge(geom)
    if not isinstance(line, LineString) or line.is_empty or len(line.coords) < 2:
        return None
    c = list(line.coords)
    if c[0] == c[-1]:
        return None
    if (c[0][0], c[0][1]) > (c[-1][0], c[-1][1]):
        line = LineString(c[::-1])
    return line


def samples(line5070, step=SAMPLE_M):
    n = max(1, int(np.ceil(line5070.length / step)))
    d = np.append(np.arange(n) * step, line5070.length)
    return shapely.line_interpolate_point(line5070, d)


def filter_lines(rows, subs_xy, val_method_known):
    """rows: dicts {id, type, status, voltage, val_method, states, geom (EPSG:4326)}; subs_xy: (n,2) EPSG:5070.
    Returns (candidates, Counter of drops by rule key). A row is counted at the first rule it fails."""
    drops = collections.Counter()
    tree = None
    if len(subs_xy):
        tree = STRtree(shapely.points(subs_xy))
    cands = []
    for r in rows:
        t = (r.get("type") or "").upper()
        kv = r.get("voltage")
        if str(r.get("status") or "").strip().upper() != "IN SERVICE":
            drops["status"] += 1; continue
        if not ("OVERHEAD" in t and t.startswith("AC")):
            drops["type"] += 1; continue
        if kv is None or not np.isfinite(kv) or kv <= 0:
            drops["voltage_missing"] += 1; continue
        if not (KV_MIN <= kv <= KV_MAX):
            drops["voltage_range"] += 1; continue
        if val_method_known and "IMAGERY" not in str(r.get("val_method") or "").upper():
            drops["val_method"] += 1; continue
        line = assemble(r["geom"])
        if line is None:
            drops["not_one_chain"] += 1; continue
        l5 = to5070(line)
        km = l5.length / 1000.0
        if not (LEN_MIN_KM <= km <= LEN_MAX_KM):
            drops["length"] += 1; continue
        ends = shapely.points([l5.coords[0], l5.coords[-1]])
        ok = tree is not None and all(
            len(tree.query(e, predicate="dwithin", distance=END_SUB_M)) > 0 for e in ends)
        if not ok:
            drops["end_substation"] += 1; continue
        if len(l5.coords) < km * MIN_VERTS_PER_KM:
            drops["sparse"] += 1; continue
        chord = shapely.distance(ends[0], ends[1])
        if not (l5.length / chord >= MIN_SINUOSITY):
            drops["straight"] += 1; continue
        region = region_of(r.get("states", ""))
        if region is None:
            drops["region"] += 1; continue
        cands.append({"id": str(r["id"]), "kv": float(kv), "line": line, "l5": l5, "km": km,
                      "region": region, "samples": samples(l5)})
    return cands, drops


def group_lines(cands):
    """Corridor groups: >= 50 % of either line's samples within 1 km of the other (connected
    components). Returns {id: group id}; group id = lexicographically smallest member id."""
    parent = list(range(len(cands)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    tree = STRtree([c["l5"] for c in cands])
    for i, a in enumerate(cands):
        for j in tree.query(a["l5"], predicate="dwithin", distance=GROUP_M):
            j = int(j)
            if j <= i:
                continue
            b = cands[j]
            fa = np.mean(shapely.distance(a["samples"], b["l5"]) <= GROUP_M)
            fb = np.mean(shapely.distance(b["samples"], a["l5"]) <= GROUP_M)
            if fa >= GROUP_SHARE or fb >= GROUP_SHARE:
                parent[find(i)] = find(j)
    members = collections.defaultdict(list)
    for i, c in enumerate(cands):
        members[find(i)].append(c["id"])
    out = {}
    for ids in members.values():
        gid = min(ids)
        for i in ids:
            out[i] = gid
    return out


def draw_one_per_group(cands, groups):
    best = {}
    for c in cands:
        k = sha(f"{SEED}:draw:{c['id']}")
        g = groups[c["id"]]
        if g not in best or k < best[g][0]:
            best[g] = (k, c)
    return [best[g][1] for g in sorted(best)]


def density_of(c, built):
    """Mean observed building share along the straight A-B; None when no cell is observed."""
    a, b = c["l5"].coords[0], c["l5"].coords[-1]
    straight = LineString([a, b])
    pts = shapely.get_coordinates(samples(straight))
    codes = built(pts[:, 0], pts[:, 1])
    obs = codes[codes > 0]
    return None if len(obs) == 0 else float(np.mean((obs.astype(float) - 1.0) / 100.0))


def stratify(pool, per_stratum=PER_STRATUM):
    """pool: candidates with `density`. Terciles of the pool's density; up to per_stratum per
    region x tercile by seeded hash order. Returns (chosen, edges, counts, shortfall)."""
    dens = sorted(c["density"] for c in pool)
    edges = [float(np.quantile(dens, 1 / 3)), float(np.quantile(dens, 2 / 3))] if dens else [0.0, 0.0]
    strata = collections.defaultdict(list)
    for c in pool:
        c["tercile"] = bisect.bisect_left(edges, c["density"])  # ties go low
        strata[(c["region"], c["tercile"])].append(c)
    chosen, counts, short = [], {}, {}
    for r in REGIONS:
        for t in range(3):
            members = sorted(strata.get((r, t), []), key=lambda c: sha(f"{SEED}:sample:{c['group']}"))
            take = members[:per_stratum]
            chosen += take
            counts[f"{r}|{t}"] = len(take)
            if len(take) < per_stratum:
                short[f"{r}|{t}"] = per_stratum - len(take)
    return chosen, edges, counts, short


def round_coords(line, nd=6):
    return [[round(x, nd), round(y, nd)] for x, y in line.coords]


def build(rows, subs_xy, built, val_method_known, per_stratum=PER_STRATUM):
    cands, drops = filter_lines(rows, subs_xy, val_method_known)
    groups = group_lines(cands) if cands else {}
    for c in cands:
        c["group"] = groups[c["id"]]
        c["split"] = split_of(c["group"])
    pool = draw_one_per_group(cands, groups) if cands else []
    drawn_out = len(cands) - len(pool)
    keep = []
    for c in pool:
        d = density_of(c, built)
        if d is None:
            drops["no_built"] += 1
            continue
        c["density"] = d
        keep.append(c)
    chosen, edges, counts, short = stratify(keep, per_stratum)
    chosen.sort(key=lambda c: c["id"])
    lines = []
    for c in chosen:
        co = round_coords(c["line"])
        lines.append({
            "id": c["id"], "group": c["group"], "split": c["split"],
            "ends": [co[0], co[-1]], "voltage": c["kv"], "lineType": line_type_of(c["kv"]),
            "region": c["region"], "tercile": c["tercile"], "density": round(c["density"], 6),
            "lengthKm": round(c["km"], 3), "geometrySha256": sha(json.dumps(co, separators=(",", ":"))),
            "_coords": co})
    return {"lines": lines, "drops": drops, "candidates": cands, "grouped_out": drawn_out,
            "edges": edges, "counts": counts, "shortfall": short, "groups": len(set(groups.values()))}


def outputs(res, val_method_known):
    """(fixture dict, geojson text)."""
    feats = [{"type": "Feature", "properties": {"id": l["id"], "group": l["group"], "split": l["split"]},
              "geometry": {"type": "LineString", "coordinates": l["_coords"]}} for l in res["lines"]]
    geo = json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"), sort_keys=True) + "\n"
    lines = [{k: v for k, v in l.items() if k != "_coords"} for l in res["lines"]]
    ids = [l["id"] for l in lines]
    fx = {
        "set": "holdout-lines", "source": SOURCE, "licence": LICENCE, "seed": SEED,
        "rules": {"kv": [KV_MIN, KV_MAX], "lengthKm": [LEN_MIN_KM, LEN_MAX_KM], "endSubstationM": END_SUB_M,
                  "minVertsPerKm": MIN_VERTS_PER_KM, "minSinuosity": MIN_SINUOSITY, "groupM": GROUP_M,
                  "groupShare": GROUP_SHARE, "sampleM": SAMPLE_M, "valMethodApplied": bool(val_method_known),
                  "perStratum": PER_STRATUM, "crs": "EPSG:5070"},
        "geometryFile": "data/build/route/validate/holdout-lines.geojson",
        "geometrySha256": hashlib.sha256(geo.encode()).hexdigest(),
        "idListSha256": sha("\n".join(sorted(ids))),
        "densityEdges": [round(e, 6) for e in res["edges"]],
        "counts": {"total": len(lines), "strata": res["counts"], "shortfall": res["shortfall"],
                   "split": dict(collections.Counter(l["split"] for l in lines))},
        "lines": lines,
    }
    return fx, geo


def built_sampler():
    import rasterio
    with rasterio.open(BUILT_TIF) as r:
        assert (r.width, r.height) == (G.COLS, G.ROWS), (r.width, r.height)
        arr = r.read(1)

    def f(x, y):
        c = np.floor((np.asarray(x) - G.X0) / G.CELL).astype(np.int64)
        rw = np.floor((G.Y0 - np.asarray(y)) / G.CELL).astype(np.int64)
        ok = (c >= 0) & (c < G.COLS) & (rw >= 0) & (rw < G.ROWS)
        out = np.zeros(len(c), dtype=np.uint8)
        out[ok] = arr[rw[ok], c[ok]]
        return out
    return f


def load_rows():
    import geopandas as gpd
    import pandas as pd
    g = gpd.read_file(LINES_GPKG)
    vm = None
    if RAW_FILE.exists():
        raw = pd.read_parquet(RAW_FILE, columns=["ID", "VAL_METHOD"]) if _has_col(RAW_FILE, "VAL_METHOD") else None
        if raw is not None:
            vm = dict(zip(raw["ID"].astype(str), raw["VAL_METHOD"]))
    rows = []
    kv = pd.to_numeric(g["VOLTAGE"], errors="coerce")
    kv = kv.where(kv != -999999)  # sentinel -> NaN
    for i, (rid, t, s, st, geom) in enumerate(zip(g["ID"], g["TYPE"], g["STATUS"], g["states"], g.geometry)):
        rows.append({"id": rid, "type": t, "status": s, "voltage": None if pd.isna(kv.iloc[i]) else float(kv.iloc[i]),
                     "val_method": None if vm is None else vm.get(str(rid)), "states": st, "geom": geom})
    return rows, vm is not None


def _has_col(path, col):
    import pyarrow.parquet as pq
    return col in pq.read_schema(path).names


def load_subs():
    import pandas as pd
    s = pd.read_csv(SUBS_CSV, usecols=["lat", "lon"]).dropna()
    x, y = _TO_5070.transform(s["lon"].to_numpy(), s["lat"].to_numpy())
    return np.column_stack([x, y])


def main():
    rows, known = load_rows()
    res = build(rows, load_subs(), built_sampler(), known)
    fx, geo = outputs(res, known)
    OUT_JSON.write_text(json.dumps(fx, indent=1, sort_keys=True) + "\n")
    OUT_GEO.parent.mkdir(parents=True, exist_ok=True)
    OUT_GEO.write_text(geo)
    dr = res["drops"]
    md = [f"input rows {len(rows)}; kept after rules {len(res['candidates'])}; corridor groups {res['groups']}; "
          f"parallel members not drawn {res['grouped_out']}; sampled {fx['counts']['total']}",
          f"VAL_METHOD: {'applied (keep IMAGERY)' if known else 'VAL_METHOD not available'}",
          f"split counts {fx['counts']['split']}; shortfall {fx['counts']['shortfall'] or 'none'}",
          f"geometry sha256 {fx['geometrySha256']}; id-list sha256 {fx['idListSha256']}", "",
          "| rule | dropped |", "|---|---|"]
    md += [f"| {t} | {dr.get(k, 0)} |" for k, t in RULES]
    md += ["", "strata (region|tercile): " + json.dumps(fx["counts"]["strata"], sort_keys=True)]
    OUT_MD.write_text("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
