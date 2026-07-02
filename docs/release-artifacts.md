# Release Artifacts

Inventory of all data files for the May 2026 build, with sizes and sources. These
files live under `data/` and are required for the app to function.

The OSM source file (`north-america-latest.osm.pbf`, ~18 GB) is not listed —
it is re-downloaded from Geofabrik on demand and never committed.

---

## App data — files loaded by the map at runtime

These live under `data/` and must be present for the app to function.

| File | Size | Description |
|---|--:|---|
| `data/layers/osm_transmission_lines.pmtiles` | 39 MB | OSM transmission lines (PMTiles, zoom 2–11) |
| `data/layers/hifld_transmission_lines.pmtiles` | 22 MB | HIFLD transmission lines (PMTiles, zoom 2–11) |
| `data/layers/osm_substations_polygons.geojson.gz` | 31 MB | OSM substation polygon footprints |
| `data/layers/osm_pipelines_lines.pmtiles` | 30 MB | OSM pipeline routes (PMTiles, zoom 3–12) |
| `data/layers/eia_crude_pipelines.geojson.gz` | 44 KB | EIA crude-oil pipelines |
| `data/layers/eia_product_pipelines.geojson.gz` | 39 KB | EIA petroleum-product pipelines |
| `data/layers/osm_substations_points.geojson.gz` | 18 MB | OSM substation points |
| `data/layers/osm_generators.pmtiles` | 17 MB | OSM generators (PMTiles, zoom 7–14) |
| `data/layers/osm_plants_polygons.geojson.gz` | 17 MB | OSM power plant polygon footprints |
| `data/layers/hifld_substations.geojson.gz` | 12 MB | HIFLD substation points |
| `data/layers/eia_generators.geojson` | 8.8 MB | EIA Form 860 generator units |
| `data/layers/osm_plants_points.geojson.gz` | 4.4 MB | OSM power plant centroids |
| `data/layers/osm_pipelines_points.geojson.gz` | 536 KB | OSM pipeline feature points (valves, etc.) |
| `data/layers/nlr_wind_100m.pmtiles` | 3.5 MB | NREL/NLR WIND Toolkit mean wind speed @ 100 m (raster PMTiles, WEBP, zoom 1–6) |
| `data/layers/nlr_wind_100m_lut.i16` | 1.3 MB | Coarse Int16 m/s value grid (0.1°) for the legend hover readout (lazy-loaded) |
| `data/layers/nlr_wind_100m_lut.json` | <1 KB | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/gsa_solar_pvout.pmtiles` | 11 MB | Global Solar Atlas PVOUT, kWh/kWp/day (raster PMTiles, WEBP, zoom 2–7) — CC BY 4.0 |
| `data/layers/gsa_solar_pvout_lut.i16` | 1.6 MB | Coarse Int16 kWh/kWp/day value grid (0.1°) for the legend hover readout (lazy-loaded) |
| `data/layers/gsa_solar_pvout_lut.json` | <1 KB | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/ihfc_geo_heatflow.pmtiles` | ~2 MB | IHFC heat flow, mW/m² (raster PMTiles, WEBP, zoom 2–7) — CC BY 4.0 |
| `data/layers/ihfc_geo_heatflow_lut.i16` | <1 MB | Coarse Int16 mW/m² value grid (0.5°) for the legend hover readout (lazy-loaded) |
| `data/layers/ihfc_geo_heatflow_lut.json` | <1 KB | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/nrel_hydrothermal_points.geojson.gz` | 40 KB | NREL/DOE low-temp hydrothermal systems (1,214 circle points, gzipped GeoJSON) |
| **Total** | **~218 MB** | |

---

## User download packs — offered as downloads from the app UI

These live under `data/releases/` as one ZIP per layer, served as download links in
the layer panel (`downloads.zip` in the registry → `assets/ui/ui-layer-rows.ts`).
In prod they are fetched from the orphan `data-static` branch via
`raw.githubusercontent.com` (pushed by `make publish-data`), not from `main` or Pages.
`build_releases.py` builds them from `scripts/release_manifest.yaml`; each ZIP bundles
the data (GeoJSON + CSV for vectors, or a COG GeoTIFF for rasters), the layer doc
(`<layer-id>.txt`, via pandoc), and `disclaimer.txt`. Sizes vary and are not pinned here.

| ZIP (`data/releases/`) | Contents |
|---|---|
| `hifld-transmission-lines.zip` | HIFLD transmission lines (GeoJSON + CSV) |
| `hifld-substations.zip` | HIFLD substation points (CSV) |
| `osm-transmission-lines.zip` | OSM transmission lines (GeoJSON + CSV) |
| `osm-substations.zip` | OSM substation points (CSV) + polygons (GeoJSON + CSV) |
| `eia-generators.zip` | EIA Form 860 generator units (CSV) |
| `osm-generators.zip` | OSM generators (CSV) |
| `osm-plants.zip` | OSM power plant points (CSV) + polygons (GeoJSON + CSV) |
| `hifld-natgas.zip` | HIFLD natural-gas pipeline lines (GeoJSON + CSV) + points (CSV) |
| `osm-pipelines.zip` | OSM pipeline routes (GeoJSON + CSV) + feature points (CSV) |
| `eia-petroleum.zip` | EIA crude-oil + petroleum-product pipelines (GeoJSON + CSV) |
| `nlr-wind-100m.zip` | NREL/NLR mean wind speed @ 100 m — COG GeoTIFF, real m/s (EPSG:4326, Float32) |
| `gsa-solar-pvout.zip` | Global Solar Atlas PVOUT — COG GeoTIFF, real kWh/kWp/day (~2 km) — CC BY 4.0 |
| `ihfc-geo-heatflow.zip` | IHFC heat flow — COG GeoTIFF, real mW/m² (0.5°) — CC BY 4.0 |
| `nrel-hydrothermal-points.zip` | NREL/DOE low-temp hydrothermal systems (GeoJSON + CSV, 1,214 points) |
| `tribal-lands.zip` | Tribal lands (GeoJSON + CSV) |
| `hifld-regions.zip` | NERC regions + control areas + retail territories (GeoJSON + CSV each) |
| `railroads.zip` | NARN rail lines (GeoJSON + CSV) |
| `osm-datacenters.zip` | OSM data centers (CSV) |
| `worldpop-pop-density.zip` | WorldPop 2020 population density — COG GeoTIFF |

Layers marked `skip: true` in the manifest produce no ZIP: the OurGridFuture
planned-transmission layer (no redistribution — link out to ourgridfuture.org),
Critical Habitat (no redistribution — link out to USFWS ECOS), and PAD-US protected
lands (too large to redistribute — link out to the USGS ScienceBase item). OGF and
Critical Habitat are pre-baked into `data/layers/` by their own extractors
(`extract_ogf.py`, `extract_crithab.py`).

---

## Pipeline inputs — minimum files required to regenerate the build

These live under `data/raw/` and are the upstream source files the scripts read.
Preserving these pins the exact data vintage used for this build.

### HIFLD (Homeland Infrastructure Foundation-Level Data)

| File | Size | Source | Downloaded |
|---|--:|---|---|
| `data/raw/hifld/electric_substations.csv` | 22 MB | ArcGIS item [ef04dc8231c9491e804a008e5faa7d3a](https://www.arcgis.com/home/item.html?id=ef04dc8231c9491e804a008e5faa7d3a) | 2026-05-28 |
| `data/raw/hifld/transmission_lines.geojson` | 115 MB | Original HIFLD ArcGIS FeatureServer (portal decommissioned Aug 2025) — **historical archive only, not re-downloadable** | 2026-05-28 |
| **Total** | **~137 MB** | | |

### SeerAI HIFLD Archive (transmission lines — CC BY 4.0)

The SeerAI parquet is the active source for `extract_hifld_lines.py` going forward.
Preserved here so the exact data vintage used for this build can be reproduced without
re-downloading from source.coop (which requires authentication).

| File | Size | Source | Downloaded |
|---|--:|---|---|
| `data/raw/hifld/transmission_lines.parquet` | 42 MB | [source.coop/seerai/hifld](https://source.coop/repositories/seerai/hifld/description/) — CC BY 4.0 | 2026-05-28 |
| **Total** | **~42 MB** | | |

**Attribution required:** SeerAI (seerai.space) / Source Cooperative, CC BY 4.0.
**Notes from quality eval (2026-05-28):**
- 94,619 total features; 51,660 matched to prior local file (73% attribute-identical)
- Adds 23,099 lines at 69 kV and 4,810 new ≥100 kV lines not in prior local file
- VAL_DATE column is corrupted int32 — null-coerced in `extract_hifld_lines.py`
- SUB_1/SUB_2 substation names are noisier than the original HIFLD export

### EIA (Form 860, 2025 Early Release)

Only two workbooks from the EIA-860 ZIP are read by `extract_eia_generators.py`.
The full ZIP is included for completeness; the two extracted workbooks are listed
separately so they can be restored without re-downloading the whole archive.
(Sizes below are approximate — Early Release files shift between vintages.)

| File | Size | Notes |
|---|--:|---|
| `data/raw/eia/2___Plant_Y2025_Early_Release.xlsx` | ~4 MB | **Used by script** — plant locations and metadata |
| `data/raw/eia/3_1_Generator_Y2025_Early_Release.xlsx` | ~11 MB | **Used by script** — generator units (operable / proposed / retired sheets) |
| `data/raw/eia/eia8602025ER.zip` | ~22 MB | Full EIA-860 Early Release archive (source of the two files above) |
| **Total (deduplicated)** | **~37 MB** | (zip + two extracted workbooks) |

---

## Summary

| Category | Size |
|---|--:|
| App data (map layers) | ~200 MB |
| User download packs (`data/releases/` ZIPs) | ~180 MB (repackaged app/pipeline data) |
| HIFLD pipeline inputs (original GeoJSON) | ~137 MB |
| SeerAI parquet (active source) | ~42 MB |
| EIA pipeline inputs (used files only) | ~15 MB |
| EIA full archive | ~22 MB |
| **Grand total** | **~598 MB** |

