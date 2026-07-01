// ─── Feature search (inside layers panel) ───────────────────────────────────

import { state } from '../state.js';
import { escapeHtml } from '../utils/utils.js';
import { setHighlightFeatures, clearHighlights } from '../highlights.js';

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
  { sourceId: "osm-datacenters",  sourceLayer: null,             label: "Data Center",        fields: ["name", "operator", "addr_city", "addr_state"] },
  { sourceId: "osm-substations-points", sourceLayer: null,             label: "OSM Substation",     fields: ["name", "operator"] },
  { sourceId: "hifld-substations",      sourceLayer: null,             label: "HIFLD Substation",   fields: ["name"] },
  { sourceId: "osm-generators",         sourceLayer: "osm_generators", label: "OSM Generator",      fields: ["name", "source", "operator"] },
  { sourceId: "osm-plants-points",      sourceLayer: null,             label: "Power Plant",        fields: ["name", "operator", "source"] },
  { sourceId: "osm-transmission-lines",  sourceLayer: "osm_transmission_lines",  label: "OSM Transmission",   fields: ["name", "operator"],        layerId: "osm-transmission-lines" },
  { sourceId: "hifld-transmission-lines", sourceLayer: "hifld_transmission_lines", label: "HIFLD Transmission", fields: ["OWNER"],                   layerId: "hifld-transmission-lines" },
  { sourceId: "ogf-planned-transmission", sourceLayer: null, label: "Planned Transmission", fields: ["Project", "Owner", "FromSub", "ToSub", "StatesFull"] },
  { sourceId: "osm-pipelines-lines",  sourceLayer: "osm_pipelines_lines", label: "Pipeline",      fields: ["name", "operator", "substance"] },
  { sourceId: "osm-pipelines-points", sourceLayer: null,             label: "Pipeline Point", fields: ["pipeline", "operator"] },
  { sourceId: "hifld-natgas-lines",   sourceLayer: "hifld_natgas_lines", label: "HIFLD Pipeline", fields: ["name", "operator", "pipe_type"] },
  { sourceId: "hifld-natgas-points",  sourceLayer: null,             label: "Fuel Facility",   fields: ["name", "operator", "state"] },
  { sourceId: "eia-crude-pipelines",   sourceLayer: null,            label: "Crude Pipeline",   fields: ["name", "operator"] },
  { sourceId: "eia-product-pipelines", sourceLayer: null,            label: "Product Pipeline", fields: ["name", "operator"] },
  { sourceId: "nrel-hydrothermal-points", sourceLayer: null,         label: "Hydrothermal",   fields: ["name", "state", "county"] },
  { sourceId: "railroads",       sourceLayer: "railroads",      label: "Railroad",           fields: ["RROWNER1", "SUBDIV", "BRANCH"], layerId: "railroads" },
  { sourceId: "nerc-regions",    sourceLayer: null,             label: "NERC Region",        fields: ["region", "sub_nm", "code", "state"] },
  { sourceId: "control-areas",   sourceLayer: null,             label: "Balancing Authority", fields: ["name", "state"] },
  { sourceId: "retail-territories", sourceLayer: "retail_territories", label: "Retail Territory", fields: ["name", "state"] },
  { sourceId: "padus",          sourceLayer: "padus",          label: "Protected Land",     fields: ["name", "desig", "mng_agency", "state"] },
  { sourceId: "tribal-lands",   sourceLayer: "tribal_lands",   label: "Tribal Land",        fields: ["name"] },
  { sourceId: "crithab",        sourceLayer: "crithab",        label: "Critical Habitat",   fields: ["comname", "sciname", "unitname"] },
  { sourceId: "wildfire-live",  sourceLayer: null,             label: "Active Fire",         fields: ["name", "fire_id", "state"] },
  { sourceId: "wecc-paths",     sourceLayer: null,             label: "WECC Path",           fields: ["name", "number"] },
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
  if (!state.map?.getSource(src.sourceId)) return null;
  if (src.sourceLayer === null && state.sourcesData[src.sourceId]) {
    return state.sourcesData[src.sourceId] as GeoJSON.Feature[];
  }
  const opts = src.sourceLayer ? { sourceLayer: src.sourceLayer } : {};
  try { return state.map.querySourceFeatures(src.sourceId, opts); }
  catch { return null; }
}

function _matchResult(f: GeoJSON.Feature, src: (typeof SEARCH_SOURCES)[number], query: string) {
  const p = f.properties || {};
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
  const out: SearchResult[] = [];
  for (const f of features) {
    const result = _matchResult(f, src, query);
    if (!result) continue;
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
      clearHighlights();
      searchResults!.innerHTML = `<div class="search-no-results">No results in loaded tiles</div>`;
      searchResults!.hidden = false;
      return;
    }

    setHighlightFeatures(results.map(_resultToFeature));

    searchResults!.innerHTML = results.map((r, i) =>
      `<button class="search-result-item" data-index="${i}">
        <span class="search-result-name truncate">${escapeHtml(r.name)}</span>
        <span class="search-result-label">${escapeHtml(r.label)}</span>
      </button>`
    ).join("");
    searchResults!.hidden = false;

    searchResults!.querySelectorAll<HTMLElement>(".search-result-item").forEach(btn => {
      const r = results[parseInt(btn.dataset.index!)];
      btn.addEventListener("mouseenter", () => setHighlightFeatures([_resultToFeature(r)]));
      btn.addEventListener("mouseleave", () => setHighlightFeatures(results.map(_resultToFeature)));
      btn.addEventListener("click", () => {
        state.map!.flyTo({ center: r.center as [number, number], zoom: Math.max(state.map!.getZoom(), 10) });
        setHighlightFeatures([_resultToFeature(r)]);
        searchResults!.hidden = true;
        searchInput!.value = r.name;
      });
    });
  }

  function hideResults() {
    searchResults!.hidden = true;
    clearHighlights();
  }

  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  function doSearch() {
    const q = searchInput!.value ?? "";
    if (!q.trim() || !state.map) { hideResults(); clearHighlights(); return; }
    showResults(_searchFeatures(q));
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(doSearch, 200);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(searchDebounce); doSearch(); }
    if (e.key === "Escape") hideResults();
  });

  window.addEventListener('tm:layerdata', () => {
    if (searchInput.value.trim()) {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(doSearch, 0);
    }
  });

  document.addEventListener("click", (e) => {
    const t = e.target as Element;
    if (!t?.closest("#searchInput") && !t?.closest("#searchResults")) hideResults();
  });
}
