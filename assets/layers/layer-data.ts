// ─── Layer data: lazy GeoJSON loading for GeoJSON-backed layers ──────────────
// Imported by: add-all-layers.ts (ensureLayerData — defaultOn bootstrap),
//              visibility.ts (ensureLayerData), map-layers-wecc.ts (ensureLayerData),
//              live-staleness.ts (fetchGeojson, liveGeneratedUtc),
//              ../dataset-query.ts (loadSource, liveGeneratedUtc),
//              ui/ui-legends.ts + ../diagnostics.ts (liveFeed — pull time and
//              subfeed status, one precedence for every display).
// Deps: state.ts, state-bus.ts (emits 'layer:data' after a source's features
//       land), diag-log.ts (recordDiagEvent — records ensureLayerData failures
//       for the diagnostics panel); registry/index.ts (layerById — reads a
//       layer's fromZoom threshold); layer-source.ts (layerDataUrl,
//       layerSourceId — which file, into which source).
// ensureLayerData's contract: "fetch this if the zoom allows" — a source
// whose LayerDef sets fromZoom is withheld below that zoom (for every registry
// id that shares it, per layerSourceId(), too), so every caller
// (bootstrap defaultOn loops included) can call it unconditionally and rely
// on the gate rather than checking zoom itself. A held id is retried on each
// 'zoomend' (one listener, attached on the first hold), so a layer switched on
// while zoomed out still loads once the map reaches its threshold. A gated
// layer whose fetch fails is held again, so the next zoom settle retries it.
// loadSource is the same fetch without the gate, for a query the user asked
// for: it fills state.sourcesData and the (hidden) map source, and never
// touches visibility or the URL, so a later switch-on reuses the load.

import type { GeoJSONSource } from 'maplibre-gl';
import { state } from '../state.js';
import { emit } from '../state-bus.js';
import { recordDiagEvent } from '../diag-log.js';
import { layerById } from '../../src/registry/index.js';
import { layerDataUrl, layerSourceId } from './layer-source.js';

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
  const sourceId = layerSourceId(registryId);
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

/** Fetch registry layer `registryId`'s GeoJSON source now, whatever the zoom. */
export function loadSource(registryId: string): Promise<void> {
  return fetchSource(layerSourceId(registryId));
}

// A live source's pull time and per-subfeed status: the first feature's
// properties, falling back to the FeatureCollection-level values stashed in
// state.liveFcMeta (needed when `features` is empty). `feedLastOk` is written
// at FeatureCollection level only.
export interface LiveFeed {
  generatedUtc?: string;
  feedStatus?: Record<string, string>;
  feedLastOk?: Record<string, string | null>;
}
export function liveFeed(sourceKey: string): LiveFeed {
  const first = (state.sourcesData[sourceKey]?.[0] as GeoJSON.Feature | undefined)?.properties;
  const meta = state.liveFcMeta[sourceKey];
  return {
    generatedUtc: (first?.generated_utc as string | undefined) ?? meta?.generated_utc,
    feedStatus: (first?.feed_status as Record<string, string> | undefined) ?? meta?.feed_status,
    feedLastOk: meta?.feed_last_ok,
  };
}

export function liveGeneratedUtc(sourceKey: string): string | undefined {
  return liveFeed(sourceKey).generatedUtc;
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
      // Stash FeatureCollection-level metadata (generated_utc/feed_status/feed_last_ok) as a
      // fallback for live layers when `features` is empty — harmless no-op for
      // non-live layers since these keys simply come out undefined.
      if (geojson.generated_utc !== undefined || geojson.feed_status !== undefined) {
        state.liveFcMeta[registryId] = {
          generated_utc: geojson.generated_utc,
          feed_status: geojson.feed_status,
          feed_last_ok: geojson.feed_last_ok,
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
