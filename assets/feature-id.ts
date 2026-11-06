// ─── Stable feature ids ──────────────────────────────────────────────────────
// Role: the one reader of a registry layer's stable-id declaration (`data.id`,
//       src/types.ts). featureId() returns the id a map feature carries — the
//       same value for the same real-world feature across rebuilds, and the key
//       feature-state and id-based calls use. Pure; no map access.
// Imported by: hover.ts (featureId, featureIdExpr),
//              filters.ts (featureIdExpr), dataset-query.ts, popup.ts and
//              user-data/user-data.ts (featureId); ui/ui-table.ts (FeatureId type).
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
