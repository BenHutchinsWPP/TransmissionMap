// ─── MapLibre initialisation ──────────────────────────────────────────────────

import maplibregl from 'maplibre-gl';
import * as pmtiles from 'pmtiles';
import { state, BLANK_STYLE, DEFAULT_CENTER, DEFAULT_ZOOM,
         OSM_TILE_URL, CARTO_LIGHT_TILE_URLS, CARTO_DARK_TILE_URLS,
         CARTO_VOYAGER_TILE_URLS, USGS_TOPO_TILE_URL, AERIAL_TILE_URL } from './state.js';
import { loadGenIcons, loadPipelineIcons, loadNatgasPtIcons, loadMineIcons } from './icons.js';
import { addAllLayers } from './layers/add-all-layers.js';
import { initPolygonHover, initLineHighlight } from './hover.js';
import { initRasterProbes } from './raster-probes.js';
import { applyAllGenModes, applyOGFColorBy } from './visibility.js';
import { applyVoltageFilter, applyGeneratorFilters, applyPipelineTypeFilter,
         applyPadusClassFilter, applyTribalClassFilter, applyNercFilter,
         applyRetailTypeFilter, applySubstanceFilter } from './filters.js';
import { initPopups } from './popup.js';
import { initMeasure } from './measure.js';
import { writeUrlState } from './url-state.js';
import { loadUserData } from './user-data/user-data.js';
import { hideLoading } from './utils/utils-dom.js';

export function initMap() {
  // Register pmtiles protocol BEFORE constructing the Map
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile.bind(protocol));

  const hashView = parseLocationHash();

  state.map = new maplibregl.Map({
    container: "map",
    style: BLANK_STYLE,
    center:  hashView?.center ?? DEFAULT_CENTER,
    zoom:    hashView?.zoom   ?? DEFAULT_ZOOM,
    maxZoom: 18,
    attributionControl: false,
  });

  // No customAttribution: every layer carries its own per-source attribution
  // (see SOURCE_ATTRIB), so credits appear/disappear with layer visibility.
  state.map.addControl(new maplibregl.AttributionControl({
    compact: true,
  }), "bottom-right");

  // Attribution credit links open in a new tab instead of navigating away from
  // the map. Delegated + capture-phase so it also covers links re-rendered when
  // layer visibility changes. Setting target before the default action suffices.
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement)?.closest?.(".maplibregl-ctrl-attrib a") as HTMLAnchorElement | null;
    if (a) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  }, true);

  state.map.addControl(new maplibregl.NavigationControl(), "bottom-right");

  state.map.addControl(new maplibregl.GeolocateControl({
    positionOptions:    { enableHighAccuracy: true },
    fitBoundsOptions:   { maxZoom: 12 },
    trackUserLocation:  false,
    showAccuracyCircle: true,
    showUserLocation:   true,
  }), "bottom-right");

  state.map.on("load", async () => {
    state.mapReady = true;
    addBasemapSources();
    switchBasemap(state.basemap);
    switchProjection(state.projection);
    // Icon loads must never block layer creation — a failed rasterize would
    // otherwise skip addAllLayers() and blank every layer. Degrade to no-icon.
    await Promise.all([loadGenIcons(), loadPipelineIcons(), loadNatgasPtIcons(), loadMineIcons()]
      .map(p => p.catch(err => console.warn('[TransmissionMap] icon load failed', err))));
    try { addAllLayers(); } finally {
      applyVoltageFilter();
      applyGeneratorFilters();
      applyAllGenModes();
      applyOGFColorBy();
      applyPipelineTypeFilter();
      applySubstanceFilter();
      applyPadusClassFilter();
      applyTribalClassFilter();
      applyNercFilter();
      applyRetailTypeFilter();
    }
    initPolygonHover();
    initLineHighlight();
    initRasterProbes();
    initPopups();
    initMeasure();
    loadUserData();
    hideLoading();

    state.map!.on("moveend", writeUrlState);
    writeUrlState();

    window.addEventListener("hashchange", () => {
      const loc = parseLocationHash();
      if (loc) state.map!.jumpTo({ center: loc.center, zoom: loc.zoom });
    });
  });
}

// ─── Dual basemap sources ─────────────────────────────────────────────────────
const BASEMAP_LAYERS = {
  street:  { sourceId: "osm-tiles",          layerId: "osm-bg"           },
  light:   { sourceId: "carto-light-tiles",  layerId: "carto-light-bg"   },
  dark:    { sourceId: "carto-dark-tiles",   layerId: "carto-dark-bg"    },
  voyager: { sourceId: "carto-voyager-tiles",layerId: "carto-voyager-bg" },
  topo:    { sourceId: "usgs-topo-tiles",    layerId: "usgs-topo-bg"     },
  aerial:  { sourceId: "aerial-tiles",       layerId: "aerial-bg"        },
};

function addBasemapSources() {
  if (!state.map) return;
  const sources = [
    { id: "osm-tiles",           tiles: [OSM_TILE_URL],           attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",                                       maxzoom: 19 },
    { id: "carto-light-tiles",   tiles: CARTO_LIGHT_TILE_URLS,   attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>", maxzoom: 19 },
    { id: "carto-dark-tiles",    tiles: CARTO_DARK_TILE_URLS,    attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>", maxzoom: 19 },
    { id: "carto-voyager-tiles", tiles: CARTO_VOYAGER_TILE_URLS, attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>", maxzoom: 19 },
    { id: "usgs-topo-tiles",     tiles: [USGS_TOPO_TILE_URL],    attribution: "USGS The National Map",                                                                                                          maxzoom: 16 },
    { id: "aerial-tiles",        tiles: [AERIAL_TILE_URL],        attribution: "Esri World Imagery",                                                                                                             maxzoom: 19 },
  ];
  for (const s of sources) {
    state.map.addSource(s.id, { type: "raster", tiles: s.tiles, tileSize: 256, attribution: s.attribution, maxzoom: s.maxzoom });
  }
  for (const [type, { sourceId, layerId }] of Object.entries(BASEMAP_LAYERS)) {
    state.map.addLayer({ id: layerId, type: "raster", source: sourceId, layout: { visibility: type === "street" ? "visible" : "none" } });
  }
}

export function switchBasemap(type: string) {
  if (!state.mapReady || !state.map) return;
  state.basemap = type;
  for (const [t, { layerId }] of Object.entries(BASEMAP_LAYERS)) {
    state.map.setLayoutProperty(layerId, "visibility", t === type ? "visible" : "none");
  }
}

export function switchProjection(type: string) {
  if (!state.map) return;
  state.projection = type;
  // ponytail: only mercator | globe exist in MapLibre; no enum needed
  state.map.setProjection({ type: type as 'mercator' | 'globe' });
}

// ─── URL hash parsing ─────────────────────────────────────────────────────────
function parseLocationHash() {
  try {
    const raw   = window.location.hash.slice(1);
    const posStr = raw.includes('?') ? raw.slice(0, raw.indexOf('?')) : raw;
    const parts = posStr.split("/");
    if (parts.length !== 3) return null;
    const zoom = parseFloat(parts[0]);
    const lat  = parseFloat(parts[1]);
    const lon  = parseFloat(parts[2]);
    if ([zoom, lat, lon].some(isNaN)) return null;
    if (zoom < 0 || zoom > 22)         return null;
    if (lat < -90  || lat > 90)        return null;
    if (lon < -180 || lon > 180)       return null;
    return { zoom, center: [lon, lat] as [number, number] };
  } catch {
    console.warn("Malformed URL hash; using default map view.");
    return null;
  }
}
