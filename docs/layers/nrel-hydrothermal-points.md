# NREL/DOE Hydrothermal Systems

Named low-temperature hydrothermal springs and wells (contiguous US + parts of Alaska).

## Source

| | |
|---|---|
| **Provider** | [National Renewable Energy Laboratory (NREL) / DOE](https://www.nrel.gov/) via the [Geothermal Data Repository (GDR)](https://gdr.openei.org/) |
| **Dataset** | [US Low-Temperature Hydrothermal Resource Potential (Mullane et al., 2016)](https://gdr.openei.org/submissions/842) — `us_low_temp_hydro_shps_080316.zip` (~952 KB, ESRI Shapefile, ~1,200 point features) |
| **Coverage** | Contiguous US + some Alaska/Canada |
| **Vintage** | Published 2016 |
| **Acquired** | 2026-06-05 |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "NREL/DOE Geothermal Data Repository" |
| **Citation** | Mullane, M., et al. (2016). *US Low-Temperature Hydrothermal Resource Potential*. GDR submission 842. NREL/DOE. https://gdr.openei.org/submissions/842 |
| **Served** | `data/layers/nrel_hydrothermal_pts.geojson.gz` — gzipped GeoJSON point layer (~1,200 features, lazy-loaded) |
| **Built by** | `scripts/build_hydrothermal_pts.sh` → `data/build/hydrothermal/` → hosted GeoJSON + CSV |
| **Raw input** | `us_low_temp_hydro_shps_080316.zip` (auto-downloaded to `data/raw/hydrothermal/` — **zip not committed**, ~952 KB) |

> **Download origin — live.** `scripts/build_hydrothermal_pts.sh` downloads the zip directly from
> `https://gdr.openei.org/files/842/us_low_temp_hydro_shps_080316.zip`
> (direct HTTP GET, ~952 KB, no login required; HTTP 200 verified 2026-06-05).

## Download pack

`nrel-hydrothermal-points.zip` — `nrel-hydrothermal-points.geojson` · `nrel-hydrothermal-points.csv` · `nrel-hydrothermal-points.md` · `disclaimer.txt`

## What this layer shows

**Named low-temperature hydrothermal systems** (isolated springs and wells) across the contiguous US and parts of Alaska. Each point represents a measured location where shallow geothermal water with a reservoir temperature between roughly 13 and 150 °C has been identified. These are primarily space-heating and process-heat resources rather than power-generation resources (unlike the high-temperature steam fields used in conventional geothermal power).

Circle color and size encode reservoir temperature:

| Band | Range | Color | Meaning |
|---|---|---|---|
| Warm | < 50 °C | amber-yellow `#fde68a` | Space / process heat potential |
| Hot | 50–89 °C | orange `#f97316` | Low-temperature power + heat |
| Very hot | ≥ 90 °C | red `#dc2626` (7 px) | Power generation potential |

## Fields

| Field | Description |
|---|---|
| `name` | Area, spring, or well name (many are generic "Spring" or "Well") |
| `state` | State name |
| `county` | County name |
| `temp_c` | Reservoir temperature, °C (range: 13–150; mean ~58) |
| `min_depth_m` | Minimum depth, metres (often absent) |
| `max_depth_m` | Maximum depth, metres (often absent) |
| `heat_mwt` | Beneficial heat potential, MW thermal over 30 years |
| `reference` | Source report (abbreviated, e.g. "Muffler(1979)") |

Fields dropped from the source: `UID`, `SYS_TYPE` (always "isolated system"), `GEO_PROV`, `RES_VOL`, `RESKM2`, `WELLKM2`, `N_WELLS`, `ACCRESBASE`, `RESOURCE`, `BENHEATJ`, `BENHEATMWH`.

## Processing — `scripts/build_hydrothermal_pts.sh`

1. **Download** the zip from the NREL Geothermal Data Repository into `data/raw/hydrothermal/` (skipped if already present). ~952 KB, direct HTTP GET, no login.
2. **Extract** the point shapefile (`us_low_temp_hydro_pt_080316.shp`) from the zip.
3. **Convert** to GeoJSON via `ogr2ogr -f GeoJSON -t_srs EPSG:4326`.
4. **Clean** with Python: rename fields from source (`GEO_AREA`→`name`, `STATE`→`state`, `COUNTY`→`county`, `RES_TEMP`→`temp_c`, `MIN_DEPTH`→`min_depth_m`, `MAX_DEPTH`→`max_depth_m`, `BENHEATMWT`→`heat_mwt`, `REFERENCE`→`reference`); drop features with null geometry and zero-value depth entries.
5. **Gzip** to `data/layers/nrel_hydrothermal_pts.geojson.gz` for the app (decompressed client-side by `fetchGeojson`).
6. **Download pack** → `build_releases.py` reads the `.geojson.gz`, flattens properties + lon/lat columns to CSV, and bundles GeoJSON + CSV into `data/releases/nrel-hydrothermal-points.zip`.

## Caveats

- **Generic names.** Many points are named "Spring", "Well", or "Hot Spring" with no distinguishing qualifier — county and state fields provide context. The popup falls back to "Hydrothermal System" when the name field is absent.
- **Low-temperature focus.** All ~1,200 points are classified "isolated system" (< 150 °C reservoir). High-enthalpy geothermal fields (The Geysers, Salton Sea, Yellowstone perimeter) are not in this dataset.
- **Depth fields sparse.** `min_depth_m` and `max_depth_m` are absent for many points (measured at surface or not reported).
- **Data vintage.** Compiled for the 2016 NREL report; underlying source reports span the 1970s–2010s. Some systems may be inactive or re-characterized.
- **Alaska and Canada.** A handful of points fall north of lat 60° (Alaska, Yukon). These are in scope — the map covers North America.
