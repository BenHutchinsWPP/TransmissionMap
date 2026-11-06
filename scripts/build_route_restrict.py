#!/usr/bin/env python3
"""Route optimizer: PD bands b9 desig and b10 flags2 on the 250 m EPSG:5070 grid.

Role: writes uint8 GeoTIFFs (DEFLATE, 512 tiles, nodata 0) data/build/route/250m/{desig,flags2}.tif
plus restrict_meta.json (per-bit sources, licences, vintages, the sage-grouse class table, the
acreage check, the new bits' land shares). Polygons are rasterised with the centre rule (not
ALL_TOUCHED); WSR / trail lines are reprojected to EPSG:5070 and buffered 402 m in metres first;
facility and NRHP points are buffered 91.44 m (300 ft) in EPSG:5070 and burned all-touched.
Outputs are written to temp names and renamed only after every check passes.
Deps: scripts/route_grid.py (grid, DESIG_BITS, FLAGS2_BITS); numpy, rasterio, geopandas, shapely,
pyogrio, pyarrow (the repo venv; imported in main() so the pure rules load with the stdlib alone).
Inputs (fetched by scripts/fetch_route_inputs.py unless noted):
  desig    PAD-US Designation layer (data/build/route/inputs/padus_gap_agency.gpkg), rivers.gov WSR
           lines, NPS NHT/NST lines (data/raw/route/{wsr,trails})
  flags2   bits 0-1 BLM GRSG HMAs (data/raw/route/grsg); bit 2 floodplain.tif (scripts/build_route_flood.py);
           bit 3 HIFLD schools, hospitals, child care, nursing homes (source.coop mirror, MIRROR below);
           bit 4 NPS NRHP points + polygons <= 10 km2 (data/raw/route/nrhp); bit 5 EPA NPL (data/raw/route/npl);
           bit 6 CBRS units (data/raw/route/cbrs); bit 7 FUDS munitions response sites (mirror)
  checks   data/build/us_states.gpkg (CONUS clip), state.tif (land = state > 0), landcover.tif (NLCD)

Checks: desig bits and flags2 bits 0, 1, 5 compare raster cells x 6.25 ha against the
CONUS-clipped, dissolved vector area of the same inputs (5070); bits whose reference exceeds
MIN_REF_KM2 must agree within +-5 %. flags2 bits 2, 3, 4, 6, 7 report their share of CONUS land
cells and must fall inside SHARE_BOUNDS.

Usage: venv/bin/python scripts/build_route_restrict.py
Run under systemd-run MemoryMax with TMPDIR/CPL_TMPDIR=tmp/build-tmp.
"""
import json
import math
import os
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("OGR_GEOJSON_MAX_OBJ_SIZE", "0")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/build/route/250m"
PADUS = ROOT / "data/build/route/inputs/padus_gap_agency.gpkg"
RAW = ROOT / "data/raw/route"
STATES = ROOT / "data/build/us_states.gpkg"
MIRROR = Path(os.environ.get("HIFLD_MIRROR") or ROOT / "data/raw/hifld-mirror")
SHAPE = (G.ROWS, G.COLS)
BUFFER_M = 402.0
SIMPLIFY_M = 30.0  # line vertices thinned before buffering (the buffer is 402 m; the dense NPS centrelines otherwise exhaust 16 GB)
SITE_BUFFER_M = 91.44  # 300 ft around a facility or NRHP point
MIN_REF_KM2 = 1000.0
TOL = 0.05
CELL_HA = G.CELL * G.CELL / 1e4
NLCD_DEVELOPED = (21, 22, 23, 24)

# flags2 bits checked by acreage (raster vs dissolved vector) and bits checked by land share.
ACREAGE_FLAGS2_BITS = (0, 1, 5)
# bit -> (min, max) share of CONUS land cells; a bit with no land cell fails too.
SHARE_BOUNDS = {2: (0.03, 0.30), 3: (0.0, 0.02), 4: (0.0, 0.005), 6: (0.0, 0.005), 7: (0.0, 0.005)}

# PAD-US Des_Tp -> desig bit (the others are not routing restrictions here).
DESIG_TP = {"WSA": 0, "NM": 1, "NCA": 1, "IRA": 2, "ACEC": 3, "WSR": 4, "NT": 5,
            "RNA": 6, "SDA": 6, "NSBV": 6, "HCA": 6, "NRA": 6, "WA": 7, "SW": 7}
# PAD-US Fee Des_Tp -> desig bit: State Wilderness and National Park (bit 7 with Designation WA / SW).
FEE_DESIG_TP = {"SW": 7, "NP": 7}

# Habitat_Type of the BLM GRSG ROD HMA layer (Feb 2026) -> flags2 bit (explicit; 0 = unmapped).
# bit 0 = classes whose ROD gives PHMA-level right-of-way management (avoidance for major ROWs);
# bit 1 = every general / connectivity / other class managed like GHMA or less restrictively.
# Meanings and ROW direction are quoted from the December 2025 / 2026 BLM RODs (full text read
# from the archive.org copies listed in SAGE_SOURCES); see restrict_meta.json flags2_b10.sage_grouse.
SAGE_BIT = {
    "PHMA": (0, "Priority Habitat Management Area (rangewide; major ROWs: avoidance with few exceptions)"),
    "IHMA": (0, "Important Habitat Management Area (Idaho ROD: 'IHMA is an avoidance area for utility-scale solar and wind development as well as for major ROWs')"),
    "LMHMA": (0, "Little Missouri Habitat Management Area (MT/Dakotas ROD, Table 4: Rights-of-Way 'LMHMA and SCHMA: Same as PHMA (Table 2)')"),
    "SCHMA": (0, "South Carter Habitat Management Area (MT/Dakotas ROD, Table 4: Rights-of-Way 'LMHMA and SCHMA: Same as PHMA (Table 2)')"),
    "GHMA": (1, "General Habitat Management Area (rangewide)"),
    "CHMA": (1, "Connectivity Habitat Management Area (MT/Dakotas ROD, Table 4: Rights-of-Way 'CHMA: Same as GHMA (Table 3)')"),
    "LCHMA": (1, "Linkage Management Area, 'LMA' in the Colorado ROD (Linkage and Connectivity HMA in the other RODs' glossaries): 'LMA are open for solar and wind energy, major and minor rights of way'"),
    "OHMA": (1, "Other Habitat Management Area (NV/CA ROD: 'areas with appropriate environmental conditions for GRSG that are less used by GRSG or have marginal habitat suitability'; Table 3 sets no ROW restriction)"),
    "SHMA": (1, "Stewardship Habitat Management Area (Wyoming ROD: 'BLM Wyoming will manage SHMA the same as GHMA'; 'SHMA and GHMA are open to ... major ROWs with ...')"),
}
SAGE_SOURCES = {
    "montana_dakotas": "https://archive.org/details/montanadakotasgr01unit",
    "colorado": "https://archive.org/details/coloradogrsgroda00unit",
    "wyoming": "https://archive.org/details/wyominggrsgrodar01unse",
    "nevada_california": "https://archive.org/details/nevadacalifornia01unit",
    "idaho": "https://archive.org/details/idahogrsgrodarmp01unit",
    "oregon": "https://archive.org/details/oregongrsgrodarm00unit",
    "utah": "https://archive.org/details/utahgrsgrodarmpa01unit",
    "index": "https://www.blm.gov/learn/blm-library/subject-guides/greater-sage-grouse-subject-guide/planning-nepa",
}
# Superfund: SITE_FEATURE_TYPE values that are a ground / contamination outline; the administrative
# aggregates (Comprehensive Site Area, Total Site Polygon/OU Aggregation, OU Boundary Aggregation,
# Site Boundary, Other, null) are dropped.
NPL_KEEP = {"Current Ground Boundary", "Extent of Contamination", "Contamination Boundary",
            "Contamination Boundary (Groundwater)", "Waste in Place"}


# ---------------------------------------------------------------- pure rules (stdlib only)
def _text(v):
    """A status cell as stripped text; None and NaN become ''."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    return str(v).strip()


def keep_all(status):
    return True


def public_school_open(status):
    """HIFLD public schools: STATUS "1" is open."""
    return _text(status) == "1"


def hospital_open(status):
    return _text(status).upper() == "OPEN"


def nursing_home_open(status):
    """Every nursing home except STATUS CLOSED (a missing status is kept)."""
    return _text(status).upper() != "CLOSED"


def nrhp_keep(status):
    """NRHP: drop STATUS Removed; Listed and missing are kept."""
    return _text(status).lower() != "removed"


NRHP_MAX_POLY_KM2 = 10.0


def nrhp_polygon_kept(area_m2):
    """NRHP polygon (EPSG:5070 area) small enough to be a property outline; larger ones are trails,
    boundary-marker sets and forest preserves drawn as one circumscribed outline."""
    return area_m2 <= NRHP_MAX_POLY_KM2 * 1e6


FUDS_DROP = re.compile(r"^responsecomplete", re.IGNORECASE)


def fuds_keep(status):
    """FUDS MRS: drop PROJECTSTATUS responseComplete* (any case); investigation, cleanup and missing are kept."""
    return not FUDS_DROP.match(_text(status))


CBRS_UNIT_TYPES = ("System Unit", "Otherwise Protected Area")


def share_ok(bit, cells, land_cells):
    """A share-checked flags2 bit: at least one land cell and its land share inside SHARE_BOUNDS[bit]."""
    lo, hi = SHARE_BOUNDS[bit]
    return cells > 0 and land_cells > 0 and lo <= cells / land_cells <= hi


def acreage_ok(ratio, ref_km2):
    """Gated (reference >= MIN_REF_KM2) bits must agree within TOL; smaller ones always pass."""
    return ref_km2 < MIN_REF_KM2 or abs(ratio - 1) <= TOL


HIFLD_LICENCE = "HIFLD via the SeerAI source.coop mirror (CC BY 4.0 packaging of federal public-domain data)"
# name -> (path under MIRROR, keep(STATUS), rule)
FACILITIES = {
    "public_schools": ("public-schools/public-schools/public-schools.parquet", public_school_open, 'STATUS == "1" (open)'),
    "private_schools": ("private-schools/private-schools/private-schools.parquet", keep_all, "all rows"),
    "hospitals": ("hospitals/hospitals/hospitals.parquet", hospital_open, "STATUS == OPEN"),
    "child_care": ("child-care-centers/childcarecenters/childcarecenters.parquet", keep_all,
                   "all rows (no TYPE filter: every TYPE is a centre, school-based, religious facility or Head Start)"),
    "nursing_homes": ("nursing-homes/nursing-homes/nursing-homes.parquet", nursing_home_open, "STATUS != CLOSED"),
}
FUDS_MRS = ("formerly-used-defense-sites-fuds-public-munitions-response-sites-mrs/fuds-munitions-response-site/"
            "fuds-munitions-response-site.parquet")
NRHP_URL = "https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/nrhp_locations/MapServer"
CBRS_URL = "https://gis1.wim.usgs.gov/server/rest/services/CBRSMapper/CoastalBarrierResourcesSystem/MapServer/3"

t0 = time.time()


def log(*a):
    print(f"[{time.time() - t0:7.0f}s]", *a, flush=True)


# ---------------------------------------------------------------- geo helpers
def _import_geo():
    global gpd, np, pd, ds, rasterio, shapely, rasterize, AFF
    import geopandas as gpd
    import numpy as np
    import pandas as pd
    import pyarrow.dataset as ds
    import rasterio
    import shapely
    from rasterio.features import rasterize
    from rasterio.transform import Affine
    AFF = Affine.from_gdal(*G.transform())


def tmp_path(name):
    return OUT / f"{Path(name).stem}.tmp{Path(name).suffix}"


def write(name, arr):
    assert arr.dtype == np.uint8 and arr.shape == SHAPE
    prof = dict(driver="GTiff", dtype="uint8", count=1, width=G.COLS, height=G.ROWS, crs=G.CRS,
                transform=AFF, nodata=0, tiled=True, blockxsize=G.BLOCK, blockysize=G.BLOCK,
                compress="deflate", predictor=2, BIGTIFF="IF_SAFER")
    p = tmp_path(f"{name}.tif")
    with rasterio.open(p, "w", **prof) as dst:
        dst.write(arr, 1)
    log(f"wrote {p.name} {p.stat().st_size / 1e6:.1f} MB")


def to_grid(gdf):
    """EPSG:5070, valid, clipped to the grid extent, empties dropped."""
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].to_crs(G.CRS)
    gdf["geometry"] = shapely.make_valid(gdf.geometry.values)
    box = grid_box()
    gdf = gdf[gdf.intersects(box)].copy()
    gdf["geometry"] = shapely.clip_by_rect(gdf.geometry.values, *box.bounds)
    return gdf[~gdf.geometry.is_empty]


def read5070(path, layer=None, where=None):
    return to_grid(gpd.read_file(path, layer=layer, where=where))


def read_mirror(rel, cols):
    """A HIFLD mirror GeoParquet table: `cols` + geometry (child care nests its columns in `properties`)."""
    d = ds.dataset(MIRROR / rel)
    nested = "properties" in d.schema.names
    t = d.to_table(columns=["geometry"] + (["properties"] if nested else cols))
    props = t.column("properties").combine_chunks() if nested else None
    df = pd.DataFrame({c: (props.field(c) if nested else t.column(c)).to_pylist() for c in cols})
    geo = json.loads((d.schema.metadata or {})[b"geo"])["columns"]["geometry"]
    crs = geo.get("crs") or "OGC:CRS84"
    return gpd.GeoDataFrame(df, geometry=shapely.from_wkb(t.column("geometry").to_pylist()), crs=crs)


def grid_box():
    x0, y1 = G.xy_of(0, 0, center=False)
    x1, y0 = G.xy_of(G.COLS, G.ROWS, center=False)
    return shapely.box(x0, y0, x1, y1)


def burn(geoms, all_touched=False):
    shapes = [(g, 1) for g in geoms if g is not None and not g.is_empty]
    if not shapes:
        return np.zeros(SHAPE, np.uint8)
    return rasterize(shapes, out_shape=SHAPE, transform=AFF, fill=0, dtype="uint8",
                     all_touched=all_touched)


def buffered_lines(path, name_field, label):
    gdf = read5070(path)
    log(f"{label}: {len(gdf)} lines in the grid extent ({gdf[name_field].nunique()} named)")
    return list(gdf.geometry.simplify(SIMPLIFY_M).buffer(BUFFER_M, resolution=4))


def points_on_land(gdf, land):
    """Sites (any CRS) -> (EPSG:5070 geometries whose centroid is on a land cell of the grid, counts)."""
    has = gdf.geometry.notna() & ~gdf.geometry.is_empty
    pts = gdf[has].to_crs(G.CRS).geometry
    c = pts.centroid
    col = np.floor((c.x.values - G.X0) / G.CELL).astype(np.int64)
    row = np.floor((G.Y0 - c.y.values) / G.CELL).astype(np.int64)
    ingrid = (row >= 0) & (row < G.ROWS) & (col >= 0) & (col < G.COLS)
    keep = ingrid.copy()
    keep[ingrid] = land[row[ingrid], col[ingrid]]
    counts = {"no_geometry": int((~has).sum()), "dropped_off_grid": int((~ingrid).sum()),
              "dropped_off_land": int((ingrid & ~keep).sum()), "kept": int(keep.sum())}
    return pts[keep], counts


def sage_class_table(gdf):
    log("sage-grouse classes (Habitat_Type, EIS_HAB, Source -> bit, 5070 acres, CONUS-clipped acres):")
    unmapped = sorted(set(gdf["Habitat_Type"]) - set(SAGE_BIT))
    assert not unmapped, f"unmapped Habitat_Type values: {unmapped}"
    table = []
    conus = conus_union()
    for _, r in gdf.sort_values(["Habitat_Type", "EIS_HAB"]).iterrows():
        ac = r.geometry.area / 4046.8564224
        cac = r.geometry.intersection(conus).area / 4046.8564224
        bit = SAGE_BIT[r["Habitat_Type"]][0]
        table.append({"habitat_type": r["Habitat_Type"], "eis_hab": r["EIS_HAB"], "source": r["Source"],
                      "bit": bit, "acres": round(ac), "conus_acres": round(cac)})
        log(f"  {r['Habitat_Type']:6s} {r['EIS_HAB']:15s} {r['Source']:15s} -> bit {bit}  {ac:14,.0f} ac  {cac:14,.0f} ac")
    log("sage-grouse final mapping: " + json.dumps({k: v[0] for k, v in SAGE_BIT.items()}))
    log(f"sage-grouse unmapped Habitat_Type values: 0 of {gdf['Habitat_Type'].nunique()} distinct")
    return table


_conus = None


def conus_union():
    global _conus
    if _conus is None:
        s = gpd.read_file(STATES).to_crs(G.CRS)
        _conus = shapely.union_all(shapely.make_valid(s.geometry.values))
    return _conus


def check(label, geoms, bit_arr, rows, state):
    """Raster cells x 6.25 ha vs the CONUS-clipped dissolved area of `geoms`."""
    cells = int((bit_arr.astype(bool) & (state > 0)).sum())
    assert cells > 0, f"{label}: no raster cells set"
    r_km2 = cells * CELL_HA / 100.0
    ref = shapely.intersection(shapely.union_all(shapely.make_valid(np.array(geoms, dtype=object))),
                               conus_union())
    ref_km2 = ref.area / 1e6
    assert ref_km2 > 0, f"{label}: empty vector reference"
    ratio = r_km2 / ref_km2 if ref_km2 else float("nan")
    gated = ref_km2 >= MIN_REF_KM2
    ok = acreage_ok(ratio, ref_km2)
    log(f"ACREAGE {label}: cells {cells:,}  raster {r_km2 * 247.1054:,.0f} ac  reference {ref_km2 * 247.1054:,.0f} ac  "
        f"ratio {ratio:.4f}  {'PASS' if ok else 'FAIL'}{'' if gated else ' (reference < 1000 km2, not gated)'}")
    rows.append({"bit": label, "cells": cells, "raster_acres": round(r_km2 * 247.1054),
                 "reference_acres": round(ref_km2 * 247.1054), "ratio": round(ratio, 4), "gated": gated, "pass": ok})
    return ok


def share(bit, arr, land, n_land):
    """Land share of a share-checked flags2 bit, logged and returned as a meta dict."""
    cells = int((arr.astype(bool) & land).sum())
    ok = share_ok(bit, cells, n_land)
    lo, hi = SHARE_BOUNDS[bit]
    log(f"SHARE flags2 bit{bit} {G.FLAGS2_BITS[bit]}: {cells:,} of {n_land:,} land cells = {100 * cells / n_land:.3f} %  "
        f"(bounds {100 * lo:g}-{100 * hi:g} %)  {'PASS' if ok else 'FAIL'}")
    return {"cells": int(arr.sum()), "land_cells": cells, "land_share": round(cells / n_land, 6),
            "bounds": [lo, hi], "pass": ok}


def sidecar(path):
    """fetch_route_inputs.py's .meta.json beside a fetched GeoJSON (url, fetched date, count, sha256)."""
    p = path.with_suffix(".meta.json")
    if not p.exists():
        return None
    m = json.loads(p.read_text())
    return {k: m.get(k) for k in ("url", "fetched", "features", "sha256", "layer_edit")}


def split_points(gdf):
    """(polygonal rows, point / line rows) of a mixed layer."""
    pl = gdf.geometry.geom_type.isin(["Point", "MultiPoint", "LineString", "MultiLineString"])
    return gdf[~pl], gdf[pl]


# ---------------------------------------------------------------- new flags2 bits
def floodplain_bit():
    p = OUT / "floodplain.tif"
    with rasterio.open(p) as r:
        assert r.transform == AFF and (r.height, r.width) == SHAPE and r.crs.to_epsg() == 5070, "floodplain.tif off the grid"
        a = (r.read(1) > 0).astype(np.uint8)
    fm = OUT / "floodplain_meta.json"
    m = json.loads(fm.read_text()) if fm.exists() else {}
    src = {k: m.get(k) for k in ("source", "url", "licence", "vintage", "rule", "built")}
    return a, {"rule": "OR of floodplain.tif (scripts/build_route_flood.py)", "all_touched": None,
               "sources": [{"name": "floodplain", "path": str(p.relative_to(ROOT)), **src}]}


def facility_bit(land):
    kept, srcs = [], []
    for name, (rel, keep, rule) in FACILITIES.items():
        g = read_mirror(rel, ["STATUS"])
        st = g["STATUS"].map(keep)
        pts, c = points_on_land(g[st], land)
        c = {"rows": len(g), "kept_status": int(st.sum()), "dropped_status": int((~st).sum()), **c}
        log(f"facilities {name}: {c}  (rule: {rule})")
        kept.append(pts)
        srcs.append({"name": name, "path": str(MIRROR / rel), "licence": HIFLD_LICENCE, "rule": rule, "counts": c})
    pts = pd.concat(kept, ignore_index=True)
    a = burn(gpd.GeoSeries(pts, crs=G.CRS).buffer(SITE_BUFFER_M, resolution=4), all_touched=True)
    return a, {"rule": f"points buffered {SITE_BUFFER_M} m (300 ft) in EPSG:5070, burned all-touched; "
                       "off-grid and off-land (state.tif == 0) points dropped",
               "all_touched": True, "sources": srcs}


def nrhp_bit(land):
    srcs, polys, ptgeoms = [], [], []
    for name in ("nrhp_points", "nrhp_polygons"):
        p = RAW / f"nrhp/{name}.geojson"
        g = gpd.read_file(p, columns=["STATUS"])
        st = g["STATUS"].map(nrhp_keep)
        c = {"rows": len(g), "kept_status": int(st.sum()), "dropped_removed": int((~st).sum())}
        poly, pt = split_points(g[st])
        if len(poly):
            gp = to_grid(poly)
            small = gp.geometry.area.map(nrhp_polygon_kept)
            c.update(polygons=len(poly), polygons_in_grid=len(gp), polygons_kept=int(small.sum()),
                     polygons_dropped_over_10_km2=int((~small).sum()))
            polys += list(gp[small].geometry)
        if len(pt):
            kp, pc = points_on_land(pt, land)
            c.update(points={"rows": len(pt), **pc})
            ptgeoms += list(kp.buffer(SITE_BUFFER_M, resolution=4))
        log(f"NRHP {name}: {c}")
        srcs.append({"name": name, "path": str(p.relative_to(ROOT)), "url": f"{NRHP_URL}/{0 if name == 'nrhp_points' else 1}",
                     "fetch": sidecar(p), "licence": "UNKNOWN (NPS federal work; NPS publishes no licence statement)",
                     "rule": "STATUS != Removed (Listed and missing kept); restricted sites are withheld by NPS", "counts": c})
    a = burn(polys) | burn(ptgeoms, all_touched=True)
    return a, {"rule": "polygons ≤ 10 km² (larger outlines — trails, boundary-marker sets, forest preserves — dropped), "
                       "centre rule; points buffered 91.44 m all-touched",
               "all_touched": "points only", "sources": srcs}


def cbrs_bit():
    p = RAW / "cbrs/cbrs_units.geojson"
    g = gpd.read_file(p, columns=["Unit", "Unit_Type"])
    types = set(g["Unit_Type"].dropna())
    assert types <= set(CBRS_UNIT_TYPES), f"unexpected CBRS Unit_Type values: {sorted(types - set(CBRS_UNIT_TYPES))}"
    assert "System Unit" in types and len(g) != 1145, "CBRS input is not the Units layer"
    gg = to_grid(g)
    c = {"rows": len(g), "by_unit_type": {str(k): int(v) for k, v in g["Unit_Type"].value_counts(dropna=False).items()}, "in_grid": len(gg)}
    log(f"CBRS units: {c}")
    return burn(gg.geometry), {
        "rule": "System Units and Otherwise Protected Areas, centre rule", "all_touched": False,
        "sources": [{"name": "cbrs_units", "path": str(p.relative_to(ROOT)), "url": CBRS_URL, "fetch": sidecar(p),
                     "licence": "public domain (USFWS CBRS units, served by the USGS-hosted CBRS Mapper)", "counts": c}]}


def fuds_bit():
    g = read_mirror(FUDS_MRS, ["PROJECTSTATUS"])
    st = g["PROJECTSTATUS"].map(fuds_keep)
    gg = to_grid(g[st])
    c = {"rows": len(g), "kept_status": int(st.sum()), "dropped_response_complete": int((~st).sum()),
         "kept_null_status": int((st & g["PROJECTSTATUS"].isna()).sum()), "in_grid": len(gg)}
    log(f"FUDS MRS: {c}")
    return burn(gg.geometry), {
        "rule": "PROJECTSTATUS not matching /^responsecomplete/i (missing kept), centre rule", "all_touched": False,
        "sources": [{"name": "fuds_mrs", "path": str(MIRROR / FUDS_MRS),
                     "licence": HIFLD_LICENCE + "; USACE FUDS, public domain", "counts": c}]}


def main():
    _import_geo()
    OUT.mkdir(parents=True, exist_ok=True)
    outs = {"desig.tif": tmp_path("desig.tif"), "flags2.tif": tmp_path("flags2.tif"),
            "restrict_meta.json": tmp_path("restrict_meta.json")}
    try:
        build(outs)
        for final, tmp in outs.items():
            os.replace(tmp, OUT / final)
        log("renamed " + ", ".join(outs) + " into place")
    finally:
        for tmp in outs.values():
            tmp.unlink(missing_ok=True)
    log("done")


def build(outs):
    rows, ok = [], True

    # ---- desig (b9) ----
    des = read5070(PADUS, layer="PADUS4_1Designation")
    log(f"PAD-US Designation: {len(des)} features; Des_Tp used: " +
        str({k: int((des.Des_Tp == k).sum()) for k in DESIG_TP}))
    srcs = {b: [] for b in G.DESIG_BITS}
    for tp, b in DESIG_TP.items():
        srcs[b] += list(des[des.Des_Tp == tp].geometry)
    fee = read5070(PADUS, layer="PADUS4_1Fee", where="Des_Tp IN ('" + "','".join(FEE_DESIG_TP) + "')")
    for tp, b in FEE_DESIG_TP.items():
        srcs[b] += list(fee[fee.Des_Tp == tp].geometry)
    acres = lambda g: round(g.geometry.area.sum() / 4046.8564224)
    for tp, b in DESIG_TP.items():
        if b == 7:
            log(f"desig bit 7 Designation {tp}: {int((des.Des_Tp == tp).sum())} features, {acres(des[des.Des_Tp == tp]):,} ac")
    for tp in FEE_DESIG_TP:
        log(f"desig bit 7 Fee {tp}: {int((fee.Des_Tp == tp).sum())} features, {acres(fee[fee.Des_Tp == tp]):,} ac")
    import pyogrio
    pres = pyogrio.read_dataframe(PADUS, layer="PADUS4_1Fee", read_geometry=False, where="Mang_Name = 'NPS' AND Unit_Nm LIKE '%Preserve%'")
    log("National Preserves (Fee, Mang_Name NPS, Unit_Nm like Preserve): " + str(len(pres)) + " features; Des_Tp " +
        str(pres.Des_Tp.value_counts().to_dict()) + "; in desig bit 7: " + str(int(pres.Des_Tp.isin(set(FEE_DESIG_TP)).sum())))
    srcs[4] += buffered_lines(RAW / "wsr/wsr_lines.geojson", "wsr_river_name", "WSR rivers.gov lines")
    srcs[5] += buffered_lines(RAW / "trails/nts_lines.geojson", "trail", "NHT/NST trail lines")
    desig = np.zeros(SHAPE, np.uint8)
    bits = {}
    for b in G.DESIG_BITS:
        bits[b] = burn(srcs[b])
        desig |= (bits[b] << b).astype(np.uint8)
        log(f"desig bit {b} ({G.DESIG_BITS[b]}): {int(bits[b].sum()):,} cells")
    write("desig", desig)
    for b in G.DESIG_BITS:
        ok &= check(f"desig{b} {G.DESIG_BITS[b]}", srcs[b], bits[b], rows, desig)
    del bits, srcs, des, desig

    with rasterio.open(OUT / "state.tif") as r:
        assert r.transform == AFF and (r.height, r.width) == SHAPE, "state.tif off the grid"
        land = r.read(1) > 0
    n_land = int(land.sum())
    log(f"CONUS land cells (state.tif > 0): {n_land:,}")

    # ---- flags2 (b10): bits 0, 1, 5 ----
    gr = read5070(RAW / "grsg/grsg_hma.geojson")
    sage_table = sage_class_table(gr)
    npl = read5070(RAW / "npl/npl_boundaries.geojson")
    st = npl["NPL_STATUS_CODE"].fillna("none")
    log("NPL polygons by NPL_STATUS_CODE: " + str(st.value_counts().to_dict()) +
        "; used: F (final) only")
    log(f"NPL sites (distinct EPA_ID) total {npl['EPA_ID'].nunique()}, status F with polygon "
        f"{npl[st == 'F']['EPA_ID'].nunique()} sites / {int((st == 'F').sum())} polygons; no point buffering")
    ftype = npl["SITE_FEATURE_TYPE"].fillna("(null)")
    final = st == "F"
    ac = lambda m: npl[m].geometry.area.sum() / 4046.8564224
    keep = final & ftype.isin(NPL_KEEP)
    log("NPL status-F SITE_FEATURE_TYPE (polygons, acres): " + json.dumps(
        {k: [int(((ftype == k) & final).sum()), round(ac((ftype == k) & final))] for k in sorted(set(ftype[final]))}))
    log(f"NPL superfund acreage before (all status F) {ac(final):,.0f} ac / {int(final.sum())} polygons; "
        f"after (ground/contamination outlines) {ac(keep):,.0f} ac / {int(keep.sum())} polygons")
    top = npl[keep].assign(ac=npl[keep].geometry.area / 4046.8564224).nlargest(15, "ac")
    for _, r in top.iterrows():
        log(f"  NPL kept {r['ac']:12,.0f} ac  {r['SITE_NAME']} | {r['SITE_FEATURE_TYPE']} | {r['STATE_CODE']}")
    npl_keep = npl[keep]
    npl_before, npl_after = round(ac(final)), round(ac(keep))
    f2src = {0: list(gr[gr["Habitat_Type"].map(lambda h: SAGE_BIT[h][0]) == 0].geometry),
             1: list(gr[gr["Habitat_Type"].map(lambda h: SAGE_BIT[h][0]) == 1].geometry),
             5: list(npl_keep.geometry)}
    flags2 = np.zeros(SHAPE, np.uint8)
    bits = {}
    for b in ACREAGE_FLAGS2_BITS:
        bits[b] = burn(f2src[b])
        flags2 |= (bits[b] << b).astype(np.uint8)
        log(f"flags2 bit {b} ({G.FLAGS2_BITS[b]}): {int(bits[b].sum()):,} cells")
    both = int((bits[0] & bits[1]).sum())
    log(f"flags2 bit0 & bit1 overlap cells: {both:,}")
    for b in ACREAGE_FLAGS2_BITS:
        ok &= check(f"flags2 bit{b} {G.FLAGS2_BITS[b]}", f2src[b], bits[b], rows, flags2)
    del bits, f2src, gr, npl

    # ---- flags2 (b10): bits 2, 3, 4, 6, 7 ----
    new = {}
    for b, make in ((2, floodplain_bit), (3, lambda: facility_bit(land)), (4, lambda: nrhp_bit(land)),
                    (6, cbrs_bit), (7, fuds_bit)):
        a, info = make()
        info.update(share(b, a, land, n_land))
        if b == 3:
            with rasterio.open(OUT / "landcover.tif") as r:
                dev = np.isin(r.read(1), NLCD_DEVELOPED)
            on = a.astype(bool) & land
            n_on, n_dev = int(on.sum()), int((on & dev).sum())
            info["nlcd_developed_overlap"] = {"cells": n_dev, "share_of_bit": round(n_dev / max(n_on, 1), 4),
                                              "share_of_developed": round(n_dev / max(int((dev & land).sum()), 1), 4)}
            log(f"flags2 bit3 vs NLCD 21-24: {n_dev:,} of {n_on:,} bit-3 land cells are developed "
                f"({100 * n_dev / max(n_on, 1):.1f} %); covers {100 * info['nlcd_developed_overlap']['share_of_developed']:.2f} % of developed land")
            del dev, on
        flags2 |= (a << b).astype(np.uint8)
        log(f"flags2 bit {b} ({G.FLAGS2_BITS[b]}): {info['cells']:,} cells")
        new[b] = info
        del a
    assert set(new) | set(ACREAGE_FLAGS2_BITS) == set(G.FLAGS2_BITS), "a flags2 bit has no source"
    write("flags2", flags2)
    del flags2

    # ---- verify + meta ----
    for n in ("desig", "flags2"):
        with rasterio.open(outs[f"{n}.tif"]) as r:
            assert r.transform == AFF and (r.height, r.width) == SHAPE and r.crs.to_epsg() == 5070, n
            assert r.dtypes[0] == "uint8" and r.nodata == 0, n
            a = r.read(1)
        allowed = sum(1 << b for b in (G.DESIG_BITS if n == "desig" else G.FLAGS2_BITS))
        assert int((a & ~np.uint8(allowed)).max()) == 0, n
        log(f"{n}: transform/shape/CRS/dtype/nodata == grid OK; used bits mask {int(np.bitwise_or.reduce(a.ravel()[::97]))}")
        del a
    meta = {
        "built": time.strftime("%Y-%m-%d"),
        "grid": G.grid_json(),
        "desig_b9": {
            "rule": "polygons: centre rule on the 250 m grid; WSR/trail lines reprojected to EPSG:5070 and buffered 402 m (width UNVERIFIED for trails)",
            "des_tp_to_bit": DESIG_TP, "fee_des_tp_to_bit": FEE_DESIG_TP,
            "ira": "IRA = USFS Inventoried Roadless Areas (2001 Roadless Area Conservation Rule inventory) as carried in PAD-US 4.1 Designation Des_Tp=IRA; "
                   "USDA proposed rescission of the Roadless Rule 2026-08-18, proposal only, NOT final; IRAs stay a restriction until a final rule",
            "sources": {
                "padus_designation": "PAD-US 4.1 Designation (data/build/route/inputs/padus_gap_agency.gpkg); public domain (USGS)",
                "wsr_lines": "rivers.gov National Wild and Scenic River lines, USFS EDW copy; public domain",
                "padus_fee": "PAD-US 4.1 Fee Des_Tp SW / NP (bit 7); public domain (USGS)",
                "trails": "NPS National Trails System NHT/NST centrelines (26+ trails); public domain"},
        },
        "flags2_b10": {
            "sage_grouse": {"rod_sources": SAGE_SOURCES, "bit0_rule": "ROD gives the class PHMA-level right-of-way management",
                            "source": "BLM Natl WesternUS GRSG ROD HabitatMgmtAreas Feb 2026 (hub item e017fcce947f4451ae049aa07383932d); public domain",
                            "bit_by_habitat_type": {k: v[0] for k, v in SAGE_BIT.items()},
                            "meaning": {k: v[1] for k, v in SAGE_BIT.items()}, "classes": sage_table},
            "superfund": {"source": "EPA NPL site boundaries; NPL_STATUS_CODE = F (final) only, SITE_FEATURE_TYPE in " + str(sorted(NPL_KEEP)) + " (ground / contamination outlines; administrative aggregates dropped); public domain",
                          "acres_before_all_status_F": npl_before, "acres_after_filter": npl_after,
                          "kept_polygons": int(keep.sum())},
            **{f"bit{b}": {"name": G.FLAGS2_BITS[b], **info} for b, info in sorted(new.items())},
        },
        "acreage_check": {"tolerance": TOL, "min_reference_km2": MIN_REF_KM2,
                          "bits": "desig all; flags2 " + ", ".join(map(str, ACREAGE_FLAGS2_BITS)), "rows": rows},
        "share_check": {"land": "state.tif > 0", "bounds": {str(b): v for b, v in SHARE_BOUNDS.items()},
                        "pass": all(i["pass"] for i in new.values())},
    }
    outs["restrict_meta.json"].write_text(json.dumps(meta, indent=1, default=str))
    log("wrote restrict_meta.json (temp)")
    bad = [f"bit{b}" for b, i in new.items() if not i["pass"]]
    assert ok, "acreage check failed (see ACREAGE FAIL lines)"
    assert not bad, f"land-share check failed for flags2 {bad} (see SHARE FAIL lines)"


if __name__ == "__main__":
    main()
