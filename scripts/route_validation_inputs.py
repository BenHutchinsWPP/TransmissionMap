#!/usr/bin/env python3
"""Route-optimizer validation inputs (PNAS corridors + WestTEC new-build lines).

Role: builds the GeoJSON files the routing validation (route.validate.test.ts, spurs.validate.test.ts) compares against.
  data/raw/route/validate/PowerLines_transmission.zip   (Zenodo 7460026, CC BY 4.0, Wu et al. 2022)
  data/raw/route/validate/PowerLines_spurs.zip          (same record, 66.8 MB: 12 230 kV spur shapefiles)
  data/raw/westtec/WestTEC 10yr Identified Upgrades.zip (the extract_westtec.py input)
    -> data/build/route/validate/pnas_corridors.geojson   27 HVAC corridors, HVDC $/mi attached
    -> data/build/route/validate/westtec_newbuild.geojson costed new-build identified lines
    -> data/build/route/validate/pnas_spurs.geojson       every onshore in-grid spur, one Point feature (CPA end) with
                                                          endpoints + attributes, no line geometry (~374k lines, ~220 MB)
    -> data/build/route/validate/pnas_spurs_sample.geojson ~200 spurs with full LineString geometry, stratified by
                                                          length decile x state (fixed seed)
Spurs: each shapefile is EPSG:5070 (the source "NAD_1983_Albers" is the same projection), fields PathCost (ArcGIS
accumulated cost-surface units, not dollars), CPA_ID, spurID, length (m = geometry length). No kV/cost field: all are
230 kV single circuit (SI Table S8). Direction: the first vertex is the CPA, the last the substation (the last
vertex sits on an existing >= 230 kV line cell; the first does not). Siting levels 1-3
are separate CPA sets (CPA_ID is renumbered per level). Offshore-wind spurs are dropped (sea endpoints).
Deps: geopandas, pyproj, shapely, numpy. Run: venv/bin/python scripts/route_validation_inputs.py
Rules: terminals (N = 2 + floor(max(0, L-400)/400) x $87.9M, 500 kV AC, 2018$);
M_backsolved = line-only $/mi / (3,278,535 x 1.175) (S5 base new 500 kV double circuit HVAC).
M_backsolved includes ROW/base: PNAS $/mi = (base*M + ROW land)*1.175 + terminals/L and our bands
carry no ROW land, so the quotient is M + ROW/base. row_over_base_range estimates ROW/base from
B&V 2014 Table 2-7 (~30.29 acres/mi for a 250 ft ROW; BLM zone land values $85-$3,414/acre).
WestTEC lines whose geometry length is outside 0.7-1.4 x the report length carry length_ratio_flag
and exclude_from_usd_compare (the matched geometry is not the costed line).
"""
import hashlib
import json
import math
import urllib.request
import zipfile
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid

import geopandas as gpd
import numpy as np
from shapely.geometry import Point
from shapely.ops import linemerge, unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data/raw/route/validate"
OUT = ROOT / "data/build/route/validate"
ZIP = RAW / "PowerLines_transmission.zip"
API = "https://zenodo.org/api/records/7460026"
SP_ZIP = RAW / "PowerLines_spurs.zip"
SP_SIZE = 66777841  # Zenodo 7460026 PowerLines_spurs.zip size and md5
SP_MD5 = "ce5ca7bd2d2ff74c4bb9ef7c442102af"
SP_SAMPLE_PER_DECILE = 20
SP_SEED = 20230123
CUBE = ROOT / "data/route/250m"
WT_ZIP = ROOT / "data/raw/westtec/WestTEC 10yr Identified Upgrades.zip"
WT_LAYER = "WestTEC 10yr Identified Upgrades.shp"
MI = 1609.344
TERMINAL_USD = 87.9e6
BASE_USD = 3_278_535
BASE_USD_MILE = BASE_USD * 1.175
ROW_ACRES_MI = 30.29  # B&V 2014 Table 2-7, 250 ft ROW
ROW_LAND_USD_ACRE = (85, 3414)  # BLM zone land values
ROW_OVER_BASE = [round(ROW_ACRES_MI * v / BASE_USD, 4) for v in ROW_LAND_USD_ACRE]
LEN_RATIO_OK = (0.7, 1.4)


RECORDED_SIZE = 421038  # Zenodo 7460026 file size and md5; a matching local zip skips the API
RECORDED_MD5 = "ba25c1c762ec7264d73425708ff27aca"


def fetch():
    RAW.mkdir(parents=True, exist_ok=True)
    if not (ZIP.exists() and ZIP.stat().st_size == RECORDED_SIZE):
        with urllib.request.urlopen(API, timeout=30) as resp:
            meta = json.load(resp)
        f = next(f for f in meta["files"] if f["key"] == ZIP.name)
        if not ZIP.exists():
            print(f"downloading {f['links']['self']}")
            urllib.request.urlretrieve(f["links"]["self"], ZIP)
        assert ZIP.stat().st_size == f["size"], "size mismatch"
        assert f["checksum"] == f"md5:{RECORDED_MD5}", "md5 mismatch"
    md5 = hashlib.md5(ZIP.read_bytes()).hexdigest()
    assert md5 == RECORDED_MD5, "md5 mismatch"
    print(f"{ZIP.name}: {ZIP.stat().st_size} bytes, md5 {md5} verified")
    dest = RAW / "extracted"
    if not dest.exists():
        zipfile.ZipFile(ZIP).extractall(dest)
    return next(dest.rglob("bulkTX_final_public.shp"))


def fetch_spurs():
    RAW.mkdir(parents=True, exist_ok=True)
    if not (SP_ZIP.exists() and SP_ZIP.stat().st_size == SP_SIZE):
        with urllib.request.urlopen(API, timeout=30) as resp:
            f = next(f for f in json.load(resp)["files"] if f["key"] == SP_ZIP.name)
        assert f["size"] == SP_SIZE and f["checksum"] == f"md5:{SP_MD5}", "recorded size/md5 differ from Zenodo"
        print(f"downloading {f['links']['self']}")
        urllib.request.urlretrieve(f["links"]["self"], SP_ZIP)
    md5 = hashlib.md5()
    with open(SP_ZIP, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            md5.update(chunk)
    assert md5.hexdigest() == SP_MD5, "md5 mismatch"
    print(f"{SP_ZIP.name}: {SP_ZIP.stat().st_size} bytes, md5 {SP_MD5} verified")
    dest = RAW / "spurs_x"
    if not dest.exists():
        zipfile.ZipFile(SP_ZIP).extractall(dest)
    return sorted(dest.rglob("spurs230_*.shp"))


def cube_state(xs, ys):
    """State FIPS (pd band 8) at EPSG:5070 points from the routing cube; 0 when the cube or tile is absent."""
    import rasterio
    out = np.zeros(len(xs), dtype=int)
    for f in sorted(CUBE.glob("pd_*.tif")):
        with rasterio.open(f) as r:
            b = r.bounds
            m = (xs >= b.left) & (xs < b.right) & (ys > b.bottom) & (ys <= b.top)
            if m.any():
                out[m] = [v[7] for v in r.sample(list(zip(xs[m], ys[m])))]
    return out


def spurs():
    import shapely
    from pyproj import Transformer
    files = fetch_spurs()
    to4326 = Transformer.from_crs("EPSG:5070", "EPSG:4326", always_xy=True)
    parts = []
    for shp in files:
        name = shp.name
        tech = "wind" if "_wind_" in name else "solar" if "_pv_" in name else "offshore_wind"
        lvl = int(name.split("SitingLevel")[1][0])
        zone = name.split(f"SitingLevel{lvl}_")[1][0] if tech == "solar" else ""
        g = gpd.read_file(shp)
        n_all = len(g)
        g = g[g.geometry.notna() & ~g.geometry.is_empty].copy()
        print(f"{name}: {n_all} features, {n_all - len(g)} null geometry, "
              f"fields {[c for c in g.columns if c != 'geometry']}, crs {g.crs.to_epsg()}")
        if tech == "offshore_wind":
            continue
        assert g.crs.to_epsg() == 5070 or "Albers" in g.crs.name
        g["geometry"] = [linemerge(x) if x.geom_type == "MultiLineString" else x for x in g.geometry]
        assert (g.geom_type == "LineString").all(), "multi-part spur after linemerge"
        g["tech"], g["siting_level"], g["pv_zone"] = tech, lvl, zone
        parts.append(g)
    g = gpd.GeoDataFrame(__import__("pandas").concat(parts, ignore_index=True), crs="EPSG:5070")
    a = shapely.line_interpolate_point(g.geometry.values, 0, normalized=True)
    b = shapely.line_interpolate_point(g.geometry.values, 1, normalized=True)
    ax, ay, bx, by = shapely.get_x(a), shapely.get_y(a), shapely.get_x(b), shapely.get_y(b)
    x0, y0 = route_grid.X0, route_grid.Y0
    x1, y1 = x0 + route_grid.CELL * route_grid.COLS, y0 - route_grid.CELL * route_grid.ROWS
    inside = ((ax > x0) & (ax < x1) & (ay < y0) & (ay > y1) & (bx > x0) & (bx < x1) & (by < y0) & (by > y1))
    print(f"onshore spurs {len(g)}; inside the routing grid {int(inside.sum())}")
    g = g[inside].reset_index(drop=True)
    ax, ay, bx, by = ax[inside], ay[inside], bx[inside], by[inside]
    alng, alat = to4326.transform(ax, ay)
    blng, blat = to4326.transform(bx, by)
    mi = g["length"].to_numpy() / MI
    chord = np.hypot(bx - ax, by - ay) / MI  # Albers metres; the grid-scale approximation is enough for the ratio
    g["id"] = [f"{t_}-L{l}{z}-{c}" for t_, l, z, c in zip(g["tech"], g["siting_level"], g["pv_zone"], g["CPA_ID"])]
    assert g["id"].is_unique
    df = gpd.GeoDataFrame({
        "id": g["id"], "tech": g["tech"], "siting_level": g["siting_level"], "pv_zone": g["pv_zone"],
        "cpa_id": g["CPA_ID"], "length_mi": np.round(mi, 3), "chord_mi": np.round(chord, 3),
        "detour_ratio": np.round(mi / np.maximum(chord, 1e-9), 4), "pnas_path_cost": g["PathCost"],
        "cpa_lnglat": [[round(float(x), 5), round(float(y), 5)] for x, y in zip(alng, alat)],
        "sub_lnglat": [[round(float(x), 5), round(float(y), 5)] for x, y in zip(blng, blat)],
        "voltage_kv": 230, "circuits": 1,
        "source": "Wu et al. 2023 PNAS 120(4) e2204098120; Zenodo 10.5281/zenodo.7460026 PowerLines_spurs.zip; CC BY 4.0",
        "geometry": gpd.points_from_xy(alng, alat)}, crs="EPSG:4326")
    df.to_file(OUT / "pnas_spurs.geojson", driver="GeoJSON")
    # stratified sample: a seeded pool, then SAMPLE_PER_DECILE per length decile spread round-robin over states
    rng = np.random.default_rng(SP_SEED)
    pool = rng.choice(len(g), size=min(len(g), 4000), replace=False)
    state = cube_state(ax[pool], ay[pool])
    dec = np.minimum(9, np.searchsorted(np.quantile(mi, np.linspace(0.1, 0.9, 9)), mi[pool], side="right"))
    pick = []
    for d in range(10):
        by_state = {}
        for i in np.flatnonzero((dec == d) & (state > 0)):
            by_state.setdefault(state[i], []).append(pool[i])
        queues = [by_state[k] for k in sorted(by_state)]
        chosen = []
        while len(chosen) < SP_SAMPLE_PER_DECILE and any(queues):
            for q in queues:
                if q and len(chosen) < SP_SAMPLE_PER_DECILE:
                    chosen.append(q.pop(0))
        pick += chosen
    sm = df.iloc[pick].copy()
    sm["length_decile"] = [int(dec[list(pool).index(i)]) + 1 for i in pick]
    sm["state_fips"] = [int(state[list(pool).index(i)]) for i in pick]
    sm["geometry"] = g.geometry.iloc[pick].to_crs("EPSG:4326").values
    sm.to_file(OUT / "pnas_spurs_sample.geojson", driver="GeoJSON")
    print("spurs by tech/level:\n", df.groupby(["tech", "siting_level"]).size().to_string())
    print("length_mi deciles:", np.round(np.quantile(mi, np.linspace(0, 1, 11)), 2).tolist())
    print(f"sample {len(sm)}; per decile {sm['length_decile'].value_counts().sort_index().tolist()}; "
          f"states {sorted(set(sm['state_fips']))}")


def ends(geom):
    """First/last vertex of a line; of the farthest-apart end pair when multi-part."""
    g = linemerge(geom) if geom.geom_type == "MultiLineString" else geom
    if g.geom_type == "LineString":
        return Point(g.coords[0]), Point(g.coords[-1])
    pts = [Point(c) for p in g.geoms for c in (p.coords[0], p.coords[-1])]
    return max(((a, b) for a in pts for b in pts), key=lambda ab: ab[0].distance(ab[1]))


def lnglat(p):
    return [round(p.x, 5), round(p.y, 5)]


def chord_mi(a, b):
    from pyproj import Geod
    return Geod(ellps="WGS84").inv(a.x, a.y, b.x, b.y)[2] / MI


def pnas():
    shp = fetch()
    g = gpd.read_file(shp)
    print("source CRS:", g.crs.name, "-> EPSG:4326 (from .prj)")
    g = g.to_crs("EPSG:4326")
    g5 = g.to_crs("EPSG:5070")
    g["len5070_mi"] = g5.length / MI
    new = g[g["type"].isin(["NEW 500kVd HVAC", "NEW 500kV HVDC"])]
    ac = new[new["type"] == "NEW 500kVd HVAC"].set_index("corridor")
    dc = new[new["type"] == "NEW 500kV HVDC"].set_index("corridor")
    assert len(ac) == 27 and set(ac.index) == set(dc.index), "expected 27 paired corridors"
    rows = []
    for c, r in ac.iterrows():
        d = dc.loc[c]
        a, b = ends(r.geometry)
        L = r["len5070_mi"]
        chord = chord_mi(a, b)
        n_term = 2 + math.floor(max(0.0, L - 400) / 400)
        term = n_term * TERMINAL_USD
        line_only = r["usd_mile"] - term / L
        rows.append(dict(
            corridor=c, length_mi=round(L, 2), shape_leng_mi=round(r["Shape_Leng"] / MI, 2),
            usd_mile_ac=r["usd_mile"], usd_mile_dc=d["usd_mile"], cap_mw=int(r["cap_mw"]),
            start_lnglat=lnglat(a), end_lnglat=lnglat(b), chord_mi=round(chord, 2),
            detour_ratio=round(L / chord, 4), n_terminals=n_term, terminals_usd_2018=term,
            line_only_usd_mile_ac=round(line_only), M_backsolved=round(line_only / BASE_USD_MILE, 4),
            row_over_base_range=ROW_OVER_BASE,
            hvdc_hvac_geom_mi_diff=round(abs(d["len5070_mi"] - L), 2), geometry=r.geometry))
    out = gpd.GeoDataFrame(rows, geometry="geometry", crs="EPSG:4326")
    out.to_file(OUT / "pnas_corridors.geojson", driver="GeoJSON")
    print(f"\n{'corridor':28}{'mi':>7}{'chord':>7}{'detour':>7}{'$ac/mi':>8}{'$dc/mi':>8}{'N':>3}{'line-only':>10}{'M':>7}")
    for r in rows:
        print(f"{r['corridor']:28}{r['length_mi']:7.0f}{r['chord_mi']:7.0f}{r['detour_ratio']:7.2f}"
              f"{r['usd_mile_ac']/1e6:8.2f}{r['usd_mile_dc']/1e6:8.2f}{r['n_terminals']:3}"
              f"{r['line_only_usd_mile_ac']/1e6:10.2f}{r['M_backsolved']:7.3f}")
    M = np.array([r["M_backsolved"] for r in rows])
    D = np.array([r["detour_ratio"] for r in rows])
    print(f"\nM_backsolved = M + ROW/base (bands carry no ROW land). ROW/base estimate (B&V 2014 Table 2-7: "
          f"{ROW_ACRES_MI} acres/mi x ${ROW_LAND_USD_ACRE[0]}-${ROW_LAND_USD_ACRE[1]:,}/acre = "
          f"${ROW_ACRES_MI*ROW_LAND_USD_ACRE[0]:,.0f}-${ROW_ACRES_MI*ROW_LAND_USD_ACRE[1]:,.0f}/mi vs base ${BASE_USD:,}/mi): "
          f"{ROW_OVER_BASE[0]:.2%} - {ROW_OVER_BASE[1]:.2%}; row_over_base_range={ROW_OVER_BASE}")
    print(f"M: median {np.median(M):.3f} mean {M.mean():.3f} min {M.min():.3f} max {M.max():.3f} "
          f"p10 {np.percentile(M,10):.3f} p90 {np.percentile(M,90):.3f}")
    print(f"detour: median {np.median(D):.3f} mean {D.mean():.3f} min {D.min():.3f} max {D.max():.3f}")
    print(f"max HVAC/HVDC length difference: {max(r['hvdc_hvac_geom_mi_diff'] for r in rows):.1f} mi")
    print(f"corridors: {len(rows)}")


# (name, kv, report_mi, report_usd_m, regex over lowercase Upgrade_Na; a 'a.*b' pattern needs every token in order;
# the Pinal Central-Tom Wray line is named only 'RioSol' in the data, so its pattern is the name 'riosol|rio sol')
WT_SPECS = [
    ("Townsend-Midpoint", 500, 429, 2112, r"townsend.*midpoint"),
    ("Townsend-Ashe", 500, 500, 2618, r"townsend.*ashe"),
    ("Walker-Bonanza", 500, 375, 2034, r"walker.*bonanza"),
    ("Mead-Liberty-West Wing", 500, 273, 1418, r"mead.*liberty.*west wing"),
    ("Second Mead-Market Place", 500, 14, 79, r"mead.*market place"),
    ("Rio Puerco-San Juan #2", 345, 41, 163, r"rio puerco.*san juan"),
    ("Four Corners-Pintado #2", 345, 81, 312, r"four corners.*pintado"),
    ("Manning-Metcalf", 500, 100, 700, r"manning.*metcalf"),
    ("Pinal Central-Tom Wray (Rio Sol)", 500, 550, 2400, r"riosol|rio sol"),
]


def westtec():
    g = gpd.read_file(f"/vsizip/{WT_ZIP}/{WT_LAYER}")
    g = g[g.geometry.notna() & ~g.geometry.is_empty]
    g = g[g["Upgrade_Ty"] == "New Line"].copy()
    g["_n"] = g["Upgrade_Na"].astype(str).str.lower().str.replace(r"\s+", " ", regex=True)
    g = g.to_crs("EPSG:4326")
    print(f"\nWestTEC new-line rows: {len(g)} (from {WT_ZIP.name})")
    feats, unmatched = [], []
    for name, kv, rmi, rusd, pat in WT_SPECS:
        m = g[g["_n"].str.contains(pat, regex=True) & (g["Upgrade_Vo"].astype(float) == kv)]
        if m.empty:
            unmatched.append(name)
            continue
        # one costed project may be split into segments and repeated per scenario: keep the
        # scenario with the most length, merge its segments
        sc = m.assign(_l=m.to_crs("EPSG:5070").length).groupby("Assessment")["_l"].sum().idxmax()
        m = m[m["Assessment"] == sc].drop_duplicates("geometry")
        geom = unary_union(list(m.geometry))
        geom = linemerge(geom) if geom.geom_type == "MultiLineString" else geom
        L = gpd.GeoSeries([geom], crs="EPSG:4326").to_crs("EPSG:5070").length.iloc[0] / MI
        a, b = ends(geom)
        ratio = L / rmi
        flag = not LEN_RATIO_OK[0] <= ratio <= LEN_RATIO_OK[1]
        feats.append(dict(
            name=name, kv=kv, report_mi=rmi, report_usd_m=rusd, geom_mi=round(L, 1),
            length_ratio=round(ratio, 2), length_ratio_flag=flag, exclude_from_usd_compare=flag,
            start_lnglat=lnglat(a), end_lnglat=lnglat(b), chord_mi=round(chord_mi(a, b), 1),
            n_segments=len(m), scenario=sc, matched_names="; ".join(sorted(set(m["Upgrade_Na"]))),
            match_method=f"regex /{pat}/i on Upgrade_Na, Upgrade_Ty=New Line, kV={kv}, segments merged in scenario {sc}",
            geometry=geom))
    out = gpd.GeoDataFrame(feats, geometry="geometry", crs="EPSG:4326")
    out.to_file(OUT / "westtec_newbuild.geojson", driver="GeoJSON")
    print(f"{'name':34}{'kv':>4}{'rep mi':>7}{'geom mi':>8}{'ratio':>6}{'chord':>7}{'$M':>6}{'seg':>4} scenario")
    for r in feats:
        print(f"{r['name']:34}{r['kv']:4}{r['report_mi']:7}{r['geom_mi']:8.1f}{r['length_ratio']:6.2f}{r['chord_mi']:7.1f}"
              f"{r['report_usd_m']:6}{r['n_segments']:4} {r['scenario']}{'  FLAG' if r['length_ratio_flag'] else ''}  <- {r['matched_names']}")
    print(f"WestTEC matched {len(feats)}/{len(WT_SPECS)}; unmatched: {unmatched or 'none'}")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    pnas()
    westtec()
    spurs()
