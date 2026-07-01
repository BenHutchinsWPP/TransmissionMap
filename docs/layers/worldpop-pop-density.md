# WorldPop Population Density

UN-adjusted population density for USA + Canada + Mexico, 2020, at 1 km resolution (people per km²).

## Source

| | |
|---|---|
| **Provider** | [WorldPop](https://www.worldpop.org/) — University of Southampton |
| **Dataset** | Global High Resolution Population Denominators Project — UN-adjusted 1 km population density, 2020. Three national GeoTIFFs: USA, CAN, MEX |
| **Coverage** | USA + Canada + Mexico (mosaiced, clipped to NA bbox) |
| **Vintage** | 2020 UN-adjusted estimates |
| **License** | **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — attribution **required** |
| **Attribution** | "WorldPop (www.worldpop.org) / University of Southampton (CC BY 4.0)" |
| **Citation** | WorldPop (www.worldpop.org) and Center for International Earth Science Information Network (CIESIN), Columbia University (2018). *Global High Resolution Population Denominators Project*. Funded by The Bill and Melinda Gates Foundation (OPP1134076). doi: 10.5258/SOTON/WP00675 |
| **Served** | `data/layers/worldpop_pop_density.pmtiles` — raster PMTiles, log-scale baked RGBA color |
| **Built by** | `scripts/build_population_density.sh` |
| **Raw input** | `data/raw/population/usa_pd_2020_1km.tif`, `can_pd_2020_1km.tif`, `mex_pd_2020_1km.tif` (auto-downloaded from WorldPop — **not committed**, ~50–70 MB each) |

> **Download origin — live.** `scripts/build_population_density.sh` downloads directly from
> `https://data.worldpop.org/GIS/Population_Density/Global_2000_2020_1km/2020/{ISO}/{iso}_pd_2020_1km.tif`
> No login required; files ~50–70 MB each (~170 MB total for USA+CAN+MEX).

## Download pack

`worldpop-pop-density.zip` — `pop-density.tif` (Cloud-Optimized GeoTIFF, real ppl/km² values, EPSG:4326, ~2 km) · `worldpop-pop-density.md` · `disclaimer.txt`

No GeoJSON/CSV — this is a continuous raster with no feature attributes.

**Attribution required in any redistribution:** "WorldPop (www.worldpop.org) / University of Southampton (CC BY 4.0)".

## Processing

- **Download:** Three GeoTIFFs fetched automatically (~50–70 MB each) from `data.worldpop.org`
- **Mosaic:** `gdalbuildvrt` merges the three national extents into a seamless VRT
- **Clip:** `gdalwarp` clips to the North America bounding box (170°W–50°W, 5°N–72°N)
- **Log transform:** `gdal_calc` computes `log10(1 + ppl/km²)` so the full 5-order-of-magnitude range (sparse rural → dense urban) is visible in color; NoData / 0 values → 0 (transparent)
- **Color tiles:** `gdaldem color-relief` applies `scripts/pop_density_color_ramp.txt` to the log-transformed raster; baked RGBA → web-mercator reproject → MBTiles → PMTiles
- **Hover LUT:** 0.1° coarse grid with raw Int16 ppl/km² values (scale=1); sampled on mousemove to drive the legend arrow readout
- **Download artifact:** 0.02° (~2 km) averaged COG with real float ppl/km² values

## Color Scale

Population density spans roughly five orders of magnitude across North America; a log scale is used so rural areas remain visible:

| Log value | Density | Color | Example |
|---|---:|---|---|
| 0 | 0 | Transparent | Ocean, uninhabited |
| 0.3 | ~1 ppl/km² | Pale yellow | Alaska interior |
| 1.0 | ~9 ppl/km² | Amber | Great Plains |
| 2.0 | ~100 ppl/km² | Orange | Suburban sprawl |
| 3.0 | ~1,000 ppl/km² | Red-orange | City proper |
| 4.0 | ~10,000 ppl/km² | Dark red | Dense urban |
| 4.7 | ~50,000 ppl/km² | Very dark red (clamp) | Manhattan-level |

## Raster values

The hover readout shows raw population density (ppl/km²). No vector attributes; this is a raster layer.

## Caveats

- 1 km resolution means individual blocks or neighborhoods are not visible; useful for city-to-regional scale analysis.
- UN-adjusted estimates correct for under-enumeration in census data, so values may differ from raw census counts.
- 2020 vintage; does not reflect post-pandemic population shifts.
- WorldPop values are `float32`; the hosted LUT truncates to `Int16` (max 32,767 ppl/km²). The download COG retains full float precision.
