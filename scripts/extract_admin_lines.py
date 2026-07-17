#!/usr/bin/env python3
"""
extract_admin_lines.py — Natural Earth admin boundary lines → GeoJSON

Source:   Natural Earth 1:50m Cultural Vectors (naciscdn.org)
License:  Public domain
Geometry: LineString (EPSG:4326)

Country borders (admin-0, land only) + state/province borders (admin-1) +
coastline, clipped to the live-weather bbox, merged with a single `level`
property (0 = country, 1 = state/province, 2 = coastline). Drawn as white
highlight lines above the
Weather (Live) raster wash (see assets/layers/map-layers-conditions.ts) —
shared infra like county_boundaries, no standalone layer/legend.

Extract → data/build/admin_lines.geojson

Usage:
  venv/bin/python scripts/extract_admin_lines.py
"""

import sys
from pathlib import Path
from urllib.request import Request, urlopen

try:
    import geopandas as gpd
    import pandas as pd
    from shapely.geometry import box
except ImportError:
    sys.stderr.write("ERROR: geopandas missing. Run: source venv/bin/activate\n")
    sys.exit(1)

RAW = Path("data/raw/natural_earth")
BUILD = Path("data/build")
USER_AGENT = "TransmissionMap (https://github.com/BenHutchinsWPP/TransmissionMap)"
CDN = "https://naciscdn.org/naturalearth/50m"

# Must cover the weather grid (WEST/SOUTH/EAST/NORTH in fetch_weather_live.py).
BBOX = box(-170.0, 15.0, -50.0, 75.0)

SOURCES = [  # (level, collection, zip stem)
    (0, "cultural", "ne_50m_admin_0_boundary_lines_land"),
    (1, "cultural", "ne_50m_admin_1_states_provinces_lines"),
    (2, "physical", "ne_50m_coastline"),
]


def _fetch(url: str, dest: Path) -> None:
    if dest.exists():
        return
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=120) as r:
        dest.write_bytes(r.read())


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)

    frames = []
    for level, collection, stem in SOURCES:
        zpath = RAW / f"{stem}.zip"
        _fetch(f"{CDN}/{collection}/{stem}.zip", zpath)
        gdf = gpd.read_file(f"zip://{zpath}")
        gdf = gdf.clip(BBOX)
        gdf = gdf[~gdf.geometry.is_empty]
        frames.append(gpd.GeoDataFrame({"level": level, "geometry": gdf.geometry}, crs="EPSG:4326"))
        print(f"level {level}: {len(gdf)} features from {stem}")

    out = BUILD / "admin_lines.geojson"
    merged = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs="EPSG:4326")
    merged.to_file(out, driver="GeoJSON")
    print(f"Wrote {out}  {len(merged)} features  {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
