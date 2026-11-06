#!/usr/bin/env python3
"""Assemble the routing cube: data/build/route/250m/*.tif bands -> data/route/250m/{pd,osm}_c_r.tif + grid.json.

Role: last producer step of the route-optimizer data (after build_route_bands/restrict/slope/flags/costbands/structures/wetland/buildings/aviation/nfhl).
The aviation and nfhl tifs are bound by sha256 (read at load, recorded in grid.json, re-read after stacking)
with their source edition (NTAD effective date; NFHL edition file + zip sha256) and credit.
Stacks the single-band 250 m grids into 4096 x 4096 super-tiles (edge tiles at true size, not
padded), one 19-band public-domain/CC BY file (pd_) and one 3-band OSM-derived file (osm_, ODbL;
the adj band is derived from OSM lines, so it lives only here)
per super-tile, as COGs the browser reader assets/route/cog-read.ts decodes (deflate, no
predictor, pixel-interleaved, 512 blocks, classic TIFF, no overviews). All-zero super-tiles
are skipped and listed in grid.json `super_tiles_present`. Also dumps three decoded 512 blocks
to data/build/route/fixtures/ for assets/route/cube.validate.test.ts. Cube and fixtures
are assembled in sibling staging directories and promoted together only on success;
previous destinations remain as uniquely named backups. Explicit --output-dir and
--fixtures-dir destinations allow parity checks before replacing an active cube.
Deps: scripts/route_grid.py (grid, tiles, code tables); rasterio, numpy (venv).
Run: venv/bin/python scripts/build_route_cube.py
"""
import argparse, base64, hashlib, json, os, sys, tempfile, time, uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import route_grid as G  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data/build/route/250m"
OUT = ROOT / "data/route/250m"
FIX = ROOT / "data/build/route/fixtures"
MAX_BYTES = 100 * 1024 * 1024
COG_OPTS = dict(COMPRESS="DEFLATE", PREDICTOR="NO", INTERLEAVE="PIXEL", BLOCKSIZE=G.BLOCK,
                BIGTIFF="NO", OVERVIEWS="NONE")

# source file per band, in band order: route_grid.PD_BANDS / OSM_BANDS name the bands; every
# PD band's file is data/build/route/250m/<name>.tif, the OSM flags band is osmflags.tif
PD_SRC = dict(G.PD_BANDS)
OSM_SRC = {b: ("osmflags" if n == "flags" else n) for b, n in G.OSM_BANDS.items()}


def raster_runtime():
    """Keep metadata and directory-promotion checks available to stdlib-only tests."""
    global np, rasterio, MemoryFile, Affine
    import numpy as np
    import rasterio
    import rasterio.shutil
    from rasterio.io import MemoryFile
    from rasterio.transform import Affine


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_metadata():
    names = ("bands", "flags", "slope", "restrict", "costbands", "bldg", "wetland", "buildings", "aviation", "nfhl")
    meta = {n: json.loads((SRC / f"{n}_meta.json").read_text()) for n in names}
    buildings = meta["buildings"]
    expected = {name: b for b, name in G.PD_BANDS.items() if name in ("built", "nonres", "bldgunk")}
    if set(buildings["bands"]) != set(expected):
        raise ValueError("buildings metadata must describe built, nonres and bldgunk")
    for name, b in expected.items():
        entry = buildings["bands"][name]
        if entry["b"] != b or not entry.get("source") or not entry.get("licence"):
            raise ValueError(f"invalid building source metadata for {name}")
    for field in ("coverage", "checks"):
        if not isinstance(buildings[field], dict):
            raise ValueError(f"buildings metadata needs {field}")
    expected_files = {f"{name}.tif" for name in expected}
    if set(buildings.get("files", {})) != expected_files:
        raise ValueError("buildings metadata must bind all three footprint files by SHA256")
    for name in sorted(expected_files):
        if sha256_file(SRC / name) != buildings["files"][name]:
            raise ValueError(f"building generation hash mismatch: {name}")
    building_provenance(buildings)
    meta["source_bands"] = {"aviation": source_band("aviation", meta["aviation"], G.AVIATION_CODES),
                            "nfhl": source_band("nfhl", meta["nfhl"], G.NFHL_CODES)}
    return meta


def source_band(name, meta, codes):
    """The pd_band_sources entry of aviation / nfhl: the meta's code table must equal route_grid.py's,
    its credit and source edition must be there, and the tif is bound by the sha256 read now (and
    by the one the meta records under `files`, when it records one). assemble() re-reads the hash."""
    if {k: v for k, v in meta.get("codes", {}).items() if k != "0"} != {str(k): v for k, v in codes.items()}:
        raise ValueError(f"{name} metadata codes differ from route_grid.py")
    if name == "aviation":
        credit, licence = "FAA NTAD", "public domain (US federal work, FAA)"
        edition = {k: meta.get(k) for k in ("ntad_eff_date", "ntad_fetched", "ntad_sha256")}
        ok = str(meta.get("product", "")).startswith(credit) and edition["ntad_eff_date"] and edition["ntad_sha256"]
        vintage = f"NTAD effective {edition['ntad_eff_date']}"
    else:
        credit, licence = "FEMA National Flood Hazard Layer", meta.get("licence")
        edition = {k: meta.get(k) for k in ("edition_file", "last_modified", "sha256", "url")}
        ok = (meta.get("credit") == credit and licence and edition["edition_file"]
              and len(str(edition["sha256"])) == 64)
        vintage = f"{edition['edition_file']} (Last-Modified {edition['last_modified']})"
    if not ok:
        raise ValueError(f"{name} metadata lacks its credit ({credit}) or source edition")
    digest = sha256_file(SRC / f"{name}.tif")
    if meta.get("files", {}).get(f"{name}.tif", digest) != digest:
        raise ValueError(f"{name} generation hash mismatch: {name}.tif")
    b = next(k for k, v in G.PD_BANDS.items() if v == name)
    return {"b": b, "source": meta["product"], "credit": credit, "licence": licence, "vintage": vintage,
            "edition": edition, "method": meta.get("method_text", meta.get("rule")), "codes": meta["codes"],
            "file": f"{name}.tif", "sha256": digest}


def verify_source_bands(metadata):
    """The aviation / nfhl tifs stacked are the ones load_metadata() hashed."""
    for name, entry in metadata["source_bands"].items():
        if sha256_file(SRC / entry["file"]) != entry["sha256"]:
            raise ValueError(f"{name} generation hash mismatch: {entry['file']} changed during assembly")


def building_provenance(buildings):
    """Keep source identity and dates in the cube without copying a regional ID list."""
    provenance = buildings["provenance"]
    identity = provenance.get("identity", {})
    ids = provenance.get("object_ids")
    return {
        "built_at": buildings["built_at"],
        "identity": {k: identity[k] for k in ("source", "bounds", "fields", "crs", "edit_state", "archives") if k in identity},
        "fetched_at": provenance.get("fetched_at"),
        "sha256": provenance["sha256"],
        "object_id_count": len(ids) if isinstance(ids, list) else None,
        "feature_count": len(ids) if isinstance(ids, list) else provenance.get("feature_count"),
    }


def promote_directories(pairs, replace=None):
    """Replace complete directories, restoring both old destinations if either swap fails."""
    replace = replace or os.replace
    done, backups = [], []
    try:
        for staged, target in pairs:
            if target.exists():
                backup = target.with_name(f"{target.name}.previous-{uuid.uuid4().hex}")
                replace(target, backup)
                backups.append((target, backup))
            replace(staged, target)
            done.append((staged, target))
    except BaseException:
        for staged, target in reversed(done):
            replace(target, staged)
        for target, backup in reversed(backups):
            replace(backup, target)
        raise
    for target, backup in backups:
        log(f"previous {target.name} retained at {backup}")
    return backups


def build_staged(output, fixtures, build=None):
    """A failed assembly never writes into either current destination."""
    global OUT, FIX
    output, fixtures = Path(output).resolve(), Path(fixtures).resolve()
    if output == fixtures or output in fixtures.parents or fixtures in output.parents:
        raise ValueError("cube and fixture destinations must be separate directories")
    for path in (output, fixtures):
        if path == SRC.resolve() or path in SRC.resolve().parents:
            raise ValueError("a destination cannot contain the source grids")
        if path.exists() and not path.is_dir():
            raise ValueError(f"destination is not a directory: {path}")
    metadata = load_metadata()
    for target in (output, fixtures):
        target.parent.mkdir(parents=True, exist_ok=True)
    staged_out = Path(tempfile.mkdtemp(prefix=f"{output.name}.stage-", dir=output.parent))
    staged_fix = Path(tempfile.mkdtemp(prefix=f"{fixtures.name}.stage-", dir=fixtures.parent))
    prior = OUT, FIX
    try:
        OUT, FIX = staged_out, staged_fix
        (build or assemble)(metadata)
        promote_directories([(staged_out, output), (staged_fix, fixtures)])
    except BaseException:
        log(f"staged build retained for inspection: {staged_out}, {staged_fix}")
        raise
    finally:
        OUT, FIX = prior


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def open_sources(table):
    out = {}
    for b, name in table.items():
        r = rasterio.open(SRC / f"{name}.tif")
        assert (r.width, r.height, r.count) == (G.COLS, G.ROWS, 1), (name, r.width, r.height, r.count)
        assert r.dtypes[0] == "uint8", (name, r.dtypes)
        assert r.transform == Affine.from_gdal(*G.transform()), (name, r.transform)
        assert r.crs.to_epsg() == 5070, (name, r.crs)
        out[b] = r
    return out


def write_cog(path, arr, win):
    """arr: (bands, h, w) uint8 for the super-tile at `win` (col_off, row_off, w, h)."""
    c0, r0, w, h = win
    x, y = G.xy_of(c0, r0, center=False)
    prof = dict(driver="GTiff", dtype="uint8", count=arr.shape[0], width=w, height=h,
                crs="EPSG:5070", transform=Affine(G.CELL, 0, x, 0, -G.CELL, y), nodata=0)
    with MemoryFile() as mf:
        with mf.open(**prof) as m:
            m.write(arr)
        with mf.open() as m:
            if path.exists():
                path.unlink()
            rasterio.shutil.copy(m, str(path), driver="COG", **COG_OPTS)


def check_tags(path, bands, win):
    c0, r0, w, h = win
    with path.open("rb") as f:
        assert f.read(4) == b"II*\x00", f"{path.name}: not classic little-endian TIFF (BigTIFF?)"
    with rasterio.open(path) as r:
        p = r.profile
        ims = r.tags(ns="IMAGE_STRUCTURE")
        assert (r.width, r.height, r.count) == (w, h, bands), (path.name, r.width, r.height, r.count)
        assert p["tiled"] and p["blockxsize"] == G.BLOCK and p["blockysize"] == G.BLOCK, (path.name, p)
        assert ims.get("COMPRESSION") == "DEFLATE", (path.name, ims)
        assert ims.get("PREDICTOR", "1") == "1", (path.name, ims)
        assert ims.get("INTERLEAVE") == "PIXEL", (path.name, ims)
        assert all(len(r.overviews(i)) == 0 for i in range(1, bands + 1)), f"{path.name}: has overviews"
        assert all(d == "uint8" for d in r.dtypes)
        x, y = G.xy_of(c0, r0, center=False)
        assert r.transform == Affine(G.CELL, 0, x, 0, -G.CELL, y), (path.name, r.transform)
        assert r.crs.to_epsg() == 5070


def dump_fixture(name, path, bx, by):
    """Raw pixel-interleaved bytes of block (bx, by) of `path`, as base64 + sha256."""
    with rasterio.open(path) as r:
        win = rasterio.windows.Window(bx * G.BLOCK, by * G.BLOCK, min(G.BLOCK, r.width - bx * G.BLOCK),
                                      min(G.BLOCK, r.height - by * G.BLOCK))
        a = r.read(window=win)
    raw = np.ascontiguousarray(a.transpose(1, 2, 0)).tobytes()  # row-major, pixel-interleaved
    FIX.mkdir(parents=True, exist_ok=True)
    (FIX / f"{name}.json").write_text(json.dumps({
        "file": path.name, "block": [bx, by], "bands": a.shape[0],
        "width": int(win.width), "height": int(win.height),
        "layout": "row-major, pixel-interleaved uint8 over the clipped block (width x height x bands)",
        "sha256": hashlib.sha256(raw).hexdigest(),
        "nonzero": int(np.count_nonzero(a)),
        "band_nonzero": [int(np.count_nonzero(a[i])) for i in range(a.shape[0])],
        "b64": base64.b64encode(raw).decode(),
    }))
    log(f"fixture {name}: {path.name} block ({bx},{by}) {win.width}x{win.height}x{a.shape[0]}, nonzero {int(np.count_nonzero(a))}")


def assemble(metadata):
    raster_runtime()
    OUT.mkdir(parents=True, exist_ok=True)
    pd, osm = open_sources(PD_SRC), open_sources(OSM_SRC)
    present, skipped, sizes = [], [], {"pd": 0, "osm": 0}
    best = None  # (score, scol, srow, bx, by): full osm block with the most distinct flag bits
    for scol, srow, c0, r0, w, h in G.super_tiles():
        win = rasterio.windows.Window(c0, r0, w, h)
        pa = np.stack([pd[b].read(1, window=win) for b in sorted(pd)])
        oa = np.stack([osm[b].read(1, window=win) for b in sorted(osm)])
        if not pa.any() and not oa.any():
            skipped.append([scol, srow])
            log(f"skip {scol}_{srow}: all zero")
            continue
        present.append([scol, srow])
        for kind, arr in (("pd", pa), ("osm", oa)):
            p = OUT / f"{kind}_{scol}_{srow}.tif"
            write_cog(p, arr, (c0, r0, w, h))
            check_tags(p, arr.shape[0], (c0, r0, w, h))
            n = p.stat().st_size
            assert n < MAX_BYTES, f"{p.name} is {n} bytes, over 100 MiB"
            sizes[kind] += n
            log(f"{p.name}: {w}x{h}x{arr.shape[0]} {n / 2**20:.1f} MiB")
        for yy in range(0, h - G.BLOCK + 1, G.BLOCK):
            for xx in range(0, w - G.BLOCK + 1, G.BLOCK):
                bits = int(np.bitwise_or.reduce(oa[0, yy:yy + G.BLOCK, xx:xx + G.BLOCK].ravel()))
                score = bin(bits).count("1")
                if best is None or score > best[0]:
                    best = (score, scol, srow, xx // G.BLOCK, yy // G.BLOCK)
        del pa, oa
    verify_source_bands(metadata)
    for kind, tot in sizes.items():
        log(f"total {kind}: {tot / 2**20:.1f} MiB")
    # stale files from an earlier run for tiles now skipped
    for s in skipped:
        for kind in ("pd", "osm"):
            (OUT / f"{kind}_{s[0]}_{s[1]}.tif").unlink(missing_ok=True)

    bands, flags, slope, restrict = (metadata[n] for n in ("bands", "flags", "slope", "restrict"))
    costb, bldg, wetland, buildings = (metadata[n] for n in ("costbands", "bldg", "wetland", "buildings"))
    extra = {
        "pd_files": {"pattern": "pd_{col}_{row}.tif", "licence": "public domain + CC BY 4.0 (credited per band/bit)"},
        "osm_files": {"pattern": "osm_{col}_{row}.tif", "licence": "ODbL: OpenStreetMap contributors (plus public-domain line sources, credited per bit)"},
        "pd_band_sources": {
            **{k: v for k, v in bands["bands"].items()},
            "slope": {"b": 2, "source": slope["source"], "product": slope["product"], "vintage": f"fetched {slope['fetch_date']}",
                      "licence": "public domain (USGS 3DEP)", "method": slope["method"], "mask": slope["mask"]},
            "flags": {"b": 7, "bits": flags["flags_pd_b7"]},
            "desig": {"b": 9, **restrict["desig_b9"]},
            "flags2": {"b": 10, **restrict["flags2_b10"]},
            "isoreg": {"b": 11, **costb["isoreg_b11"]},
            "landval": {"b": 12, **costb["landval_b12"]},
            "bldg": {**bldg["bldg_b13"], "states": {s: {k: m[k] for k in ("deliverable", "last_modified", "residential", "image_year")} for s, m in bldg["states"].items()}},
            "wetland": {**wetland["wetland_b14"], "states": {s: {k: m[k] for k in ("last_modified", "kept_features", "acres_kept", "acres_raster")} for s, m in wetland["states"].items()}},
            **buildings["bands"],
            **metadata["source_bands"],
        },
        "osm_band_sources": {"flags": {"b": 1, "bits": flags["osm_b1_flags"]}, "maxkv": {"b": 2, **flags["osm_b2_maxkv"]},
                             "adj": {"b": 3, **flags["osm_b3_adj"]}},
        "restrict_acreage_check": restrict["acreage_check"],
        "osm_vintage": flags["osm_vintage"],
        "maxkv_rules": flags["maxkv_rules"],
        "flag_rules": flags["rules"],
        "wetland_checks": wetland["checks"],
        "bldg_checks": {k: v for k, v in bldg["checks"].items() if k != "by_state_fips"},
        "building_coverage": buildings["coverage"],
        "building_checks": buildings["checks"],
        "building_provenance": building_provenance(buildings),
        "tnc_choice": bands["tnc_choice"],
        "agency_rule": bands["agency_rule"],
        "whp_cnt_max": bands["cnt_max"],
        "slope": slope,
        "super_tiles_present": present,
        "super_tiles_skipped": skipped,
        "built": time.strftime("%Y-%m-%d"),
    }

    # fixtures: interior Rockies block (pd), a block with nonzero OSM flags (osm), a partial edge block (pd)
    # Rockies (Colorado): approx (-7e5, 1.8e6) in EPSG:5070
    rx, ry = -700_000.0, 1_800_000.0
    cc, rr = G.cell_of(rx, ry)
    scol, srow = cc // G.SUPER, rr // G.SUPER
    bx, by = (cc - scol * G.SUPER) // G.BLOCK, (rr - srow * G.SUPER) // G.BLOCK
    dump_fixture("pd_rockies", OUT / f"pd_{scol}_{srow}.tif", bx, by)
    _, sc, sr, bx, by = best
    dump_fixture("osm_flags", OUT / f"osm_{sc}_{sr}.tif", bx, by)
    # partial edge: the clipped last-column/last-row block with the most non-empty bands
    ec, er = max(c for c, _ in present), max(r for _, r in present)
    edge = None  # (non-empty bands, nonzero, tile col, tile row, bx, by)
    for c, r in present:
        if c != ec and r != er:
            continue
        with rasterio.open(OUT / f"pd_{c}_{r}.tif") as ds:
            for yy in range(0, ds.height, G.BLOCK):
                for xx in range(0, ds.width, G.BLOCK):
                    if not ((c == ec and xx + G.BLOCK >= ds.width) or (r == er and yy + G.BLOCK >= ds.height)):
                        continue
                    a = ds.read(window=rasterio.windows.Window(xx, yy, min(G.BLOCK, ds.width - xx), min(G.BLOCK, ds.height - yy)))
                    if a.shape[1:] == (G.BLOCK, G.BLOCK):
                        continue  # must be ragged
                    key = (sum(1 for k in range(a.shape[0]) if a[k].any()), int(np.count_nonzero(a)))
                    if edge is None or key > edge[:2]:
                        edge = (*key, c, r, xx // G.BLOCK, yy // G.BLOCK)
    assert edge is not None, "no ragged edge block found"
    log(f"pd_edge: {edge[0]} non-empty bands")
    dump_fixture("pd_edge", OUT / f"pd_{edge[2]}_{edge[3]}.tif", edge[4], edge[5])

    # last, so a complete grid.json implies complete tiles and fixtures
    tmp = OUT / "grid.json.tmp"
    tmp.write_text(json.dumps(G.grid_json(extra), indent=1))
    tmp.replace(OUT / "grid.json")
    log(f"grid.json: {len(present)} super-tiles present, {len(skipped)} skipped {skipped}")


def main():
    global SRC
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=SRC)
    parser.add_argument("--output-dir", type=Path, default=OUT)
    parser.add_argument("--fixtures-dir", type=Path, default=FIX)
    args = parser.parse_args()
    SRC = args.source_dir
    build_staged(args.output_dir, args.fixtures_dir)


if __name__ == "__main__":
    main()
