// ─── Route panel: the HIFLD substation snap index ────────────────────────────
// Role: loads the HIFLD substations once and builds the snap index (route/snap.ts) the route
//       inputs search and snap against. `ensureSubstationIndex()` shares one load; a failed or
//       empty load is an `Outcome` refusal and is forgotten, so the next call retries.
//       `cachedSubstationIndex()` is the index when one is held. Session memory only.
//       `snapEnd()` is the one end snap: a HIFLD substation of known kV ≥ the floor, else (when
//       `osm` is on) the nearest OpenStreetMap substation of known kV ≥ the floor, else a HIFLD
//       substation of unknown kV, else null (the raw point). The OSM points come from
//       lines/osm-substation.ts, imported dynamically on first use; any OSM failure, or no answer within
//       OSM_SNAP_TIMEOUT_MS, reads as no OSM hit.
//       The chat passes `osm: false` (the chat trust model admits HIFLD names only).
// Deps: route/snap.ts (buildSubstationIndex, snapAt, snapAmong), src/outcome.ts (Outcome, type only), state.ts,
//       layers/layer-data.ts (loadSource), layers/layer-source.ts (layerSourceId),
//       lines/osm-substation.ts (substationPointsNear, dynamic import only).

import { buildSubstationIndex, snapAmong, snapAt, type OsmPoint, type SnapHit, type SubstationIndex } from '../route/snap.js';
import type { Outcome } from '../../src/outcome.js';
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

/** The OSM substation points within the box `m` metres around `at`. */
export type OsmPointsRead = (at: [number, number], m: number) => Promise<OsmPoint[]>;

/** How long an end snap waits for the OSM points before it falls back. */
export const OSM_SNAP_TIMEOUT_MS = 4000;

const readOsmPoints: OsmPointsRead = async (at, m) =>
  (await import('../lines/osm-substation.js')).substationPointsNear(at, m);

/** Snap an end at `lngLat` for a `kv` line within `km`: HIFLD known kV → OSM known kV (when `opts.osm`)
 *  → HIFLD unknown kV → null. `index` null skips HIFLD. The OSM read gets `timeoutMs` (OSM_SNAP_TIMEOUT_MS). Never rejects. */
export async function snapEnd(
  index: SubstationIndex | null,
  lngLat: [number, number],
  kv: number,
  km: number,
  opts: { osm: boolean; read?: OsmPointsRead; timeoutMs?: number },
): Promise<SnapHit | null> {
  const hifld = index ? snapAt(index, lngLat, kv, km).best : null;
  if (hifld && !hifld.kvUnknown) return hifld;
  if (opts.osm) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), opts.timeoutMs ?? OSM_SNAP_TIMEOUT_MS); });
      const points = await Promise.race([(opts.read ?? readOsmPoints)(lngLat, km * 1000), late]);
      const osm = snapAmong(points, lngLat, kv, km);
      if (osm) return osm;
    } catch { /* no OSM hit */ } finally { clearTimeout(timer); }
  }
  return hifld;
}
