# Release Artifacts

Inventory of all data files for the July 2026 build, with sizes and sources. These
files live under `data/` and are required for the app to function.

The OSM source file (`north-america-latest.osm.pbf`, 19.2 GB) is not listed —
it is re-downloaded from Geofabrik on demand and never committed. This build's
OSM-derived artifacts were rebuilt from the fresh 2026-07-13 Geofabrik extract,
which includes the recovered line voltages and the new `is_dc` HVDC field.

---

## App data — files loaded by the map at runtime

These live under `data/layers/` and must be present for the app to function.
Two files — `odin_outages.json` and the live wildfire/NWS-alert feeds — are
**live-feed artifacts** refreshed by cron onto the `data` branch rather than
built by `make tiles`; they're listed here because they still ship as app data.

| File | Size | Description |
|---|--:|---|
| `data/layers/railroads.pmtiles` | 81 MB | BTS/FRA North American rail network lines (PMTiles) |
| `data/layers/crithab.pmtiles` | 74 MB | USFWS ESA critical habitat polygons (PMTiles) |
| `data/layers/padus.pmtiles` | 68 MB | USGS PAD-US protected & managed lands (PMTiles) |
| `data/layers/usfs_wildfire_potential.pmtiles` | 64 MB | USFS wildfire hazard potential raster (PMTiles, baked color) |
| `data/layers/osm_transmission_lines.pmtiles` | 58 MB | OSM transmission lines (PMTiles, zoom 2–11) |
| `data/layers/hifld_transmission_lines.pmtiles` | 38 MB | HIFLD transmission lines (PMTiles, zoom 2–11) |
| `data/layers/osm_pipelines_lines.pmtiles` | 30 MB | OSM pipeline routes (PMTiles, zoom 3–12) |
| `data/layers/worldpop_pop_density_lut.i16` | 25 MB | Coarse Int16 people/km² value grid for the legend hover readout (lazy-loaded) |
| `data/layers/osm_generators.pmtiles` | 17 MB | OSM generators (PMTiles, zoom 7–14) |
| `data/layers/hifld_natgas_lines.pmtiles` | 16 MB | HIFLD natural gas pipeline lines (PMTiles) |
| `data/layers/retail_territories.pmtiles` | 15 MB | HIFLD retail electric territories (PMTiles, zoom 2–10) |
| `data/layers/worldpop_pop_density.pmtiles` | 11 MB | WorldPop population density, log-scale (raster PMTiles) — CC BY 4.0 |
| `data/layers/gsa_solar_pvout.pmtiles` | 10 MB | Global Solar Atlas PVOUT, kWh/kWp/day (raster PMTiles, WEBP, zoom 2–7) — CC BY 4.0 |
| `data/layers/nws_zones.pmtiles` | 7.2 MB | NWS forecast zones, shared join infra for zone-based alerts (PMTiles) |
| `data/layers/osm_substations_polygons.geojson.gz` | 4.8 MB | OSM substation polygon footprints |
| `data/layers/tribal_lands.geojson.gz` | 4.5 MB | Census TIGER AIANNH tribal lands |
| `data/layers/nlr_wind_100m.pmtiles` | 3.4 MB | NREL/NLR WIND Toolkit mean wind speed @ 100 m (raster PMTiles, WEBP, zoom 1–6) |
| `data/layers/osm_plants_polygons.geojson.gz` | 3.4 MB | OSM power plant polygon footprints |
| `data/layers/county_boundaries.pmtiles` | 2.5 MB | Census TIGER county boundaries, shared join infra (PMTiles) |
| `data/layers/bia_tribal_lands.geojson.gz` | 1.9 MB | BIA AIAN-LAR tribal lands |
| `data/layers/osm_substations_points.geojson.gz` | 1.9 MB | OSM substation points |
| `data/layers/gsa_solar_pvout_lut.i16` | 1.5 MB | Coarse Int16 kWh/kWp/day value grid for the legend hover readout (lazy-loaded) |
| `data/layers/nlr_wind_100m_lut.i16` | 1.3 MB | Coarse Int16 m/s value grid for the legend hover readout (lazy-loaded) |
| `data/layers/usgs_seismic_pga_lut.i16` | 1.2 MB | Coarse Int16 PGA (g) value grid for the legend hover readout (lazy-loaded) |
| `data/layers/hifld_substations.geojson.gz` | 1012 KB | HIFLD substation points |
| `data/layers/ogf_planned_transmission.geojson.gz` | 931 KB | Our Grid Future planned transmission projects |
| `data/layers/eia_generators.geojson.gz` | 925 KB | EIA Form 860 generator units |
| `data/layers/osm_plants_points.geojson.gz` | 616 KB | OSM power plant centroids |
| `data/layers/control_areas.geojson.gz` | 579 KB | HIFLD control areas (balancing authorities) |
| `data/layers/ihfc_geo_heatflow.pmtiles` | 462 KB | IHFC heat flow, mW/m² (raster PMTiles, WEBP, zoom 2–7) — CC BY 4.0 |
| `data/layers/wecc_path_lines.geojson.gz` | 449 KB | WECC path digitized corridor lines |
| `data/layers/nerc_regions.geojson.gz` | 332 KB | HIFLD NERC regions |
| `data/layers/hifld_natgas_points.geojson.gz` | 106 KB | HIFLD natural gas & petroleum facility points |
| `data/layers/mines.geojson.gz` | 69 KB | MSHA large mines, peak employment ≥ 50 (~2.3k points, gzipped GeoJSON) |
| `data/layers/ihfc_geo_heatflow_lut.i16` | 66 KB | Coarse Int16 mW/m² value grid for the legend hover readout (lazy-loaded) |
| `data/layers/osm_datacenters.geojson.gz` | 65 KB | OSM data center facilities |
| `data/layers/boem_wind_leases.geojson.gz` | 59 KB | BOEM offshore wind lease polygons (51 leases, gzipped GeoJSON) |
| `data/layers/osm_pipelines_points.geojson.gz` | 44 KB | OSM pipeline feature points (valves, etc.) |
| `data/layers/nrel_hydrothermal_points.geojson.gz` | 36 KB | NREL/DOE low-temp hydrothermal systems (1,214 circle points, gzipped GeoJSON) |
| `data/layers/usgs_seismic_pga.pmtiles` | 33 KB | USGS seismic hazard PGA, 2% in 50yr (raster PMTiles) |
| `data/layers/eia_crude_pipelines.geojson.gz` | 28 KB | EIA crude-oil pipelines |
| `data/layers/eia_product_pipelines.geojson.gz` | 25 KB | EIA petroleum-product pipelines |
| `data/layers/odin_outages.json` | 13 KB | ORNL ODIN live county outage counts — no geometry, live feed (cron-refreshed) |
| `data/layers/wecc_paths.geojson.gz` | 9 KB | WECC path point markers |
| `data/layers/nlr_wind_100m_lut.json` | <1 KB | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/usgs_seismic_pga_lut.json` | <1 KB | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/worldpop_pop_density_lut.json` | <1 KB | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/gsa_solar_pvout_lut.json` | <1 KB | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/ihfc_geo_heatflow_lut.json` | <1 KB | Lookup-grid metadata (dims, bbox, scale) |
| **Total** | **544 MB** | (49 files) |

---

## User download packs — offered as downloads from the app UI

These live under `data/releases/`, served as download links in the layer panel
(`downloads` in the registry → `assets/ui/ui-layer-rows.ts`). In prod they are
fetched from the orphan `data-static` branch via `raw.githubusercontent.com`
(pushed by `make publish-data`), not from `main` or Pages. `build_releases.py`
builds them from `scripts/release_manifest.yaml`.

**Convention (one pack per map layer, format-named):** every download link maps
to exactly one map layer — packs never bundle two layers together. The download
dropdown is labeled by the *format*, not "ZIP". Geometry determines what ships:

| Geometry | Menu option(s) | ZIP(s) | Contents |
|---|---|---|---|
| point | **CSV** | `<layer-id>.zip` | `<name>.csv` (lat/lon + attributes; no GeoJSON) |
| line / polygon | **GeoJSON**, **SHP** | `<layer-id>.zip`, `<layer-id>-shp.zip` | GeoJSON zip: `<name>.geojson` + `<name>.csv`; SHP zip: `.shp/.shx/.dbf/.prj/.cpg` + `<name>.csv` |
| raster | **GeoTIFF** | `<layer-id>.zip` | `<layer-id>.tif` (COG) |

Every ZIP also bundles the layer doc (`<layer-id>.txt`, via pandoc) and
`disclaimer.txt`. The attribute-only CSV rides inside *both* the GeoJSON and SHP
zips so users can preview the tabular data without downloading geometry.
`data/releases/` currently holds 35 ZIP packs totalling 525 MB; individual pack
sizes vary and are not pinned here.

| Layer | Geometry | Pack(s) in `data/releases/` |
|---|---|---|
| `hifld-transmission-lines` | line | `.zip` + `-shp.zip` |
| `hifld-substations` | point | `.zip` (CSV) |
| `osm-transmission-lines` | line | `.zip` + `-shp.zip` |
| `osm-substations-points` | point | `.zip` (CSV) |
| `osm-substations-polygons` | polygon | `.zip` + `-shp.zip` |
| `wecc-paths` | vector (1 pack, points + highlight lines) | `.zip` (GeoJSON only — mixed geometry; SHP deferred) |
| `eia-generators` | point | `.zip` (CSV) |
| `osm-generators` | point | `.zip` (CSV) |
| `osm-plants-points` | point | `.zip` (CSV) |
| `osm-plants-polygons` | polygon | `.zip` + `-shp.zip` |
| `hifld-natgas-lines` | line | `.zip` + `-shp.zip` |
| `hifld-natgas-points` | point | `.zip` (CSV) |
| `osm-pipelines-lines` | line | `.zip` + `-shp.zip` |
| `osm-pipelines-points` | point | `.zip` (CSV) |
| `nlr-wind-100m` | raster | `.zip` — COG GeoTIFF, real m/s (EPSG:4326, Float32) |
| `ihfc-geo-heatflow` | raster | `.zip` — COG GeoTIFF, real mW/m² (0.5°) — CC BY 4.0 |
| `nrel-hydrothermal-points` | point | `.zip` (CSV) |
| `nerc-regions` | polygon | `.zip` + `-shp.zip` |
| `control-areas` | polygon | `.zip` + `-shp.zip` |
| `retail-territories` | polygon | `.zip` + `-shp.zip` |
| `osm-datacenters` | point | `.zip` (CSV) |
| `worldpop-pop-density` | raster | `.zip` — COG GeoTIFF |

Layers that link to source instead of shipping a pack (registry `downloads.url`
only): `tribal-lands` (Census), `railroads` (BTS), `gsa-solar-pvout`
(energydata.info), plus the `skip: true` layers below.

Layers marked `skip: true` in the manifest produce no ZIP: the OurGridFuture
planned-transmission layer (no redistribution — link out to ourgridfuture.org),
Critical Habitat (no redistribution — link out to USFWS ECOS), PAD-US protected
lands (too large to redistribute — link out to the USGS ScienceBase item), and
Large Mines (filtered subset of the MSHA dataset — no pack offered). OGF and
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
| App data (map layers) | 544 MB |
| User download packs (`data/releases/` ZIPs) | 525 MB (repackaged app/pipeline data) |
| HIFLD pipeline inputs (original GeoJSON) | ~137 MB |
| SeerAI parquet (active source) | ~42 MB |
| EIA pipeline inputs (used files only) | ~15 MB |
| EIA full archive | ~22 MB |
| **Grand total (app data + release packs)** | **~1,069 MB** |
