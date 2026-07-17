# Wildfire Hazard Potential (WHP)

USFS wildfire hazard potential for the contiguous US, 2023, at 270 m resolution — a
categorized raster. Seven categories: Very Low → Very High, plus Non-burnable and Water.

## Source

| | |
|---|---|
| **Provider** | [USFS Rocky Mountain Research Station — Fire, Fuel, and Smoke Science Program (Fire Lab)](https://research.fs.usda.gov/firelab/products/dataandtools/wildfire-hazard-potential) |
| **Dataset** | Wildfire Hazard Potential for the United States (270 m), version 2023 — [RDS-2015-0047-4](https://www.fs.usda.gov/rds/archive/catalog/RDS-2015-0047-4) |
| **Coverage** | CONUS (lower 48). Alaska + Hawaii ship as separate rasters in the same archive but are not built. |
| **Vintage** | 2023 |
| **License** | Public domain (US Government work) |
| **Citation** | Dillon, G.K.; Menakis, J.; Fay, F. 2015. *Wildland Fire Potential: A Tool for Assessing Wildfire Risk and Fuels Management Needs.* In: Proceedings of the large wildland fires conference. Proc. RMRS-P-73. Fort Collins, CO: USDA Forest Service, RMRS. |
| **Served** | `data/layers/usfs_wildfire_potential.pmtiles` — raster PMTiles, baked discrete RGBA color |
| **Built by** | `scripts/build_wildfire_hazard.sh` |
| **Raw input** | `data/raw/wildfire_hazard/whp2023_GeoTIF/whp2023_cls_conus.tif` (Byte, EPSG:5070 Albers, NoData 255 — **not committed**) |

> **Download origin — manual.** The RDS archive is not scriptable; the four zips were
> downloaded by hand from the [catalog page](https://www.fs.usda.gov/rds/archive/catalog/RDS-2015-0047-4)
> and live in `data/raw/wildfire_hazard/`:
> `RDS-2015-0047-4_Data.zip` (rasters — gdb + GeoTIFFs), `_Supplements.zip`,
> `_Metadata_Fileindex.zip`, `firelab-whp2023_datasummaries.zip`.
> The build reads the extracted `whp2023_GeoTIF/whp2023_cls_conus.tif`.

## Download pack

No download pack is built (intentionally — not in `scripts/release_manifest.yaml`). The
served raster is the original USFS classified GeoTIFF re-colored for display, with no
meaningful transformation, so there's nothing repackaged to offer — users go to the
original USFS RMRS Fire Lab data publication above.

## Processing

- **Source:** classified CONUS GeoTIFF (`whp2023_cls_conus.tif`) — Byte, integer classes 1–7, NoData 255, EPSG:5070
- **Color tiles:** `gdaldem color-relief` applies `scripts/whp_color_ramp.txt` (discrete official symbology) → baked RGBA → web-mercator reproject → MBTiles (WEBP) → PMTiles, via `rc_bake_tiles` in `scripts/raster_common.sh`
- **No hover LUT:** categorical raster — the seven distinct colors + the static legend (`#whpLegend` in `index.html`) convey the class. Rendered with `raster-resampling: nearest` to keep class edges crisp.

The **continuous** WHP index (`whp2023_cnt_conus.tif`, Int32 0–204) is in the same archive but
not built — the classified product is the canonical, interpretable map layer.

## Raster values

Categorical raster — pixel value is an integer hazard class (1–7), no vector attributes.

| Value | Class | Color |
|---|---|---|
| 1 | Very Low | `#38A800` |
| 2 | Low | `#D1FF73` |
| 3 | Moderate | `#FFFF00` |
| 4 | High | `#FFAA00` |
| 5 | Very High | `#FF0000` |
| 6 | Non-burnable | `#B2B2B2` |
| 7 | Water | `#0070FF` |

## Caveats

- **CONUS only.** Alaska/Hawaii subdatasets exist in the archive (`whp2023_cls_ak`, `whp2023_cls_hi`) but are not tiled. Add to the build if needed.
- **270 m resolution.** Not a parcel- or structure-level risk product; intended for regional/landscape assessment.
- **Categorical:** "Non-burnable" and "Water" (6, 7) are masks, not hazard ranks — they sit outside the Very Low→Very High scale.
- WEBP tiles are lossy (quality 85); minor color blending can appear at class boundaries under zoom.
