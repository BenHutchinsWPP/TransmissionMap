// ─── addAllLayers orchestrator ────────────────────────────────────────────────
// Collects every builder's LayerPlan in z-order and applies them in one
// applyLayerPlan() call (layer-plan.ts); then runs the few non-layer side
// effects (hatch images first, then the radar poll and the data-centre and
// WECC tap wiring) and starts the data fetches for layers already on.
// Imports from layer-init.ts (helpers), layer-plan.ts (applyLayerPlan),
// layer-data.ts (ensureLayerData) and map-layers-*.ts (builders).
// Isolated here so layer-init.ts has no back-imports from map-layers-*.ts.
// >>> ADD-LAYER: add-all-layers — see docs/adding-a-layer.md §7

import { state } from '../state.js';
import { LAYERS } from '../../src/registry/index.js';
import { planPadus, planCritHab } from './layer-init.js';
import { applyLayerPlan } from './layer-plan.js';
import { ensureLayerData } from './layer-data.js';
import { RASTER_PROBES, ensureRasterLut } from '../raster-probes.js';
import {
  planOsmTransmission, planOsmSubstationPoints, planOsmSubstationPolygons,
  planOsmPlantPolygons, planOsmPlants, planOsmGenerators, planPipelineLines, planPipelinePoints,
} from './map-layers-osm.js';
import {
  planHifldTransmission, planHifldSubstationPoints, planTribalLands, planBiaTribalLands,
  planHifldNatgasLines, planHifldNatgasPts, planNercRegions, planControlAreas,
  planOGFPlannedTransmission, planRetailTerritories,
} from './map-layers-hifld.js';
import { planWindResource, planSolarResource, planGeoResource, planGeoHydroPts, planBoemWindLeases } from './map-layers-renewable.js';
import { planEiaGenerators, planEiaBalancingAuthorities } from './map-layers-eia.js';
import {
  planPopDensity, planOsmDataCenters, planDcMoratoriumAreas, planDcMoratoriumPoints,
  addDcmHatchImages, wireOsmDataCenters,
} from './map-layers-load.js';
import { planRailroads } from './map-layers-rail.js';
import { planWeccPaths, wireWeccPaths } from './map-layers-wecc.js';
import { planPetroleumPipelines } from './map-layers-petroleum.js';
import { planWestTEC } from './map-layers-westtec.js';
import {
  planWildfireHazard, planWildfireLiveAreas, planWildfireLivePoints, planSeismicHazard, planOdinOutages,
  planFemaNri, planNwsAlerts, planNexradRadar, planWeatherLive, startNexradRadar,
} from './map-layers-conditions.js';
import { planMines } from './map-layers-mines.js';
import { planCountries, planAdmin1, planUsStates, planUsCounties, planUsZcta } from './map-layers-admin.js';
import { addHighlightLayers } from '../highlights.js';

// >>> ADD-LAYER: add-all-layers
export function addAllLayers() {
  const map = state.map;
  if (!map) return;
  addDcmHatchImages(map);
  applyLayerPlan(map, [
    // Bottom-most: the temperature mosaic is a full-coverage wash — anywhere higher
    // in the stack it would veil every polygon layer under it.
    ...planWeatherLive(),    // live raster — ~3-hourly GFS weather fields
    ...planPopDensity(),
    ...planSolarResource(),
    ...planWindResource(),
    ...planGeoResource(),
    ...planSeismicHazard(),   // raster — sits low so vector infra draws on top
    ...planWildfireHazard(),  // raster — sits low so vector infra draws on top

    ...planRetailTerritories(),
    ...planEiaBalancingAuthorities(),
    ...planControlAreas(),
    ...planNercRegions(),

    // Administrative reference boundaries: broadest first so more detailed
    // outlines draw on top. us-counties mounts on the shared county_boundaries
    // source ahead of planOdinOutages() below, so the live outage choropleth
    // paints over these plain outlines rather than under them.
    ...planCountries(),
    ...planAdmin1(),
    ...planUsStates(),
    ...planUsCounties(),
    ...planUsZcta(),

    ...planPadus(),
    ...planTribalLands(),
    ...planBiaTribalLands(),
    ...planCritHab(),
    ...planBoemWindLeases(),
    ...planDcMoratoriumAreas(),  // state/county moratorium fills — with the static context fills

    // Live-conditions fills sit above static context fills (land/regions):
    // "what's happening now" beats "what's always there".
    ...planFemaNri(),            // FEMA NRI county risk choropleth — under the live outages
    ...planOdinOutages(),        // live county-outage choropleth
    ...planNwsAlerts(),          // live GeoJSON — weather alert polygons; above land fills, below infra vectors
    ...planWildfireLiveAreas(),  // live GeoJSON — smoke + perimeter POLYGONS; above NWS, below infra vectors
    ...planNexradRadar(),        // live raster — external IEM tiles; above all area polygons, below infra vectors

    ...planOsmSubstationPolygons(),
    ...planOsmPlantPolygons(),

    // Line stack: rail is context (bottom), pipelines mid, transmission is the
    // star of the map so it wins line-crossing overlaps (top).
    ...planRailroads(),

    ...planHifldNatgasLines(),
    ...planPetroleumPipelines(),
    ...planPipelineLines(),

    ...planHifldTransmission(),
    ...planOsmTransmission(),
    ...planOGFPlannedTransmission(),
    ...planWestTEC(),

    ...planOsmSubstationPoints(),
    ...planHifldSubstationPoints(),

    // Point layers below draw above substation dots: gas points, generators,
    // data centers, mines — smaller/sparser markers stay clickable on top.
    ...planPipelinePoints(),
    ...planHifldNatgasPts(),
    ...planGeoHydroPts(),

    ...planOsmPlants(),
    ...planEiaGenerators(),
    ...planOsmGenerators(),
    ...planOsmDataCenters(),
    ...planDcMoratoriumPoints(), // city/town/township moratorium points, above the data centers

    ...planMines(),           // above lines + substations

    ...planWildfireLivePoints(),  // hotspot heat/circles + incident POINTS — stay above infra like other markers

    ...planWeccPaths(),   // path-number markers sit on top of infrastructure
  ]);
  startNexradRadar();
  wireOsmDataCenters();
  wireWeccPaths();

  addHighlightLayers();

  for (const layer of LAYERS) {
    if (state.layerVisibility[layer.id]) {
      ensureLayerData(layer.id);
      if (RASTER_PROBES[layer.id]) ensureRasterLut(layer.id);
    }
  }
}
