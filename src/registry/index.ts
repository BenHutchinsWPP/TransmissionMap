// Assembles the full LAYERS array from per-group registry files; layerById()
// looks a layer up and displayModes() lists the display modes it offers.
// >>> ADD-LAYER: layer-registry — see docs/adding-a-layer.md §5
import { transmissionLayers } from './transmission.js';
import { generatorLayers }    from './generators.js';
import { pipelineLayers }     from './pipelines.js';
import { renewableLayers }    from './renewable.js';
import { landLayers }         from './land.js';
import { regionLayers }       from './regions.js';
import { railLayers }         from './rail.js';
import { conditionLayers }    from './conditions.js';
import type { LayerDef }      from '../types.js';

export const LAYERS = [
  ...transmissionLayers,
  ...generatorLayers,
  ...pipelineLayers,
  ...railLayers,
  ...renewableLayers,
  ...landLayers,
  ...regionLayers,
  ...conditionLayers,
];

export { LAYER_SOURCES, REGION_CODE_MAP } from './sources.js';

const _layerMap: Map<string, LayerDef> = new Map(LAYERS.map(l => [l.id, l]));

export function layerById(id: string): LayerDef | null {
  return _layerMap.get(id) ?? null;
}

// The display modes a layer offers: its `modes` ids, else icons/heat/both for a
// layer with a heat layer, else none.
export function displayModes(entry: LayerDef): string[] {
  return entry.modes ? entry.modes.map(m => m.id) : entry.heatLayerId ? ['icons', 'heat', 'both'] : [];
}
