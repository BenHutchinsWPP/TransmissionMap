// ─── Feature search (inside layers panel) ───────────────────────────────────
// An open query re-runs on the 'layer:data' bus event, as lazy sources land.
// Search finds what the map draws: a feature counts only when the filter of at
// least one of its layer's map layers on that source passes it — so a legend
// filter, a view's `where` and the Area filter (filters.ts effectiveFilter())
// hide it from search too, as they do from click and hover. The filters are
// evaluated with the style-spec featureFilter, a lazy chunk shared with
// popup.ts; until it loads, or if it cannot, search runs unfiltered.
// Deps: state.ts, map-input.ts (onMapTap), registry (layerById, OSM_TL_BANDS),
//       highlights.ts, state-bus.ts, diag-log.ts, utils.ts (escapeHtml).

import { state } from '../state.js';
import type { FilterSpecification } from 'maplibre-gl';
import { layerById } from '../../src/registry/index.js';
import { recordDiagEvent } from '../diag-log.js';
import { onMapTap } from '../map-input.js';
import { OSM_TL_BANDS } from '../../src/registry/transmission.js';
import { escapeHtml } from '../utils/utils.js';
import { setHighlightFeatures, clearHighlights } from '../highlights.js';
import { on } from '../state-bus.js';

interface SearchResult {
  name: string;
  label: string;
  center: number[];
  geometry: GeoJSON.Geometry;
}

// Sources to search, in priority order.
// >>> ADD-LAYER: search-sources — see docs/adding-a-layer.md §8
const SEARCH_SOURCES = [
  { sourceId: "eia-generators",  sourceLayer: null,             label: "EIA Plant",          fields: ["plant_name", "technology", "state", "ba_code"] },
  { sourceId: "dc-moratoriums",   sourceLayer: null,             label: "Data Center Moratorium", fields: ["name", "state"] },
  { sourceId: "osm-datacenters",  sourceLayer: null,             label: "Data Center",        fields: ["name", "operator", "addr_city", "addr_state"] },
  { sourceId: "osm-substations-points", sourceLayer: "osm_substations_points", label: "OSM Substation",     fields: ["name", "operator"] },
  { sourceId: "hifld-substations",      sourceLayer: null,             label: "HIFLD Substation",   fields: ["name"] },
  { sourceId: "osm-generators",         sourceLayer: "osm_generators", label: "OSM Generator",      fields: ["name", "source", "operator"] },
  { sourceId: "osm-plants-points",      sourceLayer: null,             label: "Power Plant",        fields: ["name", "operator", "source"] },
  // One entry per voltage-class archive — querySourceFeatures reads a single
  // source, so a lone "osm-transmission-lines" entry would only ever find lines
  // under 50 kV. They all report to the same registry layer for the visibility
  // check, and a line is in exactly one archive, so results cannot duplicate.
  ...OSM_TL_BANDS.map(b => ({
    sourceId: `osm-transmission-lines${b.suffix}`, sourceLayer: "osm_transmission_lines",
    label: "OSM Transmission", fields: ["name", "operator"], layerId: "osm-transmission-lines",
  })),
  { sourceId: "hifld-transmission-lines", sourceLayer: "hifld_transmission_lines", label: "HIFLD Transmission", fields: ["OWNER"],                   layerId: "hifld-transmission-lines" },
  { sourceId: "ogf-planned-transmission", sourceLayer: null, label: "Planned Transmission", fields: ["Project", "Owner", "FromSub", "ToSub", "StatesFull"] },
  { sourceId: "westtec-10yr", sourceLayer: null, label: "WestTEC Project", fields: ["name"] },
  { sourceId: "osm-pipelines-lines",  sourceLayer: "osm_pipelines_lines", label: "Pipeline",      fields: ["name", "operator", "substance"] },
  { sourceId: "osm-pipelines-points", sourceLayer: null,             label: "Pipeline Point", fields: ["pipeline", "operator"] },
  { sourceId: "hifld-natgas-lines",   sourceLayer: "hifld_natgas_lines", label: "HIFLD Pipeline", fields: ["name", "operator", "pipe_type"] },
  { sourceId: "hifld-natgas-points",  sourceLayer: null,             label: "Fuel Facility",   fields: ["name", "operator", "state"] },
  { sourceId: "eia-crude-pipelines",   sourceLayer: null,            label: "Crude Pipeline",   fields: ["name", "operator"] },
  { sourceId: "eia-product-pipelines", sourceLayer: null,            label: "Product Pipeline", fields: ["name", "operator"] },
  { sourceId: "nrel-hydrothermal-points", sourceLayer: null,         label: "Hydrothermal",   fields: ["name", "state", "county"] },
  { sourceId: "mines",           sourceLayer: null,             label: "Mine",               fields: ["name", "commodity", "operator", "state"] },
  { sourceId: "railroads",       sourceLayer: "railroads",      label: "Railroad",           fields: ["RROWNER1", "SUBDIV", "BRANCH"], layerId: "railroads" },
  { sourceId: "nerc-regions",    sourceLayer: null,             label: "NERC Region",        fields: ["region", "sub_nm", "code", "state"] },
  { sourceId: "control-areas",   sourceLayer: null,             label: "Balancing Authority", fields: ["name", "state"] },
  { sourceId: "eia-ba",          sourceLayer: null,             label: "EIA Balancing Authority", fields: ["name", "abbrev"] },
  { sourceId: "retail-territories", sourceLayer: "retail_territories", label: "Retail Territory", fields: ["name", "state"] },
  { sourceId: "padus",          sourceLayer: "padus",          label: "Protected Land",     fields: ["name", "desig", "mng_agency", "state"] },
  { sourceId: "tribal-lands",   sourceLayer: null,             label: "Tribal (Census)",      fields: ["name"] },
  { sourceId: "bia-tribal-lands", sourceLayer: null,             label: "Tribal (BIA)",       fields: ["LARNAME"] },
  { sourceId: "crithab",        sourceLayer: "crithab",        label: "Critical Habitat",   fields: ["comname", "sciname", "unitname"] },
  { sourceId: "wildfire-live",  sourceLayer: null,             label: "Active Fire",         fields: ["name", "state"],            layerId: "wildfire-live",      featureType: "perimeter" },
  { sourceId: "wildfire-live",  sourceLayer: null,             label: "Fire Incident",       fields: ["name", "fire_id", "state"], layerId: "wildfire-incidents", featureType: "incident" },
  { sourceId: "nws-alerts",     sourceLayer: null,             label: "Weather Alert",       fields: ["event", "areaDesc", "headline"] },
  { sourceId: "wecc-paths",     sourceLayer: null,             label: "WECC Path",           fields: ["name", "number"] },
  { sourceId: "boem-wind-leases", sourceLayer: null,           label: "Offshore Wind Lease", fields: ["project", "company", "lease", "state"] },
];

function _featureCenter(feature: GeoJSON.Feature) {
  const g = feature.geometry;
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  if (g.type === "LineString") return g.coordinates[Math.floor(g.coordinates.length / 2)];
  if (g.type === "MultiLineString") {
    const line = g.coordinates[0];
    return line[Math.floor(line.length / 2)];
  }
  if (g.type === "Polygon" || g.type === "MultiPolygon") {
    const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
    const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1]);
    return [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  }
  return null;
}

function _sourceFeatures(src: (typeof SEARCH_SOURCES)[number]): GeoJSON.Feature[] | null {
  const map = state.map;
  if (!map?.getSource(src.sourceId)) return null;
  if (src.sourceLayer === null && state.sourcesData[src.sourceId]) {
    return state.sourcesData[src.sourceId] as GeoJSON.Feature[];
  }
  const opts = src.sourceLayer ? { sourceLayer: src.sourceLayer } : {};
  // A source still loading its header has nothing to match yet.
  try { return map.querySourceFeatures(src.sourceId, opts); }
  catch { return []; }
}

// ─── What the map draws ──────────────────────────────────────────────────────
type FeatureFilterFn = typeof import('@maplibre/maplibre-gl-style-spec').featureFilter;
let featureFilter: FeatureFilterFn | null = null;
let featureFilterLoad: Promise<void> | null = null;
function loadFeatureFilter(): Promise<void> {
  return featureFilterLoad ??= import('@maplibre/maplibre-gl-style-spec')
    .then(m => { featureFilter = m.featureFilter; })
    .catch(err => { featureFilterLoad = null; recordDiagEvent('layer', `search filter chunk: ${err}`); });
}

const GEOMETRY_TYPE: Record<string, number> = {
  Point: 1, MultiPoint: 1, LineString: 2, MultiLineString: 2, Polygon: 3, MultiPolygon: 3,
};

/** A test that passes a feature some map layer draws: the layer filters given
 *  (one per map layer on the source; null = no filter, draws every feature),
 *  any of which may pass it. No filters at all: every feature passes. */
export function drawnBy(
  filters: (FilterSpecification | null | undefined)[], compile: FeatureFilterFn, zoom: number,
): (f: GeoJSON.Feature) => boolean {
  if (!filters.length || filters.some(f => !f)) return () => true;
  const tests = filters.map(f => compile(f!, 'layers[0].filter'));
  return (f) => {
    const feature = { type: GEOMETRY_TYPE[f.geometry?.type] ?? 0, properties: f.properties ?? {}, id: f.id };
    return tests.some(t => t.filter({ zoom }, feature as never));
  };
}

function _drawnTest(src: (typeof SEARCH_SOURCES)[number]): (f: GeoJSON.Feature) => boolean {
  const map = state.map;
  const entry = layerById(src.layerId ?? src.sourceId);
  if (!map || !entry || !featureFilter) return () => true;
  const mlIds = entry.mapLayerIds.filter(id => map.getLayer(id)?.source === src.sourceId);
  return drawnBy(mlIds.map(id => map.getFilter(id) as FilterSpecification | null), featureFilter, map.getZoom());
}

function _matchResult(f: GeoJSON.Feature, src: (typeof SEARCH_SOURCES)[number], query: string) {
  const p = f.properties || {};
  if ("featureType" in src && p._type !== src.featureType) return null;
  const matched = src.fields.some(field => {
    const val = p[field];
    return val && String(val).toLowerCase().includes(query);
  });
  if (!matched) return null;

  const name = src.fields.map(field => p[field]).find(v => v && String(v).trim()) || "(unnamed)";
  const center = _featureCenter(f);
  if (!center || !f.geometry) return null;

  return { name: String(name), label: src.label, center, geometry: f.geometry };
}

function _searchInSource(src: (typeof SEARCH_SOURCES)[number], query: string, seen: Set<string>, limit: number) {
  const features = _sourceFeatures(src);
  if (!features) return [];
  const drawn = _drawnTest(src);
  const out: SearchResult[] = [];
  for (const f of features) {
    const result = _matchResult(f, src, query);
    if (!result || !drawn(f)) continue;
    const key = `${src.sourceId}:${result.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
    if (out.length >= limit) break;
  }
  return out;
}

const SEARCH_MAX_RESULTS = 10;

function _searchFeatures(q: string) {
  const query = q.toLowerCase().trim();
  if (!query || query.length < 2) return [];

  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const src of SEARCH_SOURCES) {
    const layerId = src.layerId ?? src.sourceId;
    if (!state.layerVisibility[layerId]) continue;
    const remaining = SEARCH_MAX_RESULTS - results.length;
    results.push(..._searchInSource(src, query, seen, remaining));
    if (results.length >= SEARCH_MAX_RESULTS) break;
  }
  return results;
}

function _resultToFeature(r: SearchResult): GeoJSON.Feature {
  return { type: "Feature", geometry: r.geometry, properties: {} };
}

export function wireFeatureSearch() {
  const searchInput   = document.getElementById("searchInput") as HTMLInputElement | null;
  const searchResults = document.getElementById("searchResults");
  if (!searchInput || !searchResults) return;

  function showResults(results: SearchResult[]) {
    if (!results.length) {
      clearHighlights('search');
      searchResults!.innerHTML = `<div class="search-no-results">No results in loaded tiles</div>`;
      searchResults!.hidden = false;
      return;
    }

    setHighlightFeatures(results.map(_resultToFeature), 'search');

    searchResults!.innerHTML = results.map((r, i) =>
      `<button class="search-result-item" data-index="${i}">
        <span class="search-result-name truncate">${escapeHtml(r.name)}</span>
        <span class="search-result-label">${escapeHtml(r.label)}</span>
      </button>`
    ).join("");
    searchResults!.hidden = false;

    searchResults!.querySelectorAll<HTMLElement>(".search-result-item").forEach(btn => {
      const r = results[parseInt(btn.dataset.index!)];
      btn.addEventListener("mouseenter", () => setHighlightFeatures([_resultToFeature(r)], 'search'));
      btn.addEventListener("mouseleave", () => setHighlightFeatures(results.map(_resultToFeature), 'search'));
      btn.addEventListener("click", () => {
        state.map!.flyTo({ center: r.center as [number, number], zoom: Math.max(state.map!.getZoom(), 10) });
        setHighlightFeatures([_resultToFeature(r)], 'search');
        searchResults!.hidden = true;
        searchInput!.value = r.name;
      });
    });
  }

  function hideResults() {
    searchResults!.hidden = true;
    clearHighlights('search');
  }

  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  async function doSearch() {
    const q = searchInput!.value ?? "";
    if (!q.trim() || !state.map) { hideResults(); return; }
    await loadFeatureFilter();
    if (searchInput!.value !== q) return;   // typed on while the filter chunk loaded
    showResults(_searchFeatures(q));
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void doSearch(), 200);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(searchDebounce); void doSearch(); }
    if (e.key === "Escape") hideResults();
  });

  on('layer:data', () => {
    if (searchInput.value.trim()) {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => void doSearch(), 0);
    }
  });

  document.addEventListener("click", (e) => {
    const t = e.target as Element;
    if (!searchResults!.hidden && !t?.closest("#searchInput") && !t?.closest("#searchResults")) hideResults();
  });
  // Going back to the map is a map tap, which is not a document click on touch.
  onMapTap(hideResults);
}
