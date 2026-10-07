// Pins basemapVisibility(): the basemap × Map Labels × Esri-fallback matrix that
// switchBasemap() applies. Raster ids come from the real BASEMAP_LAYER_DEFS and
// ESRI_LAYER_IDS; the OFM groups are a fixture, since the real ones are filled
// only when the OpenFreeMap style fetch resolves.
//
// Deps: basemap.js (the module under test).

import { describe, it, expect } from 'vitest';
import { basemapVisibility, BASEMAP_LAYER_DEFS, ESRI_LAYER_IDS, type BasemapLayers } from './basemap.js';

const OFM = {
  light:  ['ofm-light-water', 'ofm-light-place'],
  dark:   ['ofm-dark-water', 'ofm-dark-place'],
  aerial: ['ofm-aerial-road', 'ofm-aerial-place'],
};
const LABELS = new Set(['ofm-light-place', 'ofm-dark-place']);
const LAYERS: BasemapLayers = { rasterDefs: BASEMAP_LAYER_DEFS, esriIds: ESRI_LAYER_IDS, ofm: OFM, labelIds: LABELS };

// The raster layers each basemap owns, as switchBasemap() is meant to show them.
const RASTER: Record<string, string[]> = {
  street: ['osm-bg'],
  light:  [],
  dark:   [],
  topo:   ['usgs-topo-bg'],
  hydro:  ['usgs-hydro-bg'],
  aerial: ['aerial-usgs-bg', ...ESRI_LAYER_IDS],
};
// The OFM group each basemap lights; hydro borrows light as its ground.
const OFM_GROUP: Record<string, keyof typeof OFM | null> = {
  street: null, light: 'light', dark: 'dark', topo: null, hydro: 'light', aerial: 'aerial',
};

function visibleIds(vis: Record<string, string>): string[] {
  return Object.keys(vis).filter(id => vis[id] === 'visible').sort();
}

describe('basemapVisibility', () => {
  const cases = Object.keys(RASTER).flatMap(basemap =>
    [true, false].flatMap(labels => [false, true].map(esriSuppressed => ({ basemap, labels, esriSuppressed }))));

  it.each(cases)('$basemap labels=$labels suppressed=$esriSuppressed', (sel) => {
    const vis = basemapVisibility(sel, LAYERS);

    // Every layer gets a value, so applying the result leaves nothing stale.
    const all = [...BASEMAP_LAYER_DEFS.map(d => d.id), ...OFM.light, ...OFM.dark, ...OFM.aerial];
    expect(Object.keys(vis).sort()).toEqual([...all].sort());

    const raster = RASTER[sel.basemap].filter(id => !(sel.esriSuppressed && ESRI_LAYER_IDS.includes(id)));
    const group = OFM_GROUP[sel.basemap];
    const ofm = group === null ? []
      : group === 'aerial' ? (sel.labels ? OFM.aerial : [])
      : OFM[group].filter(id => sel.labels || !LABELS.has(id));
    expect(visibleIds(vis)).toEqual([...raster, ...ofm].sort());
  });

  it('hydro lights the light OFM group plus the USGS water overlay', () => {
    const vis = basemapVisibility({ basemap: 'hydro', labels: true, esriSuppressed: false }, LAYERS);
    expect(visibleIds(vis)).toEqual(['ofm-light-place', 'ofm-light-water', 'usgs-hydro-bg']);
  });

  it('aerial with labels off hides the whole overlay group, roads included', () => {
    const vis = basemapVisibility({ basemap: 'aerial', labels: false, esriSuppressed: false }, LAYERS);
    expect(vis['ofm-aerial-road']).toBe('none');
    expect(vis['ofm-aerial-place']).toBe('none');
    expect(vis['aerial-usgs-bg']).toBe('visible');
  });

  it.each(['light', 'dark'])('%s with labels off hides only the label layers', (basemap) => {
    const vis = basemapVisibility({ basemap, labels: false, esriSuppressed: false }, LAYERS);
    expect(vis[`ofm-${basemap}-water`]).toBe('visible');
    expect(vis[`ofm-${basemap}-place`]).toBe('none');
  });

  it('a tripped Esri latch hides every Esri layer but keeps USGS aerial', () => {
    const vis = basemapVisibility({ basemap: 'aerial', labels: true, esriSuppressed: true }, LAYERS);
    expect(ESRI_LAYER_IDS.length).toBeGreaterThan(1);
    for (const id of ESRI_LAYER_IDS) expect(vis[id]).toBe('none');
    expect(vis['aerial-usgs-bg']).toBe('visible');
  });
});
