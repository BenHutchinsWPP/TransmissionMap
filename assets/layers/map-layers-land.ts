// MapLibre builders — protected and designated land (PMTiles vector polygons).
// Role: planPadus() (PAD-US, coloured by designation) and planCritHab() (USFWS
//       Critical Habitat, coloured by listing status), each a fill + outline pair.
// Deps: ./layer-init (planPolygon), ./layer-plan (LayerPlan type),
//       src/colors/buckets.ts (PADUS_CLASS_BUCKETS, PADUS_CLASS_DEFAULT, CRITHAB_BUCKETS).
// Called from ./add-all-layers.
import { planPolygon } from './layer-init.js';
import type { LayerPlan } from './layer-plan.js';
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

