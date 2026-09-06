// @vitest-environment jsdom
// url-state.js is imported first to prime the same import cycle ui-legends.test.ts
// documents (ui-legends → visibility → url-state → url-state-codec → ui-legends).
import { describe, it, expect } from 'vitest';
import './../url-state.js';
import { isLayerInRegion, isContinentalPack, getRegionalDownloadPath } from './ui-layer-rows.js';
import { LAYERS } from '../../src/registry/index.js';
import type { LayerDef } from '../../src/types.js';

const layer = (regions?: LayerDef['regions']) => ({ regions } as LayerDef);

describe('isLayerInRegion — layer-list scope', () => {
  it('usa lists every layer, US-only and worldwide alike', () => {
    expect(isLayerInRegion(layer(['usa']), 'usa')).toBe(true);
    expect(isLayerInRegion(layer(['global']), 'usa')).toBe(true);
    expect(isLayerInRegion(layer(undefined), 'usa')).toBe(true);
  });

  it('global hides US-only layers but keeps worldwide ones', () => {
    expect(isLayerInRegion(layer(['usa']), 'global')).toBe(false);
    expect(isLayerInRegion(layer(['global']), 'global')).toBe(true);
  });

  it('treats an unannotated layer as worldwide', () => {
    expect(isLayerInRegion(layer(undefined), 'global')).toBe(true);
    expect(isLayerInRegion(layer([]), 'global')).toBe(true);
  });

  it('global is a strict subset of usa across the real registry', () => {
    const usa = LAYERS.filter(l => isLayerInRegion(l, 'usa'));
    const global = LAYERS.filter(l => isLayerInRegion(l, 'global'));
    expect(usa.length).toBe(LAYERS.length);
    expect(global.length).toBeLessThan(usa.length);
    expect(global.every(l => usa.includes(l))).toBe(true);
  });
});

describe('download packs', () => {
  it('every OSM-derived pack is continental, whatever the format', () => {
    expect(isContinentalPack('data/releases/osm-generators.zip')).toBe(true);
    expect(isContinentalPack('data/releases/osm-transmission-lines-shp.zip')).toBe(true);
    expect(isContinentalPack('data/releases/hifld-substations.zip')).toBe(false);
    expect(isContinentalPack(undefined)).toBe(false);
    expect(isContinentalPack(null)).toBe(false);
  });

  it('rewrites a continental pack to the requested continent', () => {
    const p = 'data/releases/osm-generators.zip';
    expect(getRegionalDownloadPath(p, 'north-america')).toBe('data/releases/osm-generators-na.zip');
    expect(getRegionalDownloadPath(p, 'europe')).toBe('data/releases/osm-generators-eu.zip');
    expect(getRegionalDownloadPath(p, 'antarctica')).toBe('data/releases/osm-generators-an.zip');
  });

  // build_releases.py names the SHP pack <layer>-<code>-shp.zip, so the code
  // goes ahead of the format suffix rather than at the end.
  it('keeps the code ahead of the -shp suffix', () => {
    const p = 'data/releases/osm-plants-polygons-shp.zip';
    expect(getRegionalDownloadPath(p, 'asia')).toBe('data/releases/osm-plants-polygons-as-shp.zip');
    expect(getRegionalDownloadPath('data/releases/osm-transmission-lines-shp.zip', 'europe'))
      .toBe('data/releases/osm-transmission-lines-eu-shp.zip');
  });

  it('is idempotent — recoding an already-coded path replaces the code', () => {
    expect(getRegionalDownloadPath('data/releases/osm-generators-na.zip', 'africa'))
      .toBe('data/releases/osm-generators-af.zip');
    expect(getRegionalDownloadPath('data/releases/osm-plants-polygons-as-shp.zip', 'oceania'))
      .toBe('data/releases/osm-plants-polygons-oc-shp.zip');
  });

  it('leaves a non-continental pack untouched for every continent', () => {
    const p = 'data/releases/hifld-substations.zip';
    expect(getRegionalDownloadPath(p, 'europe')).toBe(p);
    expect(getRegionalDownloadPath(p, 'north-america')).toBe(p);
  });
});
