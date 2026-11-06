// Role: shared helpers for the GeoJSON overlays of the lazy panels (route `rp-`, proximity `px-`, line `lt-`):
//       add-or-update a GeoJSON source, remove a list of layers and sources. Each panel keeps its own addLayer.
// Deps: state.ts (the map); maplibre-gl types only. Imports no lazy chunk.
import type { GeoJSONSource } from 'maplibre-gl';
import { state } from '../state.js';

export function setGeojson(id: string, data: GeoJSON.FeatureCollection | GeoJSON.Feature, buffer?: number): void {
  const map = state.map;
  if (!map) return;
  const src = map.getSource(id) as GeoJSONSource | undefined;
  if (src) src.setData(data);
  else map.addSource(id, buffer === undefined ? { type: 'geojson', data } : { type: 'geojson', data, buffer });
}

export function removeOverlay(layerIds: string[], sourceIds: string[]): void {
  const map = state.map;
  if (!map) return;
  for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of sourceIds) if (map.getSource(id)) map.removeSource(id);
}
