// ─── Click resolution: which feature(s) a map click lands on ──────────────────
// Role: the pure decision behind a map click. Given the features
//       queryRenderedFeatures returned (already in CLICKABLE_LAYERS priority
//       order) and the edit mode, decide what to show: nothing, one feature's
//       popup, a disambiguation picker, or — in edit mode — a Copy-to-My-Data
//       popup, a copy picker, or a "tiled, can't copy" note. No map, DOM or
//       clock: popup.ts queries, calls resolveHits(), and renders the result.
// Deps: odin-outages.ts (outageFeatureLit), fema-nri.ts (nriFeatureLit),
//       nws-zone-join.ts (zoneFeatureLit) — each owner's "feature is painted"
//       predicate. Imported by popup.ts (resolveHits for clicks, hitLit for the hover
//       cursor); tested by click-resolve.test.ts.

import { outageFeatureLit } from './odin-outages.js';
import { nriFeatureLit } from './fema-nri.js';
import { zoneFeatureLit } from './nws-zone-join.js';

// The slice of a MapGeoJSONFeature the decision reads, so tests can pass plain
// objects.
export interface HitFeature {
  id?: string | number;
  layer: { id: string };
  sourceLayer?: string;
  state?: Record<string, unknown>;
  properties?: Record<string, unknown> | null;
}

export type ClickResolution<F> =
  | { kind: 'none' }
  | { kind: 'single'; feature: F }
  | { kind: 'picker'; features: F[] }
  | { kind: 'copy'; feature: F }
  | { kind: 'copy-picker'; features: F[] }
  | { kind: 'not-copyable' };

// Feature-state-joined choropleths (ODIN outages, FEMA NRI, NWS zone/county) draw EVERY
// county/zone from the shared boundary tiles and paint unlit ones transparent
// (setFilter can't read feature-state), but queryRenderedFeatures still
// hit-tests transparent fills. Each owner's predicate mirrors its layer's
// paint; a feature is a valid hit only when it's actually painted.
const HIT_LIT: Record<string, (s: Record<string, unknown> | undefined) => boolean> = {
  "odin-outages-fill": outageFeatureLit,
  "fema-nri-fill":     nriFeatureLit,
  "nws-zone-fill":     zoneFeatureLit,
  "nws-county-fill":   zoneFeatureLit,
};
export function hitLit(f: HitFeature): boolean {
  return HIT_LIT[f.layer.id]?.(f.state) ?? true;
}

export function resolveHits<F extends HitFeature>(
  features: readonly F[], mode: 'view' | 'edit',
): ClickResolution<F> {
  // Dedupe tile-boundary duplicates: queryRenderedFeatures repeats a feature once
  // per tile it straddles, vector tiles and GeoJSON sources alike (MapLibre tiles a
  // GeoJSON source internally, so a state-sized polygon comes back many times).
  // A feature with an id is keyed by it; one without (most GeoJSON layers) by its
  // properties, which every repeat shares and distinct features do not (My Data
  // features carry a unique __uid).
  const uniq: F[] = [];
  const seen = new Set<string>();
  for (const ft of features) {
    if (!hitLit(ft)) continue;
    const key = ft.layer.id + '|' + (ft.id != null ? String(ft.id) : JSON.stringify(ft.properties ?? {}));
    if (!seen.has(key)) { seen.add(key); uniq.push(ft); }
  }

  if (mode === 'edit') {
    // Vector-tile (PMTiles) features carry a sourceLayer and are clipped at tile
    // borders, so copies would be truncated — only allow GeoJSON-backed features.
    const copyable = uniq.filter(ft => !ft.sourceLayer);
    if (copyable.length > 1) return { kind: 'copy-picker', features: copyable };
    if (copyable.length === 1) return { kind: 'copy', feature: copyable[0] };
    return uniq.length ? { kind: 'not-copyable' } : { kind: 'none' };
  }

  if (!uniq.length) return { kind: 'none' };
  return uniq.length > 1 ? { kind: 'picker', features: uniq } : { kind: 'single', feature: uniq[0] };
}
