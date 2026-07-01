# IHFC Geothermal Heat Flow

## Source

| | |
|---|---|
| **Provider** | [International Heat Flow Commission (IHFC)](https://ihfc-iugg.org/) / [GFZ Data Services](https://dataservices.gfz-potsdam.de/), Potsdam |
| **Dataset** | [Global Heat Flow Database Release 2024, v2026.03](https://doi.org/10.5880/fidgeo.2024.014) — `GHFBD-R2024_v.2026-03.zip` (~18 MB, tab-delimited point data, ~39 MB uncompressed) |
| **DOI** | `10.5880/fidgeo.2024.014` (GFZ Data Services) |
| **Coverage** | Global measurement points; filtered to North America (lat 5–75, lon −170 to −50) → ~33,500 points |
| **Vintage** | Release 2024, version 2026.03 |
| **Acquired** | 2026-06-05 |
| **License** | **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — attribution **required** |
| **Attribution required** | "© IHFC / GFZ Data Services (CC BY 4.0) — Global Heat Flow Database Release 2024" |
| **Citation** | Global Heat Flow Data Assessment Group et al. (2024). *The Global Heat Flow Database: Release 2024*. V. 2026.03. GFZ Data Services. https://doi.org/10.5880/fidgeo.2024.014 |
| **Served** | `data/layers/ihfc_geo_heatflow.pmtiles` — raster PMTiles (WEBP, baked color, z2–7) + `ihfc_geo_heatflow_lut.i16`/`.json` for hover readout (lazy-loaded) |
| **Built by** | `scripts/build_geothermal_resource.sh` (+ `scripts/geo_color_ramp.txt`) → `data/build/geothermal/` → PMTiles + COG |
| **Raw input** | `IHFC_2024_GHFDB_v.2026.03.txt` from `GHFBD-R2024_v.2026-03.zip` (auto-downloaded to `data/raw/geothermal/` — **zip not committed**, ~18 MB) |

> **Download origin — live.** `scripts/build_geothermal_resource.sh` downloads the zip directly from
> `https://datapub.gfz.de/download/10.5880.FIDGEO.2024.014-VEueRf/GHFBD-R2024_v.2026-03.zip`
> (direct HTTP GET, ~18 MB, no login required; HTTP 200 verified 2026-06-05).
> If 404, resolve via the DOI landing page: `https://dataservices.gfz-potsdam.de/panmetaworks/showshort.php?id=e6755429-fbbf-11ee-967a-4ffbfe06208e`

## Download pack

`ihfc-geo-heatflow.zip` — `geo-heatflow.tif` (Cloud-Optimized GeoTIFF, real mW/m² values, EPSG:4326, Float32, 0.5° ~55 km) · `ihfc-geo-heatflow.md` · `disclaimer.txt`

No GeoJSON/CSV — this is an IDW-gridded raster with no feature attributes.

**Attribution required in any redistribution:** "© IHFC / GFZ Data Services (CC BY 4.0) — Global Heat Flow Database Release 2024" (CC BY 4.0).

## What this layer shows

**Surface heat flux in milliwatts per square metre (mW/m²)** — how much geothermal energy is escaping through the Earth's crust. High values indicate where the crust is hot relative to surface conditions, driven by proximity to mantle upwellings, crustal thinning, recent volcanism, or hydrothermal circulation.

Typical values:
- Continental crust background: **40–100 mW/m²**
- Basin and Range, Cascades, Snake River Plain: **100–200+ mW/m²**
- Yellowstone caldera, Salton Sea, active volcanic zones: **200–999 mW/m²** (clamp to dark red on the ramp)

This layer is a proxy for **where geothermal power generation may be feasible** — heat flow is a key screening criterion for both hydrothermal (conventional) and enhanced geothermal systems (EGS).

## Raster values

Like the wind and solar layers, there is **no attribute table and no per-feature fields**. The source is a 0.5° **gridded raster** IDW-interpolated from ~33,000 measurement points:

| Property | Value |
|---|---|
| Bands | 1 (grayscale) |
| Cell value | surface heat flux, **mW/m²** — read directly off band 1 |
| Data type | `Float32` (continuous; not a class code) |
| NoData | 0 — cells with no data within 2° of a measurement (rendered transparent) |
| Cell size | 0.5° (~55 km) — coarse, appropriate for IDW of sparse point data |
| CRS | EPSG:4326 |
| NA value range | ~1–999 mW/m²; mean ≈ 116 mW/m² across ~33,500 NA points |

## Processing — `scripts/build_geothermal_resource.sh`

Key difference vs wind and solar: the source is **scattered measurement points** (not a pre-made raster), so there is an extra **CSV → VRT → gdal_grid IDW** step before the standard bake-color pipeline. The IDW step takes ~5–15 minutes.

1. **Download** the IHFC 2024 zip from GFZ Data Services into `data/raw/geothermal/` (skipped if already present). ~18 MB, direct HTTP GET, no login.
2. **Extract** the `.txt` file (the `.xlsx` and PDF are skipped).
3. **Filter** to NA bbox (lat 5–75, lon −170 to −50), drop implausible values (hf ≤ 1 or ≥ 1000 mW/m²), write `data/build/geothermal/na_heatflow.csv`. The `.txt` uses latin-1 encoding (has `²` as byte 0xb2). Columns used (tab-delimited, skip `#` lines + 4 metadata header rows): index 0 = P1 (`heat_flow`, mW/m²), index 3 = P4 (latitude), index 4 = P5 (longitude).
4. **Write VRT** wrapping the CSV so `gdal_grid` can read it with explicit geometry columns.
5. **Grid via IDW** (`gdal_grid -a invdist:power=2:smoothing=0.5:radius=2.0:max_points=7:min_points=1`) at 0.5° (240×140 cells for the NA bbox). Radius of 2° fills sparse Arctic/Mexico coverage sensibly.
6. **Download artifact** → `gdal_translate -of COG -ot Float32` to `data/build/ihfc_geo_heatflow.tif` — keeps the **actual mW/m² values** for GIS use. At 0.5° the file is tiny (well under 1 MB). `build_releases.py` bundles it into `data/releases/ihfc-geo-heatflow.zip`.
7. **Bake colour** → `gdaldem color-relief -alpha` using `scripts/geo_color_ramp.txt`, then reproject the RGBA raster to EPSG:3857.
8. **Tile** → `gdal_translate -of MBTILES -co TILE_FORMAT=WEBP` + `gdaladdo` overviews → `pmtiles convert` to `data/layers/ihfc_geo_heatflow.pmtiles` (z2–7).
9. **Hover LUT** → resample to 0.5°, scale to Int16 (×10), write `.i16` + `.json` sidecar.

## Rendering — colour is baked into the tiles

The heat-flow → colour mapping is applied **at build time** (`gdaldem color-relief`), so the hosted WEBP tiles carry RGBA. The map shows it as a plain MapLibre `raster` layer (`addGeoResource()` in `assets/layers/map-layers-renewable.ts`) with `raster-opacity` 0.7.

### Hover readout — value at the cursor

A coarse **value lookup grid** ships alongside the tiles: `data/layers/ihfc_geo_heatflow_lut.i16` (Int16 = round(mW/m² × 10), 0.5°, NW-origin row-major, NoData = 0) + `ihfc_geo_heatflow_lut.json` (dims + bbox + scale). Lazy-loaded on first enable; sampled on `mousemove` by the generic raster-probe registry (`RASTER_PROBES` in `assets/raster-probes.ts`, shared with wind and solar). Prints `"N mW/m² at cursor"`.

Ramp (single source of truth: `scripts/geo_color_ramp.txt`, mirrored by `GEO_RAMP_STOPS` in `src/colors/ramps.ts`): transparent pale yellow → orange → dark red over **0–150 mW/m²**; values above 150 clamp to dark red; NoData (0) is transparent.

## Caveats

- **Attribution is mandatory.** CC BY 4.0 (IHFC / GFZ Data Services) — a visible attribution string is required.
- **0.5° resolution** (~55 km). Fine enough to show regional patterns (Basin and Range, Cascades, Yellowstone corridor); too coarse for site-level screening.
- **IDW artefacts near data gaps.** Arctic Canada and parts of Mexico have very few measurement points. The 2° search radius usually fills these in, but expect smooth gradients rather than reliable values in under-sampled areas.
- **Surface heat flow ≠ power generation potential.** High flux is a necessary but not sufficient indicator — depth to the resource, permeability, water availability, and land access also matter. For EGS potential, modelled temperature-at-depth (SMU TAD dataset) is a more direct proxy.
- **Data vintage.** The IHFC 2024 release (v2026.03) includes measurements from thousands of wells worldwide, compiled over decades. Individual measurements vary in quality; the IDW smoothing reduces the impact of outliers.
