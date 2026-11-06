#!/usr/bin/env python3
"""Route-optimizer slope band b2 + the spare coarse slope.

Role: builds two single-band uint8 GeoTIFFs on the route grid (EPSG:5070, 250 m,
DEFLATE, 512 tiles, nodata 0), classed into route_grid.SLOPE_EDGES bins 1-8:
  data/build/route/250m/slope.tif         b2: area-weighted MEAN of 30 m slope (degrees)
  data/build/route/250m/slope_coarse.tif  spare: slope of the 250 m area-averaged DEM
Source: USGS 3DEP 1 arc-second seamless DEM. The tiles of its global VRT that touch the
grid are cached whole under data/raw/route/dem/ (one GET each, resumable), and a local
copy of the VRT points those sources at the cache, so window reads never hit the network.
Extent: US land only (Census cartographic boundary, cached beside the tiles): only tiles and
windows touching it are read, and cells outside it (ocean, Canada, Mexico) are 0.
Method per window (route_grid.windows, 60 km, each with a 750 m halo):
  1. warp the DEM (NAD83 geographic) to EPSG:5070 at 30 m on the grid's 30 m lattice,
     bilinear (continuous data);
  2. Horn slope in degrees on the projected DEM (metres on both axes; an edge pixel
     with any nodata neighbour is nodata);
  3. aggregate 30 m -> 250 m with exact area weights: W[i, j] = overlap length of 250 m
     cell i and 30 m pixel j (separable, so cell = Wy @ S @ Wx.T), nodata-aware
     (sum of weights over valid pixels); a cell needs >= half its area valid.
     The window origin and halo sit on the 750 m lattice (LCM of 30 and 250), so every
     cell sees the same pixel fractions it would in a one-piece run: no seams;
  4. coarse: the same weights on the DEM give the 250 m mean DEM (halo = 3 cells),
     Horn slope at 250 m, interior kept.
Per-window float results go to data/build/route/250m/slope_parts/ (skipped on rerun);
`assemble` writes both tifs and runs the acceptance checks.
Deps: venv python with rasterio + numpy; scripts/route_grid.py.
Run: TMPDIR=tmp/build-tmp CPL_TMPDIR=tmp/build-tmp venv/bin/python scripts/build_route_slope.py
       [fetch|bench|windows|assemble|all] [--workers N]
"""
import argparse, datetime, json, multiprocessing, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

os.environ.setdefault("GDAL_CACHEMAX", "128")
os.environ.setdefault("CPL_VSIL_CURL_CACHE_SIZE", "268435456")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "3")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_MAX_DATASET_POOL_SIZE", "30")

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from rasterio.crs import CRS  # noqa: E402
from rasterio.transform import Affine  # noqa: E402
from rasterio.warp import Resampling, reproject, transform_bounds  # noqa: E402
from rasterio.windows import Window  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
VRT_URL = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/USGS_Seamless_DEM_1.vrt"
REMOTE_PREFIX = "/vsicurl/https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current/"
DEM_DIR = ROOT / "data/raw/route/dem"
LOCAL_VRT = DEM_DIR / "USGS_Seamless_DEM_1.local.vrt"
OUT_DIR = ROOT / "data/build/route/250m"
PARTS = OUT_DIR / "slope_parts"
WINDOW_M = 60000
HALO_M = 750.0  # one 750 m lattice unit: >= 1 30 m pixel and >= 1 250 m cell
DEM_NODATA = -999999.0
MIN_VALID = 0.5
DST_CRS = CRS.from_epsg(5070)
H30 = int(HALO_M / G.NLCD_CELL)  # 25
H250 = int(HALO_M / G.CELL)  # 3
METHOD_VERSION = "slope-v1"


def method():
    return {"WINDOW_M": WINDOW_M, "HALO_M": HALO_M, "MIN_VALID": MIN_VALID, "version": METHOD_VERSION}


def check_parts_method():
    """Parts are valid only for the method that built them: record it, refuse a different one."""
    PARTS.mkdir(parents=True, exist_ok=True)
    mp = PARTS / "method.json"
    if not mp.exists():
        mp.write_text(json.dumps(method(), indent=1))
        return
    have = json.loads(mp.read_text())
    if have != method():
        raise SystemExit(f"slope_parts was built with {have}, but the script now has {method()}; "
                         f"move {PARTS} aside to rebuild it")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- tiles / cache

def tile_box(name):
    """(west, south, east, north) of a 3DEP 1-degree tile name like n40w106."""
    m = re.fullmatch(r"([ns])(\d+)([ew])(\d+)", name)
    lat = int(m[2]) * (1 if m[1] == "n" else -1)
    lon = int(m[4]) * (1 if m[3] == "e" else -1)
    return (lon, lat - 1, lon + 1, lat)


GRID_BOX = (G.X0, G.Y0 - G.ROWS * G.CELL, G.X0 + G.COLS * G.CELL, G.Y0)
US_URL = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_nation_5m.zip"
US_ZIP = DEM_DIR / "cb_2023_us_nation_5m.zip"
_US = None


def us_land():
    """US land (Census cartographic boundary, NAD83 lon/lat, shoreline-clipped), prepared."""
    global _US
    if _US is None:
        import fiona, shapely
        from shapely.geometry import shape
        if not US_ZIP.exists():
            DEM_DIR.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(US_URL, US_ZIP)
        with fiona.open(f"zip://{US_ZIP}") as f:
            _US = shapely.union_all([shape(r["geometry"]) for r in f])
        shapely.prepare(_US)
    return _US


def _touches_us(box):
    from shapely.geometry import box as mkbox
    return us_land().intersects(mkbox(*box))


def _overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def remote_vrt_text():
    with urllib.request.urlopen(VRT_URL, timeout=120) as r:
        return r.read().decode()


def grid_tiles(vrt_text):
    """Tile names in the VRT that touch both the grid (projected, densified) and US land."""
    names = sorted(set(re.findall(re.escape(REMOTE_PREFIX) + r"(\w+)/USGS_1_\1\.tif", vrt_text)))
    keep = []
    for n in names:
        w, s, e, nn = tile_box(n)
        if e < -179 or w > -50 or nn < 10 or s > 60:  # far from CONUS; transform would be junk
            continue
        if (_overlaps(transform_bounds("EPSG:4269", DST_CRS, w, s, e, nn, densify_pts=21), GRID_BOX)
                and _touches_us((w, s, e, nn))):
            keep.append(n)
    return keep


def _download(name):
    dst = DEM_DIR / "tiles" / f"USGS_1_{name}.tif"
    if dst.exists():
        return name, dst.stat().st_size, 0.0
    url = REMOTE_PREFIX.replace("/vsicurl/", "") + f"{name}/USGS_1_{name}.tif"
    tmp = dst.with_suffix(".part")
    t = time.time()
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
                want = int(r.headers.get("Content-Length", -1))
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            if want >= 0 and tmp.stat().st_size != want:
                raise IOError(f"short read {tmp.stat().st_size}/{want}")
            tmp.rename(dst)
            return name, dst.stat().st_size, time.time() - t
        except Exception as ex:  # noqa: BLE001
            if getattr(ex, "code", None) == 404:
                return name, -1, 0.0
            log(f"  retry {name} ({attempt + 1}): {ex}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}")


def fetch(names=None, threads=8):
    """Cache the grid's tiles and write the local VRT. names=None -> all grid tiles."""
    (DEM_DIR / "tiles").mkdir(parents=True, exist_ok=True)
    text = remote_vrt_text()
    alln = grid_tiles(text)
    todo = alln if names is None else [n for n in names if n in set(alln)]
    log(f"fetch: {len(alln)} grid tiles in VRT, fetching {len(todo)}")
    t0, nbytes, done = time.time(), 0, 0
    with ThreadPoolExecutor(threads) as ex:
        for fut in as_completed([ex.submit(_download, n) for n in todo]):
            n, size, dt = fut.result()
            done += 1
            if size < 0:
                log(f"  WARNING: tile {n} returned 404; left as a /vsicurl source in the local VRT")
            if dt:
                nbytes += max(size, 0)
            if done % 50 == 0 or done == len(todo):
                el = time.time() - t0
                log(f"  {done}/{len(todo)} tiles, {nbytes / 1e9:.2f} GB new in {el:.0f} s "
                    f"({nbytes / 1e6 / max(el, 1e-9):.1f} MB/s)")
    # the local VRT keeps the remote one's geometry; cached sources point at disk
    local = re.sub(re.escape(REMOTE_PREFIX) + r"(\w+)/(USGS_1_\1\.tif)",
                   lambda m: str(DEM_DIR / "tiles" / m[2]) if (DEM_DIR / "tiles" / m[2]).exists()
                   else m[0], text)
    LOCAL_VRT.write_text(local)
    (DEM_DIR / "grid_tiles.txt").write_text("\n".join(alln) + "\n")
    return alln, nbytes, time.time() - t0


# ---------------------------------------------------------------- per-window maths

def overlap_matrix(n_big, big, n_small, small):
    """W[i, j] = overlap length of big cell i and small pixel j, divided by big (shared origin)."""
    b0 = np.arange(n_big)[:, None] * big
    s0 = np.arange(n_small)[None, :] * small
    return np.clip(np.minimum(b0 + big, s0 + small) - np.maximum(b0, s0), 0, None) / big


def horn_slope(z, d):
    """Slope (degrees) by Horn's method; border and nodata-adjacent pixels -> NaN."""
    out = np.full(z.shape, np.nan, np.float32)
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    dd, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * dd + g)) / (8 * d)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * d)
    out[1:-1, 1:-1] = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
    return out


def weighted_mean(arr, wy, wx):
    v = np.isfinite(arr)
    num = wy @ np.where(v, arr, 0).astype(np.float64) @ wx.T
    den = wy @ v.astype(np.float64) @ wx.T
    with np.errstate(invalid="ignore", divide="ignore"):
        m = num / den
    m[den < MIN_VALID] = np.nan
    return m.astype(np.float32)


_SRC = None


def _init_worker():
    global _SRC
    _SRC = rasterio.open(LOCAL_VRT)
    us_land()


def part_path(col_off, row_off):
    return PARTS / f"w_{row_off:05d}_{col_off:05d}.npz"


def window_lonlat(bounds):
    xa, ya, xb, yb = bounds
    return transform_bounds(DST_CRS, "EPSG:4269", xa - HALO_M, ya - HALO_M, xb + HALO_M,
                            yb + HALO_M, densify_pts=21)


def process_window(win):
    """Compute one window and save its part; returns (key, seconds, status)."""
    col_off, row_off, w, h, bounds = win
    out = part_path(col_off, row_off)
    if out.exists():
        return out.name, 0.0, "skip"
    t = time.time()
    tmp = out.with_suffix(".tmp.npz")
    ll = window_lonlat(bounds)
    if not _touches_us(ll):
        np.savez_compressed(tmp, empty=np.array(1))
        tmp.rename(out)
        return out.name, time.time() - t, "nodem"
    # 30 m lattice: window's 250 m origin minus the halo (both on the 750 m lattice)
    xa = G.X0 + col_off * G.CELL - HALO_M
    yt = G.Y0 - row_off * G.CELL + HALO_M
    n250x, n250y = w + 2 * H250, h + 2 * H250
    n30x = int(np.ceil(n250x * G.CELL / G.NLCD_CELL))
    n30y = int(np.ceil(n250y * G.CELL / G.NLCD_CELL))
    dem = np.full((n30y, n30x), np.nan, np.float32)
    reproject(rasterio.band(_SRC, 1), dem, src_nodata=DEM_NODATA, dst_nodata=np.nan,
              dst_transform=Affine(G.NLCD_CELL, 0, xa, 0, -G.NLCD_CELL, yt), dst_crs=DST_CRS,
              resampling=Resampling.bilinear, num_threads=1, warp_mem_limit=256)
    if not np.isfinite(dem).any():
        np.savez_compressed(tmp, empty=np.array(1))
        tmp.rename(out)
        return out.name, time.time() - t, "nodata"
    wy = overlap_matrix(n250y, G.CELL, n30y, G.NLCD_CELL)
    wx = overlap_matrix(n250x, G.CELL, n30x, G.NLCD_CELL)
    s30 = horn_slope(dem, G.NLCD_CELL)
    mean_slope = weighted_mean(s30, wy, wx)[H250:H250 + h, H250:H250 + w]
    dem250 = weighted_mean(dem, wy, wx)
    coarse = horn_slope(dem250, G.CELL)[H250:H250 + h, H250:H250 + w]
    np.savez_compressed(tmp, mean=mean_slope, coarse=coarse)
    tmp.rename(out)
    return out.name, time.time() - t, "ok"


def all_windows():
    return list(G.windows(WINDOW_M))


def run_windows(wins, workers):
    check_parts_method()
    todo = [w for w in wins if not part_path(w[0], w[1]).exists()]
    log(f"windows: {len(wins)} total, {len(todo)} to do, {workers} workers")
    t0, done, busy = time.time(), 0, 0.0
    # worker RSS grows with GDAL's block cache and dataset pool, so recycle workers
    with multiprocessing.get_context("spawn").Pool(workers, _init_worker,
                                                   maxtasksperchild=25) as pool:
        for name, dt, st in pool.imap_unordered(process_window, todo):
            done += 1
            busy += dt
            if done % 100 == 0 or done == len(todo):
                el = time.time() - t0
                eta = el / done * (len(todo) - done)
                log(f"  {done}/{len(todo)} windows in {el:.0f} s, eta {eta / 60:.1f} min "
                    f"(mean {busy / done:.2f} s/window/worker)")
    return time.time() - t0


# ---------------------------------------------------------------- bench

BENCH = {"rockies": (-106.2, 39.6), "plains": (-99.0, 38.5), "coast": (-123.9, 45.0)}


def bench(workers):
    wins = all_windows()
    picks = []
    for name, (lon, lat) in BENCH.items():
        x, y = rasterio.warp.transform("EPSG:4326", DST_CRS, [lon], [lat])
        c, r = G.cell_of(x[0], y[0])
        n = int(WINDOW_M // G.CELL)
        picks.append((name, next(w for w in wins if w[0] == c // n * n and w[1] == r // n * n)))
    need = set()
    text = remote_vrt_text()
    alln = grid_tiles(text)
    for _, w in picks:
        ll = window_lonlat(w[4])
        need |= {n for n in alln if _overlaps(ll, tile_box(n))}
    have = {n for n in need if (DEM_DIR / "tiles" / f"USGS_1_{n}.tif").exists()}
    _, nbytes, fdt = fetch(sorted(need))
    new = len(need) - len(have)
    rate = nbytes / fdt if new and fdt else None
    PARTS.mkdir(parents=True, exist_ok=True)
    _init_worker()
    times = []
    for name, w in picks:
        p = part_path(w[0], w[1])
        if p.exists():
            p.unlink()
        _, dt, st = process_window(w)
        times.append(dt)
        log(f"bench {name}: window {w[:4]} {st} in {dt:.2f} s")
    per = sum(times) / len(times)
    ntiles = len(alln)
    est_bytes = ntiles * sum((DEM_DIR / "tiles" / f"USGS_1_{n}.tif").stat().st_size
                             for n in need) / len(need)
    t_fetch = est_bytes / rate if rate else float("nan")
    t_win = per * len(wins) / workers
    log(f"bench: {len(need)} tiles ({new} new, {nbytes / 1e6:.0f} MB in {fdt:.1f} s"
        + (f", {rate / 1e6:.1f} MB/s)" if rate else ")"))
    log(f"bench: {ntiles} grid tiles ~{est_bytes / 1e9:.0f} GB -> fetch ~{t_fetch / 60:.0f} min; "
        f"{len(wins)} windows x {per:.2f} s / {workers} workers -> ~{t_win / 60:.0f} min "
        f"(upper bound: non-US windows are skipped); projected total "
        f"~{(t_fetch + t_win) / 3600:.2f} h")


# ---------------------------------------------------------------- assemble + checks

def classify(a):
    out = np.zeros(a.shape, np.uint8)
    v = np.isfinite(a)
    out[v] = np.digitize(a[v], G.SLOPE_EDGES[1:-1]) + 1
    return out


def write_tif(path, arr):
    prof = dict(driver="GTiff", width=G.COLS, height=G.ROWS, count=1, dtype="uint8", nodata=0,
                crs=DST_CRS, transform=Affine.from_gdal(*G.transform()), compress="deflate",
                tiled=True, blockxsize=G.BLOCK, blockysize=G.BLOCK)
    tmp = path.with_suffix(".tmp.tif")
    with rasterio.open(tmp, "w", **prof) as dst:
        dst.write(arr, 1)
    tmp.rename(path)


def box_mean_bin(b, w, s, e, n):
    x0, y0, x1, y1 = transform_bounds("EPSG:4326", DST_CRS, w, s, e, n, densify_pts=21)
    c0, r0 = G.cell_of(x0, y1)
    c1, r1 = G.cell_of(x1, y0)
    sub = b[r0:r1 + 1, c0:c1 + 1]
    return float(sub[sub > 0].mean())


def seam_check(m, land, label, min_cells=1000):
    """Window-boundary lines vs their neighbours: for each adjacent pair of rows (cols), the
    ratio of mean slope over the US-land cells valid in both, pairs with >= min_cells only;
    the same statistic off-boundary is the reference."""
    n = int(WINDOW_M // G.CELL)
    for axis, size, k in ((1, G.COLS, "cols"), (0, G.ROWS, "rows")):
        sl_a = (slice(None), slice(None, -1)) if axis == 1 else (slice(None, -1), slice(None))
        sl_b = (slice(None), slice(1, None)) if axis == 1 else (slice(1, None), slice(None))
        a, b = m[sl_a], m[sl_b]
        v = np.isfinite(a) & np.isfinite(b) & land[sl_a] & land[sl_b]
        cnt = v.sum(axis=1 - axis)
        sa = np.where(v, a, 0).sum(axis=1 - axis, dtype=np.float64)
        sb = np.where(v, b, 0).sum(axis=1 - axis, dtype=np.float64)
        del a, b, v
        ok = (cnt >= min_cells) & (sa > 0) & (sb > 0)
        r = np.ones(size - 1)
        r[ok] = np.exp(np.abs(np.log(sb[ok] / sa[ok])))
        seam = np.zeros(size - 1, bool)
        seam[np.arange(n, size, n) - 1] = True
        log(f"seams {label} {k}: boundary max ratio {r[seam & ok].max():.3f} "
            f"(median {np.median(r[seam & ok]):.4f}, {int((seam & ok).sum())} lines); "
            f"off-boundary p99 {np.percentile(r[~seam & ok], 99):.3f}, "
            f"max {r[~seam & ok].max():.3f}")


def write_slope_meta():
    tiles = sorted((DEM_DIR / "tiles").glob("USGS_1_*.tif"))
    newest = max(t.stat().st_mtime for t in tiles)
    meta = {"source": VRT_URL, "product": "USGS 3DEP 1 arc-second seamless DEM",
            "tile_count": len(tiles),
            "fetch_date": datetime.date.fromtimestamp(newest).isoformat(),
            "method": method(), "slope_edges_deg": [float(x) for x in G.SLOPE_EDGES],
            "mask": "state.tif > 0"}
    (OUT_DIR / "slope_meta.json").write_text(json.dumps(meta, indent=1))
    log(f"wrote slope_meta.json ({len(tiles)} tiles)")


def assemble():
    check_parts_method()
    wins = all_windows()
    missing = [w for w in wins if not part_path(w[0], w[1]).exists()]
    if missing:
        sys.exit(f"assemble: {len(missing)} windows not built yet")
    mean = np.full((G.ROWS, G.COLS), np.nan, np.float32)
    coarse = np.full((G.ROWS, G.COLS), np.nan, np.float32)
    for c, r, w, h, _ in wins:
        z = np.load(part_path(c, r))
        if "mean" in z:
            mean[r:r + h, c:c + w] = z["mean"]
            coarse[r:r + h, c:c + w] = z["coarse"]
    with rasterio.open(OUT_DIR / "state.tif") as r:
        land = r.read(1) > 0
    log(f"land mask (state.tif > 0): {land.sum()} cells")
    for name, arr in (("slope.tif", mean), ("slope_coarse.tif", coarse)):
        b = classify(arr)
        b[~land] = 0
        write_tif(OUT_DIR / name, b)
        hist = np.bincount(b.ravel(), minlength=9)
        log(f"{name}: land cells without slope {int((land & (b == 0)).sum())}, "
            f"slope cells off land {int((~land & (b > 0)).sum())}")
        log(f"{name} histogram (code: cells): " + ", ".join(f"{i}: {hist[i]}" for i in range(9)))
        rk = box_mean_bin(b, -107, 39, -105.5, 40.5)
        pl = box_mean_bin(b, -100, 38, -98, 39)
        log(f"{name} mean bin Rockies CO {rk:.2f} vs Plains KS {pl:.2f} -> "
            f"{'PASS' if rk > pl else 'FAIL'}")
        with rasterio.open(OUT_DIR / name) as ds:
            assert ds.transform == Affine.from_gdal(*G.transform()), ds.transform
            assert (ds.width, ds.height) == (G.COLS, G.ROWS)
            assert ds.crs == DST_CRS and ds.nodata == 0 and ds.dtypes[0] == "uint8"
        log(f"{name}: transform/shape/crs asserted OK")
    write_slope_meta()
    seam_check(mean, land, "mean-30m-slope")
    seam_check(coarse, land, "coarse-slope")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["fetch", "bench", "windows", "assemble", "all"])
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    t0 = time.time()
    if a.step == "bench":
        bench(a.workers)
    if a.step in ("fetch", "all"):
        fetch()
    if a.step in ("windows", "all"):
        run_windows(all_windows(), a.workers)
    if a.step in ("assemble", "all"):
        assemble()
    log(f"{a.step} done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
