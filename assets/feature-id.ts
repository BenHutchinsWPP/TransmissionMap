// ─── Stable feature ids ──────────────────────────────────────────────────────
// Role: the one reader of a registry layer's stable-id declaration (`data.id`,
//       src/types.ts). featureId() returns the id a map feature carries — the
//       same value for the same real-world feature across rebuilds, and the key
//       feature-state and id-based calls use. osmRef() decodes an OSM `fid`
//       (osm_id × 10 + type digit: 1 node, 2 way, 3 relation) into the
//       openstreetmap.org object it names. Pure; no map access.
// Imported by: popup-format.ts (osmRef), hover.ts (featureId, featureIdExpr).
// Deps: src/registry/index.ts (layerById).

import type { ExpressionSpecification } from 'maplibre-gl';
import { layerById } from '../src/registry/index.js';

export type FeatureId = string | number;

interface FeatureLike {
  id?: FeatureId | null;
  properties?: Record<string, unknown> | null;
}

/** The stable id of `feature`, drawn by registry layer `layerId`, or undefined
 *  when the layer declares none or the feature lacks it. A native id is the
 *  tile feature id; a promoted one is feature.id (MapLibre sets it from
 *  promoteId) with the property itself as the fallback for a plain object. */
export function featureId(layerId: string, feature: FeatureLike): FeatureId | undefined {
  const decl = layerById(layerId)?.data?.id;
  if (!decl) return undefined;
  const v = decl.native ? feature.id : feature.id ?? feature.properties?.[decl.field];
  return typeof v === 'string' || typeof v === 'number' ? v : undefined;
}

/** The expression that reads registry layer `layerId`'s stable id inside a
 *  filter: the tile feature id for a native id, else its column. */
export function featureIdExpr(layerId: string): ExpressionSpecification | undefined {
  const decl = layerById(layerId)?.data?.id;
  if (!decl) return undefined;
  return decl.native ? ['id'] : ['get', decl.field];
}

const OSM_TYPES = [undefined, 'node', 'way', 'relation'] as const;
export type OsmRef = { type: 'node' | 'way' | 'relation'; id: number };

/** An OSM `fid` (number or digit string) → its element type and OSM id, or
 *  null when it is not one: last digit 1/2/3, osm id ≥ 1, below 2^53. */
export function osmRef(fid: unknown): OsmRef | null {
  const n = typeof fid === 'number' ? fid : typeof fid === 'string' && /^\d+$/.test(fid) ? Number(fid) : NaN;
  if (!Number.isSafeInteger(n) || n < 11) return null;
  const type = OSM_TYPES[n % 10];
  return type ? { type, id: Math.floor(n / 10) } : null;
}
