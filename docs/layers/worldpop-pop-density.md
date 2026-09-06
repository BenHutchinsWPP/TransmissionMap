# WorldPop Population Density

Worldwide population density, 2020, at 1 km source resolution (people per km²), derived from WorldPop's global population-count mosaic.

## Source

| | |
|---|---|
| **Provider** | [WorldPop](https://www.worldpop.org/) — University of Southampton |
| **Dataset** | Global High Resolution Population Denominators Project — 1 km population **count** mosaic, 2020 (`ppp_2020_1km_Aggregated.tif`). WorldPop publishes *density* per country only; counts are the sole worldwide product, so density is derived here (see Processing) |
| **Coverage** | Worldwide, clipped to 60° S – 75° N |
| **Vintage** | 2020 unconstrained estimates (~7.87 billion people) |
| **License** | **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — attribution **required** |
| **Attribution** | "WorldPop (www.worldpop.org) / University of Southampton (CC BY 4.0)" |
| **Citation** | WorldPop (www.worldpop.org) and Center for International Earth Science Information Network (CIESIN), Columbia University (2018). *Global High Resolution Population Denominators Project*. Funded by The Bill and Melinda Gates Foundation (OPP1134076). doi: 10.5258/SOTON/WP00647 |
| **Served** | `data/layers/worldpop_pop_density.pmtiles` — raster PMTiles, log-scale baked RGBA color |
| **Built by** | `scripts/build_population_density.sh` |
| **Raw input** | `data/raw/population/ppp_2020_1km_Aggregated.tif` (auto-downloaded from WorldPop — **not committed**, ~830 MB) |

> **Download origin — live.** `scripts/build_population_density.sh` downloads directly from
> `https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/0_Mosaicked/ppp_2020_1km_Aggregated.tif`
> No login required; ~830 MB, and WorldPop serves it slowly (allow ~40 min).

## Download pack

`worldpop-pop-density.zip` — `pop-density.tif` (Cloud-Optimized GeoTIFF, real ppl/km² values, EPSG:4326, ~2 km) · `worldpop-pop-density.md` · `disclaimer.txt`

No GeoJSON/CSV — this is a continuous raster with no feature attributes.

**Attribution required in any redistribution:** "WorldPop (www.worldpop.org) / University of Southampton (CC BY 4.0)".

## Processing

- **Download:** the ~830 MB global 1 km count mosaic from `data.worldpop.org`
- **Counts → density:** `gdalwarp -r sum` folds the 1 km counts into a 2 km World
  Cylindrical Equal Area grid, where every cell is exactly 4 km², then `gdal_calc`
  divides by that constant. Because the grid is equal-area there is no
  latitude-dependent cell-area term anywhere. `-r sum` is what conserves people —
  averaging counts would understate every dense cell. The step is checked by
  totalling the grid: it comes to ~7.87 billion, matching WorldPop's 2020 figure.
  **Do not pass `-srcnodata` to that warp:** the mosaic declares its own NoData
  (`-3.4028235e+38`), and overriding it makes gdalwarp sum the ocean as real counts,
  driving every part-ocean cell negative — which the `A > 0` filter then erases,
  punching holes along exactly the coastlines where most people live.
- **Reproject back:** `gdalwarp` to EPSG:4326 at 0.02°, clipped to 180°W–180°E, 60°S–75°N.
  Density is an intensity, so bilinear is correct here; only the count step needs `sum`.
- **Log transform:** `gdal_calc` computes `log10(1 + ppl/km²)` so the full 5-order-of-magnitude range (sparse rural → dense urban) is visible in color; NoData / 0 values → 0 (transparent)
- **Color tiles:** `gdaldem color-relief` applies `scripts/pop_density_color_ramp.txt` to the log-transformed raster; baked RGBA → web-mercator reproject → MBTiles → PMTiles
- **Hover LUT:** 0.06° (~6.7 km) grid with raw Int16 ppl/km² values (scale=1); the browser downloads this grid whole, so it is sized for the wire — a 0.025° worldwide grid would be ~150 MB of flat Int16. A few dense urban cores saturate the Int16 ceiling of 32767; sampled on mousemove to drive the legend readout, converted to ppl/mi² unless the area preference is metric (see [settings.md](../settings.md))
- **Download artifact:** 0.02° (~2 km) averaged COG with real float ppl/km² values

## Color Scale

Population density spans roughly five orders of magnitude worldwide; a log scale is used so rural areas remain visible:

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
- These are unconstrained estimates (not UN-adjusted), so national totals may differ from UN figures and from raw census counts.
- 2020 vintage; does not reflect post-pandemic population shifts.
- WorldPop values are `float32`; the hosted LUT truncates to `Int16` (max 32,767 ppl/km²). The download COG retains full float precision.
