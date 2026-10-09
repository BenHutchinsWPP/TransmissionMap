// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { resolveHits, type HitFeature } from './click-resolve.js';

const f = (layer: string, extra: Partial<HitFeature> = {}): HitFeature =>
  ({ layer: { id: layer }, ...extra });

describe('resolveHits — view mode', () => {
  it('returns none for no features', () => {
    expect(resolveHits([], 'view')).toEqual({ kind: 'none' });
  });

  it('returns the single feature', () => {
    const a = f('eia-gen-circles', { id: 1 });
    expect(resolveHits([a], 'view')).toEqual({ kind: 'single', feature: a });
  });

  it('offers a picker for distinct features, in query order', () => {
    const a = f('eia-gen-circles', { id: 1 });
    const b = f('osm-substations', { id: 1 });
    expect(resolveHits([a, b], 'view')).toEqual({ kind: 'picker', features: [a, b] });
  });

  it('collapses tile-boundary duplicates that share layer and id', () => {
    const a = f('osm-lines', { id: 7, sourceLayer: 'lines' });
    const dup = f('osm-lines', { id: 7, sourceLayer: 'lines' });
    expect(resolveHits([a, dup], 'view')).toEqual({ kind: 'single', feature: a });
  });

  it('collapses GeoJSON tile repeats of a feature without an id', () => {
    const a = f('dcm-state-fill', { properties: { kind: 'state', name: 'Arizona' } });
    const dup = f('dcm-state-fill', { properties: { kind: 'state', name: 'Arizona' } });
    expect(resolveHits([a, dup, { ...dup }], 'view')).toEqual({ kind: 'single', feature: a });
  });

  it('keeps distinct features without an id apart', () => {
    const a = f('user-1-circle', { properties: { __uid: 'u1' } });
    const b = f('user-1-circle', { properties: { __uid: 'u2' } });
    expect(resolveHits([a, b], 'view')).toEqual({ kind: 'picker', features: [a, b] });
  });

  it('keeps the same feature apart when two layers draw it', () => {
    const a = f('dcm-state-fill', { properties: { name: 'Arizona' } });
    const b = f('us-states-fill', { properties: { name: 'Arizona' } });
    expect(resolveHits([a, b], 'view')).toEqual({ kind: 'picker', features: [a, b] });
  });

  it.each([
    ['odin-outages-fill', { odin_out: 12 }],
    ['fema-nri-fill', { nri_r: 3 }],
    ['nws-zone-fill', { nws_group: 'warning' }],
    ['nws-county-fill', { nws_group: 'watch' }],
  ])('keeps a painted %s feature and drops an unpainted one', (layer, lit) => {
    const on = f(layer, { id: 'A', state: lit });
    const off = f(layer, { id: 'B', state: {} });
    expect(resolveHits([off, on], 'view')).toEqual({ kind: 'single', feature: on });
    expect(resolveHits([off], 'view')).toEqual({ kind: 'none' });
  });

  it('treats FEMA NRI rating null (not applicable) as unpainted', () => {
    expect(resolveHits([f('fema-nri-fill', { state: { nri_r: null, nri_s: 4 } })], 'view'))
      .toEqual({ kind: 'none' });
  });
});

describe('resolveHits — edit mode', () => {
  it('offers Copy for one GeoJSON-backed feature', () => {
    const a = f('user-1-fill');
    expect(resolveHits([a], 'edit')).toEqual({ kind: 'copy', feature: a });
  });

  it('offers Copy, not a picker, for GeoJSON tile repeats of one feature', () => {
    const a = f('dcm-state-fill', { properties: { name: 'Arizona' } });
    const dup = f('dcm-state-fill', { properties: { name: 'Arizona' } });
    expect(resolveHits([a, dup], 'edit')).toEqual({ kind: 'copy', feature: a });
  });

  it('offers a copy picker for several GeoJSON-backed features, skipping tiled ones', () => {
    const a = f('user-1-fill');
    const tiled = f('padus-fill', { sourceLayer: 'padus', id: 2 });
    const b = f('tribal-lands-fill', { id: 3 });
    expect(resolveHits([a, tiled, b], 'edit')).toEqual({ kind: 'copy-picker', features: [a, b] });
  });

  it('says tiled features cannot be copied', () => {
    expect(resolveHits([f('padus-fill', { sourceLayer: 'padus' })], 'edit'))
      .toEqual({ kind: 'not-copyable' });
  });

  it('returns none when only unpainted choropleth features were hit', () => {
    expect(resolveHits([f('odin-outages-fill', { sourceLayer: 'counties', state: {} })], 'edit'))
      .toEqual({ kind: 'none' });
  });
});
