#!/usr/bin/env python3
"""Route-optimizer national aviation band.

Role: builds data/build/route/250m/aviation.tif (uint8, EPSG:5070, 250 m, nodata 0, DEFLATE, 512 tiles)
and aviation_meta.json from the FAA NTAD records the fetch_route_inputs.py `ntad` step fetched ($NTAD_DIR, default
an external disk) and route_aviation.py's 14 CFR Part 77 surfaces.
Codes: 0 nodata (outside CONUS land, or not evaluated: land with no DEM); 1 evaluated: outside the notice extent, no surface below 61 m AGL;
2 77.9(b) notice extent (lowest surface >= 61 m AGL, or none;
such a surface outside the extent is 1); 3 lowest surface AGL [46, 61) m;
4 [30, 46) m; 5 < 30 m; 6 primary surface (primary / clear zone).
Facilities: 14 CFR 77.9(d) literally (route_aviation.notice_basis: status O and public use, Federal/DoD
owner, or an IAP); closed/planned are left out of the band. ADDS IAPEXISTS is joined on IDENT = ARPT_ID
(strip + upper), ICAO_ID as the second key; an unmatched facility has IAPEXISTS unknown (the runway-end
half of has_iap still applies). Field names: route_aviation.FIELDS equals the ntad step's record keys (checked).
Ground: the cached 3DEP 1 arc-second DEM (NAVD88) warped bilinear to the grid's 30 m lattice per 60 km window
(the same cache and warp as build_route_slope.py). Per 30 m pixel: AGL = lowest surface (m MSL) - ground -
MARGIN_M (5 m datum margin, subtracted before binning); the 250 m cell takes the worst class of the pixels
whose centre it holds (centre rule, no all-touched). Pixels with no DEM are skipped; a land cell with no
valid DEM pixel (and slope.tif 0) stays 0. Land = state.tif > 0, as build_route_slope.py assemble.
Windows are 750 m-lattice aligned, so cell/pixel assignment needs no halo. Per-window parts go to
data/build/route/250m/aviation_parts/ (skipped on rerun); `assemble` writes the tif + meta.
Deps: venv python with rasterio, numpy, shapely, pyproj; route_aviation.py, route_grid.py,
build_route_slope.py (DEM cache paths, US-land mask), disk_guard.py.
Run: TMPDIR=<scratch dir on an external disk> CPL_TMPDIR=$TMPDIR \\
       venv/bin/python scripts/build_route_aviation.py [windows|assemble|check|all] [--workers N]
"""
import argparse, hashlib, json, multiprocessing, os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

os.environ.setdefault("GDAL_CACHEMAX", "128")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")

import numpy as np  # noqa: E402

try:
    import rasterio  # noqa: E402
    from rasterio.transform import Affine  # noqa: E402
    from rasterio.warp import Resampling, reproject, transform_bounds  # noqa: E402
    from pyproj import Transformer  # noqa: E402
    import route_aviation as A  # noqa: E402
    import build_route_slope as S  # noqa: E402
    import disk_guard  # noqa: E402
    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get("ROUTE_CACHE") or ROOT / "data/raw/route-cache")
NTAD_DIR = Path(os.environ.get("NTAD_DIR") or CACHE / "route-raw/ntad")
OUT_DIR = ROOT / "data/build/route/250m"
PARTS = OUT_DIR / "aviation_parts"
WINDOW_M = 60000
PIX = G.NLCD_CELL            # 30 m
MARGIN_M = 5.0               # datum margin, subtracted from AGL before binning
REACH_M = 40000.0            # every surface lies within this of the facility point (checked at run time)
BINS_AGL = (61.0, 46.0, 30.0)  # code 2 >= 61, 3 >= 46, 4 >= 30, 5 below
METHOD_VERSION = "aviation-v2"
CODES = {"0": "nodata (outside CONUS land, or land without DEM)", "1": "evaluated: outside the notice extent, no surface below 61 m AGL",
         "2": "77.9(b) notice extent: lowest surface >= 61 m AGL, or none",
         "3": "lowest surface AGL [46, 61) m", "4": "lowest surface AGL [30, 46) m",
         "5": "lowest surface AGL < 30 m", "6": "primary surface (primary / clear zone)"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def method():
    return {"version": METHOD_VERSION, "WINDOW_M": WINDOW_M, "MARGIN_M": MARGIN_M, "REACH_M": REACH_M}


# ---------------------------------------------------------------- NTAD

def _read(name, keys):
    out = []
    with open(NTAD_DIR / f"{name}.jsonl") as f:
        for line in f:
            if not line.strip():
                continue
            a = json.loads(line)["attributes"]
            out.append({k: a.get(k) for k in keys})
    return out


def _id(v):
    return ("" if v is None else str(v)).strip().upper()


def load_ntad():
    """(facilities with IAPEXISTS joined, runways by SITE_NO, ends by SITE_NO, join stats)."""
    fac = _read("facilities", A.FIELDS["facility"][:-1] + ("COUNTRY_CODE", "ICAO_ID", "ARPT_NAME"))
    rwy = _read("runways", A.FIELDS["runway"])
    ends = _read("runway_ends", A.FIELDS["end"])
    adds = _read("adds_airports", ("IDENT", "ICAO_ID", "IAPEXISTS"))
    by_ident, by_icao = {}, {}
    for r in adds:
        v = int(bool(r["IAPEXISTS"]))
        if _id(r["IDENT"]):
            by_ident[_id(r["IDENT"])] = max(v, by_ident.get(_id(r["IDENT"]), 0))
        if _id(r["ICAO_ID"]):
            by_icao[_id(r["ICAO_ID"])] = max(v, by_icao.get(_id(r["ICAO_ID"]), 0))
    unmatched, via_icao = [], 0
    for f in fac:
        k, ic = _id(f["ARPT_ID"]), _id(f["ICAO_ID"])
        if k in by_ident:
            f["IAPEXISTS"] = by_ident[k]
        elif ic and ic in by_icao:
            f["IAPEXISTS"] = by_icao[ic]
            via_icao += 1
        else:
            f["IAPEXISTS"] = None
            unmatched.append(f)
    r_by, e_by = {}, {}
    for r in rwy:
        r_by.setdefault(r["SITE_NO"], []).append(r)
    for e in ends:
        e_by.setdefault(e["SITE_NO"], []).append(e)
    return fac, r_by, e_by, {"adds": len(adds), "via_icao": via_icao, "unmatched": unmatched}


def covered(fac, e_by):
    """Facilities in the band: 14 CFR 77.9(d) (route_aviation.notice_basis), with a reference point."""
    out = []
    for f in fac:
        if f["LAT_DECIMAL"] is None or f["LONG_DECIMAL"] is None:
            continue
        if A.notice_basis(f, e_by.get(f["SITE_NO"], [])):
            out.append(f)
    return out


# ---------------------------------------------------------------- rasterising (pure given surfaces)

class Grid:
    """A 30 m pixel window: top-left (xa, yt) in EPSG:5070, nx by ny pixels."""

    def __init__(self, xa, yt, nx, ny):
        self.xa, self.yt, self.nx, self.ny = xa, yt, nx, ny


def new_layers(g):
    return (np.full((g.ny, g.nx), np.nan), np.zeros((g.ny, g.nx), bool), np.zeros((g.ny, g.nx), bool))


def paint(fs, g, layers):
    """Fold one facility's surfaces into (lowest surface m MSL, in a ground surface, in the notice extent)."""
    low, ground, notice = layers
    for s in fs.surfaces:
        if s.polygon.is_empty:  # a transitional surface the minimum trimmed away entirely (16 national facilities)
            continue
        x0, y0, x1, y1 = s.polygon.bounds
        i0, i1 = max(int((x0 - g.xa) // PIX), 0), min(int((x1 - g.xa) // PIX) + 1, g.nx)
        j0, j1 = max(int((g.yt - y1) // PIX), 0), min(int((g.yt - y0) // PIX) + 1, g.ny)
        if i0 >= i1 or j0 >= j1:
            continue
        xs = g.xa + (np.arange(i0, i1) + 0.5) * PIX
        ys = g.yt - (np.arange(j0, j1) + 0.5) * PIX
        X, Y = np.meshgrid(xs, ys)
        h = s.height_m(X.ravel(), Y.ravel()).reshape(X.shape)
        sub = (slice(j0, j1), slice(i0, i1))
        inside = ~np.isnan(h)
        if s.kind == "notice":
            notice[sub] |= inside
        else:
            low[sub] = np.fmin(low[sub], h)
            if s.kind in A.GROUND_KINDS:
                ground[sub] |= inside


def pixel_codes(layers, dem, margin=MARGIN_M):
    """uint8 per 30 m pixel: 0 none (or no DEM), 2..6; AGL = lowest surface - ground - margin.
    Code 2 is the 77.9(b) notice extent only: a surface >= 61 m AGL outside it is code 0 (cell 1)."""
    low, ground, notice = layers
    ok = np.isfinite(dem)
    agl = low - dem - margin
    code = np.zeros(low.shape, np.uint8)
    has = ok & ~np.isnan(low)
    code[has] = np.select([agl[has] >= BINS_AGL[0], agl[has] >= BINS_AGL[1], agl[has] >= BINS_AGL[2]],
                          [2, 3, 4], 5).astype(np.uint8)
    code[(code == 2) & ~notice] = 0
    code[ok & notice & (code == 0)] = 2
    code[ok & ground] = 6
    return code


def _starts(n_pix, n_cells):
    ci = np.minimum(((np.arange(n_pix) + 0.5) * PIX // G.CELL).astype(int), n_cells)  # centre rule
    keep = ci < n_cells
    starts = np.searchsorted(ci[keep], np.arange(n_cells))
    return keep.sum(), starts, ci[keep]


def to_cells(code30, valid30, w, h):
    """(worst class, any valid DEM pixel) per 250 m cell by the pixel-centre rule; origin = cell corner."""
    ny, sy, _ = _starts(code30.shape[0], h)
    nx, sx, _ = _starts(code30.shape[1], w)
    c = np.maximum.reduceat(np.maximum.reduceat(code30[:ny, :nx], sy, axis=0), sx, axis=1)
    v = np.logical_or.reduceat(np.logical_or.reduceat(valid30[:ny, :nx], sy, axis=0), sx, axis=1)
    return c, v


def finalize(cell_code, cell_valid, land, slope_ok):
    """Codes: off land 0; land with a surface its class; land evaluated 1; land without DEM 0."""
    out = np.zeros(cell_code.shape, np.uint8)
    out[land & (cell_valid | slope_ok)] = 1
    hit = land & cell_valid & (cell_code > 0)
    out[hit] = cell_code[hit]
    return out


# ---------------------------------------------------------------- windows

_CTX = {}


def _init_worker():
    global _CTX
    fac, r_by, e_by, _ = load_ntad()
    use = covered(fac, e_by)
    t = Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True)
    xy = t.transform([f["LONG_DECIMAL"] for f in use], [f["LAT_DECIMAL"] for f in use])
    ends_xy = {}
    for f in use:
        es = [e for e in e_by.get(f["SITE_NO"], []) if e["LAT_DECIMAL"] is not None and e["RWY_END_ELEV"] is not None]
        if es:
            ex, ey = t.transform([e["LONG_DECIMAL"] for e in es], [e["LAT_DECIMAL"] for e in es])
            ends_xy[f["SITE_NO"]] = [(x, y, e["RWY_END_ELEV"] * A.FT) for x, y, e in zip(ex, ey, es)]
    _CTX = dict(use=use, x=np.array(xy[0]), y=np.array(xy[1]), r_by=r_by, e_by=e_by, ends_xy=ends_xy,
                src=rasterio.open(S.LOCAL_VRT))
    S.us_land()


def part_path(c, r):
    return PARTS / f"w_{r:05d}_{c:05d}.npz"


def window_dem(src, xa, yt, nx, ny):
    dem = np.full((ny, nx), np.nan, np.float32)
    reproject(rasterio.band(src, 1), dem, src_nodata=S.DEM_NODATA, dst_nodata=np.nan,
              dst_transform=Affine(PIX, 0, xa, 0, -PIX, yt), dst_crs=S.DST_CRS,
              resampling=Resampling.bilinear, num_threads=1, warp_mem_limit=256)
    return dem


def process_window(win):
    c, r, w, h, bounds = win
    out = part_path(c, r)
    if out.exists():
        return out.name, 0.0, "skip"
    t0 = time.time()
    tmp = out.with_suffix(".tmp.npz")
    xa = G.X0 + c * G.CELL
    yt = G.Y0 - r * G.CELL
    xb, yb = xa + w * G.CELL, yt - h * G.CELL
    X, Y = _CTX["x"], _CTX["y"]
    near = np.flatnonzero((X > xa - REACH_M) & (X < xb + REACH_M) & (Y > yb - REACH_M) & (Y < yt + REACH_M))
    if not len(near) or not S._touches_us(S.window_lonlat(bounds)):
        np.savez_compressed(tmp, empty=np.array(1))
        tmp.rename(out)
        return out.name, time.time() - t0, "none"
    nx, ny = int(np.ceil(w * G.CELL / PIX)), int(np.ceil(h * G.CELL / PIX))
    dem = window_dem(_CTX["src"], xa, yt, nx, ny)
    if not np.isfinite(dem).any():
        np.savez_compressed(tmp, empty=np.array(1))
        tmp.rename(out)
        return out.name, time.time() - t0, "nodem"
    g = Grid(xa, yt, nx, ny)
    layers = new_layers(g)
    notes, over, gaps = [], 0, []
    for i in near:
        f = _CTX["use"][i]
        site = f["SITE_NO"]
        fs = A.facility_surfaces(f, _CTX["r_by"].get(site, []), _CTX["e_by"].get(site, []))
        notes += [str(n) for n in fs.notes]
        for s in fs.surfaces:
            if s.polygon.is_empty:
                continue
            bx0, by0, bx1, by1 = s.polygon.bounds
            if max(abs(bx0 - X[i]), abs(bx1 - X[i]), abs(by0 - Y[i]), abs(by1 - Y[i])) > REACH_M:
                over += 1
        paint(fs, g, layers)
        for ex, ey, elev in _CTX["ends_xy"].get(site, []):
            jj, ii = int((yt - ey) // PIX), int((ex - xa) // PIX)
            if 0 <= ii < nx and 0 <= jj < ny and ii * PIX + PIX / 2 < w * G.CELL and jj * PIX + PIX / 2 < h * G.CELL \
                    and np.isfinite(dem[jj, ii]):
                gaps.append(abs(elev - float(dem[jj, ii])))
    code = pixel_codes(layers, dem)
    cc, cv = to_cells(code, np.isfinite(dem), w, h)
    np.savez_compressed(tmp, code=cc, valid=cv, gaps=np.array(gaps, np.float32), over=np.array(over),
                        nfac=np.array(len(near)), notes=np.array(json.dumps(notes)))
    tmp.rename(out)
    return out.name, time.time() - t0, "ok"


def run_windows(workers):
    PARTS.mkdir(parents=True, exist_ok=True)
    mp = PARTS / "method.json"
    if mp.exists() and json.loads(mp.read_text()) != method():
        sys.exit(f"{PARTS} was built with another method; move it aside")
    mp.write_text(json.dumps(method(), indent=1))
    wins = list(G.windows(WINDOW_M))
    todo = [w for w in wins if not part_path(w[0], w[1]).exists()]
    log(f"windows: {len(wins)} total, {len(todo)} to do, {workers} workers")
    t0, done = time.time(), 0
    with multiprocessing.get_context("spawn").Pool(workers, _init_worker, maxtasksperchild=10) as pool:
        for name, dt, st in pool.imap_unordered(process_window, todo):
            done += 1
            if done % 10 == 0 or done == len(todo):
                el = time.time() - t0
                log(f"  {done}/{len(todo)} windows in {el:.0f} s, eta {el / done * (len(todo) - done) / 60:.1f} min "
                    f"(last {name} {st} {dt:.1f} s)")
    return time.time() - t0


# ---------------------------------------------------------------- assemble + checks

def write_tif(path, arr):
    prof = dict(driver="GTiff", width=G.COLS, height=G.ROWS, count=1, dtype="uint8", nodata=0, crs=S.DST_CRS,
                transform=Affine.from_gdal(*G.transform()), compress="deflate", tiled=True,
                blockxsize=G.BLOCK, blockysize=G.BLOCK)
    tmp = path.with_suffix(".tmp.tif")
    with rasterio.open(tmp, "w", **prof) as dst:
        dst.write(arr, 1)
    tmp.rename(path)


def assemble():
    disk_guard.require_free(OUT_DIR, int(0.5 * 2**30))
    wins = list(G.windows(WINDOW_M))
    missing = [w for w in wins if not part_path(w[0], w[1]).exists()]
    if missing:
        sys.exit(f"assemble: {len(missing)} windows not built yet")
    code = np.zeros((G.ROWS, G.COLS), np.uint8)
    valid = np.zeros((G.ROWS, G.COLS), bool)
    gaps, notes, over, nfac_max = [], set(), 0, 0
    for c, r, w, h, _ in wins:
        z = np.load(part_path(c, r))
        if "code" not in z:
            continue
        code[r:r + h, c:c + w] = z["code"]
        valid[r:r + h, c:c + w] = z["valid"]
        gaps.append(z["gaps"])
        over += int(z["over"])
        nfac_max = max(nfac_max, int(z["nfac"]))
        notes.update(json.loads(str(z["notes"])))
    with rasterio.open(OUT_DIR / "state.tif") as ds:
        land = ds.read(1) > 0
    with rasterio.open(OUT_DIR / "slope.tif") as ds:
        slope_ok = ds.read(1) > 0
    out = finalize(code, valid, land, slope_ok)
    write_tif(OUT_DIR / "aviation.tif", out)
    hist = np.bincount(out.ravel(), minlength=7)
    gaps = np.concatenate(gaps) if gaps else np.array([])
    log("class counts: " + ", ".join(f"{i}: {int(hist[i])}" for i in range(7)))
    log(f"land cells {int(land.sum())}; land with code 0 {int((land & (out == 0)).sum())}; "
        f"code>0 off land {int((~land & (out > 0)).sum())}")
    log(f"surfaces beyond REACH_M of their facility point: {over}")
    log(f"runway-end elevation vs DEM: n={len(gaps)} median |gap| {np.median(gaps):.2f} m, "
        f"p90 {np.percentile(gaps, 90):.2f} m")
    log(f"Fallback notes: {len(notes)} distinct")
    with rasterio.open(OUT_DIR / "aviation.tif") as ds:
        assert ds.transform == Affine.from_gdal(*G.transform()) and (ds.width, ds.height) == (G.COLS, G.ROWS)
        assert ds.crs == S.DST_CRS and ds.nodata == 0 and ds.dtypes[0] == "uint8"
    fac, r_by, e_by, js = load_ntad()
    use = covered(fac, e_by)
    civil = [e for f in use if f["SITE_TYPE_CODE"] == "A" and f["OWNERSHIP_TYPE_CODE"] not in A.DOD_OWNERS
             for e in e_by.get(f["SITE_NO"], [])]
    blank = sum(1 for e in civil if not A._str(e["FAR_PART_77_CODE"]))
    un = [f for f in js["unmatched"] if f["ARPT_STATUS"] == "O" and f["COUNTRY_CODE"] == "US"]
    log(f"facilities: {len(fac)} in NTAD, {len(use)} in the band; ADDS join: {js['via_icao']} via ICAO_ID, "
        f"{len(js['unmatched'])} unmatched ({len(un)} operational US): "
        + ", ".join(f"{f['ARPT_ID']}/{f['SITE_NO']}" for f in un))
    log(f"civil airport runway ends with blank FAR_PART_77_CODE: {blank}/{len(civil)} = {blank / max(len(civil), 1):.3f}")
    man = json.loads((NTAD_DIR / "ntad_manifest.json").read_text())
    meta = {"product": "FAA NTAD aviation facilities, runways, runway ends (+ ADDS IAPEXISTS)",
            "ntad_eff_date": man["eff_date"], "ntad_fetched": man["fetched"],
            "ntad_sha256": {k: v["sha256"] for k, v in man["layers"].items()},
            "codes": CODES, "margin_m": MARGIN_M, "resolution_m": {"surface_raster": PIX, "cell": G.CELL},
            "method": method(),
            "method_text": "Part 77 surfaces (route_aviation.py) rasterised on the 3DEP 1 arc-second NAVD88 DEM "
                           "warped to the 30 m lattice (centre rule); AGL = lowest surface - ground - margin, "
                           "binned; 250 m cell = worst class of the 30 m pixels whose centre it holds",
            "land_mask": "state.tif > 0", "dem_valid": "any valid DEM pixel in the cell, or slope.tif > 0",
            "facilities": {"ntad": len(fac), "in_band": len(use), "adds_unmatched": len(js["unmatched"]),
                           "adds_unmatched_operational_us": [f["ARPT_ID"] for f in un],
                           "civil_blank_code_share": round(blank / max(len(civil), 1), 4)},
            "end_elevation_vs_dem_m": {"n": int(len(gaps)), "median_abs": round(float(np.median(gaps)), 3),
                                       "p90_abs": round(float(np.percentile(gaps, 90)), 3)},
            "class_counts": {str(i): int(hist[i]) for i in range(7)}}
    (OUT_DIR / "aviation_meta.json").write_text(json.dumps(meta, indent=1))
    log("wrote aviation_meta.json")


def check():
    """Print the codes at NFL (SITE_NO 13057.) and Fallon Municipal, from the built tif."""
    fac, r_by, e_by, _ = load_ntad()
    t = Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True)
    with rasterio.open(OUT_DIR / "aviation.tif") as ds:
        a = ds.read(1)
    picks = [f for f in fac if f["SITE_NO"] == "13057."
             or ("FALLON" in A._str(f["ARPT_NAME"]).upper() and f["SITE_TYPE_CODE"] == "A")]
    for f in picks:
        x, y = t.transform(f["LONG_DECIMAL"], f["LAT_DECIMAL"])
        c, r = G.cell_of(x, y)
        cells = {}
        for e in e_by.get(f["SITE_NO"], []):
            if e["LAT_DECIMAL"] is None or e["LONG_DECIMAL"] is None:
                continue
            ex, ey = t.transform(e["LONG_DECIMAL"], e["LAT_DECIMAL"])
            cc, rr = G.cell_of(ex, ey)
            cells[f"{e['RWY_ID']} {e['RWY_END_ID']}"] = int(a[rr, cc])
        log(f"{f['SITE_NO']} {f['ARPT_ID']} {f['ARPT_NAME']}: reference cell code {int(a[r, c])}; end cells {cells}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["windows", "assemble", "check", "all"])
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    t0 = time.time()
    if a.step in ("windows", "all"):
        disk_guard.require_free(OUT_DIR, int(0.5 * 2**30))
        run_windows(min(a.workers, 4))
    if a.step in ("assemble", "all"):
        assemble()
    if a.step == "check":
        check()
    log(f"{a.step} done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
