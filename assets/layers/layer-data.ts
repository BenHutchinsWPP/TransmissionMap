// ─── Layer data: lazy GeoJSON loading for GeoJSON-backed layers ──────────────
// Imported by: add-all-layers.ts (ensureLayerData — defaultOn bootstrap),
//              visibility.ts (ensureLayerData), map-layers-wecc.ts (ensureLayerData),
//              live-staleness.ts (fetchGeojson).
// Deps: state.ts, constants.ts (DATA), state-bus.ts (emits 'layer:data' after a
//       source's features land), diag-log.ts (recordDiagEvent — records
//       ensureLayerData failures for the diagnostics panel); registry/index.ts
//       (layerById — reads a layer's fromZoom threshold).
// ensureLayerData's contract: "fetch this if the zoom allows" — a source
// whose LayerDef sets fromZoom is withheld below that zoom (for every registry
// id that shares it through LAYER_SOURCE_ALIAS too), so every caller
// (bootstrap defaultOn loops included) can call it unconditionally and rely
// on the gate rather than checking zoom itself. A held id is retried on each
// 'zoomend' (one listener, attached on the first hold), so a layer switched on
// while zoomed out still loads once the map reaches its threshold. A gated
// layer whose fetch fails is held again, so the next zoom settle retries it.

import type { GeoJSONSource } from 'maplibre-gl';
import { state } from '../state.js';
import { DATA } from '../constants.js';
import { emit } from '../state-bus.js';
import { recordDiagEvent } from '../diag-log.js';
import { layerById } from '../../src/registry/index.js';

// Maps registry ID → real data URL for GeoJSON-backed layers.
// >>> ADD-LAYER: layer-data-urls — see docs/adding-a-layer.md §7
export const LAYER_DATA_URLS: Record<string, string> = {
  "ogf-planned-transmission":   DATA.ogf_planned_transmission,
  "hifld-substations":          DATA.hifld_substations,
  "osm-plants-points":          DATA.osm_plants_points,
  "eia-generators":             DATA.eia_generators,
  "osm-pipelines-points":       DATA.osm_pipelines_points,
  "hifld-natgas-points":        DATA.hifld_natgas_points,
  "eia-crude-pipelines":        DATA.eia_crude_pipelines,
  "eia-product-pipelines":      DATA.eia_product_pipelines,
  "nrel-hydrothermal-points":   DATA.nrel_hydrothermal_points,
  "osm-datacenters":            DATA.osm_datacenters,
  "dc-moratoriums":             DATA.dc_moratoriums,
  "mines":                      DATA.mines,
  "wecc-paths":                 DATA.wecc_paths,
  "wecc-path-lines":            DATA.wecc_path_lines,
  "nerc-regions":               DATA.nerc_regions,
  "control-areas":              DATA.control_areas,
  "eia-ba":                     DATA.eia_ba,
  "us-states":                  DATA.us_states,
  "countries":                  DATA.countries,
  "admin1":                     DATA.admin1_boundaries,
  "tribal-lands":               DATA.tribal_lands,
  "bia-tribal-lands":           DATA.bia_tribal_lands,
  "wildfire-live":              DATA.wildfire_live,
  "nws-alerts":                 DATA.nws_alerts,
  "boem-wind-leases":           DATA.boem_wind_leases,
  "westtec-10yr":               DATA.westtec_10yr,
  "weather-admin-lines":        DATA.admin_lines, // not a registry id — loaded via the weather-live alias below
};

// Registry IDs that share a source with another registry ID.
// Enabling one of these triggers ensureLayerData on the owning source instead.
export const LAYER_SOURCE_ALIAS: Record<string, string> = {
  "wildfire-smoke":     "wildfire-live",
  "wildfire-incidents": "wildfire-live",
  // weather-live's own source is an image; enabling it lazily loads the
  // white admin-border lines drawn above the wash instead.
  "weather-live":       "weather-admin-lines",
  // petroleum facilities share the HIFLD points source (split by fac_type base filter)
  "hifld-petroleum-facilities": "hifld-natgas-points",
};

const _inflight: Partial<Record<string, Promise<void>>> = {};

// Registry ids held back by the fromZoom gate (or whose gated fetch failed),
// retried on each zoom settle.
const _held = new Set<string>();
let _hookedMap: unknown = null;

function retryHeld() {
  const ids = [..._held];
  _held.clear();
  for (const id of ids) if (state.layerVisibility[id]) void ensureLayerData(id);
}

function hold(registryId: string) {
  _held.add(registryId);
  if (state.map && _hookedMap !== state.map) {
    state.map.on('zoomend', retryHeld);
    _hookedMap = state.map;
  }
}

export function ensureLayerData(registryId: string): Promise<void> {
  const sourceId = LAYER_SOURCE_ALIAS[registryId] ?? registryId;
  // Fetch gate: the source's fromZoom holds the fetch back below that zoom, so
  // a heavy dataset zoomed-out users never render is never downloaded either.
  // The asking id is remembered and retried on zoom settle, so the caller (a
  // visibility toggle or a defaultOn bootstrap loop) never checks zoom itself.
  const fromZoom = layerById(sourceId)?.fromZoom;
  if (fromZoom === undefined) return fetchSource(sourceId);
  if (!state.sourcesLoaded[sourceId] && (state.map?.getZoom() ?? 0) < fromZoom) {
    hold(registryId);
    return Promise.resolve();
  }
  return fetchSource(sourceId).then(() => {
    if (!state.sourcesLoaded[sourceId]) hold(registryId);
  });
}

function fetchSource(registryId: string): Promise<void> {
  const url = LAYER_DATA_URLS[registryId];
  if (!url || state.sourcesLoaded[registryId]) return Promise.resolve();
  const existing = _inflight[registryId];
  if (existing) return existing;
  _inflight[registryId] = (async () => {
    try {
      const geojson = await fetchGeojson(url);
      state.sourcesLoaded[registryId] = true;
      state.sourcesData[registryId] = geojson.features || [];
      // Stash FeatureCollection-level metadata (generated_utc/feed_status) as a
      // fallback for live layers when `features` is empty — harmless no-op for
      // non-live layers since these keys simply come out undefined.
      if (geojson.generated_utc !== undefined || geojson.feed_status !== undefined) {
        state.liveFcMeta[registryId] = {
          generated_utc: geojson.generated_utc,
          feed_status: geojson.feed_status,
        };
      }
      const src = state.map?.getSource(registryId) as GeoJSONSource | undefined;
      if (src && typeof src.setData === 'function') {
        src.setData(geojson);
      }
      emit('layer:data', { id: registryId });
    } catch (err) {
      console.warn('[TransmissionMap] ensureLayerData failed for', registryId, err);
      recordDiagEvent('layer', `${registryId}: ${err}`);
    } finally {
      delete _inflight[registryId];
    }
  })();
  return _inflight[registryId];
}


export async function fetchGeojson(url: string, init?: RequestInit) {
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} for ${url}`);
  if (url.endsWith(".gz")) {
    const stream = resp.body!.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).json();
  }
  return resp.json();
}
