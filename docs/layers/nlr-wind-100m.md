# NREL/NLR Wind Resource (100 m)

## Source

| | |
|---|---|
| **Provider** | NREL — now **NLR (National Laboratory of the Rockies)** after a 2025–2026 rebrand |
| **Dataset** | WIND Toolkit multi-year (2007–2013) annual-average wind-speed rasters, 100 m hub height |
| **Coverage** | CONUS · Southern Canada (to ~59° N) · Mexico + Central America — onshore + offshore, ~2 km resolution |
| **Vintage** | WIND Toolkit run 2007–2013; rasters published Sept 2017 |
| **Acquired** | 2026-06-04 (recovered from Internet Archive — see note below) |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution requested** | "Source: NREL Wind Integration National Dataset (WIND) Toolkit" (Draxl et al. 2015, *Applied Energy* 151:355–366) |
| **Served** | `data/layers/nlr_wind_100m.pmtiles` — raster PMTiles (WEBP, baked color, z1–6, 3.5 MB) + `nlr_wind_100m_lut.i16`/`.json` for hover readout (1.3 MB, lazy-loaded) |
| **Built by** | `scripts/build_wind_resource.sh` (+ `scripts/wind_color_ramp.txt`) → `data/build/wind/` → PMTiles + COG |
| **Raw input** | Three regional GeoTIFFs extracted from `data/raw/wind/{us,canada,mexico}-wind-data.zip` (**not committed**) |

> **Download origin — recovered from the Internet Archive.** NREL rebranded to NLR; `nrel.gov/gis/*`
> download pages 404 and `nlr.gov/gis/*` data pages 404. The three zips were pulled from Wayback:
> - US — `https://web.archive.org/web/20241205023431id_/https://www.nrel.gov/gis/assets/images/us-wind-data.zip`
> - Canada — `https://web.archive.org/web/20240927052532id_/https://www.nrel.gov/gis/assets/images/canada-wind-data.zip`
> - Mexico — `https://web.archive.org/web/20240926222740id_/https://www.nrel.gov/gis/assets/images/mexico-wind-data.zip` (use this snapshot — the 2024-12-10 one is truncated)
>
> Skip the `*-wind-maps.zip` siblings — those are JPG map images, not data.

## Download pack

`nlr-wind-100m.zip` — `wind-100m.tif` (Cloud-Optimized GeoTIFF, real m/s values, EPSG:4326, Float32, ~31 MB) · `nlr-wind-100m.md` · `disclaimer.txt`

No GeoJSON/CSV — this is a continuous raster with no feature attributes.

## Raster values

Unlike the vector layers (substations, generators, PAD-US…), there is **no attribute
table and no per-feature fields**. Each source file is a **single-band raster**: a grid of
~2 km cells covering the region, and **every cell holds one number — the modeled mean wind
speed at 100 m above the surface, in metres per second** (multi-year average, 2007–2013).

| Property | Value |
|---|---|
| Bands | 1 (grayscale; `ColorInterp=Gray`) |
| Cell value | mean wind speed @ 100 m, **m/s** — read directly off band 1 |
| Data type | `Float64` (continuous; not a class code or lookup index) |
| NoData | `0` — water bodies / outside-mask cells (rendered transparent) |
| Cell size | ~2 km × 2 km |
| CRS | Lambert Conformal Conic, **NAD83**, `lat_0=40 lon_0=-96 lat_1=20 lat_2=60` (identical across all three regions) |
| Compression | LZW |

**How a cell becomes a number:** there is nothing to decode. The raster *is* the value —
sampling pixel (x, y) returns a float like `7.84` and that is 7.84 m/s. This differs from
the categorical layers where a code (e.g. PAD-US `Des_Tp`) must be joined to a domain
table. Here the only transform is **value → colour** at render time (next section).

### Observed value range per region

From `gdalinfo -stats` on the 100 m band:

| Region | File | Pixels | Min (m/s) | Max (m/s) | Mean (m/s) |
|---|---|---|---:|---:|---:|
| US (CONUS, on+offshore) | `wtk_conus_100m_mean_masked.tif` | 2472 × 1426 | 1.36 | 14.20 | 6.95 |
| Southern Canada (on+offshore) | `wtk_can_bc_100m_mean_masked.tif` | 2820 × 1406 | 1.52 | 15.41 | 7.85 |
| Mexico + surrounds (on+offshore) | `wtk_mex_100m_mean_masked.tif` | 2160 × 1403 | 1.41 | 15.64 | 6.44 |

Each zip also ships the same raster at 10/40/60/80/120/140/160/200 m hub heights; this
layer uses **100 m** only. The `can_bc` token in the Canada filename is a naming quirk — it
is all Southern Canada, not just British Columbia.

## Processing — `scripts/build_wind_resource.sh`

1. **Extract** the `*_100m_mean_masked.tif` from each of the three zips into `data/build/wind/`.
2. **Mosaic + reproject** the three regions into one EPSG:4326 grid in a single
   `gdalwarp` pass (`-s_srs` the shared LCC, `-t_srs EPSG:4326`, `-srcnodata 0`). The
   reproject is required: the raw data is LCC-in-metres even though the upstream metadata
   text mislabels it "EPSG:4326". NoData=0 keeps water/seams transparent.
3. **Download artifact** → `gdal_translate -of COG -ot Float32` to
   `data/build/nlr_wind_100m.tif` — this keeps the **actual m/s values** for GIS use.
   `build_releases.py` bundles it into `data/releases/nlr-wind-100m.zip`.
4. **Bake colour** → `gdaldem color-relief -alpha` using `scripts/wind_color_ramp.txt`,
   then reproject the RGBA raster to EPSG:3857.
5. **Tile** → `gdal_translate -of MBTILES -co TILE_FORMAT=WEBP` + `gdaladdo` for the low-zoom
   overviews → `pmtiles convert` to `data/layers/nlr_wind_100m.pmtiles` (z1–6; native ~2 km
   resolution tops out near z6, MapLibre over-zooms above that).
6. **Host** under `data/layers/` — *not* a GitHub Release asset (releases have no CORS
   for live tiles).

## Rendering — colour is baked into the tiles

The m/s → colour mapping is applied **at build time** (`gdaldem color-relief`), so the
hosted WEBP tiles already carry RGBA. The map shows it as a plain MapLibre `raster` layer
(`addWindResource()` in `assets/layers/map-layers-renewable.ts`) with `raster-opacity` 0.7 — **no**
`raster-color` paint and no float-tile encoding, which keeps it robust across MapLibre
versions. The colour tiles carry no values.

### Hover readout — value at the cursor

Because the tiles are colour-only, a tiny **value lookup grid** is shipped alongside them:
`data/layers/nlr_wind_100m_lut.i16` (Int16 = round(m/s × 100), 0.1° ≈ 11 km, NW-origin
row-major, NoData = 0; ~1.3 MB) + `nlr_wind_100m_lut.json` (dims + bbox + scale). It is
**lazy-loaded** the first time the layer is enabled by the generic raster-probe registry
(`RASTER_PROBES` / `ensureRasterLut` in `assets/raster-probes.ts`, shared with the solar
layer). On `mousemove`, `sampleRaster()` does a nearest-cell lookup and `updateRasterArrow()`
moves a ▼ arrow along the legend gradient to the cursor's wind speed and prints
`"N.N m/s at cursor"` beneath it. For exact, full-resolution values use the GeoTIFF download.

Ramp (single source of truth: `scripts/wind_color_ramp.txt`, mirrored by `WIND_RAMP_STOPS`
in `src/colors/ramps.ts`): transparent → light teal → teal → blue → dark navy over **0–12 m/s**;
values above 12 clamp to the darkest stop; NoData (0) is transparent.

## Caveats

- **Modeled, not measured** — WIND Toolkit is a numerical weather-model reanalysis
  (2007–2013), ~2 km resolution. Regional resource context only.
- **Source pages are gone.** NREL rebranded to NLR (`nlr.gov`) and the `nrel.gov/gis/*`
  download pages 404. These files were recovered from the Internet Archive — see Wayback
  URLs above.
- **Coverage is three stitched regions**, not a single seamless model run. Canada is
  *Southern* Canada only (to ~59° N); the high Arctic is not covered.
