// assets/constants.ts — Static, non-mutable app-wide constants.

// ─── User-layer palette + threshold ──────────────────────────────────────────
export const USER_LAYER_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#16a085',
];
export const USER_FEATURE_THRESHOLD = 20;

// ─── Data URLs ────────────────────────────────────────────────────────────────
// GeoJSON layers are hosted pre-gzipped (.geojson.gz) and decompressed in the
// browser via DecompressionStream (see ensureLayerData). PMTiles handle their
// own compression and range-loading.
// >>> ADD-LAYER: data-urls — see docs/adding-a-layer.md §4
//
// Prod data host: built layers + release ZIPs live on the orphan `data-static`
// branch (raw GitHub — CORS ok on public repos), NOT on Pages (dist ships no
// data/). Dev serves them from the local working tree at the Vite root. Wildfire
// keeps its own URL on the churning `data` branch (force-pushed hourly), so it
// must NOT share this branch — see `wildfire_live` below and `make publish-data`.
export const DATA_ORIGIN = import.meta.env.PROD
  ? "https://raw.githubusercontent.com/BenHutchinsWPP/TransmissionMap/data-static/"
  : "";
export const DATA = {
  osm_transmission_lines:   DATA_ORIGIN + "data/layers/osm_transmission_lines.pmtiles",
  hifld_transmission_lines: DATA_ORIGIN + "data/layers/hifld_transmission_lines.pmtiles",
  ogf_planned_transmission: DATA_ORIGIN + "data/layers/ogf_planned_transmission.geojson.gz",
  osm_substations_points:   DATA_ORIGIN + "data/layers/osm_substations_points.geojson.gz",
  hifld_substations:        DATA_ORIGIN + "data/layers/hifld_substations.geojson.gz",
  osm_substations_polygons: DATA_ORIGIN + "data/layers/osm_substations_polygons.geojson.gz",
  osm_plants_points:   DATA_ORIGIN + "data/layers/osm_plants_points.geojson.gz",   // power=plant — always loaded
  osm_plants_polygons: DATA_ORIGIN + "data/layers/osm_plants_polygons.geojson.gz", // plant polygon hulls
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
  retail_territories: DATA_ORIGIN + "data/layers/retail_territories.pmtiles",
  nlr_wind_100m:          DATA_ORIGIN + "data/layers/nlr_wind_100m.pmtiles",          // NREL/NLR WIND Toolkit raster (baked color)
  nlr_wind_100m_lut:      DATA_ORIGIN + "data/layers/nlr_wind_100m_lut.i16",          // Int16 m/s*100 grid for hover readout
  nlr_wind_100m_lut_meta: DATA_ORIGIN + "data/layers/nlr_wind_100m_lut.json",         // grid dims + bbox + scale
  gsa_solar_pvout:          DATA_ORIGIN + "data/layers/gsa_solar_pvout.pmtiles",      // Global Solar Atlas PVOUT raster (baked color)
  gsa_solar_pvout_lut:      DATA_ORIGIN + "data/layers/gsa_solar_pvout_lut.i16",      // Int16 kWh/kWp/day*100 grid for hover readout
  gsa_solar_pvout_lut_meta: DATA_ORIGIN + "data/layers/gsa_solar_pvout_lut.json",     // grid dims + bbox + scale
  ihfc_geo_heatflow:          DATA_ORIGIN + "data/layers/ihfc_geo_heatflow.pmtiles",  // IHFC heat flow raster (baked color)
  ihfc_geo_heatflow_lut:      DATA_ORIGIN + "data/layers/ihfc_geo_heatflow_lut.i16",  // Int16 mW/m²*10 grid for hover readout
  ihfc_geo_heatflow_lut_meta: DATA_ORIGIN + "data/layers/ihfc_geo_heatflow_lut.json", // grid dims + bbox + scale
  nrel_hydrothermal_points:  DATA_ORIGIN + "data/layers/nrel_hydrothermal_points.geojson.gz", // NREL/DOE low-temp hydrothermal systems
  osm_datacenters:        DATA_ORIGIN + "data/layers/osm_datacenters.geojson.gz",            // telecom=data_center — lazy-loaded GeoJSON
  worldpop_pop_density:          DATA_ORIGIN + "data/layers/worldpop_pop_density.pmtiles",   // WorldPop 2020 population density (baked log-color)
  worldpop_pop_density_lut:      DATA_ORIGIN + "data/layers/worldpop_pop_density_lut.i16",   // Int16 ppl/km² grid for hover readout
  worldpop_pop_density_lut_meta: DATA_ORIGIN + "data/layers/worldpop_pop_density_lut.json",  // grid dims + bbox + scale
  usfs_wildfire_potential: DATA_ORIGIN + "data/layers/usfs_wildfire_potential.pmtiles",  // USFS Wildfire Hazard Potential 2023 (classified, baked discrete color)
  usgs_seismic_pga:          DATA_ORIGIN + "data/layers/usgs_seismic_pga.pmtiles",  // USGS NSHM PGA 2% in 50yr raster (baked color)
  usgs_seismic_pga_lut:      DATA_ORIGIN + "data/layers/usgs_seismic_pga_lut.i16",  // Int16 PGA(g)*1000 grid for hover readout
  usgs_seismic_pga_lut_meta: DATA_ORIGIN + "data/layers/usgs_seismic_pga_lut.json", // grid dims + bbox + scale
  // Dev: local file (run `make wildfire-dev` first). Prod: orphan `data` branch on raw.githubusercontent.com (CORS ok, ~5min CDN lag).
  // Contains: hotspots (_type=hotspot), perimeters, named incidents, and smoke polygons.
  wildfire_live: import.meta.env.DEV
    ? DATA_ORIGIN + "data/layers/wildfire_live.geojson"
    : "https://raw.githubusercontent.com/BenHutchinsWPP/TransmissionMap/data/data/layers/wildfire_live.geojson",
  // Dev: local file (run `make nws-alerts-dev` first). Prod: orphan `data` branch on raw.githubusercontent.com (CORS ok).
  nws_alerts: import.meta.env.DEV
    ? DATA_ORIGIN + "data/layers/nws_alerts.geojson"
    : "https://raw.githubusercontent.com/BenHutchinsWPP/TransmissionMap/data/data/layers/nws_alerts.geojson",
  county_boundaries: DATA_ORIGIN + "data/layers/county_boundaries.pmtiles", // Census TIGER county polygons — shared join infra, no standalone layer/legend
  // Dev: local file (run scripts/fetch_odin_outages.py first). Prod: `data`
  // branch on raw.githubusercontent.com (CORS ok). FIPS→[customers_out,incident_count]
  // snapshot joined onto county_boundaries via MapLibre feature-state (see odin-outages.ts).
  odin_outages: import.meta.env.DEV
    ? DATA_ORIGIN + "data/layers/odin_outages.json"
    : "https://raw.githubusercontent.com/BenHutchinsWPP/TransmissionMap/data/data/layers/odin_outages.json",
};

// ─── Per-source attribution shorthand ─────────────────────────────────────────
// Short credit strings shown in the MapLibre attribution control. Keyed by the
// runtime sourceId passed to map.addSource (NOT the registry source key).
// MapLibre sorts attributions by length and drops any that are a SUBSTRING of a
// longer one. So OSM-derived layers MUST use a string identical to (a substring
// of) the basemap's OSM attribution — see OSM_ATTRIB below — or "OpenStreetMap"
// would appear twice whenever an OSM/Carto basemap is active. Sources with
// bespoke attribution set inline (wind/solar/geo/worldpop/hazards rasters +
// basemaps) are intentionally omitted here. `&copy;` = ©.
// MUST stay byte-identical to the osm-tiles basemap attribution in map.ts so
// MapLibre's substring-dedup collapses them into one credit.
const OSM_ATTRIB = "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors";
export const SOURCE_ATTRIB: Record<string, string> = {
  "hifld-transmission-lines": '<a href="https://source.coop/repositories/seerai/hifld/description/">HIFLD</a>',
  "hifld-substations":        '<a href="https://source.coop/repositories/seerai/hifld/description/">HIFLD</a>',
  "nerc-regions":             '<a href="https://source.coop/repositories/seerai/hifld/description/">HIFLD</a>',
  "control-areas":            '<a href="https://source.coop/repositories/seerai/hifld/description/">HIFLD</a>',
  "retail-territories":       '<a href="https://source.coop/repositories/seerai/hifld/description/">HIFLD</a>',
  "hifld-natgas-lines":       '<a href="https://source.coop/repositories/seerai/hifld/description/">HIFLD/EIA</a>',
  "hifld-natgas-points":      '<a href="https://source.coop/repositories/seerai/hifld/description/">HIFLD/EIA</a>',
  "eia-crude-pipelines":      '<a href="https://atlas.eia.gov/">EIA U.S. Energy Atlas</a>',
  "eia-product-pipelines":    '<a href="https://atlas.eia.gov/">EIA U.S. Energy Atlas</a>',
  "eia-generators":           '<a href="https://www.eia.gov/electricity/data/eia860/">EIA-860</a>',
  "ogf-planned-transmission": '<a href="https://ourgridfuture.org">Our Grid Future</a>',
  "padus":                    '<a href="https://www.usgs.gov/programs/gap-analysis-project">USGS PAD-US</a>',
  "tribal-lands":             '<a href="https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html">Census TIGER</a>',
  "crithab":                  '<a href="https://ecos.fws.gov/ecp/report/table/critical-habitat.html">USFWS</a>',
  "railroads":                '<a href="https://www.bts.gov/ntad">U.S. DOT BTS</a>',
  "nrel-hydrothermal-points": '<a href="https://gdr.openei.org/submissions/842">NREL/DOE</a>',
  "osm-transmission-lines":   OSM_ATTRIB,
  "osm-substations-points":   OSM_ATTRIB,
  "osm-substations-polygons": OSM_ATTRIB,
  "osm-plants-points":        OSM_ATTRIB,
  "osm-plants-polygons":      OSM_ATTRIB,
  "osm-generators":           OSM_ATTRIB,
  "osm-pipelines-lines":      OSM_ATTRIB,
  "osm-pipelines-points":     OSM_ATTRIB,
  // OSM_ATTRIB prefix stays byte-identical so MapLibre substring-dedup still
  // collapses it with the basemap credit; IM3 rides behind it.
  "osm-datacenters":          OSM_ATTRIB + " · <a href='https://github.com/IMMM-SFA/datacenter-atlas'>IM3 Data Center Atlas (PNNL/DOE)</a>",
};

// ─── Basemap tile sources ─────────────────────────────────────────────────────
export const OSM_TILE_URL    = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const AERIAL_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const CARTO_LIGHT_TILE_URLS   = ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                                  "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                                  "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                                  "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"];
export const CARTO_DARK_TILE_URLS    = ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                                  "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                                  "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                                  "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"];
export const CARTO_VOYAGER_TILE_URLS = ["https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
                                  "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
                                  "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
                                  "https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"];
export const USGS_TOPO_TILE_URL      = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}";
const GLYPHS_URL      = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

// MapLibre requires a style object even when we control all sources ourselves.
export const BLANK_STYLE = { version: 8 as const, glyphs: GLYPHS_URL, sources: {}, layers: [] as [] };

// Shared empty GeoJSON placeholder — used by lazy GeoJSON sources (layer-init.ts)
// and the search-highlight sources (highlights.ts).
export const EMPTY_FC = { type: "FeatureCollection" as const, features: [] as GeoJSON.Feature[] };

// ─── Default map viewport ─────────────────────────────────────────────────────
// Contiguous US overview
export const DEFAULT_CENTER: [number, number] = [-95.7, 37.1];
export const DEFAULT_ZOOM   = 4;
