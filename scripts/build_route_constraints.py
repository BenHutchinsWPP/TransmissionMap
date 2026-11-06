#!/usr/bin/env python3
"""Route constraints layer tiles: one paletted raster PMTiles per concern in
scripts/route_constraints.json (generated from src/colors/route-constraints.ts), built from
the routing cube's super-tiles data/route/250m/pd_{c}_{r}.tif (and osm_{c}_{r}.tif for OSM concerns).

Per concern: a one-band uint8 index raster over the whole grid (mask -> 1, classes -> the
class code, land manager -> its precedence code, "what constrains" overview -> precedence
code; 0 = none) -> gdalwarp to
EPSG:3857 with -r near on the z9 pixel grid -> `gdal raster tile` z3-z9 (nearest at max zoom,
`max` overviews so thin features survive; `mode` for the land manager and nominal classes,
whose codes are not a precedence) -> each code tile recoloured to a paletted PNG (index 0 transparent) -> MBTiles
(stdlib sqlite3, TMS rows) -> `pmtiles convert`. Output data/route/constraints/<id>.pmtiles +
manifest.json; never data/layers/ (publish_data.sh ships that). Reads pd_ files, and osm_ files
only for OSM concerns (credited ODbL); the overview and land manager never read osm_.

Usage: build_route_constraints.py [--only id1,id2] [--force] [--no-spot-checks]
Heavy deps (rasterio, numpy, PIL) are imported inside functions so the pure helpers stay
stdlib-only for scripts/test_route_constraints.py. GDAL is used through its CLI tools.
"""
import argparse
import datetime
import glob
import json
import math
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "scripts" / "route_constraints.json"
CUBE = ROOT / "data" / "route" / "250m"
OUT = ROOT / "data" / "route" / "constraints"
WORK = ROOT / "tmp" / "build-tmp" / "route-constraints"
MIN_ZOOM, MAX_ZOOM = 3, 9
MAX_BYTES = 20 * 1024 * 1024
WEB_MERCATOR_HALF = math.pi * 6378137.0
ATTRIBUTION = ("Routing cube: USGS PAD-US, USGS NLCD, USFWS, EPA, NPS, BLM, USDA Forest Service, "
               "DOE/ANL Section 368, PoPWest (Wu et al. 2023, doi:10.5281/zenodo.7460026, CC BY 4.0), "
               "USA Structures (ORNL, FEMA GRO, CC BY 4.0), "
               "HIFLD via SeerAI source.coop (CC BY 4.0), WorldPop (CC BY 4.0)")
ATTRIBUTION_OSM = "; \u00a9 OpenStreetMap contributors (ODbL)"
# Credits of the bands the shared line above does not name; added to a tile set that reads the band.
BAND_CREDITS = {
    "aviation": "FAA NTAD (EFF_DATE 2026/10/29)",
    "nfhl": "FEMA National Flood Hazard Layer (202610)",
    "isoreg": "EIA balancing authority areas",
    "landval": "USDA NASS Census of Agriculture 2022",
}
STRIP_ROWS = 1024

# Three known cells: (label, lon, lat, {concern id: expected class colour key}).
SPOT_CHECKS = [
    ("Wind River Reservation, WY", -108.80, 43.20, {"what-constrains": "tribal", "land-manager": "tribal"}),
    ("Fort Irwin, CA", -116.60, 35.35, {"what-constrains": "military", "land-manager": "dod", "military": "military"}),
    ("BLM land, central NV", -116.80, 39.80, {"land-manager": "blm"}),
    ("West desert, UT (no FEMA map)", -113.50, 39.50, {"fema-flood": "no-map"}),
    ("NAS Fallon runway, NV", -118.70, 39.417, {"aviation": "primary"}),
    ("Atchafalaya Basin floodway, LA", -91.65, 30.30, {"fema-flood": "sfha", "what-constrains": "floodplain"}),
    ("Bridger-Teton NF, WY", -110.30, 43.60, {"land-manager": "usfs"}),
    ("Great Salt Lake, UT", -112.50, 41.10, {"landcover": "water", "osm-lake": "osm-lake"}),
    ("Longs Peak, CO", -105.615, 40.255, {"slope": "mountain"}),
]


# ── pure helpers (stdlib) ──────────────────────────────────────────────────────────────────
def hex_rgb(h):
    h = h.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"colour {h!r} is not #rrggbb")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def concern_plan(spec, concern):
    """Concern -> {id, kind, classes: [(code, colour, key, [rules])] ascending by code, bands,
    overview_resampling}. Codes are 1..255; a higher code wins where classes overlap."""
    kind = concern["kind"]
    if kind == "mask":
        classes = [(1, concern["colour"], concern["id"], [concern["rule"]])]
        resampling = "max"
    elif kind == "overview":
        classes = [(e["code"], e["colour"], e["id"], e["rules"]) for e in spec["overview"]]
        resampling = "max"
    elif kind == "categorical":
        classes = [(e["code"], e["colour"], e["id"], e["rules"]) for e in spec["landManager"]]
        resampling = "mode"  # a manager is not "more" than another, so `max` would invent a ranking
    elif kind == "classes":
        resampling = concern.get("resampling")
        if resampling not in ("max", "mode"):
            raise ValueError(f"{concern['id']}: resampling must be max or mode, got {resampling!r}")
        classes = [(e["code"], e["colour"], e["id"], e["rules"]) for e in concern["classes"]]
    else:
        raise ValueError(f"{concern['id']}: unknown kind {kind!r}")
    classes.sort(key=lambda c: c[0])
    codes = [c[0] for c in classes]
    if len(set(codes)) != len(codes) or not all(1 <= c <= 255 for c in codes):
        raise ValueError(f"{concern['id']}: codes must be distinct and in 1..255, got {codes}")
    for _, colour, _, rules in classes:
        hex_rgb(colour)
        if not rules:
            raise ValueError(f"{concern['id']}: a class with no rules")
        for r in rules:
            if ("bit" in r) == ("values" in r):
                raise ValueError(f"{concern['id']}: rule needs exactly one of bit/values: {r}")
    bands = sorted({r["band"] for c in classes for r in c[3]})
    for b in bands:
        band_ref(b)
        if kind in ("overview", "categorical") and band_ref(b)[0] != "pd":
            raise ValueError(f"{concern['id']}: {kind} palettes read pd_ bands only, got {b!r}")
    if kind == "classes":
        seen = {}
        for _, _, key, rules in classes:
            for v in range(256):
                if any(rule_match(r, v) for r in rules):
                    if v in seen:
                        raise ValueError(f"{concern['id']}: classes {seen[v]!r} and {key!r} share value {v}")
                    seen[v] = key
    return {"id": concern["id"], "kind": kind, "classes": classes, "bands": bands,
            "overview_resampling": resampling}


def band_ref(name):
    """Rule band name -> (family, 1-based band number): pd names resolve through PD_BANDS,
    osm_flags / osm_maxkv / adj through OSM_BANDS; anything else is a ValueError."""
    sys.path.insert(0, str(ROOT / "scripts"))
    from route_grid import OSM_BANDS, PD_BANDS
    osm = {"osm_" + n if n != "adj" else n: i for i, n in OSM_BANDS.items()}
    if name in osm:
        return "osm", osm[name]
    pd = {n: i for i, n in PD_BANDS.items()}
    if name in pd:
        return "pd", pd[name]
    raise ValueError(f"unknown band {name!r}")


def plan_reads_osm(plan):
    return any(band_ref(b)[0] == "osm" for b in plan["bands"])


def grids_equal(a, b):
    """(width, height, transform, crs) tuples of the pd and osm VRTs; a mismatch is an error."""
    if tuple(a) != tuple(b):
        raise ValueError(f"pd and osm grids differ: {tuple(a)} vs {tuple(b)}")


def rule_match(rule, v):
    """One cell value against one rule (the scalar twin of the numpy path)."""
    if "bit" in rule:
        return (v >> rule["bit"]) & 1 == 1
    if "mask" in rule:
        v &= rule["mask"]
    return v in rule["values"]


def cell_code(plan, cell):
    """Band name -> value for one cell -> the plan's code (0 = none); highest code wins."""
    code = 0
    for c, _, _, rules in plan["classes"]:
        if any(rule_match(r, cell[r["band"]]) for r in rules):
            code = c
    return code


def palette(plan):
    """768-entry PIL palette: index = code, 0 left black (written transparent)."""
    pal = [0] * 768
    for code, colour, _, _ in plan["classes"]:
        pal[code * 3:code * 3 + 3] = hex_rgb(colour)
    return pal


def allowed_rgba(plan):
    return {(*hex_rgb(colour), 255) for _, colour, _, _ in plan["classes"]}


def tms_row(z, y):
    """XYZ row -> MBTiles (TMS) row."""
    return (1 << z) - 1 - y


def tile_lonlat(z, x, y):
    """North-west corner of XYZ tile (z, x, y) in lon/lat."""
    n = 1 << z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def tiles_bounds(z, xs, ys):
    """Lon/lat bounds (w, s, e, n) of the XYZ tiles with columns xs and rows ys at zoom z."""
    w, n = tile_lonlat(z, min(xs), min(ys))
    e, s = tile_lonlat(z, max(xs) + 1, max(ys) + 1)
    return w, s, e, n


def lonlat_tile_pixel(lon, lat, z, size=256):
    """Lon/lat -> (x, y, px, py): the XYZ tile at zoom z and the pixel inside it."""
    n = 1 << z
    fx = (lon + 180.0) / 360.0 * n
    lr = math.radians(lat)
    fy = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n
    x, y = int(fx), int(fy)
    return x, y, int((fx - x) * size), int((fy - y) * size)


def zoom_res(z, size=256):
    """Web Mercator metres per pixel at zoom z."""
    return 2 * WEB_MERCATOR_HALF / (size * (1 << z))


def is_stale(out, inputs, force=False):
    if force or not out.exists():
        return True
    t = out.stat().st_mtime
    return any(p.stat().st_mtime >= t for p in inputs)


def select_concerns(spec, only):
    ids = [c["id"] for c in spec["concerns"]]
    if not only:
        return list(spec["concerns"])
    want = [s for s in only.split(",") if s]
    unknown = [s for s in want if s not in ids]
    if unknown:
        raise SystemExit(f"unknown concern id(s): {', '.join(unknown)}; known: {', '.join(ids)}")
    return [c for c in spec["concerns"] if c["id"] in want]


# ── heavy steps ────────────────────────────────────────────────────────────────────────────
def run(cmd):
    print("  $", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, stdout=subprocess.DEVNULL)


def pd_files():
    files = sorted(CUBE.glob("pd_*.tif"))
    assert files and all(f.name.startswith("pd_") for f in files), "no pd_ super-tiles"
    return files


def osm_files():
    files = sorted(CUBE.glob("osm_*.tif"))
    assert files and all(f.name.startswith("osm_") for f in files), "no osm_ super-tiles"
    return files


def build_vrt(files, name="pd.vrt"):
    vrt = WORK / name
    if is_stale(vrt, files):
        run(["gdalbuildvrt", "-q", "-overwrite", vrt, *files])
    return vrt


def vrts_for(plans):
    """Family -> VRT for the families the plans read; the osm VRT only when one reads OSM."""
    vrts = {"pd": build_vrt(pd_files())}
    if any(plan_reads_osm(p) for p in plans):
        vrts["osm"] = build_vrt(osm_files(), "osm.vrt")
        import rasterio
        with rasterio.open(vrts["pd"]) as a, rasterio.open(vrts["osm"]) as b:
            grids_equal((a.width, a.height, tuple(a.transform), str(a.crs)),
                        (b.width, b.height, tuple(b.transform), str(b.crs)))
    return vrts


def eval_rule(rule, arr):
    import numpy as np
    if "bit" in rule:
        return ((arr >> rule["bit"]) & 1).astype(bool)
    if "mask" in rule:
        arr = arr & rule["mask"]
    return np.isin(arr, rule["values"])


def build_index(vrts, plan, out_tif):
    """The concern's code raster over the whole grid, in strips (a few bands x 1024 rows);
    each band is read from its family's VRT over the same window."""
    import numpy as np
    import rasterio
    from rasterio.windows import Window
    refs = {name: band_ref(name) for name in plan["bands"]}
    srcs = {fam: rasterio.open(vrts[fam]) for fam in {f for f, _ in refs.values()}}
    try:
        src = srcs["pd"] if "pd" in srcs else next(iter(srcs.values()))
        prof = dict(driver="GTiff", width=src.width, height=src.height, count=1, dtype="uint8",
                    crs=src.crs, transform=src.transform, nodata=0, compress="deflate",
                    tiled=True, blockxsize=512, blockysize=512, BIGTIFF="IF_SAFER")
        counts = np.zeros(256, dtype=np.int64)
        with rasterio.open(out_tif, "w", **prof) as dst:
            for r0 in range(0, src.height, STRIP_ROWS):
                win = Window(0, r0, src.width, min(STRIP_ROWS, src.height - r0))
                b = {name: srcs[fam].read(n, window=win) for name, (fam, n) in refs.items()}
                idx = np.zeros((win.height, win.width), dtype=np.uint8)
                for code, _, _, rules in plan["classes"]:
                    hit = np.zeros(idx.shape, dtype=bool)
                    for r in rules:
                        hit |= eval_rule(r, b[r["band"]])
                    idx[hit] = code
                counts += np.bincount(idx.ravel(), minlength=256)
                dst.write(idx, 1, window=win)
    finally:
        for s_ in srcs.values():
            s_.close()
    return {int(c): int(n) for c, n in enumerate(counts) if n and c}


def warp_and_tile(index_tif, plan, tiles_dir):
    """Warp once at the z9 grid and tile z3-z9; the z8 fallback drops the z9 tiles when packing."""
    w = WORK / f"{plan['id']}_3857.tif"
    res = zoom_res(MAX_ZOOM)
    run(["gdalwarp", "-q", "-overwrite", "-t_srs", "EPSG:3857", "-r", "near", "-tr", res, res, "-tap",
         "-dstnodata", "0", "-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-co", "COMPRESS=DEFLATE",
         "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER", index_tif, w])
    if tiles_dir.exists():
        shutil.rmtree(tiles_dir)
    run(["gdal", "raster", "tile", "--min-zoom", MIN_ZOOM, "--max-zoom", MAX_ZOOM, "-r", "nearest",
         "--overview-resampling", plan["overview_resampling"], "--no-alpha", "--dst-nodata", "0",
         "--skip-blank", "--webviewer", "none", w, tiles_dir])
    w.unlink()


def attribution(plan):
    extra = "".join(f"; {BAND_CREDITS[b]}" for b in plan["bands"] if b in BAND_CREDITS)
    return ATTRIBUTION + extra + (ATTRIBUTION_OSM if plan_reads_osm(plan) else "")


def pack(tiles_dir, plan, max_zoom, mbtiles):
    """Recolour code tiles -> paletted PNG -> MBTiles; returns per-zoom stats + verification."""
    import io
    import numpy as np
    from PIL import Image
    pal = palette(plan)
    allowed = allowed_rgba(plan)
    codes_ok = {c[0] for c in plan["classes"]} | {0}
    if mbtiles.exists():
        mbtiles.unlink()
    db = sqlite3.connect(mbtiles)
    db.executescript("create table metadata(name text, value text);"
                     "create table tiles(zoom_level integer, tile_column integer, tile_row integer, tile_data blob);"
                     "create unique index tile_index on tiles(zoom_level, tile_column, tile_row);")
    stats = {}
    top = {"xs": [], "ys": []}
    for f in sorted(tiles_dir.glob("*/*/*.png")):
        z, x, y = int(f.parent.parent.name), int(f.parent.name), int(f.stem)
        if z > max_zoom:
            continue
        a = np.array(Image.open(f))
        assert a.ndim == 2, f"{f}: code tile is not one band"
        present = set(np.unique(a).tolist())
        if present == {0}:
            continue
        if not present <= codes_ok:
            raise AssertionError(f"{f}: codes {sorted(present - codes_ok)} outside the plan")
        im = Image.fromarray(a, "P")
        im.putpalette(pal)
        buf = io.BytesIO()
        im.save(buf, "PNG", transparency=bytes([0]), optimize=True)
        data = buf.getvalue()
        rgba = np.array(Image.open(io.BytesIO(data)).convert("RGBA"))
        opaque = rgba[rgba[..., 3] > 0]
        alphas = set(np.unique(rgba[..., 3]).tolist())
        colours = {tuple(int(v) for v in row) for row in np.unique(opaque, axis=0)} if len(opaque) else set()
        s = stats.setdefault(z, {"tiles": 0, "bytes": 0, "colours": set(), "alpha_ok": True})
        s["tiles"] += 1
        s["bytes"] += len(data)
        s["colours"] |= colours
        s["alpha_ok"] &= alphas <= {0, 255}
        if z == max_zoom:
            top["xs"].append(x)
            top["ys"].append(y)
        db.execute("insert into tiles values (?, ?, ?, ?)", (z, x, tms_row(z, y), data))
    if not top["xs"]:
        raise AssertionError(f"{plan['id']}: no non-empty tile at z{max_zoom}")
    w, s_, e, n = tiles_bounds(max_zoom, top["xs"], top["ys"])
    meta = {"name": f"Route constraints: {plan['id']}", "format": "png", "type": "overlay",
            "minzoom": MIN_ZOOM, "maxzoom": max_zoom,
            "bounds": f"{w:.5f},{s_:.5f},{e:.5f},{n:.5f}", "attribution": attribution(plan),
            "description": f"Routing constraints ({plan['kind']}): {plan['id']}"}
    db.executemany("insert into metadata values (?, ?)", [(k, str(v)) for k, v in meta.items()])
    db.commit()
    db.close()
    for z, s in stats.items():
        s["colours_ok"] = s["colours"] <= allowed
        s["colours"] = len(s["colours"])
    return stats, meta["bounds"]


def pmtiles_tile_rgba(pm, z, x, y):
    import io
    import numpy as np
    from PIL import Image
    r = subprocess.run(["pmtiles", "tile", str(pm), str(z), str(x), str(y)], capture_output=True)
    if r.returncode != 0 or not r.stdout:
        return None
    return np.array(Image.open(io.BytesIO(r.stdout)).convert("RGBA"))


def spot_checks(vrts, spec, built):
    """Each known cell: the z9 tile pixel of the final PMTiles must be the colour of the cube
    cell's class (FAIL otherwise); a cube class other than the expected one is a WARN (a data
    fact about the cube, not a tiling fault)."""
    import rasterio
    from rasterio.warp import transform
    by_id = {c["id"]: c for c in spec["concerns"]}
    results = []
    srcs = {fam: rasterio.open(v) for fam, v in vrts.items()}
    try:
        src = srcs["pd"]
        for label, lon, lat, want in SPOT_CHECKS:
            xs, ys = transform("EPSG:4326", src.crs, [lon], [lat])
            row, col = src.index(xs[0], ys[0])
            for cid, key in want.items():
                if cid not in built:
                    continue
                plan = concern_plan(spec, by_id[cid])
                cell = {name: int(srcs[fam].read(n, window=((row, row + 1), (col, col + 1)))[0, 0])
                        for name, (fam, n) in ((b, band_ref(b)) for b in plan["bands"])}
                colours = {k: c for _, c, k, _ in plan["classes"]}
                cube_code = cell_code(plan, cell)
                cube_key = next((k for c, _, k, _ in plan["classes"] if c == cube_code), "none")
                want_rgba = (*hex_rgb(colours[cube_key]), 255) if cube_code else (0, 0, 0, 0)
                mz = built[cid]
                x, y, px, py = lonlat_tile_pixel(lon, lat, mz)
                rgba = pmtiles_tile_rgba(OUT / f"{cid}.pmtiles", mz, x, y)
                if rgba is None:
                    got = (0, 0, 0, 0)  # no tile there: transparent
                else:
                    got = tuple(int(v) for v in rgba[py, px])
                    if got[3] == 0:
                        got = (0, 0, 0, 0)
                ok = got == want_rgba
                tag = "FAIL" if not ok else ("OK  " if cube_key == key else "WARN")
                results.append((label, cid, key, cube_key, got, ok))
                print(f"  spot {tag} {label} [{cid}] expected {key} {colours[key]} | cube cell {cube_key} "
                      f"| z{mz}/{x}/{y} px({px},{py}) {got}", flush=True)
    finally:
        for s_ in srcs.values():
            s_.close()
    return results


def build_concern(vrts, spec, concern, grid_version):
    plan = concern_plan(spec, concern)
    cid = plan["id"]
    t0 = time.time()
    print(f"== {cid} ({plan['kind']}, bands {','.join(plan['bands'])}, overviews {plan['overview_resampling']})",
          flush=True)
    idx = WORK / f"{cid}_idx.tif"
    counts = build_index(vrts, plan, idx)
    print(f"  index cells per code: {counts}", flush=True)
    pm = OUT / f"{cid}.pmtiles"
    tiles = WORK / f"{cid}_tiles"
    warp_and_tile(idx, plan, tiles)
    for max_zoom in (MAX_ZOOM, MAX_ZOOM - 1):
        mb = WORK / f"{cid}.mbtiles"
        stats, bounds = pack(tiles, plan, max_zoom, mb)
        tmp_pm = WORK / f"{cid}.pmtiles"
        if tmp_pm.exists():
            tmp_pm.unlink()
        run(["pmtiles", "convert", mb, tmp_pm])
        mb.unlink()
        size = tmp_pm.stat().st_size
        for z in sorted(stats):
            s = stats[z]
            print(f"  z{z}: {s['tiles']} tiles, {s['bytes']} B, {s['colours']} opaque colours, "
                  f"palette {'OK' if s['colours_ok'] else 'FAIL'}, alpha {'OK' if s['alpha_ok'] else 'FAIL'}",
                  flush=True)
        bad = [z for z, s in stats.items() if not (s["colours_ok"] and s["alpha_ok"])]
        if bad:
            raise AssertionError(f"{cid}: colours outside the palette at z{bad}")
        print(f"  {cid}.pmtiles z{MIN_ZOOM}-{max_zoom}: {size} B ({size / 2**20:.2f} MiB)", flush=True)
        if size <= MAX_BYTES:
            break
        if max_zoom == MAX_ZOOM - 1:
            raise AssertionError(f"{cid}: {size} B > 20 MiB even at z{max_zoom}")
        print(f"  over 20 MiB at z{max_zoom}: repacking without z{max_zoom}", flush=True)
    shutil.rmtree(tiles)
    idx.unlink()
    os.replace(tmp_pm, pm)
    return {"file": pm.name, "size": size, "minzoom": MIN_ZOOM, "maxzoom": max_zoom,
            "tiles": sum(s["tiles"] for s in stats.values()), "bounds": bounds, "kind": plan["kind"],
            "overview_resampling": plan["overview_resampling"],
            "built": datetime.date.today().isoformat(), "grid_version": grid_version,
            "seconds": round(time.time() - t0, 1)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", help="comma-separated concern ids")
    ap.add_argument("--force", action="store_true", help="rebuild even when the output is newer than its inputs")
    ap.add_argument("--no-spot-checks", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    spec = json.loads(SPEC.read_text())
    concerns = select_concerns(spec, args.only)
    plans = [concern_plan(spec, c) for c in concerns]
    grid = CUBE / "grid.json"
    grid_version = json.loads(grid.read_text())["version"]
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    vrts = vrts_for(plans)
    man_path = OUT / "manifest.json"
    manifest = json.loads(man_path.read_text()) if man_path.exists() else {}
    for c, plan in zip(concerns, plans):
        out = OUT / f"{c['id']}.pmtiles"
        inputs = [*pd_files(), grid, SPEC, *(osm_files() if plan_reads_osm(plan) else [])]
        if not is_stale(out, inputs, args.force):
            print(f"== {c['id']}: up to date, skipped", flush=True)
            continue
        manifest[c["id"]] = build_concern(vrts, spec, c, grid_version)
        man_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    known = {c["id"] for c in spec["concerns"]}
    for k in sorted(set(manifest) - known):
        stale = OUT / manifest[k].get("file", f"{k}.pmtiles")
        if stale.exists():
            stale.unlink()
            print(f"== {k}: no longer in the spec, deleted {stale.name}", flush=True)
    manifest = {k: v for k, v in manifest.items() if k in known}
    man_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    print("\nconcern                 size (B)     MiB  maxz  tiles")
    total = 0
    for c in spec["concerns"]:
        m = manifest.get(c["id"])
        if not m:
            print(f"{c['id']:22s}  (not built)")
            continue
        total += m["size"]
        print(f"{c['id']:22s} {m['size']:9d} {m['size'] / 2**20:7.2f}  z{m['maxzoom']:<3d} {m['tiles']:6d}"
              + ("  (capped at z8)" if m["maxzoom"] < MAX_ZOOM else ""))
    print(f"{'total':22s} {total:9d} {total / 2**20:7.2f}")

    if not args.no_spot_checks:
        built = {cid: m["maxzoom"] for cid, m in manifest.items() if (OUT / m["file"]).exists()}
        res = spot_checks(vrts_for([concern_plan(spec, c) for c in spec["concerns"] if c["id"] in built]),
                          spec, built)
        if not all(r[-1] for r in res):
            print("spot checks: FAIL", flush=True)
            sys.exit(1)
        warn = sum(1 for r in res if r[2] != r[3])
        print(f"spot checks: {len(res) - warn} OK, {warn} WARN", flush=True)
    print(f"done in {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()
