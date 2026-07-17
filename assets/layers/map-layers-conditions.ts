// ─── Hazard layers ────────────────────────────────────────────────────────────
// Role: MapLibre builders for the conditions group — baked-color raster PMTiles
//       (wildfire hazard potential, seismic PGA), live GeoJSON (smoke, wildfire,
//       incidents), and the live ODIN county-outage choropleth (feature-state
//       data-join onto the shared county_boundaries PMTiles — the FIPS→[out,n]
//       join itself lives in ../odin-outages.ts; this file only builds the source/layers).
// Deps: layer-init.ts (pmtilesUrl, initialVisibility), state (DATA).
//
// All live data shares one source ("wildfire-live") and one GeoJSON file.
// _type field distinguishes: "smoke" | "perimeter" | "hotspot" | "incident"
// Three registry entries control separate layer groups via mapLayerIds:
//   wildfire-smoke     → wildfire-smoke-fill, wildfire-smoke-line
//   wildfire-live      → wildfire-perimeters-fill/line, wildfire-hotspots-heat/circle
//   wildfire-incidents → wildfire-incidents-circle
//
// addNwsAlerts() is a separate live GeoJSON source ("nws-alerts") — NOAA/NWS
// active alert polygons, colored by the server-computed `_group` prop.
// Registry entry: nws-alerts → nws-alerts-fill, nws-alerts-line.
//
// addWeatherLive() is a live baked-color raster IMAGE source ("weather-live") —
// GFS 0.25° weather fields (temperature, wind, etc.) from scripts/fetch_weather_live.py.
// The refresh loop, age chip and hover-LUT reload live in ../weather-live.ts.
// It also adds "weather-admin-lines" (Natural Earth country/state borders,
// scripts/extract_admin_lines.py) — white highlight lines above the wash,
// toggled with the same registry row.
//
// addNexradRadar() is a live external raster tile source ("nexrad-radar") —
// IEM NEXRAD composite reflectivity; no data pipeline. Frame consistency comes
// from polling IEM's tms.json for the current timestamped layer name. Canada
// coverage comes from two ECCC GeoMet WMS raster sources (geomet-radar-rain/
// -snow) added underneath and toggled by the same registry row.

import type { LayerSpecification, ExpressionSpecification, RasterTileSource } from "maplibre-gl";
import {
  state, DATA, EMPTY_FC, RADAR_TILE_TEMPLATE, RADAR_TILE_URL, RADAR_TMS_JSON_URL,
  GEOMET_RADAR_TILE_TEMPLATE, WEATHER_IMAGE_COORDS, TRANSPARENT_PNG,
  WEATHER_WASH_OPACITY,
} from '../state.js';
import { pmtilesUrl, initialVisibility, ensureCountyBoundaries, COUNTY_SRC, COUNTY_SRC_LAYER, addRasterLayer } from './layer-init.js';

// Split into two builders so add-all-layers.ts can slot the polygon half
// (smoke + perimeters) below infra vectors and the point half (hotspots +
// incidents) above them — all area fills under all lines/points.
export function addWildfireLiveAreas() {
  if (!state.map || state.map.getSource("wildfire-live")) return;

  state.map.addSource("wildfire-live", {
    type: "geojson",
    data: EMPTY_FC,
  });

  const smokeVis     = initialVisibility("wildfire-smoke");
  const wildfireVis  = initialVisibility("wildfire-live");

  // ── Smoke layers (bottom — below fire perimeters) ──────────────────────────
  state.map.addLayer({
    id: "wildfire-smoke-fill",
    type: "fill",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "smoke"],
    layout: { visibility: smokeVis },
    paint: {
      "fill-color": [
        "match", ["get", "density"],
        "Light",  "#ffd700",
        "Medium", "#ff8c00",
        "Heavy",  "#8b4513",
        "#aaaaaa",
      ],
      "fill-opacity": [
        "match", ["get", "density"],
        "Light",  0.18,
        "Medium", 0.28,
        "Heavy",  0.38,
        0.2,
      ],
    },
  } as LayerSpecification);

  state.map.addLayer({
    id: "wildfire-smoke-line",
    type: "line",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "smoke"],
    layout: { visibility: smokeVis },
    paint: {
      "line-color": [
        "match", ["get", "density"],
        "Light",  "#c8a000",
        "Medium", "#c86000",
        "Heavy",  "#5a2a00",
        "#888888",
      ],
      "line-width": 1,
      "line-opacity": 0.5,
    },
  } as LayerSpecification);

  // ── Fire perimeter fill — thin so basemap terrain reads through ────────────
  state.map.addLayer({
    id: "wildfire-perimeters-fill",
    type: "fill",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "perimeter"],
    layout: { visibility: wildfireVis },
    paint: {
      "fill-color": "#ff6600",
      "fill-opacity": 0.12,
    },
  } as LayerSpecification);

  // ── Perimeter outline — colored by % contained (red→orange→green) ──────────
  state.map.addLayer({
    id: "wildfire-perimeters-line",
    type: "line",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "perimeter"],
    layout: { visibility: wildfireVis },
    paint: {
      "line-color": [
        "interpolate", ["linear"],
        ["to-number", ["get", "pct_contained"], 0],
        0,   "#cc2200",
        50,  "#ff8800",
        100, "#22aa44",
      ],
      "line-width": 2,
      "line-opacity": 0.9,
    },
  } as LayerSpecification);

}

export function addWildfireLivePoints() {
  if (!state.map || !state.map.getSource("wildfire-live")
      || state.map.getLayer("wildfire-hotspots-heat")) return;

  const wildfireVis  = initialVisibility("wildfire-live");
  const incidentVis  = initialVisibility("wildfire-incidents");

  // The heatmap is a soft area wash at national zoom — slot it below the
  // point block (anchor = bottom-most point layer) so generator/substation
  // dots stay visible over it; the discrete circles below go on top as usual.
  const heatBefore = state.map.getLayer("osm-substations-points-hv")
    ? "osm-substations-points-hv" : undefined;

  // ── Hotspot heatmap — FRP-weighted, shown at low zoom ─────────────────────
  state.map.addLayer({
    id: "wildfire-hotspots-heat",
    type: "heatmap",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "hotspot"],
    maxzoom: 9,
    layout: { visibility: wildfireVis },
    paint: {
      // Weight floor + low-density color stops are deliberately hot: a lone
      // low-FRP hotspot must still glow at national zoom (z3–5), where a
      // single detection covers only a few pixels.
      "heatmap-weight": [
        "interpolate", ["linear"], ["to-number", ["get", "frp"], 0],
        0, 0.12,
        10, 0.2,
        50, 0.4,
        200, 0.65,
        500, 0.85,
        2000, 1,
      ],
      "heatmap-intensity": [
        "interpolate", ["linear"], ["zoom"],
        0, 3.2,
        9, 1,
      ],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 4, 11, 9, 22],
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0,   "rgba(255,200,0,0)",
        0.02, "rgba(255,200,0,0.4)",
        0.15, "rgba(255,170,0,0.8)",
        0.45, "rgba(255,100,0,0.92)",
        1.0, "rgba(180,0,0,1)",
      ],
      "heatmap-opacity": 0.85,
    },
  } as LayerSpecification, heatBefore);

  // ── Hotspot circles — individual dots at high zoom, colored by confidence ──
  state.map.addLayer({
    id: "wildfire-hotspots-circle",
    type: "circle",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "hotspot"],
    minzoom: 8,
    layout: { visibility: wildfireVis },
    paint: {
      "circle-color": [
        "interpolate", ["linear"],
        ["coalesce", ["to-number", ["get", "age_hours"], null], 24],
        0, "#ff2200",
        24, "#ffcc00",
      ],
      "circle-radius": [
        "interpolate", ["linear"], ["to-number", ["get", "frp"], 0],
        0, 4, 100, 7, 1000, 12,
      ],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 0.5,
      "circle-opacity": 0.9,
    },
  } as LayerSpecification);

  // ── Named incident points — human-reported; always visible, above hotspots ─
  state.map.addLayer({
    id: "wildfire-incidents-circle",
    type: "circle",
    source: "wildfire-live",
    filter: ["==", ["get", "_type"], "incident"],
    layout: { visibility: incidentVis },
    paint: {
      "circle-color": [
        "interpolate", ["linear"], ["to-number", ["get", "pct_contained"], 0],
        0,   "#cc0000",
        90,  "#f1c40f",
        100, "#2ecc71",
      ],
      "circle-radius": [
        "step", ["to-number", ["get", "acres"], 0],
        6,
        100,   8,
        1000,  11,
        10000, 14,
      ],
      "circle-stroke-color": [
        "match", ["get", "type_cat"],
        "RX", "#3498db",
        "#ffffff",
      ],
      "circle-stroke-width": 2,
      "circle-opacity": 0.9,
    },
  } as LayerSpecification);
}

// ─── NWS active weather alerts (live) ──────────────────────────────────────
// Curated, polygon-bearing alerts only (phase 1). Colored by `_group`
// (server-side grouping of NWS event types — see scripts/fetch_nws_alerts.py).
const NWS_GROUP_COLOR: ExpressionSpecification = [
  "match", ["get", "_group"],
  "convective", "#a855f7",
  "flood",      "#22c55e",
  "fire",       "#ef4444",
  "heat",       "#f97316",
  "wind",       "#eab308",
  "winter",     "#38bdf8",
  "tropical",   "#14b8a6",
  /* other */   "#9ca3af",
];

export function addNwsAlerts() {
  if (!state.map || state.map.getSource("nws-alerts")) return;

  state.map.addSource("nws-alerts", {
    type: "geojson",
    data: EMPTY_FC,
  });

  const vis = initialVisibility("nws-alerts");

  state.map.addLayer({
    id: "nws-alerts-fill",
    type: "fill",
    source: "nws-alerts",
    layout: { visibility: vis },
    paint: {
      "fill-color": NWS_GROUP_COLOR,
      "fill-opacity": 0.25,
    },
  } as LayerSpecification);

  state.map.addLayer({
    id: "nws-alerts-line",
    type: "line",
    source: "nws-alerts",
    layout: { visibility: vis },
    paint: {
      "line-color": NWS_GROUP_COLOR,
      "line-width": ["case", ["==", ["get", "severity"], "Extreme"], 2.5, 1.5],
    },
  } as LayerSpecification);
}

export const addSeismicHazard = () => addRasterLayer("usgs-seismic-pga", DATA.usgs_seismic_pga,
  '<a href="https://www.usgs.gov/programs/earthquake-hazards/science/2018-nshm">USGS NSHM</a>');

// ─── NEXRAD live radar (external tiles, no pipeline) ──────────────────────────
// IEM's "-0" latest-frame alias resolves per tile inside their cache, so during
// a frame rollover adjacent tiles can come from different volume scans (visible
// seams). tms.json names the current frame atomically (ridge::USCOMP-N0Q-
// YYYYMMDDHHMM); polling it and swapping in the timestamped layer name keeps
// every tile on the same scan. New frames land ~5 min apart; the 60s poll of
// the tiny JSON keeps swap lag low, and setTiles only fires on a frame change.
let radarTimer: ReturnType<typeof setInterval> | undefined;
let radarFrame = "";   // last applied timestamped layer name

// Canada: ECCC GeoMet WMS, one source per product (GeoMet rejects multi-layer
// GetMap). Both toggle with the nexrad-radar row via the registry mapLayerIds.
const GEOMET_RADAR = [
  ["geomet-radar-rain", "RADAR_1KM_RRAI"],
  ["geomet-radar-snow", "RADAR_1KM_RSNO"],
] as const;

const geometTiles = (wmsLayer: string, bust: string) =>
  [GEOMET_RADAR_TILE_TEMPLATE.replace("{layer}", wmsLayer).replace("{bust}", bust)];

async function refreshRadarFrame() {
  const map = state.map;
  if (!map?.getLayer("nexrad-radar")) return;
  if (map.getLayoutProperty("nexrad-radar", "visibility") !== "visible") return;
  try {
    const res = await fetch(RADAR_TMS_JSON_URL);
    if (!res.ok) return;
    const tms = await res.json() as { services?: { id: string; layername: string }[] };
    const layername = tms.services?.find(s => s.id === "ridge_uscomp_n0q")?.layername;
    if (!layername || layername === radarFrame || !map.getSource("nexrad-radar")) return;
    radarFrame = layername;
    (map.getSource("nexrad-radar") as RasterTileSource)
      .setTiles([RADAR_TILE_TEMPLATE.replace("{layer}", layername)]);
    // GeoMet has no frame index we poll; TIME-less GetMap always serves the
    // latest frame, so cache-busting on the IEM frame change (~5 min) is enough.
    for (const [srcId, wmsLayer] of GEOMET_RADAR) {
      const src = map.getSource(srcId) as RasterTileSource | undefined;
      src?.setTiles(geometTiles(wmsLayer, layername));
    }
  } catch {
    // transient network failure — keep showing the current frame
  }
}

export function addNexradRadar() {
  if (!state.map || state.map.getSource("nexrad-radar")) return;

  // GeoMet (Canada) first so the IEM layer draws on top where coverage overlaps.
  for (const [srcId, wmsLayer] of GEOMET_RADAR) {
    state.map.addSource(srcId, {
      type: "raster",
      tiles: geometTiles(wmsLayer, "0"),
      tileSize: 256,
      attribution: '<a href="https://eccc-msc.github.io/open-data/">Environment and Climate Change Canada</a>',
    });
    state.map.addLayer({
      id: srcId,
      type: "raster",
      source: srcId,
      layout: { visibility: initialVisibility("nexrad-radar") },
      paint: { "raster-opacity": 0.7, "raster-resampling": "linear" },
    } as LayerSpecification);
  }

  state.map.addSource("nexrad-radar", {
    type: "raster",
    tiles: [RADAR_TILE_URL],   // "-0" alias until the first tms.json answer
    tileSize: 256,
    attribution: '<a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a>',
  });
  state.map.addLayer({
    id: "nexrad-radar",
    type: "raster",
    source: "nexrad-radar",
    layout: { visibility: initialVisibility("nexrad-radar") },
    paint: { "raster-opacity": 0.7, "raster-resampling": "linear" },
  } as LayerSpecification);

  void refreshRadarFrame();
  radarTimer ??= setInterval(() => void refreshRadarFrame(), 60_000);
}

// ─── ODIN live county-outage choropleth ───────────────────────────────────────
// A geometry-less FIPS→[customers_out, incident_count] snapshot is joined onto
// the shared county_boundaries PMTiles by MapLibre feature-state — promoteId
// makes each county feature's id its 5-digit GEOID string (never parseInt a
// FIPS — leading zeros matter). Counties with NO feature-state paint fully
// transparent; the null guard comes first because arithmetic on a null
// feature-state value poisons the whole expression. The join + refresh logic
// lives in ../odin-outages.ts.
export function addOdinOutages() {
  if (!state.map || state.map.getLayer("odin-outages-fill")) return;
  // The source is SHARED infra owned by layer-init.ts — guard on our own layer
  // above, never on the source, or a future county layer that adds it first
  // would silently suppress these layers.
  ensureCountyBoundaries();

  const vis = initialVisibility("odin-outages");

  // YlOrRd choropleth — customers-out buckets: <100 / 100–1k / 1k–5k / 5k+.
  // Guard null FIRST (no feature-state → transparent), else step by count.
  state.map.addLayer({
    id: "odin-outages-fill",
    type: "fill",
    source: COUNTY_SRC,
    "source-layer": COUNTY_SRC_LAYER,
    layout: { visibility: vis },
    paint: {
      "fill-color": [
        "case",
        ["==", ["feature-state", "odin_out"], null], "rgba(0,0,0,0)",
        ["step", ["feature-state", "odin_out"],
          "#fed976",          // <100
          100,  "#fd8d3c",    // 100–1k
          1000, "#e31a1c",    // 1k–5k
          5000, "#800026",    // 5k+
        ],
      ],
      "fill-opacity": 0.6,
    },
  } as LayerSpecification);

  // Thin outline, only where there's data (transparent otherwise).
  state.map.addLayer({
    id: "odin-outages-line",
    type: "line",
    source: COUNTY_SRC,
    "source-layer": COUNTY_SRC_LAYER,
    layout: { visibility: vis },
    paint: {
      "line-color": [
        "case",
        ["==", ["feature-state", "odin_out"], null], "rgba(0,0,0,0)",
        "#800026",
      ],
      "line-width": 0.6,
      "line-opacity": 0.7,
    },
  } as LayerSpecification);
}

// ─── Live weather fields (baked-color images, every ~3 h) ──────────────────────
// WEBP mosaics (GFS 0.25° temperature, wind, humidity, etc.) served as
// MapLibre `image` sources, not tiles — a whole-continent field is ~40–60 KB per
// variable, so tiling it would buy nothing. Started holding a 1×1 transparent PNG
// so visitors who never enable the layer never fetch; ../weather-live.ts
// calls updateImage() on first enable and on every ~3-hourly refresh, and also
// owns the age chip and the hover-LUT reload.
export function addWeatherLive() {
  if (!state.map || state.map.getSource("weather-live")) return;
  // MapLibre's image-source spec has no `attribution` field (unlike raster/geojson),
  // so the GFS credit rides in the credits dialog (index.html,
  // data-source-credit="noaa-gfs") instead of the attribution control.
  // A/B pair: weather-live.ts paints each new step/variable/bake onto the
  // hidden partner and crossfades raster-opacity — a lone updateImage() swaps
  // the texture with a hard pop. The fade is driven per-frame by paintImage()
  // (a complement curve that keeps combined coverage constant — two linear
  // transitions dip toward the basemap mid-fade), so the property's own
  // transition must be instant. "weather-live" starts as the front layer.
  for (const [id, opacity] of [
    ["weather-live", WEATHER_WASH_OPACITY],
    ["weather-live-b", 0],
  ] as const) {
    state.map.addSource(id, {
      type: "image",
      url: TRANSPARENT_PNG,
      coordinates: WEATHER_IMAGE_COORDS,
    });
    state.map.addLayer({
      id,
      type: "raster",
      source: id,
      layout: { visibility: initialVisibility("weather-live") },
      paint: {
        "raster-opacity": opacity,
        "raster-opacity-transition": { duration: 0 },
        "raster-resampling": "linear",
      },
    } as LayerSpecification);
  }

  // White country/state border highlights over the wash (Ventusky-style) —
  // the dark ramp colors swallow the basemap's own borders. Natural Earth
  // lines, lazily loaded via the weather-live alias in layer-init.ts and
  // toggled by the same registry row (mapLayerIds).
  state.map.addSource("weather-admin-lines", { type: "geojson", data: EMPTY_FC });
  state.map.addLayer({
    id: "weather-admin-lines-states",
    type: "line",
    source: "weather-admin-lines",
    filter: ["==", ["get", "level"], 1],
    layout: { visibility: initialVisibility("weather-live") },
    paint: { "line-color": "#ffffff", "line-width": 0.8, "line-opacity": 0.45 },
  });
  state.map.addLayer({
    id: "weather-admin-lines-countries",
    type: "line",
    source: "weather-admin-lines",
    // level 0 = country borders, 2 = coastline — both get the prominent style
    filter: ["!=", ["get", "level"], 1],
    layout: { visibility: initialVisibility("weather-live") },
    paint: { "line-color": "#ffffff", "line-width": 1.4, "line-opacity": 0.7 },
  });
}

export const addWildfireHazard = () => addRasterLayer("usfs-wildfire-potential", DATA.usfs_wildfire_potential,
  '<a href="https://research.fs.usda.gov/firelab/products/dataandtools/wildfire-hazard-potential">USFS Fire Lab</a>',
  { resampling: "nearest" });
