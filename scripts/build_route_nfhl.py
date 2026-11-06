#!/usr/bin/env python3
"""Route-optimizer national flood band.

Role: builds data/build/route/250m/nfhl.tif (uint8, EPSG:5070, 250 m, nodata 0, DEFLATE, 512 tiles) and
nfhl_meta.json from FEMA's dated NFHL Key Layers GDB ($NFHL_DIR, default
an external disk; fetched by `fetch_route_inputs.py nfhl`).
Codes: 0 nodata (off CONUS land); 1 observed none (effective panels cover >= 50 % of the cell's area, SFHA < 50 %);
2 SFHA (panels >= 50 % and SFHA_TF='T' union >= 50 % of the cell's area); 3 no effective panel (panels < 50 %,
whatever SFHA says). Every land cell is 1, 2 or 3; no code > 0 off land (land = state.tif > 0).
Shares are exact AREA shares of the 250 m cell (union, never a sum). `share_ge` finds them fast: a 20 x 20 supersample
(centre rule) per cell, then the exact shapely area for cells whose supersampled share lies within [0.35, 0.65].
Layers: S_Fld_Haz_Ar (SFHA_TF in {T, F, U, null}: only T is SFHA; anything else stops the build) and S_FIRM_Pan, read with pyogrio through
an unzipped copy ($NFHL_DIR/gdb/, files of the two layers + catalog extracted from the zip; /vsizip/ is the fallback) in 60 km windows; geometries are made valid and reprojected to EPSG:5070.
Per-window parts go to tmp/build-tmp/nfhl/parts/ (skipped on rerun); `assemble` writes the tif + meta.
Deps: venv python with numpy, rasterio, shapely, pyogrio, pyproj; route_grid.py, disk_guard.py.
Run: TMPDIR=<scratch dir on an external disk> CPL_TMPDIR=$TMPDIR \\
       venv/bin/python scripts/build_route_nfhl.py [inspect|windows|assemble|all] [--workers N]
"""
import argparse, json, multiprocessing, os, resource, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

os.environ.setdefault("GDAL_CACHEMAX", "256")

try:
    import numpy as np
    import shapely
    from shapely import box
    from shapely.strtree import STRtree
    import rasterio
    from rasterio.features import rasterize
    from rasterio.transform import Affine
    import disk_guard
    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(os.environ.get("ROUTE_CACHE") or ROOT / "data/raw/route-cache")
NFHL_DIR = Path(os.environ.get("NFHL_DIR") or CACHE / "route-raw/nfhl")
EDITION = os.environ.get("NFHL_EDITION", "NFHL_Key_Layers_202610.gdb.zip")
OUT_DIR = ROOT / "data/build/route/250m"
PARTS = ROOT / "tmp/build-tmp/nfhl/parts"
WINDOW_M = 60000
THRESHOLD = 0.5          # area share of the cell
SS = 20                  # supersample per cell edge
BAND = (0.35, 0.65)      # supersampled shares in here are recomputed exactly
BLOCK = 8                # cells per edge of the blocks the exact step clips to
METHOD_VERSION = "nfhl-v1"
LAYER_SFHA, LAYER_PANEL = "S_Fld_Haz_Ar", "S_FIRM_Pan"  # the GDB spells them so; the brief says upper case
SFHA_VALUES = {"T", "F", "U", "None"}  # "None" = null; only T is SFHA (U/null treated as not SFHA)
CODES = {"0": "nodata (outside CONUS land)",
         "1": "observed none: effective panels cover >= 50 % of the cell, SFHA < 50 %",
         "2": "SFHA: panels >= 50 % and SFHA (SFHA_TF = 'T') >= 50 % of the cell's area",
         "3": "no effective panel: panels < 50 % of the cell (whatever SFHA says)"}
SFHA_NOTE = "U/null treated as not SFHA"
RULE = ("area shares of the 250 m cell (union of the polygons); panel share >= 0.5 -> observed; "
        "then SFHA share >= 0.5 -> 2 else 1; panel share < 0.5 -> 3")


def sfha_bad_values(counts):
    """SFHA_TF values (as strings, null = 'None') outside the allowed set; any one stops the build."""
    return sorted(set(counts) - SFHA_VALUES)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def method():
    return {"version": METHOD_VERSION, "WINDOW_M": WINDOW_M, "THRESHOLD": THRESHOLD, "SS": SS, "BAND": list(BAND)}


# ---------------------------------------------------------------- rule

def classify(panel_ge, sfha_ge, land):
    """Code table: off land 0; panels < 50 % -> 3; panels >= 50 %: SFHA >= 50 % -> 2 else 1."""
    out = np.zeros(np.shape(land), np.uint8)
    out[land & ~panel_ge] = 3
    out[land & panel_ge] = 1
    out[land & panel_ge & sfha_ge] = 2
    return out


# ---------------------------------------------------------------- area shares

def polygons(geoms):
    """Valid polygonal parts of `geoms` (make_valid; lines and points a repair leaves are dropped)."""
    out = []
    for g in geoms:
        if g is None or g.is_empty:
            continue
        for p in shapely.get_parts(shapely.make_valid(g)):
            if p.geom_type in ("Polygon", "MultiPolygon") and not p.is_empty:
                out.append(p)
    return out


def _cell_boxes(x0, y_top, ii, jj, cell):
    return [box(x0 + i * cell, y_top - (j + 1) * cell, x0 + (i + 1) * cell, y_top - j * cell) for i, j in zip(ii, jj)]


def exact_share(u, x0, y_top, ii, jj, cell=G.CELL):
    """Exact area share of cells (row jj, col ii) inside the union polygon `u` (clipped per BLOCK x BLOCK blocks)."""
    shares = np.zeros(len(ii))
    keys = {}
    for k, (i, j) in enumerate(zip(ii, jj)):
        keys.setdefault((int(i) // BLOCK, int(j) // BLOCK), []).append(k)
    for (bi, bj), ks in keys.items():
        bb = box(x0 + bi * BLOCK * cell, y_top - (bj + 1) * BLOCK * cell,
                 x0 + (bi + 1) * BLOCK * cell, y_top - bj * BLOCK * cell)
        piece = shapely.intersection(u, bb)
        if piece.is_empty:
            continue
        parts = [p for p in shapely.get_parts(piece) if p.geom_type in ("Polygon", "MultiPolygon")]
        tree = STRtree(parts)
        for k in ks:
            cb = _cell_boxes(x0, y_top, [ii[k]], [jj[k]], cell)[0]
            idx = tree.query(cb)
            shares[k] = sum(parts[t].intersection(cb).area for t in idx) / (cell * cell)
    return shares


def share_ge(geoms, x0, y_top, w, h, thr=THRESHOLD, ss=SS, band=BAND):
    """(w x h bool [row, col] array: cell area covered by the union of `geoms` >= thr, number of exact cells).

    Cell (row r, col c) is the box x0 + c*250 .. , y_top - r*250 ... Supersampled shares outside `band` are final;
    inside it the exact shapely share decides (>= thr, as the reference does)."""
    geoms = polygons(geoms)
    out = np.zeros((h, w), bool)
    if not geoms:
        return out, 0
    wbox = box(x0, y_top - h * G.CELL, x0 + w * G.CELL, y_top)
    geoms = polygons([shapely.intersection(g, wbox) for g in geoms if g.intersects(wbox)])
    if not geoms:
        return out, 0
    fine = G.CELL / ss
    m = rasterize([(g, 1) for g in geoms], out_shape=(h * ss, w * ss), transform=Affine(fine, 0, x0, 0, -fine, y_top),
                  fill=0, all_touched=False, dtype="uint8")
    share = m.reshape(h, ss, w, ss).sum(axis=(1, 3), dtype=np.int32) / float(ss * ss)
    out = share >= thr
    amb = (share >= band[0]) & (share <= band[1])
    jj, ii = np.nonzero(amb)
    if len(ii):
        u = shapely.union_all(geoms)
        sh = exact_share(u, x0, y_top, ii, jj)
        out[jj, ii] = sh >= thr
    return out, int(len(ii))


# ---------------------------------------------------------------- GDB

def gdb_path():
    """$NFHL_GDB, else the unzipped copy $NFHL_DIR/gdb/<edition>.gdb (windowed reads are ~1000x faster than /vsizip/), else /vsizip/."""
    un = NFHL_DIR / "gdb" / EDITION.replace(".zip", "")
    return os.environ.get("NFHL_GDB") or (str(un) if un.exists() else f"/vsizip/{NFHL_DIR / EDITION}")


def layer_info(path=None):
    import pyogrio
    import pyogrio.raw
    path = path or gdb_path()
    names = {n for n, _ in pyogrio.list_layers(path)}
    for need in (LAYER_SFHA, LAYER_PANEL):
        if need not in names:
            sys.exit(f"{path}: layer {need} missing (have {sorted(names)[:20]})")
    out = {}
    for ly, field in ((LAYER_SFHA, "SFHA_TF"), (LAYER_PANEL, None)):
        info = pyogrio.read_info(path, layer=ly)
        if field and field not in list(info["fields"]):
            sys.exit(f"{ly}: field {field} missing (have {list(info['fields'])})")
        out[ly] = info
    return out


class Reader:
    """Per-window reads of the two layers in EPSG:5070."""

    def __init__(self, path=None):
        import pyogrio
        import pyogrio.raw
        from pyproj import Transformer, CRS
        self.path = path or gdb_path()
        self.pyogrio = pyogrio
        self.crs = {}
        self.fwd = {}
        for ly in (LAYER_SFHA, LAYER_PANEL):
            c = CRS.from_user_input(pyogrio.read_info(self.path, layer=ly)["crs"])
            self.crs[ly] = c
            self.fwd[ly] = (Transformer.from_crs(c, G.CRS, always_xy=True), Transformer.from_crs(G.CRS, c, always_xy=True))

    def read(self, layer, bounds, columns=()):
        """(geometries in EPSG:5070, {column: values}) for the features whose bbox meets `bounds`; empty geometries dropped."""
        from rasterio.warp import transform_bounds
        fwd, inv = self.fwd[layer]
        bb = transform_bounds(G.CRS, self.crs[layer], *bounds, densify_pts=21)
        raw = self.pyogrio.raw.read(self.path, layer=layer, bbox=bb, columns=list(columns), read_geometry=True)
        geom = shapely.from_wkb(raw[2]) if raw[2] is not None else np.array([], object)
        keep = np.array([g is not None and not g.is_empty for g in geom], bool)
        cols = {c: np.array([str(v) for v in a], object)[keep] for c, a in zip(raw[0]["fields"], raw[3] or [])}
        geom = geom[keep]
        if len(geom) == 0:
            return [], cols
        return list(shapely.transform(geom, lambda xy: np.column_stack(fwd.transform(xy[:, 0], xy[:, 1])))), cols


def only_sfha(geoms, values):
    """The geometries whose SFHA_TF is 'T' (F, U and null are not SFHA)."""
    return [g for g, v in zip(geoms, values) if v == "T"]


# ---------------------------------------------------------------- windows

_CTX = {}


def _init_worker():
    _CTX["r"] = Reader()


def part_path(c, r):
    return PARTS / f"w_{r:05d}_{c:05d}.npz"


def process_window(win):
    c, r, w, h, bounds = win
    out = part_path(c, r)
    if out.exists():
        return out.name, 0.0, "skip"
    t0 = time.time()
    tmp = out.with_suffix(".tmp.npz")
    x0, y_top = G.X0 + c * G.CELL, G.Y0 - r * G.CELL
    rd = _CTX["r"]
    pan, _ = rd.read(LAYER_PANEL, bounds)
    allf, cols = rd.read(LAYER_SFHA, bounds, columns=["SFHA_TF"])
    sfha = only_sfha(allf, cols["SFHA_TF"])
    pan_ge, n1 = share_ge(pan, x0, y_top, w, h)
    sfha_ge, n2 = share_ge(sfha, x0, y_top, w, h)
    np.savez_compressed(tmp, panel=pan_ge, sfha=sfha_ge, exact=np.array([n1, n2]), feats=np.array([len(pan), len(sfha)]))
    tmp.rename(out)
    return out.name, time.time() - t0, "ok" if len(pan) or len(sfha) else "none"


def run_windows(workers):
    PARTS.mkdir(parents=True, exist_ok=True)
    mp = PARTS / "method.json"
    if mp.exists() and json.loads(mp.read_text()) != method():
        sys.exit(f"{PARTS} was built with another method; move it aside")
    mp.write_text(json.dumps(method(), indent=1))
    wins = list(G.windows(WINDOW_M))
    land = _land()
    todo = [w for w in wins if not part_path(w[0], w[1]).exists()
            and land[w[1]:w[1] + w[3], w[0]:w[0] + w[2]].any()]
    log(f"windows: {len(wins)} total, {len(todo)} to do on land, {workers} workers")
    t0, done = time.time(), 0
    with multiprocessing.get_context("spawn").Pool(workers, _init_worker, maxtasksperchild=20) as pool:
        for name, dt, st in pool.imap_unordered(process_window, todo):
            done += 1
            if done % 10 == 0 or done == len(todo):
                el = time.time() - t0
                log(f"  {done}/{len(todo)} windows in {el:.0f} s, eta {el / done * (len(todo) - done) / 60:.1f} min "
                    f"(last {name} {st} {dt:.1f} s)")
    return time.time() - t0


def _land():
    with rasterio.open(OUT_DIR / "state.tif") as ds:
        return ds.read(1) > 0


# ---------------------------------------------------------------- assemble

def write_tif(path, arr):
    prof = dict(driver="GTiff", width=G.COLS, height=G.ROWS, count=1, dtype="uint8", nodata=0, crs=G.CRS,
                transform=Affine.from_gdal(*G.transform()), compress="deflate", tiled=True,
                blockxsize=G.BLOCK, blockysize=G.BLOCK)
    tmp = path.with_suffix(".tmp.tif")
    with rasterio.open(tmp, "w", **prof) as dst:
        dst.write(arr, 1)
    tmp.rename(path)


def read_parts():
    """(panel_ge, sfha_ge, exact cells, features read) over the whole grid; a window with no part is all False."""
    pan = np.zeros((G.ROWS, G.COLS), bool)
    sf = np.zeros((G.ROWS, G.COLS), bool)
    ex, ft = np.zeros(2, np.int64), np.zeros(2, np.int64)
    land = _land()
    missing = []
    for c, r, w, h, _ in G.windows(WINDOW_M):
        p = part_path(c, r)
        if not p.exists():
            if land[r:r + h, c:c + w].any():
                missing.append(p.name)
            continue
        with np.load(p) as z:
            pan[r:r + h, c:c + w] = z["panel"]
            sf[r:r + h, c:c + w] = z["sfha"]
            ex += z["exact"]
            ft += z["feats"]
    if missing:
        sys.exit(f"{len(missing)} windows have no part, e.g. {missing[:3]}; run `windows` first")
    return pan, sf, ex, ft


def assemble(t_windows=None):
    t0 = time.time()
    disk_guard.require_free(OUT_DIR, int(0.5 * 2**30))
    pan, sf, ex, ft = read_parts()
    land = _land()
    out = classify(pan, sf, land)
    write_tif(OUT_DIR / "nfhl.tif", out)
    hist = np.bincount(out.ravel(), minlength=4)
    n_land = int(land.sum())
    sfha_off_panel = int((land & sf & ~pan).sum())
    log("class counts: " + ", ".join(f"{i}: {int(hist[i])}" for i in range(4)))
    log(f"land cells {n_land}; land with code 0 {int((land & (out == 0)).sum())}; code>0 off land {int((~land & (out > 0)).sum())}")
    log(f"panel cover (codes 1+2)/land {(hist[1] + hist[2]) / n_land:.4f}; land cells with SFHA >= 50 % and no panel majority {sfha_off_panel}")
    with rasterio.open(OUT_DIR / "nfhl.tif") as ds:
        assert ds.transform == Affine.from_gdal(*G.transform()) and (ds.width, ds.height) == (G.COLS, G.ROWS)
        assert ds.crs == rasterio.crs.CRS.from_user_input(G.CRS) and ds.nodata == 0 and ds.dtypes[0] == "uint8"
    meta = {"product": "FEMA National Flood Hazard Layer, Key Layers (S_FIRM_PAN effective panels, S_FLD_HAZ_AR SFHA)",
            "credit": "FEMA National Flood Hazard Layer",
            "licence": "US federal work; FEMA asks for acknowledgement of the NFHL as the source",
            "codes": CODES, "rule": RULE, "sfha_rule": SFHA_NOTE, "land_mask": "state.tif > 0", "method": method()}
    man_p = NFHL_DIR / "nfhl_manifest.json"
    if man_p.exists():
        man = json.loads(man_p.read_text())
        meta.update(edition_file=man["file"], last_modified=man["last_modified"], sha256=man["sha256"], size=man["size"],
                    url=man["url"])
    stats_p = PARTS.parent / "inspect.json"
    if stats_p.exists():
        meta.update(json.loads(stats_p.read_text()))
    meta.update(class_counts={str(i): int(hist[i]) for i in range(4)}, land_cells=n_land,
                sfha_ge50_without_panel_ge50=sfha_off_panel,
                exact_cells={"panel": int(ex[0]), "sfha": int(ex[1])}, features_read={"panel": int(ft[0]), "sfha": int(ft[1])},
                runtime_s=round((t_windows or 0) + time.time() - t0, 1),
                peak_rss_gib=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20, 2))
    (OUT_DIR / "nfhl_meta.json").write_text(json.dumps(meta, indent=1))
    log("wrote nfhl_meta.json")


# ---------------------------------------------------------------- inspect

def inspect_layers():
    """Layers, fields, counts and SFHA_TF value counts; stops on a value outside SFHA_VALUES. Writes tmp/build-tmp/nfhl/inspect.json."""
    import pyogrio
    import pyogrio.raw
    info = layer_info()
    path = gdb_path()
    res = {"layer_counts": {ly: int(i["features"]) for ly, i in info.items()}, "layer_crs": {ly: str(i["crs"]) for ly, i in info.items()}}
    log(f"features: {res['layer_counts']}; crs {res['layer_crs']}")
    meta, _, _, data = pyogrio.raw.read(path, layer=LAYER_SFHA, columns=["SFHA_TF", "FLD_ZONE"], read_geometry=False)
    cols = dict(zip(meta["fields"], data))  # columns come back in layer order, not the order asked
    vals = np.array([str(v) for v in cols["SFHA_TF"]])
    zone = np.array([str(v) for v in cols["FLD_ZONE"]])
    keys, counts = np.unique(vals, return_counts=True)
    res["sfha_tf_counts"] = {str(k): int(c) for k, c in zip(keys, counts)}
    log(f"SFHA_TF value counts: {res['sfha_tf_counts']}")
    res["fld_zone_counts_of_u_and_null"] = {}
    for key, v in (("U", "U"), ("null", "None")):
        k2, c2 = np.unique(zone[vals == v], return_counts=True)  # one pass over the columns (a `where` on this layer is not trusted for IS NULL)
        res["fld_zone_counts_of_u_and_null"][key] = {str(k): int(c) for k, c in zip(k2, c2)}
    log(f"FLD_ZONE of U / null: {res['fld_zone_counts_of_u_and_null']}")
    bad = sfha_bad_values(res["sfha_tf_counts"])
    if bad:
        sys.exit(f"SFHA_TF holds values outside {sorted(SFHA_VALUES)}: {res['sfha_tf_counts']}")
    res["sfha_t_features"] = res["sfha_tf_counts"].get("T", 0)
    PARTS.parent.mkdir(parents=True, exist_ok=True)
    (PARTS.parent / "inspect.json").write_text(json.dumps(res, indent=1))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["inspect", "windows", "assemble", "all"])
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    t0 = time.time()
    if a.step in ("inspect", "all"):
        inspect_layers()
    t_w = None
    if a.step in ("windows", "all"):
        disk_guard.require_free(ROOT / "tmp", int(2 * 2**30))
        t_w = run_windows(min(a.workers, 4))
    if a.step in ("assemble", "all"):
        assemble(t_w)
    log(f"{a.step} done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
