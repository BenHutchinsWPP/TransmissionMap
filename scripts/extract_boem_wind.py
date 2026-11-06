#!/usr/bin/env python3
"""
extract_boem_wind.py — BOEM offshore wind leases → GeoJSON

Source:   Bureau of Ocean Energy Management (BOEM)
License:  Public domain (U.S. federal government work)
Geometry: Polygon (EPSG:4326)

URL: https://www.boem.gov/renewable-energy/boem-renewable-energy-shapefiles
Serves the zip directly; save to data/raw/boem_wind/

Extract Offshore_Wind_Leases_outlines.shp → data/build/boem_wind_leases.geojson
with a content id `fid` (see `boem_fid`) and fields renamed:
lease←LEASE_NUMB, company←COMPANY, project←PROJECT_NA, type←LEASE_TYPE, state←STATE, acres←ACRES, date←LEASE_DATE, term←LEASE_TERM.

Usage:
  venv/bin/python scripts/extract_boem_wind.py
"""

import hashlib
import sys
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

RAW = Path("data/raw/boem_wind")
BUILD = Path("data/build")
USER_AGENT = "TransmissionMap (https://github.com/BenHutchinsWPP/TransmissionMap)"
ZIP_URL = "https://www.boem.gov/renewable-energy/boem-renewable-energy-shapefiles"
ZIP_NAME = "boem-renewable-energy-shapefiles.zip"

GRID_DP = 6  # bounds grid: 1e-6 degrees


KEY_FIELDS = ("LEASE_NUMB", "LEASE_TYPE", "LEASE_DATE")


def clean(v):
    """A raw value as served and hashed: strings stripped, a missing value None."""
    if v is None or v != v:
        return None
    return v.strip() if isinstance(v, str) else v


def boem_fid(props, bounds, n_vertices) -> str:
    """Content id of one lease outline from its raw properties and EPSG:4326 bounds:
    12 hex digits of a sha1 over the lease number, type and date, the bounds on a
    1e-6 degree grid and the vertex count. The publisher has no key, and easements
    repeat the lease number."""
    grid = ",".join(f"{round(float(b), GRID_DP) + 0.0:.{GRID_DP}f}" for b in bounds)
    attrs = ["" if (v := clean(props.get(k))) is None else str(v) for k in KEY_FIELDS]
    key = "\x1f".join(attrs + [grid, str(int(n_vertices))])
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def assign_fids(keys) -> list[str]:
    """Ids from `boem_fid` values: the second and later rows with an identical
    id take `-<n>` (n = occurrence index). Refuses a duplicate after suffixing."""
    seen: dict[str, int] = {}
    out = []
    for k in keys:
        n = seen.get(k, 0)
        seen[k] = n + 1
        out.append(k if n == 0 else f"{k}-{n}")
    check_unique(out)
    return out


def check_unique(ids) -> None:
    ids = list(ids)
    if len(set(ids)) != len(ids):
        raise ValueError(f"{len(ids) - len(set(ids))} duplicate ids")


def _fetch(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=60) as r:
        return r.read()

def ensure_shapefile() -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    existing = next(RAW.rglob("Offshore_Wind_Leases_outlines.shp"), None)
    if existing:
        print(f"  ✓ BOEM Wind: using existing {existing}")
        return existing

    zpath = RAW / ZIP_NAME
    if not zpath.exists():
        print(f"  ↓ BOEM Wind: downloading {ZIP_URL}")
        data = _fetch(ZIP_URL)
        zpath.write_bytes(data)

    print(f"  ↓ BOEM Wind: extracting {zpath}")
    with zipfile.ZipFile(zpath) as z:
        z.extractall(RAW)

    shp = next(RAW.rglob("Offshore_Wind_Leases_outlines.shp"), None)
    if not shp:
        sys.exit(f"no Offshore_Wind_Leases_outlines.shp found after unzipping {zpath}")
    return shp

def main():
    try:
        import geopandas as gpd
        import shapely
    except ImportError:
        sys.stderr.write("ERROR: geopandas missing. Run: source venv/bin/activate\n")
        sys.exit(1)
    shp = ensure_shapefile()
    gdf = gpd.read_file(shp)
    if gdf.crs is not None and str(gdf.crs) != "EPSG:4326":
        gdf = gdf.to_crs(4326)
    for c in gdf.columns.drop("geometry"):
        gdf[c] = gdf[c].map(clean)
    try:
        fids = assign_fids(
            boem_fid(props, g.bounds, shapely.count_coordinates(g))
            for props, g in zip(gdf.drop(columns="geometry").to_dict("records"), gdf.geometry))
    except ValueError as e:
        sys.exit(f"ERROR: {e}")
    gdf.insert(0, "fid", fids)
    
    # Rename fields
    rename_map = {
        "LEASE_NUMB": "lease",
        "COMPANY": "company",
        "PROJECT_NA": "project",
        "LEASE_TYPE": "type",
        "STATE": "state",
        "ACRES": "acres",
        "LEASE_DATE": "date",
        "LEASE_TERM": "term"
    }
    gdf = gdf.rename(columns=rename_map)
    
    keep_cols = ["fid", "lease", "company", "project", "type", "state", "acres", "date", "term", "geometry"]
    gdf = gdf[keep_cols]
    
    BUILD.mkdir(parents=True, exist_ok=True)
    out = BUILD / "boem_wind_leases.geojson"
    out.unlink(missing_ok=True)
    gdf.to_file(out, driver="GeoJSON")
    print(f"  ✓ {out} ({len(gdf)} features)")

if __name__ == "__main__":
    main()
