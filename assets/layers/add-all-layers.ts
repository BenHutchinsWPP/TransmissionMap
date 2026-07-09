// ─── addAllLayers orchestrator ────────────────────────────────────────────────
// Imports from layer-init.ts (helpers) and map-layers-*.ts (builders).
// Isolated here so layer-init.ts has no back-imports from map-layers-*.ts.
// >>> ADD-LAYER: add-all-layers — see docs/adding-a-layer.md §7

import { state } from '../state.js';
import { LAYERS } from '../../src/registry/index.js';
import { ensureLayerData, addPadus, addCritHab } from './layer-init.js';
import { RASTER_PROBES, ensureRasterLut } from '../raster-probes.js';
import {
  addOsmTransmission, addOsmSubstationPoints, addOsmSubstationPolygons,
  addOsmPlantPolygons, addOsmPlants, addOsmGenerators, addPipelineLines, addPipelinePoints,
} from './map-layers-osm.js';
import {
  addHifldTransmission, addHifldSubstationPoints, addTribalLands, addBiaTribalLands,
  addHifldNatgasLines, addHifldNatgasPts, addNercRegions, addControlAreas,
  addOGFPlannedTransmission, addRetailTerritories,
} from './map-layers-hifld.js';
import { addWindResource, addSolarResource, addGeoResource, addGeoHydroPts } from './map-layers-renewable.js';
import { addEiaGenerators } from './map-layers-eia.js';
import { addPopDensity, addOsmDataCenters } from './map-layers-load.js';
import { addRailroads } from './map-layers-rail.js';
import { addWeccPaths } from './map-layers-wecc.js';
import { addPetroleumPipelines } from './map-layers-petroleum.js';
import { addWildfireHazard, addWildfireLive, addSeismicHazard } from './map-layers-hazards.js';
import { addMines } from './map-layers-mines.js';
import { addHighlightLayers } from '../highlights.js';

// >>> ADD-LAYER: add-all-layers
export function addAllLayers() {
  addPopDensity();
  addSolarResource();
  addWindResource();
  addGeoResource();
  addSeismicHazard();   // raster — sits low so vector infra draws on top
  addWildfireHazard();  // raster — sits low so vector infra draws on top
  addWildfireLive();    // live GeoJSON — smoke + perimeters + hotspots + incidents (one source)

  addRetailTerritories();
  addControlAreas();
  addNercRegions();

  addPadus();
  addTribalLands();
  addBiaTribalLands();
  addCritHab();
  addMines();

  addOsmSubstationPolygons();
  addOsmPlantPolygons();

  addHifldTransmission();
  addOsmTransmission();
  addOGFPlannedTransmission();

  addRailroads();

  addHifldNatgasLines();
  addPetroleumPipelines();
  addPipelineLines();
  addPipelinePoints();
  addHifldNatgasPts();
  addGeoHydroPts();

  addOsmPlants();
  addEiaGenerators();
  addOsmGenerators();
  addOsmDataCenters();  // load points sit above lines, below substation dots

  addOsmSubstationPoints();
  addHifldSubstationPoints();

  addWeccPaths();   // path-number markers sit on top of infrastructure

  addHighlightLayers();

  for (const layer of LAYERS) {
    if (state.layerVisibility[layer.id]) {
      ensureLayerData(layer.id);
      if (RASTER_PROBES[layer.id]) ensureRasterLut(layer.id);
    }
  }
}
