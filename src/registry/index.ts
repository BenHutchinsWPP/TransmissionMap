// Assembles the full LAYERS array from per-group registry files.
// >>> ADD-LAYER: layer-registry — see docs/adding-a-layer.md §5
import { transmissionLayers } from './transmission.js';
import { generatorLayers }    from './generators.js';
import { pipelineLayers }     from './pipelines.js';
import { renewableLayers }    from './renewable.js';
import { landLayers }         from './land.js';
import { regionLayers }       from './regions.js';
import { railLayers }         from './rail.js';
import { hazardLayers }       from './hazards.js';
import type { LayerDef }      from '../types.js';

export const LAYERS = [
  ...transmissionLayers,
  ...generatorLayers,
  ...pipelineLayers,
  ...railLayers,
  ...renewableLayers,
  ...landLayers,
  ...regionLayers,
  ...hazardLayers,
];

export { LAYER_SOURCES } from './sources.js';

const _layerMap: Map<string, LayerDef> = new Map(LAYERS.map(l => [l.id, l]));

export function layerById(id: string): LayerDef | null {
  return _layerMap.get(id) ?? null;
}
