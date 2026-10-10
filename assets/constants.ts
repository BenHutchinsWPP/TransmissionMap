// assets/constants.ts — Static constants shared across modules; imports nothing.
// Holds: where data lives (DATA, releaseUrl, weatherLiveUrl, RELEASES_ORIGIN),
// the external hosts more than one module
// reads (basemap/terrain/radar/glyph URLs that diagnostics.ts also probes),
// EMPTY_FC and the county join keys (COUNTY_SRC*).
// A constant with one owner lives in that owner instead: MW_SLIDER_MAX in
// filters.ts, the default viewport in map.ts, BLANK_STYLE + fog/atmosphere tuning and the USGS topo/hydro URLs
// in basemap.ts, terrain exaggeration and credit in terrain.ts.
// Which registry layer reads which DATA file, and its map credit, is the layer's
// own LayerDef.data (resolved by layers/layer-source.ts).

// ─── Data URLs ────────────────────────────────────────────────────────────────
// GeoJSON layers are hosted pre-gzipped (.geojson.gz) and decompressed in the
// browser via DecompressionStream (see ensureLayerData). PMTiles handle their
// own compression and range-loading.
// >>> ADD-LAYER: data-urls — see docs/adding-a-layer.md §4
//
// Prod data host: built layers + release ZIPs live on the orphan `data-static`
// branch, served through raw.githubusercontent.com, NOT on Pages (dist ships no
// data/). Raw answers ranged GETs with HTTP 206 and `access-control-allow-origin:
// *`, which is what PMTiles needs, and caps responses at `max-age=300`. Its one
// hard constraint is git's: no file over 100 MiB. Dev serves them from the local
// working tree at the Vite root. Publish with `make publish-data` (see
// scripts/publish_data.sh and docs/hosting-plan.md).
// The live feeds (wildfire, NWS alerts, ODIN outages, weather) sit on the
// churning `data` branch (force-pushed hourly) behind LIVE_ORIGIN instead, so
// they must NOT use DATA_ORIGIN. In dev both are "" — every file, live or
// static, is read from the local data/layers/ (run the fetch script first).
// Paths stay double-quoted data/layers/… string literals after the origin:
// scripts/validate_build.py scrapes them to decide what to check and publish,
// and assets/constants.test.ts fails when a DATA path is not one.
const RAW_REPO = "https://raw.githubusercontent.com/BenHutchinsWPP/TransmissionMap/";
const DATA_ORIGIN = import.meta.env.PROD ? RAW_REPO + "data-static/" : "";
const LIVE_ORIGIN = import.meta.env.PROD ? RAW_REPO + "data/" : "";
// Data center moratoriums keep their own orphan branch, appended to and never
// force-pushed, so its commit history is the record of how they changed. Dev
// reads the local working copy of that branch. Not a data/layers/ path, so
// validate_build.py and publish_data.sh leave it alone.
const MORATORIUM_ORIGIN = import.meta.env.PROD ? RAW_REPO + "data-moratoriums/" : "_private/moratoriums/dataset/";

// Download packs are plain navigations, never fetch() or PMTiles range reads, so
// they need no CORS header — which frees them from the branch and its 100 MiB
// per-file ceiling. Release assets allow 2 GB per file and live outside the git
// object store, so publishing one never grows the repo. The tag rolls in place
// (`gh release upload --clobber`) to keep these URLs stable, because they are
// baked into the deployed bundle. See docs/hosting-plan.md.
export const RELEASES_ORIGIN = import.meta.env.PROD
  ? "https://github.com/BenHutchinsWPP/TransmissionMap/releases/download/data-latest/"
  : "";

// Registry entries name packs by repo-relative path. In prod that maps to a flat
// Release asset name; in dev it stays a path the Vite server serves from disk.
export function releaseUrl(path: string): string {
  return import.meta.env.PROD ? RELEASES_ORIGIN + path.replace(/^data\/releases\//, "") : path;
}
export const DATA = {
  // Transmission ships as six planet-wide archives split by voltage class: one
  // world file is 266 MiB against the host's 100 MiB per-file ceiling. The order
  // is load-bearing — MapLibre paints sources in the order their style layers are
  // added, so ascending kV puts EHV on top. `nominal_kv = -1` encodes unknown, so
  // it sorts into `kv0` for free. See docs/hosting-plan.md.
  osm_transmission_lines_kv0:   DATA_ORIGIN + "data/layers/osm_transmission_lines_kv0.pmtiles",
  osm_transmission_lines_kv50:  DATA_ORIGIN + "data/layers/osm_transmission_lines_kv50.pmtiles",
  osm_transmission_lines_kv100: DATA_ORIGIN + "data/layers/osm_transmission_lines_kv100.pmtiles",
  osm_transmission_lines_kv125: DATA_ORIGIN + "data/layers/osm_transmission_lines_kv125.pmtiles",
  osm_transmission_lines_kv200: DATA_ORIGIN + "data/layers/osm_transmission_lines_kv200.pmtiles",
  osm_transmission_lines_kv300: DATA_ORIGIN + "data/layers/osm_transmission_lines_kv300.pmtiles",
  hifld_transmission_lines: DATA_ORIGIN + "data/layers/hifld_transmission_lines.pmtiles",
  ogf_planned_transmission: DATA_ORIGIN + "data/layers/ogf_planned_transmission.geojson.gz",
  osm_substations_points:   DATA_ORIGIN + "data/layers/osm_substations_points.pmtiles",
  hifld_substations:        DATA_ORIGIN + "data/layers/hifld_substations.geojson.gz",
  osm_substations_polygons: DATA_ORIGIN + "data/layers/osm_substations_polygons.pmtiles",
  osm_plants_points:   DATA_ORIGIN + "data/layers/osm_plants_points.geojson.gz",   // power=plant — always loaded
  osm_plants_polygons: DATA_ORIGIN + "data/layers/osm_plants_polygons.pmtiles",   // plant polygon hulls
  osm_generators:      DATA_ORIGIN + "data/layers/osm_generators.pmtiles",         // power=generator — tiles at z7+
  eia_generators:      DATA_ORIGIN + "data/layers/eia_generators.geojson.gz",
  osm_pipelines_lines:  DATA_ORIGIN + "data/layers/osm_pipelines_lines.pmtiles",
  osm_pipelines_points: DATA_ORIGIN + "data/layers/osm_pipelines_points.geojson.gz",
  hifld_natgas_lines:   DATA_ORIGIN + "data/layers/hifld_natgas_lines.pmtiles",
  hifld_natgas_points:  DATA_ORIGIN + "data/layers/hifld_natgas_points.geojson.gz",
  eia_crude_pipelines:   DATA_ORIGIN + "data/layers/eia_crude_pipelines.geojson.gz",   // EIA crude-oil pipelines
  eia_product_pipelines: DATA_ORIGIN + "data/layers/eia_product_pipelines.geojson.gz", // EIA petroleum-product pipelines
  railroads:            DATA_ORIGIN + "data/layers/railroads.pmtiles",  // BTS NARN rail network lines
  padus:          DATA_ORIGIN + "data/layers/padus.pmtiles",          // USGS PAD-US: GAP 1-3 conservation + GAP 4 federal (DoD/DOE/USACE)
  tribal_lands:   DATA_ORIGIN + "data/layers/tribal_lands.geojson.gz", // Census TIGER Tribal (AIANNH) — lazy GeoJSON (copyable features)
  bia_tribal_lands: DATA_ORIGIN + "data/layers/bia_tribal_lands.geojson.gz", // BIA AIAN-LAR Tribal Lands — lazy GeoJSON (copyable features)
  crithab:        DATA_ORIGIN + "data/layers/crithab.pmtiles",         // USFWS Critical Habitat (T&E species)
  mines:          DATA_ORIGIN + "data/layers/mines.geojson.gz",        // MSHA large mines (filtered) — lazy GeoJSON
  wecc_paths:         DATA_ORIGIN + "data/layers/wecc_paths.geojson.gz",   // WECC Path Rating Catalog 2026 (points + ratings + line lists)
  wecc_path_lines:    DATA_ORIGIN + "data/layers/wecc_path_lines.geojson.gz", // OSM/HIFLD lines matched to each WECC path (click-highlight)
  nerc_regions:       DATA_ORIGIN + "data/layers/nerc_regions.geojson.gz",
  control_areas:      DATA_ORIGIN + "data/layers/control_areas.geojson.gz",
  eia_ba:             DATA_ORIGIN + "data/layers/eia_ba.geojson.gz",
  retail_territories: DATA_ORIGIN + "data/layers/retail_territories.pmtiles",
  countries:          DATA_ORIGIN + "data/layers/countries.geojson.gz",          // geoBoundaries CGAZ country outlines
  admin1_boundaries:  DATA_ORIGIN + "data/layers/admin1_boundaries.geojson.gz",  // geoBoundaries CGAZ state/province outlines
  us_states:          DATA_ORIGIN + "data/layers/us_states.geojson.gz",       // Census cartographic state boundaries
  us_zcta:            DATA_ORIGIN + "data/layers/us_zcta.pmtiles",            // Census cartographic ZCTA boundaries
  nlr_wind_100m:          DATA_ORIGIN + "data/layers/nlr_wind_100m.pmtiles",          // NREL/NLR WIND Toolkit raster (baked color)
  nlr_wind_100m_lut:      DATA_ORIGIN + "data/layers/nlr_wind_100m_lut.i16.gz",          // Int16 m/s*100 grid for hover readout
  nlr_wind_100m_lut_meta: DATA_ORIGIN + "data/layers/nlr_wind_100m_lut.json",         // grid dims + bbox + scale
  gsa_solar_pvout:          DATA_ORIGIN + "data/layers/gsa_solar_pvout.pmtiles",      // Global Solar Atlas PVOUT raster (baked color)
  gsa_solar_pvout_lut:      DATA_ORIGIN + "data/layers/gsa_solar_pvout_lut.i16.gz",      // Int16 kWh/kWp/day*100 grid for hover readout
  gsa_solar_pvout_lut_meta: DATA_ORIGIN + "data/layers/gsa_solar_pvout_lut.json",     // grid dims + bbox + scale
  ihfc_geo_heatflow:          DATA_ORIGIN + "data/layers/ihfc_geo_heatflow.pmtiles",  // IHFC heat flow raster (baked color)
  ihfc_geo_heatflow_lut:      DATA_ORIGIN + "data/layers/ihfc_geo_heatflow_lut.i16.gz",  // Int16 mW/m²*10 grid for hover readout
  ihfc_geo_heatflow_lut_meta: DATA_ORIGIN + "data/layers/ihfc_geo_heatflow_lut.json", // grid dims + bbox + scale
  nrel_hydrothermal_points:  DATA_ORIGIN + "data/layers/nrel_hydrothermal_points.geojson.gz", // NREL/DOE low-temp hydrothermal systems
  osm_datacenters:        DATA_ORIGIN + "data/layers/osm_datacenters.geojson.gz",            // telecom=data_center — lazy-loaded GeoJSON
  worldpop_pop_density:          DATA_ORIGIN + "data/layers/worldpop_pop_density.pmtiles",   // WorldPop 2020 population density (baked log-color)
  worldpop_pop_density_lut:      DATA_ORIGIN + "data/layers/worldpop_pop_density_lut.i16.gz",   // Int16 ppl/km² grid for hover readout
  worldpop_pop_density_lut_meta: DATA_ORIGIN + "data/layers/worldpop_pop_density_lut.json",  // grid dims + bbox + scale
  usfs_wildfire_potential: DATA_ORIGIN + "data/layers/usfs_wildfire_potential.pmtiles",  // USFS Wildfire Hazard Potential 2023 (classified, baked discrete color)
  usgs_seismic_pga:          DATA_ORIGIN + "data/layers/usgs_seismic_pga.pmtiles",  // USGS NSHM PGA 2% in 50yr raster (baked color)
  usgs_seismic_pga_lut:      DATA_ORIGIN + "data/layers/usgs_seismic_pga_lut.i16.gz",  // Int16 PGA(g)*1000 grid for hover readout
  usgs_seismic_pga_lut_meta: DATA_ORIGIN + "data/layers/usgs_seismic_pga_lut.json", // grid dims + bbox + scale
  boem_wind_leases:          DATA_ORIGIN + "data/layers/boem_wind_leases.geojson.gz",
  westtec_10yr:              DATA_ORIGIN + "data/layers/westtec_10yr.geojson.gz",
  // Dev: run `make wildfire-dev` first. Prod: `data` branch (~5 min CDN lag).
  // Contains: hotspots (_type=hotspot), perimeters, named incidents, and smoke polygons.
  wildfire_live: LIVE_ORIGIN + "data/layers/wildfire_live.geojson.gz",
  // Dev: run `make nws-alerts-dev` first. Prod: `data` branch.
  nws_alerts: LIVE_ORIGIN + "data/layers/nws_alerts.geojson",
  county_boundaries: DATA_ORIGIN + "data/layers/county_boundaries.pmtiles", // Census TIGER county polygons — shared join infra, no standalone layer/legend
  admin_lines: DATA_ORIGIN + "data/layers/admin_lines.geojson.gz", // Natural Earth country/state border lines — white highlights over the weather wash, no standalone layer/legend
  nws_zones: DATA_ORIGIN + "data/layers/nws_zones.pmtiles", // NWS public forecast + fire weather zone polygons — shared join infra, no standalone layer/legend
  // FEMA National Risk Index — geometry-less FIPS → [score, rating]×hazard table
  // (scripts/extract_fema_nri.py), joined onto county_boundaries via feature-state (see fema-nri.ts).
  fema_nri: DATA_ORIGIN + "data/layers/fema_nri.json",
  // Dev: run scripts/fetch_odin_outages.py first. Prod: `data` branch.
  // FIPS→[customers_out,incident_count] snapshot joined onto county_boundaries
  // via MapLibre feature-state (see odin-outages.ts).
  odin_outages: LIVE_ORIGIN + "data/layers/odin_outages.json",
  // One feature per jurisdiction: state/county polygons, points for the rest
  // (built from moratoriums.csv + events.csv on the data-moratoriums branch).
  dc_moratoriums: MORATORIUM_ORIGIN + "dc_moratoriums.geojson",
  // Per-layer provenance (licence, row counts, artifact size, per-field
  // coverage, retrieval date) the Data Credits page renders from, grouped
  // under each source's own LAYER_SOURCES label — the manifest's own
  // `source` field isn't rendered. Built by scripts/build_data_manifest.py.
  data_manifest: DATA_ORIGIN + "data/layers/manifest.json",
};

// Live GFS weather mosaic (temperature, wind, humidity, dew point, cloud,
// pressure), rebuilt every ~3h by scripts/fetch_weather_live.py. Dev: run that
// script first. Prod: `data` branch. Per variable: a baked-color WEBP
// (EPSG:3857 image source) and an Int16 hover LUT (EPSG:4326 grid); one
// shared meta.json carries run_utc/valid_utc/generated_utc/feed_status plus
// per-variable {width, height, bbox, scale, nodata, units}.
// `file` is e.g. "temp.webp", "temp.i16.gz", or "meta.json".
export function weatherLiveUrl(file: string): string {
  return LIVE_ORIGIN + `data/layers/weather_live/${file}`;
}

// Shared by the weather A/B layer pair (map-layers-conditions.ts) and the
// crossfade in weather-live.ts — the fade's target must equal the wash opacity.
export const WEATHER_WASH_OPACITY = 0.65;

// ─── Basemap tile sources ─────────────────────────────────────────────────────
// Read by basemap.ts and probed by diagnostics.ts.
export const OSM_TILE_URL    = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const ESRI_TOKEN = import.meta.env.VITE_ESRI_API_KEY;  // basemap tiles + geocoder (ui-geocoder.ts)
export const AERIAL_TILE_URL = ESRI_TOKEN
  ? `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${ESRI_TOKEN}`
  : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
// Keyless NAIP imagery. Serves aerial below AERIAL_SEAM_ZOOM, and all zooms if
// the Esri key fails. Cache stops at z16 (z17+ 404s), so its source must declare
// maxzoom 16.
export const USGS_AERIAL_TILE_URL =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";
// OpenFreeMap vector basemaps (keyless, unlimited, commercial-OK). The style
// JSONs are fetched at runtime and their sources/layers merged under the app's
// overlay layers — see addOfmBasemaps() in basemap.ts. "light" (Positron) doubles
// as the ground under the hydro overlay.
export const OFM_STYLE_URLS = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark:  "https://tiles.openfreemap.org/styles/dark",
} as const;

// ─── 3D terrain (optional) ────────────────────────────────────────────────────
// AWS Open Data "Terrain Tiles" (Terrarium-encoded raster-dem), CC-BY 4.0,
// keyless, not requester-pays. Mosaic is a static snapshot (~2017; SRTM/USGS
// 3DEP/GMTED2010/ETOPO1) — elevations don't change, so no refresh is needed.
// Tile pyramid tops out at z15; MapLibre overzooms above that. Read by
// terrain.ts and probed by diagnostics.ts.
export const TERRAIN_TILE_URL = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";

// ─── Live layer tile sources ──────────────────────────────────────────────────
// IEM NEXRAD composite reflectivity (USCOMP N0Q) — nexrad-radar layer.
// {layer} is an IEM layer name: "ridge::USCOMP-N0Q-0" is the latest-frame alias,
// but IEM resolves it per tile so adjacent tiles can mix scans during rollover;
// RADAR_TMS_JSON_URL names the current frame (ridge::USCOMP-N0Q-YYYYMMDDHHMM),
// which is consistent across all tiles.
export const RADAR_TILE_TEMPLATE = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/{layer}/{z}/{x}/{y}.png";
export const RADAR_TILE_URL      = RADAR_TILE_TEMPLATE.replace("{layer}", "ridge::USCOMP-N0Q-0");
export const RADAR_TMS_JSON_URL  = "https://mesonet.agron.iastate.edu/json/tms.json";
// ECCC GeoMet WMS radar (Canada) — drawn under the IEM layer in the same
// nexrad-radar row. GeoMet rejects multi-layer GetMap, so rain (RADAR_1KM_RRAI)
// and snow (RADAR_1KM_RSNO) are separate sources. Omitting TIME returns the
// latest frame; {bust} is an ignored extra param swapped on each IEM frame
// change so MapLibre refetches the Canadian tiles on the same cadence.
export const GEOMET_RADAR_TILE_TEMPLATE =
  "https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={layer}&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true&_={bust}";

// OpenFreeMap glyphs (same host as the basemap styles). Serves Noto Sans
// Regular/Bold/Italic ONLY, as single-font stacks — comma-joined stacks and
// other families 404, so every text-font in the app must be a one-element
// Noto Sans array. Named by basemap.ts's BLANK_STYLE; probed by diagnostics.ts.
export const GLYPHS_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

// Shared empty GeoJSON placeholder — used by lazy GeoJSON sources (layers/*.ts)
// and the search-highlight sources (highlights.ts).
export const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as GeoJSON.Feature[] };

// US county boundaries source, shared by the feature-state joins (ODIN, NRI, NWS).
// Kept here, in a module that imports nothing, so every county-joined module reads
// it straight from the source of truth (odin-outages, fema-nri, nws-zone-join, the
// admin and conditions builders, layer-init's countyBoundariesSource).
export const COUNTY_SRC = "county_boundaries";
export const COUNTY_SRC_LAYER = "county_boundaries";   // tippecanoe names the layer after the manifest id
