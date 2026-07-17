# Global Solar Atlas Solar Resource (PVOUT)

## Source

| | |
|---|---|
| **Provider** | [Global Solar Atlas](https://globalsolaratlas.info/) — Solargis, funded by the World Bank / ESMAP |
| **Dataset** | [World — PVOUT (Global Solar Atlas) on EnergyData.info](https://energydata.info/dataset/world-photovoltaic-power-potential-pvout-gis-data-global-solar-atlas) — `World_PVOUT_GISdata_LTAy_AvgDailyTotals_GlobalSolarAtlas-v2_GEOTIFF.zip`. PVOUT = specific PV power output, kWh/kWp/day; **LTAy** = long-term yearly average of daily totals |
| **Coverage** | Global EPSG:4326 ~930 m resolution; clipped to North America (to 65° N) for this build |
| **Vintage** | Global Solar Atlas v2 (Solargis model, 1994/1999/2007–onward depending on region) |
| **License** | **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — Solargis / World Bank — **attribution required** |
| **Attribution required** | "© 2024 Global Solar Atlas / Solargis / World Bank" — carried on the MapLibre raster source `attribution` |
| **Served** | `data/layers/gsa_solar_pvout.pmtiles` — raster PMTiles (WEBP, baked color, z2–7, 11 MB) + `gsa_solar_pvout_lut.i16`/`.json` for hover readout (1.6 MB, lazy-loaded) |
| **Built by** | `scripts/build_solar_resource.sh` (+ `scripts/solar_color_ramp.txt`) → `data/build/solar/` → PMTiles + COG |
| **Raw input** | `PVOUT.tif` from global GSA zip (auto-downloaded to `data/raw/solar/` — **zip not committed**, ~345 MB) |

> **Download origin — live.** The build script downloads the zip directly from
> `https://api.globalsolaratlas.info/download/World/World_PVOUT_GISdata_LTAy_AvgDailyTotals_GlobalSolarAtlas-v2_GEOTIFF.zip`
> (302 → S3; HEAD 404s but GET works). Fall back to the EnergyData.info page or Wayback if it 404s.
> Use `LTAy` — the `LTAm` sibling is the monthly (12-band) product.

## Download pack

`gsa-solar-pvout.zip` — `solar-pvout.tif` (Cloud-Optimized GeoTIFF, real kWh/kWp/day values, EPSG:4326, Float32, ~22 MB) · `gsa-solar-pvout.md` · `disclaimer.txt`

No GeoJSON/CSV — this is a continuous raster with no feature attributes.

**Attribution required in any redistribution:** "© 2024 Global Solar Atlas / Solargis / World Bank" (CC BY 4.0).

## Why PVOUT (not GHI)?

The Global Solar Atlas publishes several rasters. **PVOUT — specific photovoltaic power
output, kWh/kWp/day** — is the truest single proxy for "how much power will a panel here
generate": it is the energy yield per kW of installed capacity and **already folds in
module-temperature and system losses**, unlike the raw irradiation metrics (GHI on a
horizontal surface, GTI on a tilted plane, DNI direct-beam only). The metric shipped is the
**LTAy long-term yearly average of daily totals**.

## Raster values

Like the wind layer, there is **no attribute table and no per-feature fields**. The source
is a **single-band raster**: every cell holds one number — the modeled long-term average
daily PV yield, in **kWh/kWp/day**.

| Property | Value |
|---|---|
| Bands | 1 (grayscale; `ColorInterp=Gray`) |
| Cell value | specific PV yield (PVOUT), **kWh/kWp/day** — read directly off band 1 |
| Data type | `Float32` (continuous; not a class code) |
| NoData | source = `NaN`; set to `0` in processing — ocean / outside-mask cells (rendered transparent) |
| Cell size | ~930 m (0.008333°) native; download resampled to ~2 km (0.02°) |
| CRS | EPSG:4326 (already — no reprojection needed) |
| NA value range | ~0.7 – 5.9 kWh/kWp/day (mean ≈ 3.9), from `gdalinfo -stats` on the NA clip |

**How a cell becomes a number:** nothing to decode — the raster *is* the value. Sampling a
pixel returns a float like `5.19` and that is 5.19 kWh/kWp/day.

## Processing — `scripts/build_solar_resource.sh`

Simpler than wind: the GSA raster is already global EPSG:4326, single continuous band — so
**no LCC reprojection** and **no multi-region mosaic**.

1. **Download** the global PVOUT (LTAy) zip from the Global Solar Atlas API into
   `data/raw/solar/` (skipped if already present).
2. **Extract** `PVOUT.tif` into `data/build/solar/`.
3. **Clip** to the North-America bbox (`gdalwarp -te -170 5 -50 72`, `-dstnodata 0` so
   ocean/outside reads 0 to match the wind layer's convention). PVOUT data tops out at
   65° N, so the upper bound is cosmetic — the far Arctic is not modeled.
4. **Download artifact** → resample to ~2 km then `gdal_translate -of COG -ot Float32` to
   `data/build/gsa_solar_pvout.tif` — keeps the **actual kWh/kWp/day values** for GIS use.
   `build_releases.py` bundles it into `data/releases/gsa-solar-pvout.zip`.
   (Full-res NA is ~100 MB Float32, which busts GitHub's 100 MB/file limit; ~2 km is ample
   for a regional resource-overview download.)
5. **Bake colour** → `gdaldem color-relief -alpha` using `scripts/solar_color_ramp.txt`,
   then reproject the RGBA raster to EPSG:3857.
6. **Tile** → `gdal_translate -of MBTILES -co TILE_FORMAT=WEBP` + `gdaladdo` overviews →
   `pmtiles convert` to `data/layers/gsa_solar_pvout.pmtiles` (z2–7).
7. **Host** under `data/layers/` — *not* a GitHub Release asset (releases have no CORS
   for live tiles).

## Rendering — colour is baked into the tiles

The PVOUT → colour mapping is applied **at build time** (`gdaldem color-relief`), so the
hosted WEBP tiles already carry RGBA. The map shows it as a plain MapLibre `raster` layer
(`addSolarResource()` in `assets/layers/map-layers-renewable.ts`) with `raster-opacity` 0.7 — **no**
`raster-color` paint and no float-tile encoding. The colour tiles carry no values.

### Hover readout — value at the cursor

Because the tiles are colour-only, a tiny **value lookup grid** is shipped alongside them:
`data/layers/gsa_solar_pvout_lut.i16` (Int16 = round(kWh/kWp/day × 100), 0.1° ≈ 11 km,
NW-origin row-major, NoData = 0; 1.6 MB) + `gsa_solar_pvout_lut.json` (dims + bbox + scale). It
is **lazy-loaded** the first time the layer is enabled and sampled on `mousemove` by the
generic raster-probe registry (`RASTER_PROBES` / `ensureRasterLut` / `sampleRaster` /
`updateRasterArrow` in `assets/raster-probes.ts`, shared with the wind layer). A ▼ arrow tracks
the cursor's value along the legend gradient and prints `"N.NN kWh/kWp/day at cursor"`. For
exact, full-resolution values use the GeoTIFF download.

Ramp (single source of truth: `scripts/solar_color_ramp.txt`, mirrored by
`SOLAR_RAMP_STOPS` in `src/colors/ramps.ts`): transparent pale yellow → orange → deep red over
**0–7 kWh/kWp/day**; values above 7 clamp to the darkest stop; NoData (0) is transparent.

## Caveats

- **Attribution is mandatory.** CC BY 4.0 (Solargis / World Bank) — a visible attribution
  string is required, not a courtesy.
- **Modeled long-term average**, ~930 m native resolution. Good for regional resource
  context only.
- **Coverage stops at 65° N** — the high Arctic is not modeled (negligible PV yield).
