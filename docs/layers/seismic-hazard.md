# Seismic Hazard (PGA, 2% in 50yr)

USGS National Seismic Hazard Model peak ground acceleration for the contiguous US.
**Probability of exceedance** surface — not historical epicenters.

Continuous raster, Peak Ground Acceleration in **g**, 2% probability of exceedance in
50 years (≈2475-yr return period), Site Class B/C.

## Source

| | |
|---|---|
| **Provider** | [USGS — 2018 National Seismic Hazard Model](https://www.usgs.gov/programs/earthquake-hazards/science/2018-nshm) |
| **Dataset** | Probabilistic seismic-hazard maps and data — DOI [10.5066/P9WT5OVB](https://doi.org/10.5066/P9WT5OVB) · [ScienceBase item](https://www.sciencebase.gov/catalog/item/5d5597d0e4b01d82ce8e3ff1) |
| **Coverage** | CONUS (lon −125…−65, lat 24.4…50) |
| **Vintage** | 2018 NSHM |
| **License** | Public domain (US Government work) |
| **Served** | `data/layers/usgs_seismic_pga.pmtiles` — raster PMTiles, baked color · `_lut.i16`/`_lut.json` — hover readout |
| **Built by** | `scripts/build_seismic_hazard.sh` (`make seismic`) |
| **Raw input** | `data/raw/usgs/US_2018_2PctIn50_pga_0pt2sec_1sec_5sec_BC.csv` (37 MB, **not committed**) |

> **Download origin — manual.** The CSV was downloaded by hand from the ScienceBase
> child item "Probabilistic seismic-hazard maps and data". Public domain, no login.

## Download pack

No download pack is built (intentionally — not in `scripts/release_manifest.yaml`). The
served raster is a near-direct rendering of the USGS source grid with no meaningful
transformation, so there's nothing repackaged to offer — users go to the original USGS
NSHM ScienceBase item above.

## Processing

- **Source form:** complete regular 0.05° lon/lat CSV grid, 1201×513 = 616,113 points. Six columns: `lon, lat, PGA, 0.2s, 1.0s, 5.0s`. Only **PGA** (col 3) is kept; the spectral-acceleration columns are dropped.
- **Grid → raster:** clean `lon,lat,pga` CSV → OGR VRT → `gdal_grid -a nearest` at native 0.05° (exact cell values, no interpolation — the grid is already complete) → Float32 GeoTIFF, EPSG:4326.
- **Color tiles:** `gdaldem color-relief` with `scripts/seis_color_ramp.txt` (yellow→red, in sync with `SEIS_RAMP_STOPS` in `src/colors/ramps.ts`) → baked RGBA → web-mercator → MBTiles (WEBP) → PMTiles, via `rc_bake_tiles`. Rendered `raster-resampling: linear` (continuous surface).
- **Hover LUT:** Int16 grid of `round(PGA × 1000)`, NoData 0 (`scale: 1000` in the sidecar) → cursor readout in g via `RASTER_PROBES["usgs-seismic-pga"]`.
- **Download:** Float32 COG of real g values at `data/build/usgs_seismic_pga.tif`.

## Raster values

Raster — no vector attributes. Pixel value = PGA in g.

| Quantity | Range (CONUS) | Notes |
|---|---|---|
| PGA | 0.002 – 2.87 g | Legend clamps at **1.5 g** (`SEIS_RAMP_MAX`); above that = "very high". Hotspots: New Madrid, coastal CA, PNW. |

## Caveats

- **2475-yr return period** (2% probability of exceedance in 50 years). USGS also publishes 475- and 975-yr grids.
- **Site Class B/C** (firm rock) — does not account for local soil conditions.
- CONUS only. Alaska, Hawaii, and territories are separate USGS grids; not included.
- 0.05° resolution (~5 km).
