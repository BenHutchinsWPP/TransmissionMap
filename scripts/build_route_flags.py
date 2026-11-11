#!/usr/bin/env python3
"""Route optimizer PD band b7 (flags, adj) and the osm file's two bands (flags, maxkv)
on the 250 m EPSG:5070 grid.

Role: writes uint8 GeoTIFFs (DEFLATE, 512 tiles, nodata 0) to data/build/route/250m/
{flags,osmflags,maxkv}.tif plus flags_meta.json (per-bit source, licence, vintage), then prints
the acceptance checks. OSM-derived bits live only in osmflags/maxkv (ODbL); flags.tif is PD + CC BY.
Deps: scripts/route_grid.py (transform, shape, bit tables); numpy, rasterio, geopandas, pyogrio;
the osmium CLI. Inputs: tribal_lands.gpkg (TIGER AIANNH), BIA LAR, PAD-US DOD
(data/build/route/inputs), FAA airports/runways, crithab polygons + CRITHAB_LINE (_Archive zip), Section 368, the HIFLD mirror NID dams + FCC ASR towers, WorldPop 1 km counts,
the North America PBF, transmission_lines_na.gpkg, transmission_hifld.gpkg, hifld_natgas_lines.gpkg,
pipeline_lines_na_processed.gpkg, BTS NARN geojson; state.tif/landcover.tif for the checks.

OSM extraction is staged under <cache>/route-osm/ on an external disk (tags-filter of the
North America PBF, smart extract to the CONUS bbox, one slim geojsonseq per theme, streamed into the rasterizer); stages are skipped when
their output exists. Usage: venv/bin/python scripts/build_route_flags.py [--only pd,osm|checks|adj]
[--check-against <dir>] [--out-dir <dir>]
--out-dir <dir> reads and writes the bands there instead of data/build/route/250m (a trial build).
--check-against <dir> (an earlier build directory) asserts the new bands against that
earlier build's flags.tif/adj.tif (bits 0,2,4,5 identical, bit 3 a superset, adj bits 0-1 and 4-6 identical); off by default.
Run under systemd-run MemoryMax with TMPDIR/CPL_TMPDIR=tmp/build-tmp.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio
import rasterio
import shapely.geometry
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import Affine
from rasterio.warp import reproject, transform_bounds
from rasterio.windows import from_bounds

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/build/route/250m"
CHECK_AGAINST = None  # --check-against <dir>: earlier build to assert against
CACHE = Path(os.environ.get("ROUTE_CACHE") or ROOT / "data/raw/route-cache") / "route-osm"
PBF = ROOT / "data/raw/osm/north-america-latest.osm.pbf"
B = ROOT / "data/build"
AFF = Affine.from_gdal(*G.transform())
SHAPE = (G.ROWS, G.COLS)
CONUS_BBOX = (-130.0, 21.0, -60.0, 52.0)  # lon/lat, generous; the grid clips the rest
BUF_AIRPORT_M = 5000
POP_THRESHOLD = 38.6  # people per km2 = 100 per mi2
WEST_FIPS = [4, 6, 8, 16, 30, 32, 35, 41, 49, 53, 56]
NOT_RIVER = ("river", "canal", "stream", "ditch", "wastewater", "reflecting_pool")
NOT_GAS = ("aqueduct", "siphon", "penstock", "water", "substation")
CRITHAB_ZIP = ROOT / "_Archive/crithab_all_layers.zip"
CRITHAB_LINE_LAYER = f"/vsizip/{CRITHAB_ZIP}/CRITHAB_LINE.shp"
MIRROR = Path(os.environ.get("HIFLD_MIRROR") or ROOT / "data/raw/hifld-mirror")
NID_PARQUET = MIRROR / "national-inventory-of-dams-nid/national-inventory-of-dams/national-inventory-of-dams.parquet"
ASR_PARQUET = MIRROR / "antenna-structure-registration-asr/asr/asr.parquet"
DAM_HAZARD_CLASSES = ("high", "significant")  # NID HAZARD_POTENTIAL, compared case-insensitively
TOWER_MIN_HEIGHT_M = 61.0  # ASR Strucht, metres (200 ft, FAA marking threshold)
STRUCTURE_BUFFER_M = 100
MIRTA_STATUS_KEPT = ("act", "semi", "care")  # SITEOPERATIONALSTATUS; clsd and excs dropped
MIRROR_LICENCE = ("underlying data: federal / FCC public record; mirror packaging CC BY 4.0 "
                  "(SeerAI, source.coop hifld mirror 2026-10-17)")

t0 = time.time()


def log(*a):
    print(f"[{time.time() - t0:7.0f}s]", *a, flush=True)


def write(name, arr):
    OUT.mkdir(parents=True, exist_ok=True)
    assert arr.dtype == np.uint8 and arr.shape == SHAPE
    prof = dict(driver="GTiff", dtype="uint8", count=1, width=G.COLS, height=G.ROWS, crs=G.CRS,
                transform=AFF, nodata=0, tiled=True, blockxsize=G.BLOCK, blockysize=G.BLOCK,
                compress="deflate", predictor=2, BIGTIFF="IF_SAFER")
    with rasterio.open(OUT / f"{name}.tif", "w", **prof) as dst:
        dst.write(arr, 1)
    log(f"wrote {name}.tif {(OUT / f'{name}.tif').stat().st_size / 1e6:.1f} MB")


def read5070(path, layer=None, where=None, columns=None, bbox=CONUS_BBOX):
    """Vector layer -> EPSG:5070 GeoDataFrame, bbox given in lon/lat, invalid polygons repaired."""
    src_crs = pyogrio.read_info(path, layer=layer)["crs"]
    bb = bbox
    if src_crs and "4326" not in src_crs and "4269" not in src_crs:
        bb = transform_bounds("EPSG:4326", src_crs, *bbox, densify_pts=21)
    gdf = pyogrio.read_dataframe(path, layer=layer, where=where, columns=columns, bbox=bb)
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    gdf = gdf.to_crs(G.CRS)
    if (gdf.geom_type.isin(["Polygon", "MultiPolygon"])).any():
        bad = ~gdf.geometry.is_valid
        gdf.loc[bad, "geometry"] = gdf.loc[bad, "geometry"].buffer(0)
    return gdf


def burn(geoms, all_touched, value=1):
    """One bit's own temp array."""
    arr = np.zeros(SHAPE, np.uint8)
    geoms = [g for g in geoms if g is not None and not g.is_empty]
    for i in range(0, len(geoms), 50000):
        rasterize(((g, value) for g in geoms[i:i + 50000]), out=arr, transform=AFF,
                  all_touched=all_touched, default_value=value)
    return arr


def is_hazardous_dam(hazard):
    """NID HAZARD_POTENTIAL is High or Significant (case-insensitive, whitespace ignored)."""
    return str(hazard or "").strip().lower() in DAM_HAZARD_CLASSES


def is_tall_tower(height_m):
    """ASR Strucht (metres) at or above TOWER_MIN_HEIGHT_M; missing or non-numeric is not tall."""
    try:
        return float(height_m) >= TOWER_MIN_HEIGHT_M
    except (TypeError, ValueError):
        return False


def merge_meta(old, new):
    """New keys replace old ones of the same name; keys this run did not produce are kept."""
    return {**old, **new}


def log_bit(name, arr):
    log(f"  {name}: {int(arr.sum())} cells")


# ---------------------------------------------------------------- PD flags
def worldpop_bit():
    """bit5: WorldPop 1 km counts -> density per km2 at the source cell's true area (ellipsoid
    zone area at its latitude), thresholded 38.6/km2, then warped (nearest) to the 250 m grid."""
    src_path = ROOT / "data/raw/population/ppp_2020_1km_Aggregated.tif"
    with rasterio.open(src_path) as r:
        lon0, lat0, lon1, lat1 = CONUS_BBOX
        win = from_bounds(lon0, lat0, lon1, lat1, r.transform).round_offsets().round_lengths()
        cnt = r.read(1, window=win, masked=True).astype("float64")
        tr = r.window_transform(win)
        log(f"  WorldPop res={r.res} nodata={r.nodata} window={cnt.shape}")
    R = 6371007.2  # authalic radius; cell area = R^2 * dlon * (sin lat_n - sin lat_s)
    rows = np.arange(cnt.shape[0])
    lat_n = np.radians(tr.f + rows * tr.e)
    lat_s = np.radians(tr.f + (rows + 1) * tr.e)
    area_km2 = (R ** 2 * np.radians(tr.a) * (np.sin(lat_n) - np.sin(lat_s)) / 1e6)[:, None]
    dens = (cnt / area_km2).filled(0)
    flag = (dens > POP_THRESHOLD).astype(np.uint8)
    dst = np.zeros(SHAPE, np.uint8)
    reproject(flag, dst, src_transform=tr, src_crs="EPSG:4326", dst_transform=AFF, dst_crs=G.CRS,
              resampling=Resampling.nearest, init_dest_nodata=True, warp_mem_limit=512)
    return dst


def structure_points():
    """High/Significant-hazard NID dams + ASR structures >= TOWER_MIN_HEIGHT_M, on the CONUS grid's land.
    Returns (EPSG:5070 point GeoSeries, counts)."""
    box = CONUS_BBOX
    nid = gpd.read_parquet(NID_PARQUET, columns=["HAZARD_POTENTIAL", "geometry"], bbox=box)
    asr = gpd.read_parquet(ASR_PARQUET, columns=["Strucht", "geometry"], bbox=box)
    counts = {"nid_rows_in_bbox": len(nid), "asr_rows_in_bbox": len(asr)}
    dams = nid[nid["HAZARD_POTENTIAL"].map(is_hazardous_dam)]
    towers = asr[asr["Strucht"].map(is_tall_tower)]
    counts.update(dams_selected=len(dams), towers_selected=len(towers))
    pts = pd.concat([dams.geometry, towers.geometry], ignore_index=True)
    pts = gpd.GeoSeries(pts, crs=nid.crs or "EPSG:4326")
    pts = pts[pts.notna() & ~pts.is_empty].to_crs(G.CRS)
    rows, cols = rasterio.transform.rowcol(AFF, pts.x.values, pts.y.values)
    rows, cols = np.asarray(rows), np.asarray(cols)
    ingrid = (rows >= 0) & (rows < G.ROWS) & (cols >= 0) & (cols < G.COLS)
    keep = ingrid.copy()
    sp = OUT / "state.tif"
    with rasterio.open(sp) as r:  # a missing state.tif raises
        land = r.read(1) > 0
    keep[ingrid] = land[rows[ingrid], cols[ingrid]]
    counts.update(points=len(pts), kept=int(keep.sum()), dropped_off_grid=int((~ingrid).sum()),
                  dropped_off_land=int((ingrid & ~keep).sum()), land_mask_applied=True)
    log(f"  structures: {counts}")
    return pts[keep], counts


def build_pd():
    bits = {}
    old = None
    if CHECK_AGAINST:
        with rasterio.open(CHECK_AGAINST / "flags.tif") as r:
            old = r.read(1)
    tr = read5070(B / "tribal_lands.gpkg")
    log("  tribal area_type values:", sorted(tr["area_type"].unique()))
    tr = tr[~tr["area_type"].str.contains("Statistical", na=False)]
    log(f"  tribal kept (no Statistical areas): {len(tr)} rows, {sorted(tr['area_type'].unique())}")
    bia = read5070(ROOT / "data/raw/bia/bia_aian_national_lar.geojson")
    bits[0] = burn(list(tr.geometry) + list(bia.geometry), False)
    mil = read5070(B / "route/inputs/padus_dod.gpkg")
    mirta = read5070(ROOT / "data/raw/route/mirta/mirta_boundaries.geojson", columns=["SITEOPERATIONALSTATUS"])
    mstat = mirta["SITEOPERATIONALSTATUS"].fillna("").str.strip().str.lower()
    log("  MIRTA status values in bbox:", mstat.value_counts().to_dict())
    mirta = mirta[mstat.isin(MIRTA_STATUS_KEPT)]
    log(f"  MIRTA kept ({', '.join(MIRTA_STATUS_KEPT)}): {len(mirta)} features")
    bits[1] = burn(list(mil.geometry) + list(mirta.geometry), True)
    parks = read5070(B / "route/inputs/padus_gap_agency.gpkg", layer="PADUS4_1Fee",
                     where="Des_Tp IN ('SP','LP') AND GAP_Sts IN ('3','4')")
    log(f"  state/local parks GAP 3-4: {len(parks)} features, {parks['Des_Tp'].value_counts().to_dict()}")
    bits[6] = burn(list(parks.geometry), False)
    ap = read5070(ROOT / "data/raw/route/faa/airports_public.geojson")
    rw = read5070(ROOT / "data/raw/route/faa/runways.geojson")
    rw = rw[rw["AIRPORT_ID"].isin(set(ap["GLOBAL_ID"]))]
    log(f"  airports {len(ap)}, runways joined {len(rw)}")
    bits[2] = burn(list(ap.geometry.buffer(BUF_AIRPORT_M)) + list(rw.geometry.buffer(BUF_AIRPORT_M)), True)
    ch = read5070(ROOT / "data/raw/crithab/crithab_poly.shp")
    log("  crithab status values:", ch["status"].value_counts().to_dict())
    ch = ch[ch["status"] == "Final"]
    poly3 = burn(list(ch.geometry), False)
    cl = read5070(CRITHAB_LINE_LAYER, columns=["status"])
    log("  crithab line status values:", cl["status"].value_counts().to_dict())
    cl = cl[cl["status"] == "Final"]
    line3 = burn(list(cl.geometry), True)
    log(f"  crithab lines Final: {len(cl)} features, {int(line3.sum())} cells all-touched; polygons {int(poly3.sum())} cells")
    bits[3] = poly3 | line3
    pts, scount = structure_points()
    bits[7] = burn(list(pts.buffer(STRUCTURE_BUFFER_M)), True)
    s368 = read5070(ROOT / "data/raw/route/sec368/unzipped/Section368Corridors/Shapefiles/Sec368_Energy_Corridor.shp")
    bits[4] = burn(list(s368.geometry), False)
    bits[5] = worldpop_bit()
    flags = np.zeros(SHAPE, np.uint8)
    for b, a in bits.items():
        log_bit(G.PD_FLAGS[b], a)
        flags |= (a << b).astype(np.uint8)
    if old is not None:  # acceptance against the previous flags.tif
        same = [b for b in (0, 2, 4, 5) if np.array_equal((old >> b) & 1, bits[b])]
        log(f"  bits identical to previous flags.tif (want 0,2,4,5): {same}")
        assert same == [0, 2, 4, 5], f"bits changed against {CHECK_AGAINST}: identical {same}"
        o3 = ((old >> 3) & 1).astype(bool)
        added = bits[3].astype(bool) & ~o3
        assert not (o3 & ~bits[3].astype(bool)).any(), "new bit 3 is not a superset of the old bit 3"
        assert not (added & ~line3.astype(bool)).any(), "bit 3 gained cells outside the lines' mask"
        o1 = ((old >> 1) & 1).astype(bool)
        assert not (o1 & ~bits[1].astype(bool)).any(), "new bit 1 is not a superset of the old bit 1"
        o6 = ((old >> 6) & 1).astype(bool)
        assert not o6.any() or np.array_equal(o6, bits[6].astype(bool)), "old bit 6 was set and differs from the new bit 6"
        log(f"  bit 1 superset OK: +{int((bits[1].astype(bool) & ~o1).sum())} cells; old bit 6 {'empty' if not o6.any() else 'identical'}")
        log(f"  bit 3 superset OK: +{int(added.sum())} cells, all inside the lines' all-touched mask")
    write("flags", flags)
    info = {"crithab_line_features": len(cl), "crithab_line_cells": int(line3.sum()),
            "crithab_polygon_cells": int(poly3.sum()), "structures": scount}
    return {b: int(a.sum()) for b, a in bits.items()}, info


# ---------------------------------------------------------------- OSM staging
def sh(cmd):
    log("$", " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True)


THEMES = {  # name -> (tags-filter expressions, tags kept in the export)
    "water": (["w/natural=water", "r/natural=water"], ["natural", "water"]),
    "lines": (["w/waterway=river", "w/highway=motorway,trunk,primary,motorway_link,trunk_link,primary_link"],
              ["waterway", "highway"]),
    "military": (["w/landuse=military", "r/landuse=military"], ["landuse"]),
}


def stage_osm():
    """tags-filter -> smart extract (CONUS bbox) -> one slim geojsonseq per theme; returns paths."""
    CACHE.mkdir(parents=True, exist_ok=True)
    filt, ext = CACHE / "na_filtered.osm.pbf", CACHE / "conus_filtered.osm.pbf"
    if not filt.exists() or filt.stat().st_size == 0:
        part = filt.with_name(filt.name + ".part")
        part.unlink(missing_ok=True)
        sh(["osmium", "tags-filter", PBF, "w/natural=water", "r/natural=water", "w/waterway=river",
            "w/highway=motorway,trunk,primary,motorway_link,trunk_link,primary_link",
            "w/landuse=military", "r/landuse=military", "-o", part, "-f", "pbf", "--overwrite"])
        part.rename(filt)
    if not ext.exists():
        b = ",".join(str(x) for x in CONUS_BBOX)
        part = ext.with_name(ext.name + ".part")
        part.unlink(missing_ok=True)
        sh(["osmium", "extract", "-b", b, "-s", "smart", filt, "-o", part, "-f", "pbf", "--overwrite"])
        part.rename(ext)
    out = {}
    for name, (exprs, tags) in THEMES.items():
        pbf, seq, cfg = (CACHE / f"conus_{name}.{x}" for x in ("osm.pbf", "geojsonseq", "json"))
        out[name] = seq
        if seq.exists():
            continue
        cfg.write_text(json.dumps({"include_tags": tags}))
        sh(["osmium", "tags-filter", ext, *exprs, "-o", pbf, "--overwrite"])
        part = seq.with_name(seq.name + ".part")
        part.unlink(missing_ok=True)
        sh(["osmium", "export", pbf, "-f", "geojsonseq", "-c", cfg, "-o", part, "--overwrite",
            f"--geometry-types={'linestring' if name == 'lines' else 'polygon'}"])
        part.rename(seq)
        pbf.unlink()
    return out


def burn_seq(seq, accept, all_touched, kind, batch=100000):
    """Stream a geojsonseq, keep features whose properties pass accept(props) and whose geometry is of `kind`
    ("polygon" or "line"), burn into one array."""
    want = ("Polygon", "MultiPolygon") if kind == "polygon" else ("LineString", "MultiLineString")
    arr = np.zeros(SHAPE, np.uint8)
    geoms, n, kept = [], 0, 0

    def flush():
        if geoms:
            g = gpd.GeoSeries(geoms, crs=4326).to_crs(G.CRS)
            g = g[g.notna() & ~g.is_empty]
            rasterize(((x, 1) for x in g), out=arr, transform=AFF, all_touched=all_touched)
            geoms.clear()

    with open(seq, "rb") as fh:
        for line in fh:
            line = line.strip(b"\x1e \n")
            if not line:
                continue
            n += 1
            f = json.loads(line)
            if not accept(f.get("properties") or {}):
                continue
            g = shapely.geometry.shape(f["geometry"])
            if g.geom_type not in want:
                continue
            if g.geom_type in ("Polygon", "MultiPolygon") and not g.is_valid:
                g = g.buffer(0)
            geoms.append(g)
            kept += 1
            if len(geoms) >= batch:
                flush()
    flush()
    log(f"  {Path(seq).name}: {n} features, {kept} burned")
    return arr


def kv_of(voltage, nominal):
    """max kV across ';'-separated OSM voltages (V), falling back to nominal_kv."""
    best = 0.0
    for tok in re.split(r"[;,]", str(voltage or "")):
        try:
            v = float(tok)
        except ValueError:
            continue
        best = max(best, v / 1000.0 if v >= 1000 else v)
    return best if best > 0 else max(float(nominal or 0), 0.0)


def line_kv():
    """[(geometry, kV)] for existing lines: OSM (no busbar/bay/internal/substation) + HIFLD."""
    o = read5070(B / "transmission_lines_na.gpkg",
                 columns=["voltage", "nominal_kv", "line_type", "is_undergrnd"])
    o = o[~o["line_type"].isin(["busbar", "bay", "internal", "substation"])]
    o["kv"] = [kv_of(v, n) for v, n in zip(o["voltage"], o["nominal_kv"])]
    h = read5070(B / "transmission_hifld.gpkg", columns=["VOLTAGE", "VOLT_CLASS", "STATUS"])
    h = h[~h["STATUS"].isin(["INACTIVE", "UNDER CONSTRUCTION"])]
    cls = h["VOLT_CLASS"].map({"345": 345.0, "500": 500.0, "735 AND ABOVE": 735.0,
                               "100-161": 100.0, "220-287": 220.0})
    h["kv"] = pd.to_numeric(h["VOLTAGE"], errors="coerce").fillna(cls).fillna(0)
    h.loc[h["VOLT_CLASS"] == "DC", "kv"] /= 2  # pole-to-pole -> pole voltage
    h.loc[h["kv"] < 0, "kv"] = 0
    log(f"  lines: OSM {len(o)} ({(o.kv > 0).sum()} with kV), HIFLD {len(h)} ({(h.kv > 0).sum()} with kV)")
    return pd.concat([o[["geometry", "kv"]], h[["geometry", "kv"]]], ignore_index=True)


def build_osm():
    seqs = stage_osm()
    bits = {
        0: burn_seq(seqs["water"], lambda p: p.get("natural") == "water" and p.get("water") not in NOT_RIVER + ("basin",), False, "polygon"),
        1: burn_seq(seqs["lines"], lambda p: p.get("waterway") == "river", True, "line"),
        4: burn_seq(seqs["lines"], lambda p: "highway" in p, True, "line"),
        7: burn_seq(seqs["military"], lambda p: p.get("landuse") == "military", True, "polygon"),
    }
    lk = line_kv()
    lk.loc[lk.kv > 800, "kv"] = 0  # > 800 kV is unknown
    lk = lk[lk.kv >= 100]
    bits[2] = burn(list(lk.geometry[lk.kv >= 230]), True)
    bits[3] = burn(list(lk.geometry[(lk.kv >= 100) & (lk.kv < 230)]), True)
    # maxkv: ascending kV, later burns replace earlier, so each cell keeps its maximum
    lk = lk.sort_values("kv")
    maxkv = np.zeros(SHAPE, np.uint8)
    codes = np.minimum(np.maximum(np.rint(lk.kv / G.OSM_MAXKV_DIV), 1), G.OSM_MAXKV_CAP).astype(int)
    for code in np.unique(codes):
        sel = lk.geometry[(codes == code).values]
        rasterize(((g, int(code)) for g in sel if g is not None and not g.is_empty), out=maxkv,
                  transform=AFF, all_touched=True)
    rail = read5070(ROOT / "data/raw/railroads/narn_rail_lines.geojson", columns=["COUNTRY"])
    bits[5] = burn(list(rail.geometry), True)
    gas = read5070(B / "hifld_natgas_lines.gpkg", columns=["pipe_type"])
    op = read5070(B / "pipeline_lines_na_processed.gpkg", columns=["pipeline", "substance"])
    op = op[~op["pipeline"].isin(NOT_GAS) & ~op["substance"].isin(["water", "sewage", "wastewater"])]
    log(f"  pipelines: HIFLD {len(gas)}, OSM {len(op)}")
    bits[6] = burn(list(gas.geometry) + list(op.geometry), True)
    flags = np.zeros(SHAPE, np.uint8)
    for b, a in bits.items():
        log_bit(G.OSM_FLAGS[b], a)
        flags |= (a << b).astype(np.uint8)
    write("osmflags", flags)
    write("maxkv", maxkv)
    return {b: int(a.sum()) for b, a in bits.items()}, bits, maxkv


# ---------------------------------------------------------------- checks
def checks(pd_counts, osm_bits, maxkv):
    with rasterio.open(OUT / "state.tif") as r:
        state = r.read(1)
    land = state > 0
    n = int(land.sum())
    log(f"CONUS land cells (state>0): {n}")
    for name in ("flags", "osmflags", "maxkv"):
        with rasterio.open(OUT / f"{name}.tif") as r:
            assert r.transform == AFF and (r.height, r.width) == SHAPE and r.crs.to_string() == G.CRS, name
    log("grid assert OK (transform/shape/CRS) for flags, osmflags, maxkv")
    for label, tbl, src in (("PD", G.PD_FLAGS, None), ("OSM", G.OSM_FLAGS, osm_bits)):
        with rasterio.open(OUT / ("flags.tif" if label == "PD" else "osmflags.tif")) as r:
            arr = r.read(1)
        for b, nm in tbl.items():
            cells = int((((arr >> b) & 1).astype(bool) & land).sum())
            log(f"  {label} bit{b} {nm}: {cells} cells in land = {100 * cells / n:.2f}% of land")
            if label == "PD" and b == 2:
                assert 100 * cells / n < 6, "airport bit >= 6% of land"
    lkm = ((maxkv > 0) & land).sum()
    log(f"  maxkv > 0: {int(lkm)} cells = {100 * lkm / n:.2f}% of land; max code {int(maxkv.max())} (= {int(maxkv.max()) * G.OSM_MAXKV_DIV} kV), cells with code >= 161 (> 800 kV): {int((maxkv >= 161).sum())}")
    assert int((maxkv >= 161).sum()) == 0, "maxkv has > 800 kV codes"
    with rasterio.open(OUT / "landcover.tif") as r:
        nlcd11 = r.read(1) == 11
    lake = osm_bits[0].astype(bool)
    west = np.isin(state, WEST_FIPS)
    for label, m in (("CONUS", land), ("west", west)):
        a, b = int((lake & m).sum()), int((nlcd11 & m).sum())
        log(f"  lake bit vs NLCD 11 ({label}): OSM {a} cells, NLCD {b} cells, ratio {a / max(b, 1):.2f}")


def osm_vintage():
    """PBF header timestamp (date), else the file's mtime."""
    r = subprocess.run(["osmium", "fileinfo", "-g", "header.option.timestamp", str(PBF)],
                       capture_output=True, text=True)
    ts = r.stdout.strip()[:10]
    return ts if r.returncode == 0 and re.fullmatch(r"\d{4}-\d\d-\d\d", ts) else \
        time.strftime("%Y-%m-%d", time.gmtime(PBF.stat().st_mtime))


def shifted_or(a, offsets):
    """OR of `a` shifted by every (dy, dx) in offsets (cells beyond the grid edge read False); bool in, bool out."""
    out = np.zeros_like(a)
    h, w = a.shape
    for dy, dx in offsets:
        out[max(dy, 0):h + min(dy, 0), max(dx, 0):w + min(dx, 0)] |= \
            a[max(-dy, 0):h + min(-dy, 0), max(-dx, 0):w + min(-dx, 0)]
    return out


def ring_class(line):
    """Ring class of a bool line mask: 1 on the line cell, 2 within 1 cell (8-neighbour ring),
    3 within 3 cells (Euclidean disk r = 3), 0 beyond."""
    ring1 = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
    disk3 = [(dy, dx) for dy in range(-3, 4) for dx in range(-3, 4) if dy * dy + dx * dx <= 9]
    d1 = shifted_or(line, ring1)
    d3 = shifted_or(line, disk3)
    return np.where(line, 1, np.where(d1, 2, np.where(d3, 3, 0))).astype(np.uint8)


def build_adj():
    """osm b3 adj: ring class around >= 230 kV lines (osmflags bit 2) in bits 0-1, around 100-229 kV lines
    (osmflags bit 3) in bits 5-6; bits 2 / 3 on or within 1 cell of a >= 345 / >= 500 kV line cell
    (maxkv code); bit 4 = computed, so value != 0 everywhere on the grid."""
    with rasterio.open(OUT / "osmflags.tif") as r:
        of = r.read(1)
    on230 = ((of >> 2) & 1).astype(bool)
    cls = ring_class(on230)
    cls100 = ring_class(((of >> 3) & 1).astype(bool))
    del of
    with rasterio.open(OUT / "maxkv.tif") as r:
        maxkv = r.read(1)
    ring1 = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
    adj = (G.ADJ_COMPUTED_BIT | cls | (cls100 << G.ADJ100_SHIFT)).astype(np.uint8)
    near = {}
    for bit, kv in G.ADJ_KV_TIERS.items():
        line = maxkv >= kv // G.OSM_MAXKV_DIV
        stray = int((line & ~on230).sum())
        log(f"adj >= {kv} kV: {int(line.sum()):,} line cells ({stray} not on a >= 230 kV cell)")
        assert stray == 0, f">= {kv} kV line cells outside the >= 230 kV line cells"
        near[bit] = shifted_or(line, ring1)
        adj |= (near[bit] << bit).astype(np.uint8)
    del maxkv, on230
    assert all(G.adj_encode(c, c2) == (16 | c | c2 << 5) for c in range(4) for c2 in range(4))
    assert G.adj_encode(1, 0, True, True) == 16 | 1 | 4 | 8
    if CHECK_AGAINST:  # the >= 230 kV and 100-229 kV classes must not change
        with rasterio.open(CHECK_AGAINST / "adj.tif") as r:
            prev = r.read(1)
        keep = G.ADJ_COMPUTED_BIT | G.ADJ_CLASS_MASK | G.ADJ100_MASK
        same = np.array_equal(prev & keep, adj & keep)
        log(f"adj classes (bits 0-1, 4-6) byte-identical to previous adj.tif: {same}")
        assert same, "adj >= 230 kV or 100-229 kV class changed"
        del prev
    with rasterio.open(OUT / "state.tif") as r:
        land = r.read(1) > 0
    nland = int(land.sum())
    shares, shares100, shares_kv = {}, {}, {}
    for c in range(4):
        for tag, arr, dst in (("", cls, shares), (" 100-229 kV", cls100, shares100)):
            n = int(((arr == c) & land).sum())
            dst[c] = n
            log(f"adj{tag} class {c} ({G.ADJ_CLASSES[c]}): {n:,} land cells = {100 * n / nland:.3f} % of CONUS land (all cells {int((arr == c).sum()):,})")
    for bit, kv in G.ADJ_KV_TIERS.items():
        n = int((near[bit] & land).sum())
        shares_kv[kv] = n
        log(f"adj bit {bit} (on/beside >= {kv} kV): {n:,} land cells = {100 * n / nland:.3f} % of CONUS land")
    write("adj", adj)
    with rasterio.open(OUT / "adj.tif") as r:
        assert r.transform == AFF and (r.height, r.width) == SHAPE and r.crs.to_epsg() == 5070
        assert r.dtypes[0] == "uint8" and r.nodata == 0
        a = r.read(1)
    assert a.max() <= G.ADJ_MAX and (a & 16).all() and not (a & G.ADJ_RESERVED_MASK).any()
    b2, b3, c = (a >> G.ADJ345_BIT) & 1, (a >> G.ADJ500_BIT) & 1, a & G.ADJ_CLASS_MASK
    assert not (b3 & ~b2).any(), ">= 500 kV bit without the >= 345 kV bit"
    assert np.isin(c[b2 == 1], (1, 2)).all(), ">= 345 kV bit outside >= 230 kV classes 1-2"
    log("adj: transform/shape/CRS/dtype/nodata == grid OK; values " + str(np.unique(a).tolist()))
    mp = OUT / "flags_meta.json"
    m = json.loads(mp.read_text()) if mp.exists() else {}
    m["osm_b3_adj"] = {"rule": "bits 0-1: class 1 on a >= 230 kV line cell (osm b1 bit 2), 2 Chebyshev <= 1 cell, 3 Euclidean <= 3 cells; bits 5-6: the same rings around 100-229 kV line cells (osm b1 bit 3); bit 2: on or Chebyshev <= 1 cell from a cell with osm b2 maxkv >= 69 (>= 345 kV), bit 3 the same for maxkv >= 100 (>= 500 kV); bit 4 = computed (+16)",
                       "licence": "derived from osm b1 and b2: ODbL, (c) OpenStreetMap contributors; HIFLD public domain (osm file only)",
                       "land_cells_by_class": shares, "land_cells_by_class_100_229": shares100,
                       "land_cells_on_beside_kv": shares_kv}
    mp.write_text(json.dumps(m, indent=1))


def meta(only, pd_counts, osm_counts, pd_info=None):
    """The meta keys this run produced (`only` = the steps run); main merges them into flags_meta.json."""
    now = time.strftime("%Y-%m-%d")
    vint = osm_vintage() if "osm" in only else "unused"
    pd_src = {
        0: ("Census TIGER/Line AIANNH 2026 (data/build/tribal_lands.gpkg), area_type containing 'Statistical' dropped (reservation/trust/home-land classes kept) + BIA LAR national", "public domain", "2026 / BIA LAR"),
        1: ("PAD-US 4.1 Proclamation Mang_Name=DOD (data/build/route/inputs/padus_dod.gpkg) + DoD DISDI MIRTA 'DoD Sites - Boundary' (data/raw/route/mirta/mirta_boundaries.geojson) with SITEOPERATIONALSTATUS act / semi / care, all-touched", "public domain", "PAD-US 4.1; MIRTA fetched per data/raw/route/mirta"),
        2: ("FAA ADDS airports (public-use AD, PRIVATEUSE=0) + runways joined by AIRPORT_ID, buffer 5 km", "public domain", "FAA ADDS, fetched per data/raw/route/faa"),
        3: ("USFWS critical habitat polygons, status=Final only, Proposed dropped (data/raw/crithab/crithab_poly.shp) polygons, centre rule, plus CRITHAB_LINE (crithab_all_layers.zip, status=Final) lines, all-touched, no buffer", "public domain", "crithab_poly.shp + CRITHAB_LINE"),
        4: ("DOE/ANL Section 368 energy corridors (Sec368_Energy_Corridor)", "public domain", "Section368Corridors.zip"),
        5: ("WorldPop 2020 1 km aggregated counts, density = count / true cell area, > 38.6 per km2", "CC BY 4.0", "ppp_2020_1km_Aggregated"),
        6: ("PAD-US 4.1 Fee Des_Tp SP (state park) or LP (local park) with GAP_Sts 3 or 4, centre rule", "public domain", "PAD-US 4.1"),
        7: (f"NID dams with HAZARD_POTENTIAL High or Significant (case-insensitive) + FCC ASR structures with Strucht >= {TOWER_MIN_HEIGHT_M} m, "
            f"CONUS grid land only, buffer {STRUCTURE_BUFFER_M} m, all-touched ({NID_PARQUET.relative_to(MIRROR)}; {ASR_PARQUET.relative_to(MIRROR)})",
            MIRROR_LICENCE, MIRROR.name),
    }
    osm_src = {
        0: ("OSM natural=water polygons minus water=river|canal|stream|ditch|wastewater|reflecting_pool|basin (polygon geometries only)", "ODbL, (c) OpenStreetMap contributors", "north-america-latest.osm.pbf 2026-10-11"),
        1: ("OSM waterway=river lines", "ODbL, (c) OpenStreetMap contributors", "2026-10-11"),
        2: ("existing lines >= 230 kV: OSM power lines (transmission_lines_na.gpkg) + HIFLD transmission", "OSM ODbL (c) OpenStreetMap contributors; HIFLD public domain", "OSM 2026-10-11; HIFLD frozen copy"),
        3: ("existing lines 100-229 kV: OSM + HIFLD", "OSM ODbL (c) OpenStreetMap contributors; HIFLD public domain", "OSM 2026-10-11; HIFLD frozen copy"),
        4: ("OSM highway=motorway|trunk|primary and their _link ways", "ODbL, (c) OpenStreetMap contributors", "2026-10-11"),
        5: ("BTS NARN rail lines (data/raw/railroads/narn_rail_lines.geojson; no status field, all lines)", "public domain", "NARN 2026"),
        6: ("HIFLD natural gas lines + OSM pipelines (aqueduct/siphon/penstock/water/substation and water substances dropped)", "OSM ODbL (c) OpenStreetMap contributors; HIFLD public domain", "OSM 2026-10-11; HIFLD frozen copy"),
        7: ("OSM landuse=military polygons", "ODbL, (c) OpenStreetMap contributors", "2026-10-11"),
    }
    osm_src = {b: tuple(x.replace("2026-10-11", vint) for x in v) for b, v in osm_src.items()}
    pack = lambda tbl, src, counts: {str(b): dict(name=tbl[b], source=s[0], licence=s[1], vintage=s[2],
                                                  cells=counts.get(b)) for b, s in src.items()}
    out = {"built": now, "grid": G.grid_json(),
           "rules": "lines/airports/military ALL_TOUCHED, polygons centre rule; bit = own array, OR-combined"}
    if "pd" in only:
        out["flags_pd_b7"] = pack(G.PD_FLAGS, pd_src, pd_counts)
        out["flags_pd_b7_inputs"] = {"built": now, "tower_min_height_m": TOWER_MIN_HEIGHT_M,
                                     "dam_hazard_classes": list(DAM_HAZARD_CLASSES),
                                     "structure_buffer_m": STRUCTURE_BUFFER_M, **(pd_info or {})}
    if "osm" in only:
        out.update(osm_vintage=vint, osm_b1_flags=pack(G.OSM_FLAGS, osm_src, osm_counts),
                   osm_b2_maxkv={"rule": "max existing-line kV in cell / 5, capped 255; code >= 1 for any >= 100 kV line",
                                 "min_kv_included": 100, "licence": osm_src[2][1]},
                   maxkv_rules="HIFLD VOLT_CLASS DC uses VOLTAGE/2; kV > 800 treated as unknown (dropped)")
    return out


def main():
    global CHECK_AGAINST, OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="pd,osm,adj")
    ap.add_argument("--check-against", type=Path, default=None)
    ap.add_argument("--out-dir", type=Path, default=OUT)
    a = ap.parse_args()
    only = set(a.only.split(","))
    CHECK_AGAINST = a.check_against
    OUT = a.out_dir
    OUT.mkdir(parents=True, exist_ok=True)
    pdc, oc, bits, maxkv, pd_info = {}, {}, None, None, None
    if "pd" in only:
        pdc, pd_info = build_pd()
    if "osm" in only:
        oc, bits, maxkv = build_osm()
    if "adj" in only:
        build_adj()
        if not only - {"adj"}:
            return
    if "checks" in only:  # re-run the acceptance prints from the written GeoTIFFs
        with rasterio.open(OUT / "osmflags.tif") as r:
            of = r.read(1)
        with rasterio.open(OUT / "maxkv.tif") as r:
            maxkv = r.read(1)
        bits = {b: (of >> b) & 1 for b in G.OSM_FLAGS}
        checks({}, bits, maxkv)
        return
    if "osm" in only and (OUT / "flags.tif").exists():
        if not pdc:
            with rasterio.open(OUT / "flags.tif") as r:
                fl = r.read(1)
            pdc = {b: int(((fl >> b) & 1).sum()) for b in G.PD_FLAGS}
        checks(pdc, bits, maxkv)
    if only & {"pd", "osm"}:
        mp = OUT / "flags_meta.json"
        old = json.loads(mp.read_text()) if mp.exists() else {}
        mp.write_text(json.dumps(merge_meta(old, meta(only, pdc, oc, pd_info)), indent=1))
        log("wrote flags_meta.json (merged; keys of steps not run kept)")


if __name__ == "__main__":
    main()
