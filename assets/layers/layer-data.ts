// ─── Layer data: lazy GeoJSON loading for GeoJSON-backed layers ──────────────
// Imported by: add-all-layers.ts (ensureLayerData — defaultOn bootstrap),
//              visibility.ts (ensureLayerData), map-layers-wecc.ts (ensureLayerData),
//              live-staleness.ts (fetchGeojson, liveGeneratedUtc).
// Deps: state.ts, constants.ts (DATA), state-bus.ts (emits 'layer:data' after a
//       source's features land), diag-log.ts (recordDiagEvent — records
//       ensureLayerData failures for the diagnostics panel); registry/index.ts
//       (layerById — reads a layer's geojson file and fromZoom threshold).
// Where a source's data lives is layerDataUrl(): the registry entry's
// `geojson` DATA key, or SOURCE_DATA_URLS for the two source-only ids.
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

// Sources the loader fills that are not registry layers. A registry layer
// names its file itself, with LayerDef.geojson (a DATA key).
export const SOURCE_DATA_URLS: Record<string, string> = {
  "wecc-path-lines":     DATA.wecc_path_lines,  // fetched by map-layers-wecc.ts for the click highlight
  "weather-admin-lines": DATA.admin_lines,      // loaded via the weather-live alias below
};

/** The GeoJSON URL ensureLayerData() fetches into source `sourceId`, if any:
 *  its registry entry's `geojson` file, else a SOURCE_DATA_URLS row. */
export function layerDataUrl(sourceId: string): string | undefined {
  const key = layerById(sourceId)?.geojson;
  return key ? DATA[key] : SOURCE_DATA_URLS[sourceId];
}

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

// Pull timestamp of a live source: the first feature's `generated_utc`, falling
// back to the FeatureCollection-level value stashed in state.liveFcMeta (needed
// when `features` is empty).
export function liveGeneratedUtc(sourceKey: string): string | undefined {
  const f = state.sourcesData[sourceKey]?.[0] as GeoJSON.Feature | undefined;
  return (f?.properties?.generated_utc as string | undefined)
    ?? state.liveFcMeta[sourceKey]?.generated_utc;
}

function fetchSource(registryId: string): Promise<void> {
  const url = layerDataUrl(registryId);
  if (!url || state.sourcesLoaded[registryId]) return Promise.resolve();
  const existing = _inflight[registryId];
  if (existing) return existing;
  _inflight[registryId] = (async () => {
    try {
      const geojson = await fetchGeojson(url);
      // A live feed's poll may have landed a newer pull while this one was in flight.
      const incoming = (geojson.features?.[0]?.properties?.generated_utc ?? geojson.generated_utc) as string | undefined;
      const current = liveGeneratedUtc(registryId);
      state.sourcesLoaded[registryId] = true;
      if (current && incoming && incoming < current) return;
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
