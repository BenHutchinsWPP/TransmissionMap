import { describe, it, expect } from 'vitest';
import { ensureFeatureUid, ensureGeoJsonFeatureUids } from './utils-uid.js';

function makeFeature(id?: string | number, uid?: string): GeoJSON.Feature {
  return {
    type: 'Feature',
    id,
    properties: uid ? { __uid: uid } : {},
    geometry: { type: 'Point', coordinates: [0, 0] },
  };
}

describe('ensureFeatureUid', () => {
  it('assigns __uid when feature has no id or __uid', () => {
    const f = makeFeature();
    const uid = ensureFeatureUid(f);
    expect(uid).toBeTruthy();
    expect(f.properties!.__uid).toBe(uid);
  });

  it('preserves an existing feature.id', () => {
    const f = makeFeature('existing-id');
    const uid = ensureFeatureUid(f);
    expect(uid).toBe('existing-id');
    expect(f.properties!.__uid).toBe('existing-id');
  });

  it('preserves an existing __uid in properties', () => {
    const f = makeFeature(undefined, 'prop-uid');
    const uid = ensureFeatureUid(f);
    expect(uid).toBe('prop-uid');
    expect(f.properties!.__uid).toBe('prop-uid');
  });

  it('feature.id takes priority over __uid in properties', () => {
    const f: GeoJSON.Feature = {
      type: 'Feature',
      id: 'id-wins',
      properties: { __uid: 'prop-uid' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    };
    const uid = ensureFeatureUid(f);
    expect(uid).toBe('id-wins');
  });

  it('generates distinct UIDs for different features', () => {
    const a = ensureFeatureUid(makeFeature());
    const b = ensureFeatureUid(makeFeature());
    expect(a).not.toBe(b);
  });
});

describe('ensureGeoJsonFeatureUids', () => {
  it('assigns UIDs to all features in a FeatureCollection', () => {
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [makeFeature(), makeFeature(), makeFeature()],
    };
    ensureGeoJsonFeatureUids(fc);
    for (const f of fc.features) {
      expect(f.properties!.__uid).toBeTruthy();
    }
  });

  it('assigns UID to a standalone Feature', () => {
    const f = makeFeature();
    ensureGeoJsonFeatureUids(f);
    expect(f.properties!.__uid).toBeTruthy();
  });

  it('returns the original geojson object', () => {
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    expect(ensureGeoJsonFeatureUids(fc)).toBe(fc);
  });
});
