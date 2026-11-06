// ─── Proximity sample: HIFLD substations in the view (pure) ──────────────────
// Role: viewBox (a map's bounds → a longitude-wrapped box), inBox, and cutSample(geojson, box, cap):
//       the Point features inside the box as columns (lon, lat, and per feature name, hifld_id,
//       max_kv, kv_range as text), refused with the count above `cap` and with kind 'none' at zero.
//       The sample worker (sample-worker.ts) runs it over the downloaded layer; tests run it directly.
// Deps: none. Used by sample-worker.ts and ui-proximity.ts (viewBox, SAMPLE_FIELDS, SAMPLE_CAP).

export const SAMPLE_CAP = 15_000;
/** The properties kept per substation, in this order. */
export const SAMPLE_FIELDS = ['name', 'hifld_id', 'max_kv', 'kv_range'] as const;

/** west ≤ east, or west > east when the box crosses the antimeridian. */
export interface Box { w: number; s: number; e: number; n: number }

const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;

export function viewBox(b: { west: number; south: number; east: number; north: number }): Box {
  const s = Math.max(-90, Math.min(90, b.south)), n = Math.max(-90, Math.min(90, b.north));
  if (b.east - b.west >= 360) return { w: -180, s, e: 180, n };
  return { w: wrap(b.west), s, e: wrap(b.east), n };
}

export function inBox(lon: number, lat: number, b: Box): boolean {
  if (lat < b.s || lat > b.n) return false;
  return b.w <= b.e ? lon >= b.w && lon <= b.e : lon >= b.w || lon <= b.e;
}

export type SampleCut =
  | { kind: 'ok'; lon: Float64Array; lat: Float64Array; props: string[][] }
  | { kind: 'none' }
  | { kind: 'tooMany'; n: number };

export function cutSample(fc: unknown, box: Box, cap = SAMPLE_CAP): SampleCut {
  const feats = (fc as { features?: unknown }).features;
  if (!Array.isArray(feats)) throw new TypeError('not a FeatureCollection');
  const lon: number[] = [], lat: number[] = [], props: string[][] = [];
  let n = 0;
  for (const f of feats as { geometry?: { type?: string; coordinates?: number[] }; properties?: Record<string, unknown> }[]) {
    const g = f?.geometry;
    if (g?.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
    const [x, y] = g.coordinates;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !inBox(x, y, box)) continue;
    n++;
    if (n > cap) continue;
    lon.push(x); lat.push(y);
    props.push(SAMPLE_FIELDS.map(k => String(f.properties?.[k] ?? '')));
  }
  if (n === 0) return { kind: 'none' };
  if (n > cap) return { kind: 'tooMany', n };
  return { kind: 'ok', lon: Float64Array.from(lon), lat: Float64Array.from(lat), props };
}
