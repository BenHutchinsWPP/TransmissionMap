#!/usr/bin/env python3
"""Post-pipeline / pre-tile sanity checks. Catches silent build failures.

Pipeline role:
    run after `make pipeline` (and after `make tiles`) to confirm the build is
    consistent before it reaches `make releases` / production.

Three independent nets:
  1. INPUT sanity  — every Shapefile that release_manifest.yaml pulls from
     data/build/ must have >=1 row and CRS=EPSG:4326. (Catches empty / wrong-CRS
     shapefiles that tile silently into broken layers.)
  2. OUTPUT completeness — every "data/layers/<f>" path the frontend expects
     (assets/constants.ts DATA{}) must exist and be non-empty, and there must be
     NO orphan files in data/layers/ that the frontend doesn't reference.
     The orphan check is the A1 fingerprint: a double-prefixed tile name
     (gsa_gsa_solar_pvout.pmtiles) shows up as an orphan + a missing expected file.
  3. CROSS-MANIFEST consistency — every vector source release_manifest.yaml pulls
     from data/build/ must also be a tile_manifest.yaml `src` (the two consume the
     same build artifact). A path renamed in one manifest but not the other is the
     A1 bug class: silent drift between the two sources of truth. (Rasters are
     excluded — built by build_*_resource.sh, not the tile manifest.)

Severity:
  FAIL  present-but-broken (empty shp, wrong CRS, orphan layer file)  -> exit 1
  WARN  absent (layer not built yet — optional/manual inputs)         -> exit 0
  --strict upgrades every WARN to FAIL.

Usage:
  python scripts/validate_build.py [--strict]
  python scripts/validate_build.py --self-test   # check the parsers, no data
"""
from __future__ import annotations
import argparse
import re
import sys
from pathlib import Path

import yaml

MANIFEST  = Path("scripts/release_manifest.yaml")
TILE_MANIFEST = Path("scripts/tile_manifest.yaml")
CONSTANTS = Path("assets/constants.ts")
LAYERS    = Path("data/build")  # input shapefiles live here
OUT_DIR   = Path("data/layers")

VECTOR_KEYS = ("shp", "geojson", "geojson_gz", "csv", "tif")

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"


def manifest_sources(doc: dict):
    """Yield every source path declared in the manifest (skips skip:true layers)."""
    for entry in (doc.get("layers") or {}).values():
        if not isinstance(entry, dict) or entry.get("skip"):
            continue
        specs = entry.get("files", {}).values() if "files" in entry else [entry]
        for spec in specs:
            for key in VECTOR_KEYS:
                if key in spec:
                    yield key, spec[key]


def tile_sources(doc: dict) -> set[str]:
    """Every `src` path declared in tile_manifest.yaml (a list of layer blocks)."""
    return {l["src"] for l in (doc.get("layers") or []) if isinstance(l, dict) and "src" in l}


def expected_layers(text: str) -> set[str]:
    """Pull every "data/layers/..." path out of constants.ts DATA{}."""
    return set(re.findall(r'"(data/layers/[^"]+)"', text))


def check_shp(path: Path) -> tuple[str, str]:
    import geopandas as gpd
    try:
        gdf = gpd.read_file(path, rows=1)
    except Exception as e:  # noqa: BLE001 — surface any read error as FAIL
        return FAIL, f"unreadable: {e}"
    if len(gdf) == 0:
        return FAIL, "0 rows"
    epsg = gdf.crs.to_epsg() if gdf.crs else None
    if epsg != 4326:
        return FAIL, f"CRS is {gdf.crs.name if gdf.crs else 'unset'}, want EPSG:4326"
    return PASS, "ok"


def run(strict: bool) -> int:
    results: list[tuple[str, str]] = []  # (severity, message)

    def record(sev, msg):
        if sev == WARN and strict:
            sev = FAIL
        results.append((sev, msg))

    # 1. input shapefile sanity ----------------------------------------------
    doc = yaml.safe_load(MANIFEST.read_text())
    for key, src in manifest_sources(doc):
        p = Path(src)
        if not str(p).startswith("data/build/"):
            continue  # outputs handled below; data/raw handled by nothing (manual)
        if not p.exists():
            record(WARN, f"input absent: {src}")
            continue
        if key == "shp":
            sev, why = check_shp(p)
            record(sev, f"input {src}: {why}")
        elif p.stat().st_size == 0:
            record(FAIL, f"input {src}: empty file")

    # 2. output completeness + orphans ---------------------------------------
    expected = expected_layers(CONSTANTS.read_text())
    present = {str(p) for p in OUT_DIR.glob("*")} if OUT_DIR.exists() else set()

    for want in sorted(expected):
        p = Path(want)
        if not p.exists():
            record(WARN, f"output absent: {want}")
        elif p.stat().st_size == 0:
            record(FAIL, f"output empty: {want}")

    # orphans: files in data/layers/ not referenced by the frontend.
    # .geojson.gz/.pmtiles/.i16/.json only — ignore dotfiles & dirs.
    for got in sorted(present):
        gp = Path(got)
        if gp.is_dir() or gp.name.startswith("."):
            continue
        if got not in expected:
            record(FAIL, f"orphan in data/layers/ (unreferenced — rename bug?): {got}")

    # 3. cross-manifest consistency -------------------------------------------
    tsrcs = tile_sources(yaml.safe_load(TILE_MANIFEST.read_text()))
    for key, src in manifest_sources(doc):
        if key == "tif":
            continue  # rasters built by build_*_resource.sh, not the tile manifest
        if str(src).startswith("data/build/") and src not in tsrcs:
            record(FAIL, f"release source not produced by tile_manifest (drift?): {src}")

    # report ------------------------------------------------------------------
    for sev, msg in results:
        if sev != PASS:
            print(f"  [{sev}] {msg}")
    fails = sum(1 for s, _ in results if s == FAIL)
    warns = sum(1 for s, _ in results if s == WARN)
    checked = len(results)
    print(f"\nvalidate_build: {checked} checks, {fails} FAIL, {warns} WARN")
    return 1 if fails else 0


def _self_test() -> int:
    doc = {"layers": {
        "a": {"shp": "data/build/a.shp"},
        "b": {"skip": True, "shp": "data/build/b.shp"},
        "c": {"files": {"x": {"geojson_gz": "data/layers/c.geojson.gz"},
                        "y": {"tif": "data/build/c.tif"}}},
    }}
    srcs = dict(manifest_sources(doc))
    assert ("shp", "data/build/a.shp") in manifest_sources(doc), "should list a.shp"
    assert "data/build/b.shp" not in srcs.values(), "skip:true must be excluded"
    assert "data/layers/c.geojson.gz" in srcs.values(), "nested files: must be walked"

    ts = 'export const DATA = { foo: "data/layers/foo.pmtiles", x: "http://nope" };'
    assert expected_layers(ts) == {"data/layers/foo.pmtiles"}, "only data/layers/ paths"

    tile_doc = {"layers": [{"id": "a", "src": "data/build/a.shp"},
                           {"id": "n", "format": "geojson"}]}  # no src
    assert tile_sources(tile_doc) == {"data/build/a.shp"}, "src-less blocks skipped"
    # cross-check logic: a release data/build src absent from tile srcs is drift
    rel = {"layers": {"a": {"shp": "data/build/a.shp"},
                      "z": {"shp": "data/build/zzz.shp"},
                      "r": {"tif": "data/build/r.tif"}}}
    tsrcs = tile_sources(tile_doc)
    drift = [s for k, s in manifest_sources(rel)
             if k != "tif" and s.startswith("data/build/") and s not in tsrcs]
    assert drift == ["data/build/zzz.shp"], f"only zzz.shp should drift, got {drift}"
    print("self-test ok")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true", help="treat WARN (absent) as FAIL")
    ap.add_argument("--self-test", action="store_true", help="check parsers, no data needed")
    args = ap.parse_args()
    sys.exit(_self_test() if args.self_test else run(args.strict))
