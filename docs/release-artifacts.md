# Release Artifacts

Inventory of the data files the build produces and reads. These files live under
`data/` and are required for the app to function. Each built layer's size is in
`data/layers/manifest.json` (`make data-manifest`), each line geometry file's in
`data/analysis/index.json`.

The OSM source PBFs are not listed — they are re-downloaded from Geofabrik on
demand and never committed.

---

## App data — files loaded by the map at runtime

These live under `data/layers/` and must be present for the app to function.
`odin_outages.json`, `wildfire_live.geojson.gz` and `nws_alerts.geojson.gz` are
**live-feed artifacts** refreshed by cron onto the `data` branch rather than
built by `make tiles`; they're listed here because they still ship as app data.

| File | Description |
|---|---|
| `data/layers/osm_transmission_lines.pmtiles` | OSM transmission lines, world (PMTiles, zoom 2–12) — see [hosting-plan.md](hosting-plan.md). |
| `data/layers/railroads.pmtiles` | BTS/FRA North American rail network lines (PMTiles) |
| `data/layers/crithab.pmtiles` | USFWS ESA critical habitat polygons (PMTiles) |
| `data/layers/padus.pmtiles` | USGS PAD-US protected & managed lands (PMTiles) |
| `data/layers/usfs_wildfire_potential.pmtiles` | USFS wildfire hazard potential raster (PMTiles, baked color) |
| `data/layers/us_zcta.pmtiles` | Census ZIP Code Tabulation Areas, (PMTiles, zoom 4–11) |
| `data/layers/hifld_transmission_lines.pmtiles` | HIFLD transmission lines (PMTiles, zoom 2–11) |
| `data/layers/osm_pipelines_lines.pmtiles` | OSM pipeline routes (PMTiles, zoom 3–12) |
| `data/layers/worldpop_pop_density_lut.i16.gz` | Coarse Int16 people/km² value grid for the legend hover readout (lazy-loaded, gzipped — fetched whole, no range path) |
| `data/layers/osm_generators.pmtiles` | OSM generators, world (PMTiles, zoom 7–13) |
| `data/layers/hifld_natgas_lines.pmtiles` | HIFLD natural gas pipeline lines (PMTiles) |
| `data/layers/retail_territories.pmtiles` | HIFLD retail electric territories (PMTiles, zoom 2–10) |
| `data/layers/wildfire_live.geojson.gz` | Live wildfire hotspots, perimeters, incidents and smoke — live feed (cron-refreshed) |
| `data/layers/worldpop_pop_density.pmtiles` | WorldPop population density, log-scale (raster PMTiles) — CC BY 4.0 |
| `data/layers/gsa_solar_pvout.pmtiles` | Global Solar Atlas PVOUT, kWh/kWp/day (raster PMTiles, WEBP, zoom 2–7) — CC BY 4.0 |
| `data/layers/nws_zones.pmtiles` | NWS forecast zones, shared join infra for zone-based alerts (PMTiles) |
| `data/layers/osm_substations_polygons.pmtiles` | OSM substation polygon footprints (PMTiles) |
| `data/layers/tribal_lands.geojson.gz` | Census TIGER AIANNH tribal lands |
| `data/layers/admin1_boundaries.geojson.gz` | geoBoundaries CGAZ states/provinces worldwide, 3,224 units (DP 0.01°) |
| `data/layers/countries.geojson.gz` | geoBoundaries CGAZ country outlines (DP 0.005°) — CC BY 4.0 |
| `data/layers/nlr_wind_100m.pmtiles` | NREL/NLR WIND Toolkit mean wind speed @ 100 m (raster PMTiles, WEBP, zoom 1–6) |
| `data/layers/osm_plants_polygons.pmtiles` | OSM power plant polygon footprints (PMTiles, zoom 5–12) |
| `data/layers/county_boundaries.pmtiles` | Census county boundaries — paints the Census Counties layer and is the shared join target for ODIN outages and NWS county alerts (PMTiles, zoom 2–8) |
| `data/layers/bia_tribal_lands.geojson.gz` | BIA AIAN-LAR tribal lands |
| `data/layers/osm_substations_points.pmtiles` | OSM substation points, world (PMTiles, zoom 4–13) |
| `data/layers/gsa_solar_pvout_lut.i16.gz` | Coarse Int16 kWh/kWp/day value grid for the legend hover readout (lazy-loaded) |
| `data/layers/nlr_wind_100m_lut.i16.gz` | Coarse Int16 m/s value grid for the legend hover readout (lazy-loaded) |
| `data/layers/usgs_seismic_pga_lut.i16.gz` | Coarse Int16 PGA (g) value grid for the legend hover readout (lazy-loaded) |
| `data/layers/hifld_substations.geojson.gz` | HIFLD substation points |
| `data/layers/ogf_planned_transmission.geojson.gz` | Our Grid Future planned transmission projects |
| `data/layers/eia_generators.geojson.gz` | EIA Form 860 generator units |
| `data/layers/eia_ba.geojson.gz` | EIA balancing authority territories |
| `data/layers/osm_plants_points.geojson.gz` | OSM power plant centroids |
| `data/layers/control_areas.geojson.gz` | HIFLD control areas (balancing authorities) |
| `data/layers/ihfc_geo_heatflow.pmtiles` | IHFC heat flow, mW/m² (raster PMTiles, WEBP, zoom 2–7) — CC BY 4.0 |
| `data/layers/wecc_path_lines.geojson.gz` | WECC path digitized corridor lines |
| `data/layers/nerc_regions.geojson.gz` | HIFLD NERC regions |
| `data/layers/us_states.geojson.gz` | Census state boundaries (DP 0.005°) |
| `data/layers/admin_lines.geojson.gz` | Natural Earth country/state border lines — white highlights over the weather wash, no standalone layer |
| `data/layers/odin_outages.json` | ORNL ODIN live county outage counts — no geometry, live feed (cron-refreshed) |
| `data/layers/westtec_10yr.geojson.gz` | WestTEC 10-Year Horizon planned transmission |
| `data/layers/hifld_natgas_points.geojson.gz` | HIFLD natural gas & petroleum facility points |
| `data/layers/mines.geojson.gz` | MSHA large mines, peak employment ≥ 50 (gzipped GeoJSON) |
| `data/layers/ihfc_geo_heatflow_lut.i16.gz` | Coarse Int16 mW/m² value grid for the legend hover readout (lazy-loaded) |
| `data/layers/osm_datacenters.geojson.gz` | OSM data center facilities |
| `data/layers/boem_wind_leases.geojson.gz` | BOEM offshore wind lease polygons (gzipped GeoJSON) |
| `data/layers/osm_pipelines_points.geojson.gz` | OSM pipeline feature points (valves, etc.) |
| `data/layers/nrel_hydrothermal_points.geojson.gz` | NREL/DOE low-temp hydrothermal systems (circle points, gzipped GeoJSON) |
| `data/layers/usgs_seismic_pga.pmtiles` | USGS seismic hazard PGA, 2% in 50yr (raster PMTiles) |
| `data/layers/eia_crude_pipelines.geojson.gz` | EIA crude-oil pipelines |
| `data/layers/eia_product_pipelines.geojson.gz` | EIA petroleum-product pipelines |
| `data/layers/nws_alerts.geojson.gz` | NWS active weather alerts — live feed (cron-refreshed) |
| `data/layers/wecc_paths.geojson.gz` | WECC path point markers |
| `data/layers/nlr_wind_100m_lut.json` | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/usgs_seismic_pga_lut.json` | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/worldpop_pop_density_lut.json` | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/gsa_solar_pvout_lut.json` | Lookup-grid metadata (dims, bbox, scale) |
| `data/layers/ihfc_geo_heatflow_lut.json` | Lookup-grid metadata (dims, bbox, scale) |

---

## Line geometry files

Built by `make line-parquet` into `data/analysis/` for the line tools (copy, fault
locator, elevation profile); see [pipeline.md](pipeline.md) § *Line geometry*. They are
published to `data.wpptx.org` by `make publish-r2`.

| File | Description |
|---|---|
| `data/analysis/index.json` | Every dataset's manifest: bytes, sha256, footer length, rows, `build_id` |
| `data/analysis/osm_transmission_lines/*.geo.p{0..5}.*.parquet` | OSM world lines, `fid` + `bbox` + WKB geometry on the 1e-6° grid, Hilbert order |
| `data/analysis/osm_transmission_lines/*.idx.*.parquet` | `fid` → GEO `row`, `length_km`, `chain`, `circuits` |
| `data/analysis/osm_transmission_lines/*.chains.*.parquet` | Ways in chain order with the end substations |
| `data/analysis/hifld_transmission_lines/*.geo.p0.*.parquet` | HIFLD lines, same layout |
| `data/analysis/hifld_transmission_lines/*.idx.*.parquet` | `fid` (publisher `ID`) → GEO `row`, `length_km` |

---

## User download packs — offered as downloads from the app UI

These live under `data/releases/`, served as download links in the layer panel
(`downloads` in the registry → `assets/download-packs.ts` → the row's Download menu). In prod they are
served from `data.wpptx.org/data/releases/<name>.zip`, uploaded by
`make publish-r2`. See [hosting-plan.md](hosting-plan.md). `build_releases.py` builds them
from `scripts/release_manifest.yaml`.

**Packs stay per continent.** The map reads one planet-wide tileset per layer, but
a download is a file someone opens in QGIS, so OSM-derived packs keep the
continental split — one per code (`na eu as sa af oc ca an`). Layers marked
`continental: true` in `release_manifest.yaml` take a `{code}` placeholder, and
**every format that layer offers is built for every continent**: the SHP pack lands
as `<layer-id>-<code>-shp.zip`, the code ahead of the format suffix.
`assets/download-packs.ts` inserts it.

**Convention (one pack per map layer, format-named):** every download link maps
to exactly one map layer — packs never bundle two layers together. The download
dropdown is labeled by the *format*, not "ZIP". Geometry determines what ships:

| Geometry | Menu option(s) | ZIP(s) | Contents |
|---|---|---|---|
| point | **CSV** | `<pack-id>.zip` | `<name>.csv` (lat/lon + attributes; no GeoJSON) |
| line / polygon | **GeoJSON**, **SHP** | `<pack-id>.zip`, `<pack-id>-shp.zip` | GeoJSON zip: `<name>.geojson` + `<name>.csv`; SHP zip: `.shp/.shx/.dbf/.prj/.cpg` + `<name>.csv` |
| raster | **GeoTIFF** | `<pack-id>.zip` | `<layer-id>.tif` (COG) |

`<pack-id>` is the layer id, or `<layer-id>-<code>` for a continental layer.

Every ZIP also bundles the layer doc (`<layer-id>.txt`, via pandoc) and
`disclaimer.txt`. The attribute-only CSV rides inside *both* the GeoJSON and SHP
zips so users can preview the tabular data without downloading geometry.
Nothing in `data/releases/` is built without a download link pointing at it: a
continental layer produces only its eight coded packs, never an extra worldwide one.

| Layer | Geometry | Pack(s) in `data/releases/` |
|---|---|---|
| `hifld-transmission-lines` | line | `.zip` + `-shp.zip` |
| `hifld-substations` | point | `.zip` (CSV) |
| `osm-transmission-lines` | line | `-<code>.zip` + `-<code>-shp.zip` (×8 continents) |
| `osm-substations-points` | point | `-<code>.zip` (CSV, ×8 continents) |
| `osm-substations-polygons` | polygon | `-<code>.zip` + `-<code>-shp.zip` (×8 continents) |
| `wecc-paths` | vector (1 pack, points + highlight lines) | `.zip` (GeoJSON only — mixed geometry; SHP deferred) |
| `eia-generators` | point | `.zip` (CSV) |
| `osm-generators` | point | `-<code>.zip` (CSV, ×8 continents) |
| `osm-plants-points` | point | `-<code>.zip` (CSV, ×8 continents) |
| `osm-plants-polygons` | polygon | `-<code>.zip` + `-<code>-shp.zip` (×8 continents) |
| `hifld-natgas-lines` | line | `.zip` + `-shp.zip` |
| `hifld-natgas-points` | point | `.zip` (CSV) |
| `osm-pipelines-lines` | line | `-<code>.zip` + `-<code>-shp.zip` (×8 continents) |
| `osm-pipelines-points` | point | `-<code>.zip` (CSV, ×8 continents) |
| `nlr-wind-100m` | raster | `.zip` — COG GeoTIFF, real m/s (EPSG:4326, Float32) |
| `ihfc-geo-heatflow` | raster | `.zip` — COG GeoTIFF, real mW/m² (0.5°) — CC BY 4.0 |
| `nrel-hydrothermal-points` | point | `.zip` (CSV) |
| `nerc-regions` | polygon | `.zip` + `-shp.zip` |
| `control-areas` | polygon | `.zip` + `-shp.zip` |
| `retail-territories` | polygon | `.zip` + `-shp.zip` |
| `osm-datacenters` | point | `-<code>.zip` (CSV, ×8 continents) |
| `worldpop-pop-density` | raster | `.zip` — COG GeoTIFF |

Layers with no pack show no download button at all; their source link lives in
the Data Credits panel, reached from the info button. `tribal-lands` (Census),
`railroads` (BTS) and `gsa-solar-pvout` (energydata.info) work this way, as do
the five administrative-boundary layers (Countries, States / Provinces, Census
States, Census Counties, Census ZIP Codes) — every one of those is directly
downloadable from Census or geoBoundaries, so mirroring it adds nothing — plus
the `skip: true` layers below.

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

The SeerAI parquet is the source `extract_hifld_lines.py` reads.
Preserved here so the exact data vintage used for this build can be reproduced without
re-downloading from source.coop (which requires authentication).

| File | Size | Source | Downloaded |
|---|--:|---|---|
| `data/raw/hifld/transmission_lines.parquet` | 42 MB | [source.coop/seerai/hifld](https://source.coop/repositories/seerai/hifld/description/) — CC BY 4.0 | 2026-05-28 |
| **Total** | **~42 MB** | | |

**Attribution required:** SeerAI (seerai.space) / Source Cooperative, CC BY 4.0.
**Notes:**
- VAL_DATE column is corrupted int32 — null-coerced in `extract_hifld_lines.py`
- SUB_1/SUB_2 substation names are noisier than the original HIFLD export

### Administrative boundaries (Census cartographic + geoBoundaries CGAZ)

Both sets auto-download on first run of their extract script and are skipped on
re-run if already present. Neither needs preserving to reproduce a build — the
URLs are stable and public — but the sizes are worth knowing before a cold run.

| File | Size | Source | Downloaded |
|---|--:|---|---|
| `data/raw/census_boundaries/cb_2025_us_state_500k.zip` | 3.1 MB | [Census cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html), GENZ2025 | 2026-08-25 |
| `data/raw/census_boundaries/cb_2020_us_zcta520_500k.zip` | 64 MB | Census cartographic boundary files, GENZ2020 — the last vintage to ship ZCTAs | 2026-08-25 |
| `data/raw/geoboundaries/geoBoundariesCGAZ_ADM0.zip` | 99 MB | [geoBoundaries CGAZ](https://www.geoboundaries.org/) ADM0 — CC BY 4.0 | 2026-08-25 |
| `data/raw/geoboundaries/geoBoundariesCGAZ_ADM1.zip` | 99 MB | geoBoundaries CGAZ ADM1 — CC BY 4.0 | 2026-08-25 |
| `data/raw/boundaries/cb_2025_us_county_500k.zip` | 12 MB | Census cartographic boundary files, GENZ2025 — shared county tileset | 2026-10-11 |
| **Total** | **~277 MB** | | |

The shapefile `.zip` is used for CGAZ rather than the published `.geojson`,
which is 401 MB for ADM0 and 360 MB for ADM1 — GDAL reads the same geometry out
of the zip at a quarter of the transfer.

**Attribution required:** geoBoundaries (William & Mary geoLab), CC BY 4.0. The
Census files are public domain (17 U.S.C. § 105).

### EIA (Form 860, 2025 final edition)

Only two workbooks from the EIA-860 ZIP are read by `extract_eia_generators.py`.
The full ZIP is included for completeness; the two extracted workbooks are listed
separately so they can be restored without re-downloading the whole archive.
(Sizes below are approximate — files shift between vintages.)

| File | Size | Notes |
|---|--:|---|
| `data/raw/eia/2___Plant_Y2025.xlsx` | ~4 MB | **Used by script** — plant locations and metadata |
| `data/raw/eia/3_1_Generator_Y2025.xlsx` | ~11 MB | **Used by script** — generator units (operable / proposed / retired sheets) |
| `data/raw/eia/eia8602025.zip` | ~24 MB | Full EIA-860 archive (source of the two files above) |
| **Total (deduplicated)** | **~37 MB** | (zip + two extracted workbooks) |

