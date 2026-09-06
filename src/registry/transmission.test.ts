// Guards the OSM transmission voltage split. The layer is spread over six
// PMTiles archives because one world file is past the host's 100 MiB per-file
// ceiling (docs/hosting-plan.md). Every failure mode below is silent at runtime:
// the map still renders, it just stops responding above some voltage.
import { describe, it, expect } from 'vitest';
import { DATA } from '../../assets/constants.js';
import { layerById } from './index.js';
import { OSM_TL_BANDS, OSM_TL_TIERS, osmTlLayerIds } from './transmission.js';

describe('OSM transmission voltage split', () => {
  it('covers the whole voltage range with no gap or overlap', () => {
    // -1 encodes unknown, so the bottom band must be open below or 18% of the
    // layer lands in no archive at all.
    expect(OSM_TL_BANDS[0]!.kv[0]).toBe(-Infinity);
    expect(OSM_TL_BANDS.at(-1)!.kv[1]).toBe(Infinity);
    for (const [prev, band] of OSM_TL_BANDS.map((b, i) => [OSM_TL_BANDS[i - 1], b] as const).slice(1)) {
      expect(band.kv[0], `band ${band.suffix} must start where the previous ended`).toBe(prev!.kv[1]);
    }
  });

  it('names a real DATA key for every archive', () => {
    for (const b of OSM_TL_BANDS) {
      expect(DATA, b.dataKey).toHaveProperty(b.dataKey);
      expect(DATA[b.dataKey as keyof typeof DATA]).toContain(`${b.suffix || '_kv0'}`.replace('-', '_'));
    }
  });

  it('gives every tier a layer on each archive that can hold it', () => {
    for (const t of OSM_TL_TIERS) {
      const ids = osmTlLayerIds(t.id);
      const holders = OSM_TL_BANDS.filter(b => b.kv[0] < t.kv[1] && t.kv[0] < b.kv[1]);
      expect(ids, t.id).toHaveLength(holders.length);
      expect(holders.length, `${t.id} must live somewhere`).toBeGreaterThan(0);
    }
  });

  it('lists every built style layer in mapLayerIds', () => {
    // visibility.ts toggles exactly these; one missing means part of the layer
    // ignores its checkbox.
    const entry = layerById('osm-transmission-lines')!;
    const built = [
      ...osmTlLayerIds(...OSM_TL_TIERS.map(t => t.id)),
      ...osmTlLayerIds('dc', 'dc-label', 'label'),
    ];
    expect([...entry.mapLayerIds].sort()).toEqual([...built].sort());
    expect(new Set(entry.mapLayerIds).size).toBe(entry.mapLayerIds.length);
  });

  it('scopes kV tiers but spreads the overlays across every archive', () => {
    // HVDC runs at every voltage class and a line can be named in any of them.
    for (const overlay of ['dc', 'dc-label', 'label']) {
      expect(osmTlLayerIds(overlay), overlay).toHaveLength(OSM_TL_BANDS.length);
    }
  });
});
