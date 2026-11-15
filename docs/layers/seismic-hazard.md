# Seismic Hazard (PGA, 2% in 50yr)

USGS National Seismic Hazard Model peak ground acceleration for all 50 states.
**Probability of exceedance** surface — not historical epicenters.

Continuous raster, Peak Ground Acceleration in **g**, 2% probability of exceedance in
50 years (≈2475-yr return period), Site Class B/C.

## Source

| | |
|---|---|
| **Provider** | USGS — 2023 50-State National Seismic Hazard Model |
| **Dataset** | 2023 50-State National Seismic Hazard Model, PGA 2% in 50 years, Site Class B/C — DOI [10.5066/P9GNPCOD](https://doi.org/10.5066/P9GNPCOD) · [ScienceBase item](https://www.sciencebase.gov/catalog/item/64ff886dd34ed30c2057b4d9) |
| **Coverage** | All 50 states (CONUS, Alaska, Hawaii) |
| **Vintage** | 2023 NSHM |
| **License** | Public domain (US Government work) |
| **Served** | `data/layers/usgs_seismic_pga.pmtiles` — raster PMTiles, baked color · `_lut.i16.gz`/`_lut.json` — hover readout |
| **Built by** | `scripts/build_seismic_hazard.sh` (`make seismic`) |
| **Raw input** | `data/raw/usgs/nshm2023/US_PGA_2Pct_5Pct_10Pct_50Yrs_BC.zip` (**not committed**; the build fetches it and checks its SHA-256) |

## Download pack

No download pack is built (intentionally — not in `scripts/release_manifest.yaml`). The
served raster is a near-direct rendering of the USGS source grid with no meaningful
transformation, so there's nothing repackaged to offer — users go to the original USGS
NSHM ScienceBase item above.

## Processing

- **Source form:** the USGS PGA 2%-in-50-year contour-band polygons (`US_PGA_2Pct50Yrs_BC_poly.shp`), each carrying a low and high PGA bound.
- **Bands → raster:** each band is rasterised at 0.05° lon/lat with its midpoint value → Float32 GeoTIFF, EPSG:4326, covering lon −180…180 (the western Aleutians east of 180° included). Cell values are band midpoints (±0.005 g). Areas below 0.01 g are not drawn.
- **Color tiles:** `gdaldem color-relief` with `scripts/seis_color_ramp.txt` (yellow→red, in sync with `SEIS_RAMP_STOPS` in `src/colors/ramps.ts`) → baked RGBA → web-mercator → MBTiles (WEBP) → PMTiles, via `rc_bake_tiles`. Rendered `raster-resampling: linear` (continuous surface).
- **Hover LUT:** Int16 grid of `round(PGA × 1000)`, NoData 0 (`scale: 1000` in the sidecar), covering lon −180…−64.5, so the western Aleutians east of 180° draw but have no hover value → cursor readout in g (2 decimals) via `RASTER_PROBES["usgs-seismic-pga"]`.
- **Download:** Float32 COG of real g values at `data/build/usgs_seismic_pga.tif`.

## Raster values

Raster — no vector attributes. Pixel value = PGA in g.

| Quantity | Range | Notes |
|---|---|---|
| PGA | 0.01 – 3 g | Legend clamps at **1.5 g** (`SEIS_RAMP_MAX`); above that = "very high". Hotspots: New Madrid, coastal CA, PNW, Alaska, Hawaii. |

## Caveats

- **2475-yr return period** (2% probability of exceedance in 50 years). USGS also publishes 475- and 975-yr grids.
- **Site Class B/C** (firm rock) — does not account for local soil conditions.
- Territories are not included.
- 0.05° resolution (~5 km); values are contour-band midpoints.
