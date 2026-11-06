#!/usr/bin/env python3
"""Route optimizer bands b1 landcover, b3 protect, b4 agency, b5 wildfire,
b6 whpclass, b8 state on the 250 m EPSG:5070 grid.

Role: writes single-band uint8 GeoTIFFs (DEFLATE, 512 tiles, nodata 0) to
data/build/route/250m/{landcover,protect,agency,wildfire,whpclass,state}.tif plus
bands_meta.json (sources, licences, cnt_max, agency rule), then prints the acceptance checks.
Deps: scripts/route_grid.py (grid transform, code tables); numpy, rasterio, fiona, geopandas
(the repo venv). Inputs: NLCD 2025 (data/raw/route/nlcd), PAD-US gpkg and PoPWest rasters
(data/build/route/inputs, data/raw/route/popwest), WHP 2023 (data/raw/wildfire_hazard),
data/build/us_states.gpkg.

Also the own passes `easement` and `preserve`, which touch protect only (PAD-US easement
classes and bit 7, NPS units named Preserve).

Pure helpers (testable without data): `raster_shapes` (drops null/empty geometries before a
rasterize call) and `checked_outputs` (step names -> outputs check_outputs verifies). A rasterize
call on an empty shape list raises, so every call site skips an empty list.
Tests: scripts/test_route_bands.py.

Usage: venv/bin/python scripts/build_route_bands.py [--only state,protect,...]
Run under systemd-run MemoryMax with TMPDIR/CPL_TMPDIR=tmp/build-tmp.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import fiona
import geopandas as gpd
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import Affine
from rasterio.warp import reproject

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/build/route/250m"
NLCD = ROOT / "data/raw/route/nlcd/unzipped/Annual_NLCD_LndCov_2025_CU_C1V2.tif"
PADUS = ROOT / "data/build/route/inputs/padus_gap_agency.gpkg"
POPWEST = ROOT / "data/raw/route/popwest"
WHP = ROOT / "data/raw/wildfire_hazard/whp2023_GeoTIF"
STATES = ROOT / "data/build/us_states.gpkg"

AFF = Affine.from_gdal(*G.transform())
SHAPE = (G.ROWS, G.COLS)
NLCD_NODATA = 250
NLCD_CLASSES = [11, 12, 21, 22, 23, 24, 31, 41, 42, 43, 52, 71, 81, 82, 90, 95]
WEST_FIPS = [4, 6, 8, 16, 30, 32, 35, 41, 49, 53, 56]
AGENCY_RULE = ("overlapping PAD-US polygons: rank = 2*federal + fee (federal Fee > federal "
               "Designation > non-federal Fee > non-federal Designation), ties -> higher code; "
               "code from Mang_Name (AGENCY_BY_MANG_NAME), else federal Mang_Type FED -> 9, "
               "else Mang_Type (AGENCY_BY_MANG_TYPE; DIST -> 11), else 13; cells inside a state "
               "with no polygon = 1, outside states = 0")

log_t0 = time.time()


def log(*a):
    print(f"[{time.time() - log_t0:7.0f}s]", *a, flush=True)


def write(name, arr):
    OUT.mkdir(parents=True, exist_ok=True)
    assert arr.dtype == np.uint8 and arr.shape == SHAPE
    prof = dict(driver="GTiff", dtype="uint8", count=1, width=G.COLS, height=G.ROWS,
                crs=G.CRS, transform=AFF, nodata=0, tiled=True, blockxsize=G.BLOCK,
                blockysize=G.BLOCK, compress="deflate", predictor=2, BIGTIFF="IF_SAFER")
    with rasterio.open(OUT / f"{name}.tif", "w", **prof) as dst:
        dst.write(arr, 1)
    log(f"wrote {name}.tif {(OUT / f'{name}.tif').stat().st_size / 1e6:.1f} MB")


def warp(src_path, resampling, dtype, src_nodata=None, dst_nodata=None, fill=0):
    dst = np.full(SHAPE, fill, dtype=dtype)
    with rasterio.open(src_path) as r:
        reproject(rasterio.band(r, 1), dst, dst_transform=AFF, dst_crs=G.CRS,
                  src_nodata=src_nodata, dst_nodata=dst_nodata, resampling=resampling,
                  init_dest_nodata=True, warp_mem_limit=512)
    return dst


# ---- b8 state ----
def build_state():
    gdf = gpd.read_file(STATES).to_crs(G.CRS)
    shapes = [(g, int(f)) for g, f in zip(gdf.geometry, gdf["geoid"])]
    arr = rasterize(shapes, out_shape=SHAPE, transform=AFF, fill=0, dtype="uint8")
    write("state", arr)
    return arr


# ---- b3 protect ----
def build_tnc():
    """Per category raw arrays, 255 = outside the raster's extent."""
    cats = {}
    for k in (1, 2, 3):
        p = POPWEST / f"Category{k}_Wind_EE.tif"
        # Cat3 is int8 with no declared nodata; unset, GDAL treats its value 127 as nodata.
        cats[k] = warp(p, Resampling.nearest, "uint8", src_nodata=-99 if k == 3 else None,
                       dst_nodata=255, fill=255)
        log(f"Cat{k} warped: " + str(dict(zip(*[x.tolist() for x in np.unique(cats[k], return_counts=True)]))))
    return cats


def chunks(it, n):
    buf = []
    for x in it:
        buf.append(x)
        if len(buf) >= n:
            yield buf
            buf = []
    if buf:
        yield buf


def agency_code(name, mtype):
    if name in G.AGENCY_BY_MANG_NAME:
        return G.AGENCY_BY_MANG_NAME[name]
    if mtype == "FED":
        return G.AGENCY_OTHER_FEDERAL
    if mtype in G.AGENCY_BY_MANG_TYPE:
        return G.AGENCY_BY_MANG_TYPE[mtype]
    if mtype == "DIST":
        return 11
    return 13


def raster_shapes(shapes):
    """Keeps (geometry, value) pairs whose geometry is present and non-empty."""
    return [(g, v) for g, v in shapes if g and (g.get("coordinates") or g.get("geometries"))]


# Steps that write protect.tif (build_protect_agency runs for protect or agency).
PROTECT_WRITERS = {"protect", "agency", "easement", "preserve"}
AGENCY_WRITERS = {"protect", "agency"}  # build_protect_agency writes agency.tif beside protect.tif


def checked_outputs(names, exists=lambda n: True):
    """Outputs check_outputs verifies after the steps in `names`, in table order."""
    names = set(names)
    return [n for n in ("landcover", "protect", "agency", "wildfire", "whpclass", "state")
            if exists(n) and (n in names or n == "state" or (n == "protect" and names & PROTECT_WRITERS)
                or (n == "agency" and names & AGENCY_WRITERS))]


def build_padus():
    """Returns (gap 0..4 smallest non-zero, agency code 0 = no polygon)."""
    best_gap = np.zeros(SHAPE, np.uint8)  # 5 - gap, max wins
    best_ag = np.zeros(SHAPE, np.uint8)  # rank*16 + code, max wins
    unmatched = {}
    for layer, fee in (("PADUS4_1Fee", 1), ("PADUS4_1Designation", 0)):
        with fiona.open(PADUS, layer=layer) as src:
            n = 0
            for ch in chunks(src, 20000):
                gs, ags = [], []
                for f in ch:
                    p = f["properties"]
                    geom = f["geometry"]
                    if geom is None:
                        continue
                    if p["GAP_Sts"] in ("1", "2", "3", "4"):
                        gs.append((geom, 5 - int(p["GAP_Sts"])))
                    name, mt = p["Mang_Name"], p["Mang_Type"]
                    code = agency_code(name, mt)
                    if name not in G.AGENCY_BY_MANG_NAME:
                        unmatched[(mt, name, code)] = unmatched.get((mt, name, code), 0) + 1
                    rank = 2 * (mt == "FED") + fee + 1
                    ags.append((geom, rank * 16 + code))
                for shapes, best in ((gs, best_gap), (ags, best_ag)):
                    shapes = raster_shapes(shapes)
                    if not shapes:
                        continue
                    shapes.sort(key=lambda s: s[1])
                    m = rasterize(shapes, out_shape=SHAPE, transform=AFF, fill=0, dtype="uint8")
                    np.maximum(best, m, out=best)
                n += len(ch)
                log(f"PAD-US {layer}: {n} features")
    log("PAD-US names not in AGENCY_BY_MANG_NAME (type, name, code): features -> "
        + str(sorted(unmatched.items(), key=lambda kv: -kv[1])))
    gap = np.where(best_gap > 0, 5 - best_gap.astype(np.int16), 0).astype(np.uint8)
    return gap, (best_ag & 15)


def easement_gap():
    """PAD-US Easement layer -> 5 - GAP raster (max wins, 0 = none). Feeds best_gap only: easements are
    mostly private land, so they never enter build_padus()'s Fee + Designation loop that also writes agency."""
    best = np.zeros(SHAPE, np.uint8)
    with fiona.open(PADUS, layer="PADUS4_1Easement") as src:
        n = 0
        for ch in chunks(src, 20000):
            gs = [(f["geometry"], 5 - int(str(f["properties"]["GAP_Sts"]).strip())) for f in ch
                  if f["geometry"] is not None and str(f["properties"]["GAP_Sts"]).strip() in ("1", "2", "3", "4")]
            gs = raster_shapes(gs)
            gs.sort(key=lambda s: s[1])
            if gs:
                np.maximum(best, rasterize(gs, out_shape=SHAPE, transform=AFF, fill=0, dtype="uint8"), out=best)
            n += len(ch)
            log(f"PAD-US Easement: {n} features")
    esm = np.where(best > 0, 5 - best.astype(np.int16), 0).astype(np.uint8)
    assert int((esm > 0).sum()) > 0, "easement pass burned no cells"
    return esm


def easement_reference(esm):
    """Dissolved, CONUS-clipped vector area of easement GAP 1 and 2 vs the raster cells (GAP 1/2 only)."""
    import shapely
    states = gpd.read_file(STATES).to_crs(G.CRS)
    conus = shapely.union_all(shapely.make_valid(states.geometry.values))
    for g in (1, 2):
        parts = []
        with fiona.open(PADUS, layer="PADUS4_1Easement") as src:
            for ch in chunks(src, 20000):
                geoms = [shapely.geometry.shape(f["geometry"]) for f in ch
                         if f["geometry"] is not None and str(f["properties"]["GAP_Sts"]).strip() == str(g)]
                if geoms:
                    gs = gpd.GeoSeries(geoms, crs=src.crs).to_crs(G.CRS)
                    parts.append(shapely.union_all(shapely.make_valid(gs.values)))
        ref = shapely.intersection(shapely.union_all(shapely.make_valid(np.array(parts, dtype=object))), conus)
        r_ac = int((esm == g).sum()) * 15.4441
        ref_ac = ref.area / 4046.8564224
        log(f"easement GAP {g} reference: raster {r_ac:,.0f} ac vs CONUS-clipped dissolved vector {ref_ac:,.0f} ac "
            f"(ratio {r_ac / ref_ac:.4f}; raster counts cells first covered by this class before the min-GAP merge)")


def merge_easement_gap(gap, esm):
    """min-GAP merge of the easement raster into gap (both 0 = none); prints cells/acres moved per GAP class."""
    take = (esm > 0) & ((gap == 0) | (esm < gap))
    for g in (1, 2, 3, 4):
        m = take & (esm == g)
        log(f"easement GAP {g}: {int((esm == g).sum()):,} cells covered, {int(m.sum()):,} cells set protect GAP "
            f"({int(m.sum()) * 15.4441:,.0f} acres added/lowered)")
    return np.where(take, esm, gap).astype(np.uint8)


def build_easement():
    """Own pass: update protect.tif's GAP bits only (min over Fee, Designation and Easement); agency.tif is not touched."""
    ag_path = OUT / "agency.tif"
    sha = lambda: __import__("hashlib").sha256(ag_path.read_bytes()).hexdigest()
    before = sha()
    log(f"agency.tif sha256 before: {before}")
    with rasterio.open(OUT / "protect.tif") as r:
        protect = r.read(1)
    gap = protect & G.PROTECT_BITS["gap_mask"]
    esm = easement_gap()
    easement_reference(esm)
    new = merge_easement_gap(gap, esm)
    protect = ((protect & ~np.uint8(G.PROTECT_BITS["gap_mask"])) | new).astype(np.uint8)
    write("protect", protect)
    with rasterio.open(OUT / "protect.tif") as r:
        assert r.transform == AFF and (r.height, r.width) == SHAPE and r.dtypes[0] == "uint8", "protect.tif grid changed"
        assert np.array_equal(r.read(1), protect)
    after = sha()
    log(f"agency.tif sha256 after:  {after}  {'UNCHANGED' if after == before else 'CHANGED'}")
    assert after == before
    v, c = np.unique(protect & G.PROTECT_BITS["gap_mask"], return_counts=True)
    log("protect GAP histogram after easement: " + str(dict(zip(v.tolist(), c.tolist()))))


def merge_preserve(protect, mask):
    """Set protect bit 7 where mask is true and clear it elsewhere; bits 0-6 untouched."""
    bit = np.uint8(1 << G.PROTECT_BITS["nps_preserve_bit"])
    return np.where(mask, protect | bit, protect & ~bit).astype(np.uint8)


def preserve_mask(state):
    """Cells whose centre falls in a PAD-US Fee NPS unit named Preserve (CONUS land only)."""
    shapes, names = [], {}
    with fiona.open(PADUS, layer="PADUS4_1Fee") as src:
        for f in src.filter(where=G.NPS_PRESERVE_WHERE):
            shapes.append((f["geometry"], 1))
            names.setdefault(f["properties"]["Unit_Nm"], []).append(f["geometry"])
    log(f"preserve: {len(shapes)} Fee features, {len(names)} units")
    assert len(shapes) == 25, f"preserve rule matched {len(shapes)} Fee features, expected 25 (PAD-US 4.1): the count changed, re-check the rule"
    mask = (rasterize(shapes, out_shape=SHAPE, transform=AFF, fill=0, dtype="uint8") > 0) & (state > 0)
    for nm, geoms in sorted(names.items()):
        m = (rasterize([(g, 1) for g in geoms], out_shape=SHAPE, transform=AFF, fill=0, dtype="uint8") > 0) & (state > 0)
        log(f"  {nm}: {len(geoms)} features, {int(m.sum()):,} cells, {int(m.sum()) * 15.4441:,.0f} acres")
    n = int(mask.sum())
    log(f"preserve total: {n:,} cells, {n * 15.4441:,.0f} acres")
    assert 50_000 <= n <= 400_000, f"preserve cells {n} outside 50,000..400,000"
    dpath = OUT / "desig.tif"
    if dpath.exists():
        with rasterio.open(dpath) as r:
            d = r.read(1)
        log(f"preserve cells already desig bit 7 (excluded): {int((mask & ((d & 128) > 0)).sum()):,}; "
            f"desig bit 4: {int((mask & ((d & 16) > 0)).sum()):,}")
    return mask


def build_preserve(state):
    """Own pass: set protect bit 7 from preserve_mask; bits 0-6 and agency.tif are not touched."""
    ag_path = OUT / "agency.tif"
    sha = lambda: __import__("hashlib").sha256(ag_path.read_bytes()).hexdigest()
    before = sha()
    with rasterio.open(OUT / "protect.tif") as r:
        old = r.read(1)
    new = merge_preserve(old, preserve_mask(state))
    assert np.array_equal(new & 0x7F, old & 0x7F), "protect bits 0-6 changed"
    write("protect", new)
    assert sha() == before, "agency.tif changed"
    log("agency.tif sha256 UNCHANGED")


def build_protect_agency(state, need):
    cats = build_tnc()
    f1, f2, f3 = (cats[k] == 1 for k in (1, 2, 3))
    log("TNC overlap counts (cells): Cat1=%d Cat2=%d Cat3=%d | Cat1&Cat2=%d Cat1&Cat3=%d "
        "Cat1&(Cat2|Cat3)=%d Cat2&Cat3=%d | Cat3==127: %d"
        % (f1.sum(), f2.sum(), f3.sum(), (f1 & f2).sum(), (f1 & f3).sum(),
           (f1 & (f2 | f3)).sum(), (f2 & f3).sum(), (cats[3] == 127).sum()))
    tnc = np.where(f1, 1, np.where(f2, 2, np.where(f3, 3, 0))).astype(np.uint8)
    log("TNC coverage of western-state land cells (share: in-any-cat / Cat3==127 / outside raster extent)")
    for fp in WEST_FIPS:
        m = state == fp
        n = m.sum()
        anyc = (f1 | f2 | f3)[m].sum() / n
        out127 = (cats[3][m] == 127).sum() / n
        ext = ((cats[1][m] == 255) | (cats[3][m] == 255)).sum() / n
        log(f"  FIPS {fp:02d}: n={n} any={anyc:.3f} 127={out127:.3f} outside-extent={ext:.3f}")
    outside = (cats[3] == 127).astype(np.uint8)

    gap, ag = build_padus()
    gap = merge_easement_gap(gap, easement_gap())
    ag = np.where(ag > 0, ag, np.where(state > 0, G.AGENCY_PRIVATE, 0)).astype(np.uint8)
    ag[state == 0] = 0
    protect = (gap | (tnc << G.PROTECT_BITS["tnc_shift"])
               | (outside << G.PROTECT_BITS["outside_popwest_bit"])).astype(np.uint8)
    protect = merge_preserve(protect, preserve_mask(state))
    write("protect", protect)
    write("agency", ag)

    # placement checks
    ys = None
    with fiona.open(PADUS, layer="PADUS4_1Fee") as src:
        shapes = [(f["geometry"], 1) for f in src.filter(bbox=(-1200000, 2300000, -1000000, 2500000))
                  if f["properties"]["Unit_Nm"] == "Yellowstone National Park"
                  and f["properties"]["Mang_Name"] == "NPS"]
    if not shapes:
        with fiona.open(PADUS, layer="PADUS4_1Fee") as src:
            shapes = [(f["geometry"], 1) for f in src if f["properties"]["Unit_Nm"] == "Yellowstone National Park"]
    ys = rasterize(shapes, out_shape=SHAPE, transform=AFF, fill=0, dtype="uint8").astype(bool)
    c1 = f1[ys].mean()
    wy = state == 56
    c23 = (f2 | f3)[wy].mean()
    log(f"Yellowstone placement check: {len(shapes)} polygons, {ys.sum()} cells, Cat1 share = {c1:.3f} (need >= 0.90)")
    log(f"Wyoming placement check: {wy.sum()} land cells, Cat2|Cat3 share = {c23:.3f} (need >= 0.75)")
    assert c1 >= 0.90 and c23 >= 0.75, "placement check failed"
    return {"yellowstone_cat1": float(c1), "wyoming_cat23": float(c23)}


# ---- b5 / b6 ----
def build_wildfire():
    cnt = warp(WHP / "whp2023_cnt_conus.tif", Resampling.average, "float32",
               src_nodata=2147483647, dst_nodata=np.nan, fill=np.nan)
    valid = np.isfinite(cnt)
    cnt_max = float(np.nanmax(cnt))
    log(f"cnt 250 m average: valid {valid.sum()} cells, cnt_max = {cnt_max}")
    out = np.zeros(SHAPE, np.uint8)
    out[valid] = (1 + np.rint(254 * np.minimum(cnt[valid] / cnt_max, 1))).astype(np.uint8)
    write("wildfire", out)
    return cnt_max


def build_whpclass():
    cls = warp(WHP / "whp2023_cls_conus.tif", Resampling.nearest, "uint8",
               src_nodata=255, dst_nodata=0, fill=0)
    write("whpclass", cls)


# ---- b1 landcover ----
def overlap_matrix(n_cells, n_px):
    """(n_cells, n_px) overlap, in 10 m units, between 250 m cells and 30 m pixels (window-relative)."""
    ci = np.arange(n_cells)[:, None] * 250.0
    pj = np.arange(n_px)[None, :] * 30.0
    ov = np.minimum(ci + 250, pj + 30) - np.maximum(ci, pj)
    return (np.maximum(ov, 0) / 10.0).astype(np.float32)


def build_landcover():
    out = np.zeros(SHAPE, np.uint8)
    cache = {}
    nwin = done = 0
    with rasterio.open(NLCD) as r:
        assert r.nodata == NLCD_NODATA
        nx0, ny0 = r.transform.c, r.transform.f
        for co, ro, w, h, (xa, ya, xb, yb) in G.windows(30000):
            nwin += 1
            c0 = round((xa - nx0) / 30)
            r0 = round((ny0 - yb) / 30)
            npx_w, npx_h = round((xb - xa) / 30), round((yb - ya) / 30)
            a = r.read(1, window=((r0, r0 + npx_h), (c0, c0 + npx_w)), boundless=True,
                       fill_value=NLCD_NODATA)
            if (a == NLCD_NODATA).all():
                continue
            wx = cache.setdefault(("x", w, npx_w), overlap_matrix(w, npx_w))
            wy = cache.setdefault(("y", h, npx_h), overlap_matrix(h, npx_h))
            best = np.full((h, w), -1.0, np.float32)
            res = np.zeros((h, w), np.uint8)
            for c in np.unique(a):
                if c == NLCD_NODATA:
                    continue
                cnt = wy @ (a == c).astype(np.float32) @ wx.T
                upd = cnt > best + 0.5  # counts are integers; strict > keeps lowest class on ties
                best[upd] = cnt[upd]
                res[upd] = c
            res[best < 0.5] = 0
            out[ro:ro + h, co:co + w] = res
            done += 1
            if done % 500 == 0:
                log(f"landcover: {done} land windows ({nwin} visited)")
    log(f"landcover: {done} land windows of {nwin}")
    write("landcover", out)


def hist(name, arr):
    v, c = np.unique(arr, return_counts=True)
    log(f"{name} histogram: " + str(dict(zip(v.tolist(), c.tolist()))))
    return set(v.tolist())


def check_outputs(names):
    allowed = {
        "landcover": set(NLCD_CLASSES) | {0},
        "protect": {g | (t << 4) | (o << 6) | (p << 7) for g in range(5) for t in range(4) for o in (0, 1) for p in (0, 1)},
        "agency": set(range(0, 14)),
        "wildfire": set(range(0, 256)),
        "whpclass": set(range(0, 8)),
        "state": None,
    }
    for n in names:
        with rasterio.open(OUT / f"{n}.tif") as r:
            assert r.transform == AFF, (n, r.transform)
            assert (r.height, r.width) == SHAPE and r.crs.to_epsg() == 5070, n
            assert r.dtypes[0] == "uint8" and r.nodata == 0
            arr = r.read(1)
        log(f"{n}: transform/shape/CRS == grid OK")
        vals = hist(n, arr) if n != "wildfire" else None
        if n == "wildfire":
            log(f"wildfire: zero cells {(arr == 0).sum()}, mean nonzero {arr[arr > 0].mean():.2f}, "
                f"p50/p99/max {np.percentile(arr[arr > 0], [50, 99]).tolist()} {arr.max()}")
        if n == "state":
            fips = sorted(v for v in np.unique(arr).tolist() if v)
            log(f"state: {len(fips)} FIPS: {fips}")
            assert len(fips) == 49, "expected 48 CONUS states + DC"
        elif vals is not None:
            assert vals <= allowed[n], (n, vals - allowed[n])
        if n == "landcover":
            assert NLCD_NODATA not in vals
            log(f"landcover: class 11 cells {(arr == 11).sum()}, zero cells {(arr == 0).sum()}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="state,protect,agency,whpclass,wildfire,landcover")
    names = ap.parse_args().only.split(",")
    known = {"state", "protect", "agency", "whpclass", "wildfire", "landcover", "easement", "preserve"}
    assert set(names) <= known, f"unknown --only names {sorted(set(names) - known)}"
    if "easement" in names and len(names) > 1 and not {"protect", "agency"} & set(names):
        raise SystemExit("--only easement cannot be combined with other bands unless protect/agency is among them "
                         "(it would silently drop the others); run them separately")
    OUT.mkdir(parents=True, exist_ok=True)
    meta_path = OUT / "bands_meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    meta["grid"] = G.grid_json()
    meta["tnc_choice"] = "Wind_EE"
    meta["agency_rule"] = AGENCY_RULE
    meta["bands"] = {
        "landcover": {"b": 1, "source": str(NLCD.relative_to(ROOT)), "vintage": "Annual NLCD C1V2 2025",
                      "licence": "public domain", "method": "mode of 30 m classes per 250 m cell (exact area overlap), nodata 250 masked"},
        "protect": {"b": 3, "source": [str(PADUS.relative_to(ROOT)), "data/raw/route/popwest/Category{1,2,3}_Wind_EE.tif"],
                    "vintage": "PAD-US 4.1 (Fee + Designation + Easement layers); PoPWest EnvExclusions (Zenodo 7460026)",
                    "easements": "PADUS4_1Easement GAP 1-4 folded into the GAP bits (min-GAP merge). PAD-US is the distributor of record for conservation-easement data: the National Conservation Easement Database (NCED) was discontinued in January 2025 and its records continue in PAD-US",
                    "nps_preserve": "PAD-US 4.1 PADUS4_1Fee " + G.NPS_PRESERVE_WHERE + " -> bit 7 (NPS unit named Preserve), centre rule, CONUS",
                    "licence": "PAD-US public domain; PoPWest CC BY 4.0, Wu et al. 2022 doi:10.5281/zenodo.7460026"},
        "agency": {"b": 4, "source": str(PADUS.relative_to(ROOT)), "vintage": "PAD-US 4.1", "licence": "public domain"},
        "wildfire": {"b": 5, "source": "data/raw/wildfire_hazard/whp2023_GeoTIF/whp2023_cnt_conus.tif",
                     "vintage": "WHP 2023", "licence": "public domain, RDS-2015-0047-4"},
        "whpclass": {"b": 6, "source": "data/raw/wildfire_hazard/whp2023_GeoTIF/whp2023_cls_conus.tif",
                     "vintage": "WHP 2023", "licence": "public domain, RDS-2015-0047-4"},
        "state": {"b": 8, "source": "data/build/us_states.gpkg", "vintage": "Census cartographic boundary 500k",
                  "licence": "public domain"},
    }
    state = None
    if any(n in names for n in ("protect", "agency", "preserve")) or "state" in names:
        if "state" in names or not (OUT / "state.tif").exists():
            state = build_state()
        else:
            state = rasterio.open(OUT / "state.tif").read(1)
    if "easement" in names and not {"protect", "agency"} & set(names):
        build_easement()
    if "preserve" in names and not {"protect", "agency"} & set(names):
        build_preserve(state)
    if "protect" in names or "agency" in names:
        meta["f33"] = build_protect_agency(state, names)
    if "whpclass" in names:
        build_whpclass()
    if "wildfire" in names:
        meta["cnt_max"] = build_wildfire()
    meta_path.write_text(json.dumps(meta, indent=2))
    if "landcover" in names:
        build_landcover()
    meta_path.write_text(json.dumps(meta, indent=2))
    check_outputs(checked_outputs(names, lambda n: (OUT / f"{n}.tif").exists()))
    log("done")


if __name__ == "__main__":
    main()
