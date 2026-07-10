#!/usr/bin/env python3
"""
extract_nws_zones.py — NWS public forecast zones + fire weather zones → GeoJSON

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NWS ZONE SHAPEFILES (WSOM)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Source:   National Weather Service / NOAA — www.weather.gov/gis
License:  Public domain (U.S. federal government work)
Geometry: Polygon/MultiPolygon (EPSG:4269 → reprojected to WGS84 on read by
          geopandas)

Two zone sets, listed on:
  Public forecast zones — https://www.weather.gov/gis/PublicZones
  Fire weather zones    — https://www.weather.gov/gis/FireZones
Each page links a dated shapefile ZIP under
  https://www.weather.gov/source/gis/Shapefiles/WSOM/  (newest listed first;
  public = z_*.zip, fire = fz*.zip). This script scrapes the page for the
  FIRST matching href and downloads it if not already present.

Not a standalone map layer: this is shared join infra (same pattern as
county_boundaries — see scripts/tile_manifest.yaml). Zone alerts (phase 2 of
the NWS weather-alerts layer, see HANDOFF.md "Stage 1") join onto this
tileset by (type, ugc) feature-state; nothing renders it directly.

Raw inputs (downloaded to data/raw/nws_zones/):
  pub/z_*.zip un-zipped   — public forecast zones (~4157 rows)
  fire/fz*.zip un-zipped  — fire weather zones (~3683 rows)
  Fields used from both: STATE (2-char), ZONE (3-digit string), NAME.

Output (data/build/):
  nws_zones.geojson — fields: ugc (STATE + "Z" + ZONE), type
  ("forecast"|"fire"), name, key ("z"+ugc for type=forecast, "f"+ugc for
  type=fire — the (type,ugc) join key used as pmtiles promoteId, since bare
  ugc collides across the two zone sets; see assets/nws-zone-join.ts).
  Duplicate ugc rows (multipart zones) are dissolved by (ugc, type) —
  ~7683 output features.
The tile_manifest builds this into data/layers/nws_zones.pmtiles (PMTiles).

Usage:
  venv/bin/python scripts/extract_nws_zones.py
"""

import re
import sys
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

try:
    import geopandas as gpd
except ImportError:
    sys.stderr.write("ERROR: geopandas missing. Run: source venv/bin/activate\n")
    sys.exit(1)

RAW = Path("data/raw/nws_zones")
BUILD = Path("data/build")
USER_AGENT = "TransmissionMap (benrhutchins@gmail.com)"

# (listing page, href regex, raw subdir, zone type)
SOURCES = [
    (
        "https://www.weather.gov/gis/PublicZones",
        re.compile(r"/source/gis/Shapefiles/WSOM/(z_[^\"'>]+\.zip)"),
        RAW / "pub",
        "forecast",
    ),
    (
        "https://www.weather.gov/gis/FireZones",
        re.compile(r"/source/gis/Shapefiles/WSOM/(fz[^\"'>]+\.zip)"),
        RAW / "fire",
        "fire",
    ),
]


def _fetch(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=60) as r:
        return r.read()


def ensure_shapefile(listing_url: str, href_re: re.Pattern, subdir: Path, label: str) -> Path:
    """Return path to a .shp in `subdir`, downloading + unzipping if absent."""
    existing = next(subdir.glob("*.shp"), None)
    if existing:
        print(f"  ✓ {label}: using existing {existing}")
        return existing

    print(f"  ↓ {label}: scraping {listing_url}")
    html = _fetch(listing_url).decode("utf-8", errors="ignore")
    m = href_re.search(html)
    if not m:
        sys.exit(f"no matching shapefile href found on {listing_url}")
    zip_name = m.group(1)
    zip_url = f"https://www.weather.gov/source/gis/Shapefiles/WSOM/{zip_name}"

    subdir.mkdir(parents=True, exist_ok=True)
    zpath = subdir / zip_name
    print(f"  ↓ {label}: {zip_url}")
    data = _fetch(zip_url)
    zpath.write_bytes(data)

    with zipfile.ZipFile(zpath) as z:
        z.extractall(subdir)

    shp = next(subdir.glob("*.shp"), None)
    if not shp:
        sys.exit(f"no .shp found after unzipping {zpath}")
    return shp


def load_zones(shp: Path, zone_type: str) -> "gpd.GeoDataFrame":
    gdf = gpd.read_file(shp)
    gdf["ugc"] = gdf["STATE"].astype(str) + "Z" + gdf["ZONE"].astype(str)
    gdf["type"] = zone_type
    gdf["name"] = gdf["NAME"]
    prefix = "z" if zone_type == "forecast" else "f"
    gdf["key"] = prefix + gdf["ugc"]
    gdf = gdf[["ugc", "type", "name", "key", "geometry"]]
    if gdf.crs is not None and str(gdf.crs) != "EPSG:4326":
        gdf = gdf.to_crs(4326)
    return gdf


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    frames = []
    for listing_url, href_re, subdir, zone_type in SOURCES:
        shp = ensure_shapefile(listing_url, href_re, subdir, zone_type)
        gdf = load_zones(shp, zone_type)
        print(f"  {zone_type}: {len(gdf)} rows read")
        frames.append(gdf)

    merged = gpd.pd.concat(frames, ignore_index=True)
    merged = gpd.GeoDataFrame(merged, crs="EPSG:4326")

    # Dissolve multipart duplicate (ugc, type) rows into single features.
    dissolved = merged.dissolve(by=["ugc", "type"], aggfunc="first", as_index=False)
    dissolved = dissolved[["ugc", "type", "name", "key", "geometry"]]

    BUILD.mkdir(parents=True, exist_ok=True)
    out = BUILD / "nws_zones.geojson"
    out.unlink(missing_ok=True)
    dissolved.to_file(out, driver="GeoJSON")

    print(f"  ✓ {out} ({len(dissolved)} features)")


if __name__ == "__main__":
    main()
