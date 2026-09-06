// Layer registry entry — BTS NARN rail network lines.
// Role: pure-data LayerDef for the rail group; consumed by src/registry/index.ts.
// Deps: ../types (LayerDef). No side effects.
import type { LayerDef } from '../types.js';

export const railLayers: LayerDef[] = [
  {
    id:                "railroads",
    urlCode:           "RRL",
    label:             "BTS Railroads",
    titleKey:          "layer.railroads",
    group:             "rail",
    sourceId:          "bts-narn",
    swatch:            "#525252",
    defaultOn:         false,
    lineHighlightKeys: ["RROWNER1", "SUBDIV"],
    mapLayerIds:       ["railroads"],
    regions:           ["usa"],
    downloads: {},
  },
];
