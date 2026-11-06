// Guards the OSM transmission registry entry: one world archive, one style
// layer per tier and overlay, every built layer listed so visibility reaches it.
import { describe, it, expect } from 'vitest';
import { DATA } from '../../assets/constants.js';
import { layerById } from './index.js';
import { OSM_TL_TIERS, OSM_TL_POPUP_IDS } from './transmission.js';

describe('OSM transmission', () => {
  it('reads the one world archive', () => {
    const entry = layerById('osm-transmission-lines')!;
    expect(entry.data!.key).toBe('osm_transmission_lines');
    expect(DATA.osm_transmission_lines).toContain('osm_transmission_lines.pmtiles');
  });

  it('lists every built style layer in mapLayerIds', () => {
    // visibility.ts toggles exactly these; one missing means part of the layer
    // ignores its checkbox.
    const entry = layerById('osm-transmission-lines')!;
    const built = [...OSM_TL_TIERS.map(t => t.id), 'dc', 'dc-label', 'label'].map(p => `osm-transmission-lines-${p}`);
    expect([...entry.mapLayerIds].sort()).toEqual([...built].sort());
    expect(new Set(entry.mapLayerIds).size).toBe(entry.mapLayerIds.length);
  });

  it('popup ids are registered style layers, highest voltage first', () => {
    const entry = layerById('osm-transmission-lines')!;
    for (const id of OSM_TL_POPUP_IDS) expect(entry.mapLayerIds, id).toContain(id);
    expect(OSM_TL_POPUP_IDS[0]).toBe('osm-transmission-lines-hv');
  });
});
