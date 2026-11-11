// MapLibre builders — protected and designated land (PMTiles vector polygons).
// Role: planPadus() (PAD-US, coloured by designation) and planCritHab() (USFWS
//       Critical Habitat, coloured by listing status), each a fill + outline pair;
//       planRouteConstraints() (the Routing constraints raster,
//       nearest resampling, opening on the concern in state).
// Deps: ./layer-init (planPolygon, planRaster), ./layer-plan (LayerPlan type),
//       src/colors/buckets.ts (PADUS_CLASS_BUCKETS, PADUS_CLASS_DEFAULT, CRITHAB_BUCKETS),
//       src/registry (layerById), ../state.ts (routeConcern),
//       ../route-constraints.ts (routeConcernUrl, ROUTE_CONSTRAINTS_ID).
// Called from ./add-all-layers.
import { planPolygon, planRaster } from './layer-init.js';
import type { LayerPlan } from './layer-plan.js';
import { layerById } from '../../src/registry/index.js';
import { state } from '../state.js';
import { routeConcernUrl, ROUTE_CONSTRAINTS_ID } from '../route-constraints.js';
import { bucketColorExpr, PADUS_CLASS_BUCKETS, PADUS_CLASS_DEFAULT, CRITHAB_BUCKETS } from '../../src/colors/buckets.js';

export function planPadus(): LayerPlan {
  return planPolygon({
    sourceId: "padus",
    sourceLayer: "padus", prefix: "padus",
    color: bucketColorExpr("desig", PADUS_CLASS_BUCKETS, PADUS_CLASS_DEFAULT),
    fillMinzoom: 3, fillOpacity: 0.28,
    outlineMinzoom: 6, outlineWidth: 0.6, outlineOpacity: 0.5,
  });
}

export function planCritHab(): LayerPlan {
  return planPolygon({
    sourceId: "crithab",
    sourceLayer: "crithab", prefix: "crithab",
    color: bucketColorExpr("listing_st", CRITHAB_BUCKETS, "#dc2626"),
    fillMinzoom: 3, fillOpacity: 0.30,
    outlineMinzoom: 5, outlineWidth: 0.7, outlineOpacity: 0.6,
  });
}

// The raster source opens on the concern in state (a link or a seeded view);
// a later pick swaps its url (route-constraints.ts setRouteConcern).
export function planRouteConstraints(): LayerPlan {
  if (!layerById(ROUTE_CONSTRAINTS_ID)) return [];
  return planRaster(ROUTE_CONSTRAINTS_ID, { opacity: 0.75, resampling: "nearest" }).map(step =>
    "source" in step ? { ...step, spec: { ...step.spec, url: routeConcernUrl(state.routeConcern) } as typeof step.spec } : step);
}
