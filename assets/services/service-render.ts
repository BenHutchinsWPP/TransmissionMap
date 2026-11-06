// assets/services/service-render.ts — draws `state.services` on the map: the one
// place service sources and `svc-` layers are added, updated and removed, by
// diffing the services in view state against what the map holds. A service is
// drawn only when service-trust.ts's isAllowed() says so (its URL is vetted,
// or the visitor approved it this session); any other gets no source — nothing
// is fetched — and the status 'pending-approval'. Sources and layers are added
// directly (not through applyLayerPlan, which reads registry visibility),
// below the first My Data / highlight / draw layer. Idempotent; a no-op
// before the map has loaded. A feature service is (re)loaded only when its
// source is new or changed, no loader runs for it, or it was just switched
// on; otherwise its loader is handed the current copy and the moveend refresh
// does the rest, so a repaint (undo, a story, Reset) re-downloads nothing.
// A source carries no `attribution`: MapLibre renders that as HTML, and a
// service's credit is untrusted text (shown escaped in the popup and Data Credits).
// Library ids: a service's `libraryId` is kept only when the library entry it
// names has the same url, kind and layer (checked once the library chunk —
// src/registry/service-library.json, a dynamic import — has loaded); a kept
// one takes the library's own title and credit, and a mismatched one is
// dropped from state.services (no 'url:write': the next commit carries it).
// serviceLibraryEntry() is the only way to the library's badge and licence,
// and answers nothing until the library has loaded and the entry matches.
// Deps: state.ts, service-spec.ts (styleToLayers, SERVICE_LAYER_PREFIX),
//       service-trust.ts (isAllowed), service-load.ts (feature loading +
//       status), layers/layer-plan.ts (setMapLayerVisibility),
//       src/registry/service-library.json (dynamic).
import type { LayerSpecification } from 'maplibre-gl';
import { state } from '../state.js';
import { SERVICE_LAYER_PREFIX, styleToLayers, type LinkedService } from './service-spec.js';
import { isAllowed } from './service-trust.js';
import { loadService, keepService, unloadService, setServiceStatus } from './service-load.js';
import { setMapLayerVisibility } from '../layers/layer-plan.js';

/** Layers services draw beneath: My Data, the search/table/user highlights and the draw control. */
const ABOVE_SERVICES = /^(user-|highlight-|gl-draw-)/;

interface Drawn { sourceKey: string; layersKey: string; layers: LayerSpecification[]; visible: boolean }
const drawn = new Map<string, Drawn>();

// ─── library ids ─────────────────────────────────────────────────────────────

export interface LibraryEntry {
  id: string; title: string; category: string; kind: LinkedService['kind']; url: string; layer?: string;
  credit: string; licence: string; source: string; host: string; description: string;
}
let library: LibraryEntry[] | null = null;
let libraryLoad: Promise<void> | null = null;

/** The library entry this service is, or undefined: its libraryId names an
 *  entry with the same url, kind and layer. Undefined until the library has loaded. */
export function serviceLibraryEntry(s: LinkedService): LibraryEntry | undefined {
  const e = s.libraryId === undefined ? undefined : library?.find(x => x.id === s.libraryId);
  return e && e.url === s.url && e.kind === s.kind && e.layer === s.layer ? e : undefined;
}

function honestLibraryIds(): void {
  const next = state.services.map(s => {
    if (s.libraryId === undefined) return s;
    const e = serviceLibraryEntry(s);
    if (!e) {
      const rest = { ...s };
      delete rest.libraryId;
      return rest;
    }
    return e.title === s.title && e.credit === s.credit ? s : { ...s, title: e.title, credit: e.credit };
  });
  if (next.some((s, i) => s !== state.services[i])) state.services = next;
}

/** Resolves once the library is loaded and the view's library ids checked (for tests). */
export function libraryChecked(): Promise<void> {
  return libraryLoad ?? Promise.resolve();
}

function checkLibraryIds(): void {
  if (!state.services.some(s => s.libraryId !== undefined)) return;
  if (library) { honestLibraryIds(); return; }
  libraryLoad ??= import('../../src/registry/service-library.json').then(
    m => { library = m.default as unknown as LibraryEntry[]; renderServices(); },
    () => { libraryLoad = null; },
  );
}

// ─── drawing ─────────────────────────────────────────────────────────────────

function removeDrawn(id: string) {
  const map = state.map!;
  const d = drawn.get(id);
  for (const l of d?.layers ?? []) if (map.getLayer(l.id)) map.removeLayer(l.id);
  if (map.getSource(SERVICE_LAYER_PREFIX + id)) map.removeSource(SERVICE_LAYER_PREFIX + id);
  drawn.delete(id);
  unloadService(id);
}

function beforeId(): string | undefined {
  return state.map!.getStyle()?.layers?.find(l => ABOVE_SERVICES.test(l.id))?.id;
}

export function renderServices(): void {
  checkLibraryIds();
  const map = state.map;
  if (!map || !state.mapReady) return;
  const allowed = new Map<string, LinkedService>();
  for (const s of state.services) {
    if (isAllowed(s)) allowed.set(s.id, s);
    else setServiceStatus(s.id, { state: 'pending-approval' });
  }
  for (const id of [...drawn.keys()]) {
    if (allowed.has(id)) continue;
    removeDrawn(id);
    if (!state.services.some(s => s.id === id)) setServiceStatus(id, undefined);
  }
  for (const s of allowed.values()) {
    const { sourceId, source, layers } = styleToLayers(s);
    const sourceKey = JSON.stringify([s.kind, s.url, s.layer, s.version]);
    const layersKey = JSON.stringify(layers.map(l => [l.id, l.type, l.minzoom]));
    const prev = drawn.get(s.id);
    const fresh = !prev || prev.sourceKey !== sourceKey || !map.getSource(sourceId);
    if (fresh || prev.layersKey !== layersKey) {
      if (fresh) {
        if (prev || map.getSource(sourceId)) removeDrawn(s.id);
        map.addSource(sourceId, source);
      } else {
        for (const l of prev.layers) if (map.getLayer(l.id)) map.removeLayer(l.id);
      }
      const before = beforeId();
      for (const l of layers) map.addLayer(l, before);
    } else {
      for (const l of layers) {
        const old = prev.layers.find(o => o.id === l.id);
        const paint = (l.paint ?? {}) as Record<string, unknown>;
        const oldPaint = (old?.paint ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(paint))
          if (JSON.stringify(v) !== JSON.stringify(oldPaint[k])) map.setPaintProperty(l.id, k as Parameters<typeof map.setPaintProperty>[1], v as Parameters<typeof map.setPaintProperty>[2]);
        const vis = s.visible ? 'visible' : 'none';
        if ((old?.layout as { visibility?: string } | undefined)?.visibility !== vis) setMapLayerVisibility(map, l.id, vis);
      }
    }
    drawn.set(s.id, { sourceKey, layersKey, layers, visible: s.visible });
    if (fresh || (s.visible && !prev.visible) || !keepService(s)) void loadService(s, fresh);
  }
}
