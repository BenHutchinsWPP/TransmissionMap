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
import { addWildfireHazard, addWildfireLiveAreas, addWildfireLivePoints, addSeismicHazard, addOdinOutages, addNwsAlerts, addNexradRadar } from './map-layers-conditions.js';
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

  addRetailTerritories();
  addControlAreas();
  addNercRegions();

  addPadus();
  addTribalLands();
  addBiaTribalLands();
  addCritHab();

  // Live-conditions fills sit above static context fills (land/regions):
  // "what's happening now" beats "what's always there".
  addOdinOutages();        // live county-outage choropleth
  addNwsAlerts();          // live GeoJSON — weather alert polygons; above land fills, below infra vectors
  addWildfireLiveAreas();  // live GeoJSON — smoke + perimeter POLYGONS; above NWS, below infra vectors
  addNexradRadar();        // live raster — external IEM tiles; above all area polygons, below infra vectors

  addOsmSubstationPolygons();
  addOsmPlantPolygons();

  // Line stack: rail is context (bottom), pipelines mid, transmission is the
  // star of the map so it wins line-crossing overlaps (top).
  addRailroads();

  addHifldNatgasLines();
  addPetroleumPipelines();
  addPipelineLines();

  addHifldTransmission();
  addOsmTransmission();
  addOGFPlannedTransmission();

  addOsmSubstationPoints();
  addHifldSubstationPoints();

  // Point layers below draw above substation dots: gas points, generators,
  // data centers, mines — smaller/sparser markers stay clickable on top.
  addPipelinePoints();
  addHifldNatgasPts();
  addGeoHydroPts();

  addOsmPlants();
  addEiaGenerators();
  addOsmGenerators();
  addOsmDataCenters();

  addMines();           // above lines + substations

  addWildfireLivePoints();  // hotspot heat/circles + incident POINTS — stay above infra like other markers

  addWeccPaths();   // path-number markers sit on top of infrastructure

  addHighlightLayers();

  for (const layer of LAYERS) {
    if (state.layerVisibility[layer.id]) {
      ensureLayerData(layer.id);
      if (RASTER_PROBES[layer.id]) ensureRasterLut(layer.id);
    }
  }
}
