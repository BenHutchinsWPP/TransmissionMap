import { describe, it, expect } from 'vitest';
import { aerialOverlayLayer, normalizeOfmFilter, type OfmLayer } from './basemap-overlay.js';

// Fixtures below are lifted verbatim (structure-relevant fields only) from the
// real OpenFreeMap Positron style JSON, not invented shapes.

const roadAreaPier: OfmLayer = {
  id: 'road_area_pier',
  type: 'fill',
  source: 'openmaptiles',
  'source-layer': 'transportation',
  paint: { 'fill-antialias': true, 'fill-color': 'rgb(242,243,240)' },
};

const roadPier: OfmLayer = {
  id: 'road_pier',
  type: 'line',
  source: 'openmaptiles',
  'source-layer': 'transportation',
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: { 'line-color': 'rgb(242,243,240)' },
};

const railwayDashline: OfmLayer = {
  id: 'railway_dashline',
  type: 'line',
  source: 'openmaptiles',
  'source-layer': 'transportation',
  minzoom: 13,
  layout: { 'line-join': 'round' },
  paint: { 'line-color': '#fafafa', 'line-dasharray': [3, 3] },
};

const water: OfmLayer = {
  id: 'water',
  type: 'fill',
  source: 'openmaptiles',
  'source-layer': 'water',
  paint: { 'fill-antialias': true, 'fill-color': 'rgb(194, 200, 202)' },
};

const highwayMajorCasing: OfmLayer = {
  id: 'highway_major_casing',
  type: 'line',
  source: 'openmaptiles',
  'source-layer': 'transportation',
  minzoom: 11,
  layout: { 'line-cap': 'butt', 'line-join': 'miter' },
  paint: {
    'line-color': 'rgb(213, 213, 213)',
    'line-dasharray': [12, 0],
    'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 10, 3, 20, 23],
  },
};

// Keeps its real `filter` — the class match is what makes this the *major*
// road layer rather than every road. See the pass-through test below.
const highwayMajorInner = {
  id: 'highway_major_inner',
  type: 'line',
  source: 'openmaptiles',
  'source-layer': 'transportation',
  minzoom: 11,
  filter: ['all',
    ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
    ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk'], true, false]],
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: {
    'line-color': '#fff',
    'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 10, 2, 20, 20],
  },
} satisfies OfmLayer;

const highwayMinor: OfmLayer = {
  id: 'highway_minor',
  type: 'line',
  source: 'openmaptiles',
  'source-layer': 'transportation',
  minzoom: 8,
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: {
    'line-color': 'hsl(0,0%,88%)',
    'line-opacity': 0.9,
    'line-width': ['interpolate', ['exponential', 1.55], ['zoom'], 13, 1.8, 20, 20],
  },
};

// transportation_name WITHOUT icon-image — the half of the shield guard that
// must still get the text inversion.
const highwayNameMajor: OfmLayer = {
  id: 'highway-name-major',
  type: 'symbol',
  source: 'openmaptiles',
  'source-layer': 'transportation_name',
  minzoom: 12.2,
  layout: {
    'symbol-placement': 'line',
    'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
    'text-font': ['Noto Sans Regular'],
  },
  paint: { 'text-color': '#666', 'text-halo-blur': 0.5, 'text-halo-width': 1 },
};

const labelCity: OfmLayer = {
  id: 'label_city',
  type: 'symbol',
  source: 'openmaptiles',
  'source-layer': 'place',
  minzoom: 3,
  layout: {
    'icon-allow-overlap': true,
    'icon-image': ['step', ['zoom'], 'circle_11_black', 9, ''],
    'icon-size': 0.4,
    'text-anchor': 'bottom',
    'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
  },
  paint: { 'text-color': '#000', 'text-halo-blur': 1, 'text-halo-color': '#fff', 'text-halo-width': 1 },
};

const labelTown: OfmLayer = {
  id: 'label_town',
  type: 'symbol',
  source: 'openmaptiles',
  'source-layer': 'place',
  minzoom: 6,
  layout: {
    'icon-allow-overlap': true,
    'icon-image': ['step', ['zoom'], 'circle_11_black', 10, ''],
    'icon-size': 0.2,
    'text-anchor': 'bottom',
    'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
  },
  paint: { 'text-color': '#000', 'text-halo-blur': 1, 'text-halo-color': '#fff', 'text-halo-width': 1 },
};

const roadShieldUs: OfmLayer = {
  id: 'road_shield_us',
  type: 'symbol',
  source: 'openmaptiles',
  'source-layer': 'transportation_name',
  minzoom: 12,
  layout: {
    'icon-image': ['concat', ['get', 'network'], '_', ['get', 'ref_length']],
    'icon-size': 1,
    'text-field': ['to-string', ['get', 'ref']],
    'text-size': 10,
  },
};

const highwayShieldUsInterstate: OfmLayer = {
  id: 'highway-shield-us-interstate',
  type: 'symbol',
  source: 'openmaptiles',
  'source-layer': 'transportation_name',
  minzoom: 11,
  layout: {
    'icon-image': ['concat', ['get', 'network'], '_', ['get', 'ref_length']],
    'icon-size': 1,
    'text-field': ['to-string', ['get', 'ref']],
    'text-size': 10,
  },
};

const highwayShieldNonUs: OfmLayer = {
  id: 'highway-shield-non-us',
  type: 'symbol',
  source: 'openmaptiles',
  'source-layer': 'transportation_name',
  minzoom: 11,
  layout: {
    'icon-image': ['concat', 'road_', ['get', 'ref_length']],
    'icon-size': 1,
    'text-field': ['to-string', ['get', 'ref']],
    'text-size': 10,
  },
};

const boundary2: OfmLayer = {
  id: 'boundary_2',
  type: 'line',
  source: 'openmaptiles',
  'source-layer': 'boundary',
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: {
    'line-color': 'hsl(0,0%,70%)',
    'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 4, 1],
    'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 5, 1.2, 12, 3],
  },
};

const boundary3: OfmLayer = {
  id: 'boundary_3',
  type: 'line',
  source: 'openmaptiles',
  'source-layer': 'boundary',
  minzoom: 8,
  paint: {
    'line-color': 'hsl(0,0%,70%)',
    'line-dasharray': [1, 1],
    'line-width': ['interpolate', ['linear', 1], ['zoom'], 7, 1, 11, 2],
  },
};

describe('aerialOverlayLayer — exclusions', () => {
  it('excludes road_area_pier, road_pier, railway_dashline', () => {
    expect(aerialOverlayLayer(roadAreaPier)).toBeNull();
    expect(aerialOverlayLayer(roadPier)).toBeNull();
    expect(aerialOverlayLayer(railwayDashline)).toBeNull();
  });

  it('excludes source-layers outside the kept set (e.g. water)', () => {
    expect(aerialOverlayLayer(water)).toBeNull();
  });
});

describe('aerialOverlayLayer — road casings', () => {
  it('darkens casing line-color', () => {
    const spec = aerialOverlayLayer(highwayMajorCasing);
    expect(spec?.paint?.['line-color']).toBe('rgba(0,0,0,0.55)');
  });

  // minor/service/track all sit back at half opacity, flat across zoom.
  it('lifts highway_minor to white at half opacity', () => {
    const spec = aerialOverlayLayer(highwayMinor);
    expect(spec?.paint?.['line-color']).toBe('#fff');
    expect(spec?.paint?.['line-opacity']).toBe(0.5);
  });

  // Majors turn on at z11; the stop at 14 clamps downward, so z11-z14 all sit
  // at 0.75 and only tighter zooms fade further.
  it('ramps the major inner fill while keeping it white', () => {
    const spec = aerialOverlayLayer(highwayMajorInner);
    expect(spec?.paint?.['line-color']).toBe('#fff');
    expect(spec?.paint?.['line-opacity']).toEqual(
      ['interpolate', ['linear'], ['zoom'], 14, 0.75, 16, 0.65],
    );
  });
});

describe('aerialOverlayLayer — symbol text', () => {
  it('inverts place labels to white text with a dark halo (label_city)', () => {
    const spec = aerialOverlayLayer(labelCity);
    expect(spec?.paint?.['text-color']).toBe('#fff');
    expect(spec?.paint?.['text-halo-color']).toBe('rgba(0,0,0,0.75)');
    expect(spec?.paint?.['text-halo-width']).toBe(1.2);
  });

  it('inverts label_town even though it carries icon-image (place dot, not a shield badge)', () => {
    const spec = aerialOverlayLayer(labelTown);
    expect(spec?.paint?.['text-color']).toBe('#fff');
    expect(spec?.paint?.['text-halo-color']).toBe('rgba(0,0,0,0.75)');
    expect(spec?.paint?.['text-halo-width']).toBe(1.2);
  });

  it('inverts icon-less transportation_name road names (highway-name-major)', () => {
    const spec = aerialOverlayLayer(highwayNameMajor);
    expect(spec?.paint?.['text-color']).toBe('#fff');
    expect(spec?.paint?.['text-halo-color']).toBe('rgba(0,0,0,0.75)');
  });

  it('never writes text-color onto the three transportation_name shield layers', () => {
    for (const shield of [roadShieldUs, highwayShieldUsInterstate, highwayShieldNonUs]) {
      const spec = aerialOverlayLayer(shield);
      expect(spec?.paint ? 'text-color' in spec.paint : false).toBe(false);
    }
  });
});

describe('aerialOverlayLayer — boundaries', () => {
  it('lightens boundary_3 and drops its minzoom floor to 0', () => {
    const spec = aerialOverlayLayer(boundary3);
    expect(spec?.paint?.['line-color']).toBe('rgba(255,255,255,0.75)');
    expect(spec?.minzoom).toBe(0);
  });

  it('lightens boundary_2 without touching its (absent) minzoom', () => {
    const spec = aerialOverlayLayer(boundary2);
    expect(spec?.paint?.['line-color']).toBe('rgba(255,255,255,0.75)');
    expect(spec?.minzoom).toBeUndefined();
  });
});

describe('aerialOverlayLayer — id/source/layout remap', () => {
  it('prefixes id with ofm-aerial- and remaps source to ofm-openmaptiles', () => {
    const spec = aerialOverlayLayer(highwayMajorInner);
    expect(spec?.id).toBe('ofm-aerial-highway_major_inner');
    expect(spec?.source).toBe('ofm-openmaptiles');
  });

  it('forces layout.visibility to none', () => {
    const spec = aerialOverlayLayer(labelCity);
    expect(spec?.layout?.visibility).toBe('none');
  });

  // `filter` is not in OfmLayer, so it rides through on the spread rather than
  // by name. Dropping it would render every road at major-road width instead of
  // only primary/secondary/tertiary/trunk — invisible to typecheck.
  it('carries through fields it does not model, notably filter and source-layer', () => {
    const spec = aerialOverlayLayer(highwayMajorInner) as (OfmLayer & { filter?: unknown }) | null;
    expect(spec?.filter).toEqual(highwayMajorInner.filter);
    expect(spec?.['source-layer']).toBe('transportation');
  });
});

describe('aerialOverlayLayer — purity', () => {
  it('does not mutate the input layer or its nested paint/layout', () => {
    const original = JSON.parse(JSON.stringify(highwayMajorCasing));
    aerialOverlayLayer(highwayMajorCasing);
    expect(highwayMajorCasing).toEqual(original);
  });

  it('does not mutate a symbol input either', () => {
    const original = JSON.parse(JSON.stringify(labelCity));
    aerialOverlayLayer(labelCity);
    expect(labelCity).toEqual(original);
  });
});

describe('normalizeOfmFilter', () => {
  it('makes missing shield lengths and boundary levels fail without evaluator warnings', () => {
    const shield = normalizeOfmFilter({
      ...roadShieldUs,
      filter: ['all', ['<=', ['get', 'ref_length'], 6], ['has', 'ref']],
    });
    const boundary = normalizeOfmFilter({
      ...boundary3,
      filter: ['all', ['>=', ['get', 'admin_level'], 3], ['<=', ['get', 'admin_level'], 6]],
    });

    expect(shield.filter).toEqual(
      ['all', ['<=', ['coalesce', ['get', 'ref_length'], 7], 6], ['has', 'ref']],
    );
    expect(boundary.filter).toEqual(
      ['all', ['>=', ['coalesce', ['get', 'admin_level'], 0], 3],
        ['<=', ['coalesce', ['get', 'admin_level'], 0], 6]],
    );
  });

  it('leaves unrelated filters untouched', () => {
    expect(normalizeOfmFilter(highwayMajorInner)).toBe(highwayMajorInner);
  });
});
