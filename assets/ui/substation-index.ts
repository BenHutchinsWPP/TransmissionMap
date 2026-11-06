// ─── Route panel: the HIFLD substation snap index ────────────────────────────
// Role: loads the HIFLD substations once and builds the snap index (route/snap.ts) the route
//       inputs search and snap against. `ensureSubstationIndex()` shares one load; a failed or
//       empty load is an `Outcome` refusal and is forgotten, so the next call retries.
//       `cachedSubstationIndex()` is the index when one is held. Session memory only.
// Deps: route/snap.ts (buildSubstationIndex), dataset-query.ts (Outcome, type only), state.ts,
//       layers/layer-data.ts (loadSource), layers/layer-source.ts (layerSourceId).

import { buildSubstationIndex, type SubstationIndex } from '../route/snap.js';
import type { Outcome } from '../dataset-query.js';
import { state } from '../state.js';
import { loadSource } from '../layers/layer-data.js';
import { layerSourceId } from '../layers/layer-source.js';

let index: SubstationIndex | null = null;
let loading: Promise<Outcome<SubstationIndex>> | null = null;

export function cachedSubstationIndex(): SubstationIndex | null { return index; }

/** Test support: forget the held index and any load in flight. */
export function _resetSubstationIndex(): void { index = null; loading = null; }

/** Load the index once; a failed or empty load is reported and forgotten, so the next call tries again. */
export function ensureSubstationIndex(): Promise<Outcome<SubstationIndex>> {
  if (index?.subs.length) return Promise.resolve({ ok: true, result: index });
  loading ??= loadSource('hifld-substations').then(() => {
    const features = (state.sourcesData[layerSourceId('hifld-substations')] ?? []) as GeoJSON.Feature[];
    const idx = buildSubstationIndex({ type: 'FeatureCollection', features });
    if (!idx.subs.length) throw new Error('no substations');
    index = idx;
    return { ok: true as const, result: idx };
  }).catch(() => {
    loading = null;
    return { ok: false as const, reason: 'the substation list could not be loaded; try again' };
  });
  return loading;
}
