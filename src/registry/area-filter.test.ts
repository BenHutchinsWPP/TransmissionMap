// areaCondition (every way an area reaches a dataset), areaFlag (layers it
// cannot reach, datacenter clusters, EIA's NERC regions), normalizeArea
// and validateArea, with the compiled filters evaluated by MapLibre's own
// featureFilter rather than compared as arrays.
import { describe, it, expect } from 'vitest';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { areaCondition, areaFlag, normalizeArea, AREA_KIND_CODES, AREA_KINDS, type AreaFilter } from './area-filter.js';
import { toMapLibreFilter, type Condition } from './condition-compile.js';
import { validateArea } from './view-validate.js';
import { layerById } from './index.js';

const matches = (dataset: string, cond: Condition, props: Record<string, unknown>) =>
  featureFilter(toMapLibreFilter(dataset, [cond]) as never, 'layers[0].filter')
    .filter({ zoom: 10 } as never, { type: 1, properties: props, geometry: [] } as never);

describe('areaCondition', () => {
  it('filters a dataset by the area\'s own field', () => {
    expect(areaCondition('hifld_transmission_lines', { kind: 'states', codes: ['TX'] }))
      .toEqual({ field: 'states', op: 'contains_any', value: ['TX'] });
    expect(areaCondition('osm_plants_points', { kind: 'counties', codes: ['48201'] }))
      .toEqual({ field: 'counties', op: 'contains_any', value: ['48201'] });
  });

  it('reaches a world layer from US states through admin-1 codes', () => {
    const c = areaCondition('osm_transmission_lines', { kind: 'states', codes: ['TX', 'WY'] }) as Condition;
    expect(c).toEqual({ field: 'admin1', op: 'contains_any', value: ['USAB', 'USA1'] });
    expect(matches('osm_transmission_lines', c, { admin1: '|USAB|' })).toBe(true);
    expect(matches('osm_transmission_lines', c, { admin1: '|USA10|' })).toBe(false);
  });

  it('reaches a US layer from US admin-1 codes, dropping the rest', () => {
    expect(areaCondition('hifld_substations', { kind: 'admin1', codes: ['USAB', 'FRA1'] }))
      .toEqual({ field: 'states', op: 'contains_any', value: ['TX'] });
    expect(areaCondition('hifld_substations', { kind: 'admin1', codes: ['FRA1'] }))
      .toEqual({ unfiltered: 'area.reason.usaLayer' });
  });

  it('a country on a US layer: all of it for USA, unfiltered otherwise', () => {
    expect(areaCondition('eia_generators', { kind: 'countries', codes: ['CAN', 'USA'] })).toBe('all');
    expect(areaCondition('eia_generators', { kind: 'countries', codes: ['FRA'] }))
      .toEqual({ unfiltered: 'area.reason.usaLayer' });
  });

  it('retail on a lines dataset, and any kind on a context dataset, stay unfiltered', () => {
    expect(areaCondition('hifld_transmission_lines', { kind: 'retail', codes: ['44372'] }))
      .toEqual({ unfiltered: 'area.reason.linesNoRetail' });
    expect(areaCondition('osm_pipelines_lines', { kind: 'retail', codes: ['44372'] }))
      .toEqual({ unfiltered: 'area.reason.linesNoRetail' });
    expect(areaCondition('nerc_regions', { kind: 'nerc', codes: ['TRE'] }))
      .toEqual({ unfiltered: 'area.reason.noField' });
    expect(areaCondition(undefined, { kind: 'states', codes: ['TX'] }))
      .toEqual({ unfiltered: 'area.reason.noField' });
    expect(areaCondition('no_such_dataset', { kind: 'states', codes: ['TX'] }))
      .toEqual({ unfiltered: 'area.reason.noField' });
  });

  it('maps only real codes, never an inherited key', () => {
    expect(areaCondition('hifld_substations', { kind: 'admin1', codes: ['constructor'] }))
      .toEqual({ unfiltered: 'area.reason.usaLayer' });
    expect(areaCondition('osm_generators', { kind: 'states', codes: ['constructor'] }))
      .toEqual({ field: 'admin1', op: 'contains_any', value: ['constructor'] });
  });

  it('none keeps its absent-key meaning across the states → admin-1 mapping', () => {
    const c = areaCondition('osm_generators', { kind: 'states', codes: ['none'] }) as Condition;
    expect(c.value).toEqual(['none']);
    expect(matches('osm_generators', c, {})).toBe(true);
  });
});

describe('areaFlag', () => {
  const TX: AreaFilter = { kind: 'states', codes: ['TX'] };
  const flag = (id: string, area: AreaFilter | null, mode?: string) => areaFlag(layerById(id)!, area, mode);

  it('is null with no area, and on a layer the area reaches', () => {
    expect(flag('padus', null)).toBeNull();
    expect(flag('hifld-transmission-lines', TX)).toBeNull();
    expect(flag('osm-transmission-lines', TX)).toBeNull();
  });

  it('names why a feature layer is not filtered', () => {
    expect(flag('padus', TX)).toBe('area.reason.noField');
    expect(flag('nerc-regions', TX)).toBe('area.reason.noField');
    expect(flag('hifld-transmission-lines', { kind: 'retail', codes: ['44372'] })).toBe('area.reason.linesNoRetail');
    expect(flag('eia-generators', { kind: 'countries', codes: ['FRA'] })).toBe('area.reason.usaLayer');
  });

  it('keeps raster rows silent', () => {
    for (const id of ['nlr-wind-100m', 'gsa-solar-pvout', 'weather-live', 'nexrad-radar']) {
      expect(flag(id, TX), id).toBeNull();
    }
  });

  it('flags datacenter clusters, not points', () => {
    expect(flag('osm-datacenters', TX, 'clusters')).toBe('area.clustersUnfiltered');
    expect(flag('osm-datacenters', TX, 'icons')).toBeNull();
  });

  it('flags EIA plants under a NERC region EIA does not file plants in', () => {
    expect(flag('eia-generators', { kind: 'nerc', codes: ['SPP'] })).toBe('area.nercVintage');
    expect(flag('eia-generators', { kind: 'nerc', codes: ['TRE'] })).toBeNull();
    expect(flag('hifld-substations', { kind: 'nerc', codes: ['SPP'] })).toBeNull();
  });
});

describe('normalizeArea / validateArea', () => {
  it('sorts and deduplicates', () => {
    expect(normalizeArea({ kind: 'states', codes: ['TX', 'NM', 'TX'] })).toEqual({ kind: 'states', codes: ['NM', 'TX'] });
  });

  it('every kind has a distinct one-char code', () => {
    const chars = AREA_KINDS.map(k => AREA_KIND_CODES[k]);
    expect(new Set(chars).size).toBe(7);
    for (const c of chars) expect(c).toMatch(/^[a-z]$/);
  });

  it('accepts each kind\'s real codes and none', () => {
    for (const a of [
      { kind: 'states', codes: ['TX', 'none'] }, { kind: 'counties', codes: ['48201'] },
      { kind: 'ba', codes: ['ERCO', 'EPE'] }, { kind: 'nerc', codes: ['SPP'] },
      { kind: 'retail', codes: ['44372', 'NA2'] }, { kind: 'countries', codes: ['FRA', '111'] },
      { kind: 'admin1', codes: ['USAB'] },
    ]) expect(validateArea(a), JSON.stringify(a)).toBeNull();
  });

  it('refuses a bad shape, kind or code', () => {
    for (const a of [
      null, 'TX', [], { kind: 'states' }, { kind: 'states', codes: [] },
      { kind: 'states', codes: 'TX' }, { kind: 'zcta', codes: ['77002'] },
      { kind: '__proto__', codes: ['TX'] }, { kind: 'states', codes: ['TX'], extra: 1 },
      { kind: 'states', codes: ['ZZ'] }, { kind: 'states', codes: ['TX|NM'] }, { kind: 'states', codes: [' TX'] },
      { kind: 'states', codes: [['get', 'x']] }, { kind: 'counties', codes: ['6037'] },
      { kind: 'admin1', codes: ['usab'] }, { kind: 'states', codes: [42] },
      { kind: 'counties', codes: Array.from({ length: 101 }, (_, i) => String(10000 + i)) },
    ]) expect(validateArea(a), JSON.stringify(a)).toEqual(expect.any(String));
  });

  it('accepts exactly 100 codes', () => {
    expect(validateArea({ kind: 'counties', codes: Array.from({ length: 100 }, (_, i) => String(10000 + i)) })).toBeNull();
  });
});
