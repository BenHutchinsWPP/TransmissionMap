// effectiveFilter / setWhere / setArea / setSelection / applyAllWhere on a recording fake map, plus the
// guard that every setFilter call site in assets/ is a known one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import type { FilterSpecification } from 'maplibre-gl';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { state } from './state.js';
import { layerById } from '../src/registry/index.js';
import {
  effectiveFilter, setWhere, setArea, setSelection, applyAllWhere,
  applyVoltageFilter, applyGeneratorFilters, whereOwnership,
} from './filters.js';
import { getDiagLog, clearDiagLog } from './diag-log.js';
import { registerBaseFilter } from './layers/base-filters.js';

// ─── Every setFilter writer is accounted for ──────────────────────────────────
// filters.ts writes every feature filter through its single refilter() call,
// which composes base ∧ legend ∧ where. Any other site bypasses that and would
// drop a view's `where` conditions — the ones below write highlight twins that
// no legend filter or `where` targets. A new entry here needs that same reason.
const SETFILTER_SITES: Record<string, number> = {
  'filters.ts': 1,                  // refilter() — the effectiveFilter writer
  'hover.ts': 2,                    // polygon-hover + line click-highlight twins
  'layers/map-layers-wecc.ts': 2,   // wecc-path-lines-highlight (click selection)
  'ui/proximity-map.ts': 2,         // px-focus, px-focus-pt (the Proximity tool's own layers; no registry filter)
};

describe('setFilter call sites', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const found: Record<string, number> = {};
  for (const f of readdirSync(root, { recursive: true }) as string[]) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const n = (readFileSync(join(root, f), 'utf8').match(/\.setFilter\s*\(/g) ?? []).length;
    if (n) found[relative(root, join(root, f)).replaceAll('\\', '/')] = n;
  }
  it('matches the allowlist exactly', () => {
    expect(found).toEqual(SETFILTER_SITES);
  });
});

// ─── where on a fake map ──────────────────────────────────────────────────────
const SUBS = 'osm-substations-points';
const SUB_ML = layerById(SUBS)!.mapLayerIds;               // hv, lv, label
const HV = 'osm-substations-points-hv';
const HV_BASE = ['>=', ['to-number', ['get', 'nominal_kv'], -1], 200] as FilterSpecification;
const KV345 = { field: 'nominal_kv', op: '>=' as const, value: 345 };
const valued = (f: string, e: unknown[]) => ['all', ['!=', ['to-string', ['get', f]], ''], e];
const KV345_EXPR = valued('nominal_kv', ['>=', ['to-number', ['get', 'nominal_kv']], 345]);

function fakeMap(ids: string[]) {
  const filters: Record<string, unknown> = {};
  const map = {
    getLayer: vi.fn((id: string) => (ids.includes(id) ? {} : undefined)),
    setFilter: vi.fn((id: string, f: unknown) => { filters[id] = f; }),
  };
  state.map = map as unknown as typeof state.map;
  return { map, filters };
}

beforeEach(() => {
  state.mapReady = true;
  state.where = {};
  state.area = null;
  state.sel = null;
  state.legendFilters = {};
  registerBaseFilter(HV, HV_BASE);
});

describe('setWhere', () => {
  it('adds conditions on top of the base filter and removes them again', () => {
    const { filters } = fakeMap(SUB_ML);
    applyVoltageFilter();
    expect(filters[HV]).toEqual(HV_BASE);

    expect(setWhere(SUBS, [KV345])).toBeNull();
    expect(state.where[SUBS]).toEqual([KV345]);
    expect(filters[HV]).toEqual(['all', HV_BASE, KV345_EXPR]);

    expect(setWhere(SUBS, [])).toBeNull();
    expect(SUBS in state.where).toBe(false);
    expect(filters[HV]).toEqual(HV_BASE);
  });

  it('composes with the legend filter under one flat all', () => {
    const { filters } = fakeMap(SUB_ML);
    state.legendFilters.kv = new Set(['550+']);
    applyVoltageFilter();
    const legendOnly = filters[HV] as unknown[];
    expect(legendOnly[0]).toBe('all');
    expect(legendOnly).toHaveLength(3);                      // all, base, kv buckets

    setWhere(SUBS, [KV345]);
    expect(filters[HV]).toEqual([...legendOnly, KV345_EXPR]);
  });

  it('re-filters only the changed layer\'s map layers', () => {
    const lines = layerById('osm-transmission-lines')!.mapLayerIds;
    const { map } = fakeMap([...SUB_ML, ...lines]);
    applyVoltageFilter();
    map.setFilter.mockClear();

    setWhere(SUBS, [KV345]);
    const touched = map.setFilter.mock.calls.map(c => c[0]);
    expect(new Set(touched)).toEqual(new Set(SUB_ML));
  });

  it('leaves state and map untouched when it refuses, and says why', () => {
    const { map } = fakeMap(SUB_ML);
    state.where = { [SUBS]: [KV345] };
    const before = state.where;
    const refusals: [string, unknown, string][] = [
      ['nws-alerts', [KV345], 'drawn partly by feature-state'],
      ['osm-dc-clusters', [KV345], '"osm-dc-clusters" is not a layer id'],       // map layer, not a registry id
      ['osm-dc-cluster-count', [KV345], '"osm-dc-cluster-count" is not a layer id'],
      ['nexrad-radar', [KV345], 'has no field schema'],
      ['no-such-layer', [KV345], '"no-such-layer" is not a layer id'],
      [SUBS, [{ field: 'states', op: '=', value: 'TX' }], 'is not a declared field'],
      [SUBS, [{ field: 'nominal_kv', op: 'in', value: [1] }], 'is not available on'],
      [SUBS, 'nominal_kv >= 345', 'conditions must be a list'],
    ];
    for (const [id, conds, why] of refusals) {
      expect(setWhere(id, conds as never), `${id} ${JSON.stringify(conds)}`).toContain(why);
    }
    expect(state.where).toBe(before);
    expect(state.where).toEqual({ [SUBS]: [KV345] });
    expect(map.setFilter).not.toHaveBeenCalled();
  });

  it('writes state but not the map before the map is ready', () => {
    const { map } = fakeMap(SUB_ML);
    state.mapReady = false;
    expect(setWhere(SUBS, [KV345])).toBeNull();
    expect(state.where[SUBS]).toEqual([KV345]);
    expect(map.setFilter).not.toHaveBeenCalled();
  });
});

describe('where ownership', () => {
  const stub = (id: string, ids: string[]) => ({ id, dataset: 'osm_substations_points', mapLayerIds: ids });

  it('excludes cluster aggregates and highlight twins, keeps the plain twins', () => {
    const owner = whereOwnership([
      stub('osm-datacenters', ['osm-dc-circles', 'osm-dc-clusters', 'osm-dc-cluster-count', 'osm-dc-points']),
      stub('wecc-paths', ['wecc-paths-circles', 'wecc-path-lines-highlight']),
    ]);
    expect(owner).toEqual({
      'osm-dc-circles': 'osm-datacenters',
      'osm-dc-points': 'osm-datacenters',
      'wecc-paths-circles': 'wecc-paths',
    });
  });

  it('skips layers without a dataset', () => {
    expect(whereOwnership([{ id: 'x', mapLayerIds: ['x-fill'] }])).toEqual({});
  });

  it('leaves the real cluster and highlight layers unfiltered', () => {
    expect(effectiveFilter('osm-dc-clusters')).toBeNull();
    expect(effectiveFilter('wecc-path-lines-highlight')).toBeNull();
  });
});

describe('invalid state.where', () => {
  it('records one diagnostic per bad entry, however many map layers refilter', () => {
    fakeMap(SUB_ML);
    clearDiagLog();
    state.where = { [SUBS]: [{ field: 'nope', op: '=', value: 1 }] };
    applyAllWhere();
    applyAllWhere();
    expect(getDiagLog().filter(e => String(e.detail).includes(SUBS))).toHaveLength(1);
    expect(effectiveFilter(HV)).toEqual(HV_BASE);            // bad entry skipped
  });
});

describe('applyAllWhere', () => {
  it('restores the exact pre-where filter once state.where is cleared', () => {
    const { filters } = fakeMap(SUB_ML);
    state.legendFilters.kv = new Set(['550+', '500-549']);
    applyVoltageFilter();
    const pre = structuredClone(filters);

    setWhere(SUBS, [KV345]);
    expect(filters[HV]).not.toEqual(pre[HV]);

    state.where = {};                                        // what a Reset writes
    applyAllWhere();
    expect(filters).toEqual(pre);
  });

  it('applies a where seeded straight into state (cold boot / applyView)', () => {
    const { filters } = fakeMap(SUB_ML);
    applyVoltageFilter();
    state.where = { [SUBS]: [KV345] };
    applyAllWhere();
    expect(effectiveFilter(HV)).toEqual(['all', HV_BASE, KV345_EXPR]);
    expect(filters[HV]).toEqual(['all', HV_BASE, KV345_EXPR]);
  });
});

describe('setArea', () => {
  const TX_ADMIN1 = ['in', '|USAB|', ['to-string', ['get', 'admin1']]];

  it('adds the area as the last part, beside a layer\'s own where, and clearing it keeps the where', () => {
    const { filters } = fakeMap(SUB_ML);
    applyVoltageFilter();
    expect(setWhere(SUBS, [KV345])).toBeNull();

    expect(setArea({ kind: 'states', codes: ['TX'] })).toBeNull();
    expect(state.area).toEqual({ kind: 'states', codes: ['TX'] });
    expect(filters[HV]).toEqual(['all', HV_BASE, KV345_EXPR, ['any', TX_ADMIN1]]);
    expect(state.where[SUBS]).toEqual([KV345]);

    expect(setArea(null)).toBeNull();
    expect(state.area).toBeNull();
    expect(filters[HV]).toEqual(['all', HV_BASE, KV345_EXPR]);
  });

  it('reaches layers no applier writes and leaves the cluster aggregates alone', () => {
    const ids = [...layerById('osm-datacenters')!.mapLayerIds];
    const { filters } = fakeMap(ids);
    expect(setArea({ kind: 'countries', codes: ['FRA'] })).toBeNull();
    expect(JSON.stringify(filters['osm-dc-points'])).toContain('|FRA|');
    expect('osm-dc-clusters' in filters).toBe(false);
  });

  it('leaves a layer the area cannot reach at its filter', () => {
    const { filters } = fakeMap(SUB_ML);
    applyVoltageFilter();
    expect(setArea({ kind: 'retail', codes: ['NA2'] })).toBeNull();
    // osm_substations_points carries retail, so it filters; HIFLD lines do not.
    expect(JSON.stringify(filters[HV])).toContain('|NA2|');
    for (const ml of layerById('hifld-transmission-lines')!.mapLayerIds) {
      expect(JSON.stringify(effectiveFilter(ml) ?? null), ml).not.toContain('retail');
    }
  });

  it('sorts the codes, and refuses a bad area without touching state or map', () => {
    const { map } = fakeMap(SUB_ML);
    expect(setArea({ kind: 'states', codes: ['TX', 'NM'] })).toBeNull();
    expect(state.area!.codes).toEqual(['NM', 'TX']);
    map.setFilter.mockClear();
    expect(setArea({ kind: 'states', codes: ['ZZ'] })).toEqual(expect.any(String));
    expect(setArea({ kind: 'zcta' as never, codes: ['77002'] })).toEqual(expect.any(String));
    expect(state.area!.codes).toEqual(['NM', 'TX']);
    expect(map.setFilter).not.toHaveBeenCalled();
  });
});

describe('generator filters keep their flat shape', () => {
  it('is base ∧ fuel ∧ mw ∧ … with where appended last', () => {
    const { filters } = fakeMap(['eia-gen-circles']);
    state.mwFilter = { min: 100, max: 10000 };
    applyGeneratorFilters();
    const mw = ['>=', ['coalesce', ['to-number', ['get', 'nameplate_mw']], 0], 100];
    expect(filters['eia-gen-circles']).toEqual(mw);

    setWhere('eia-generators', [{ field: 'op_year', op: '>=', value: 2000 }]);
    expect(filters['eia-gen-circles']).toEqual(['all', mw, valued('op_year', ['>=', ['to-number', ['get', 'op_year']], 2000])]);
    setWhere('eia-generators', []);
    state.mwFilter = { min: 0, max: 10000 };
  });
});

// ─── sel: isolate / keep on the stable id ─────────────────────────────────────
describe('setSelection', () => {
  const EIA = 'eia-generators';
  const EIA_CIRCLES = 'eia-gen-circles';
  const POINT_ONLY = ['==', ['geometry-type'], 'Point'] as FilterSpecification;
  const WIND = { field: 'energy_source', op: 'in' as const, value: ['WND'] };
  const GEOM = { Point: 1, LineString: 2, Polygon: 3 } as const;
  // Evaluates the map layer's filter the way MapLibre does, on a tile-like feature.
  const draws = (mlId: string, f: { id?: number; type?: keyof typeof GEOM; props: Record<string, unknown> }) => {
    const filter = effectiveFilter(mlId);
    if (!filter) return true;
    const test = featureFilter(filter as never, 'layers[0].filter');
    // nameplate_mw clears any MW range an earlier applier test left on the layer.
    const properties = { nameplate_mw: 500, ...f.props };
    return test.filter({ zoom: 8 }, { type: GEOM[f.type ?? 'Point'], id: f.id, properties } as never);
  };

  it('isolate on a native-id layer: base ∧ … ∧ id ∈ sel', () => {
    fakeMap(SUB_ML);
    expect(setSelection({ mode: 'isolate', ids: { [SUBS]: [12345678901] } })).toBeNull();
    expect(effectiveFilter(HV)).toEqual(['all', HV_BASE, ['in', ['id'], ['literal', [12345678901]]]]);
    expect(draws(HV, { id: 12345678901, props: { nominal_kv: 345 } })).toBe(true);
    expect(draws(HV, { id: 22222222221, props: { nominal_kv: 345 } })).toBe(false);
    // The band test still holds: a selected 100 kV substation is not an HV one.
    expect(draws(HV, { id: 12345678901, props: { nominal_kv: 100 } })).toBe(false);
  });

  it('keep on a promoted-id layer: base ∧ ((where) ∨ id ∈ sel)', () => {
    fakeMap([EIA_CIRCLES]);
    registerBaseFilter(EIA_CIRCLES, POINT_ONLY);
    setWhere(EIA, [WIND]);
    expect(setSelection({ mode: 'keep', ids: { [EIA]: ['27:3'] } })).toBeNull();
    const wind = { energy_source: 'WND', fid: '1:1' };
    const keptGas = { energy_source: 'NG', fid: '27:3' };
    const otherGas = { energy_source: 'NG', fid: '9:1' };
    expect(draws(EIA_CIRCLES, { props: wind })).toBe(true);
    expect(draws(EIA_CIRCLES, { props: keptGas })).toBe(true);
    expect(draws(EIA_CIRCLES, { props: otherGas })).toBe(false);
    // The base stays outside the OR: a kept polygon is no point layer's feature.
    expect(draws(EIA_CIRCLES, { type: 'Polygon', props: keptGas })).toBe(false);
    registerBaseFilter(EIA_CIRCLES, null);
  });

  it('isolate on a promoted-id layer keeps its where: selected ∧ filtered', () => {
    fakeMap([EIA_CIRCLES]);
    setWhere(EIA, [WIND]);
    setSelection({ mode: 'isolate', ids: { [EIA]: ['1:1', '27:3'] } });
    expect(draws(EIA_CIRCLES, { props: { energy_source: 'WND', fid: '1:1' } })).toBe(true);
    expect(draws(EIA_CIRCLES, { props: { energy_source: 'NG', fid: '27:3' } })).toBe(false);
    expect(draws(EIA_CIRCLES, { props: { energy_source: 'WND', fid: '5:1' } })).toBe(false);
  });

  it('keep with nothing filtering the layer adds nothing', () => {
    fakeMap(SUB_ML);
    setSelection({ mode: 'keep', ids: { [SUBS]: [12345678901] } });
    expect(effectiveFilter(HV)).toEqual(HV_BASE);
  });

  it('leaves a layer absent from sel.ids at its filter, and clears with null', () => {
    const { filters } = fakeMap([...SUB_ML, EIA_CIRCLES]);
    setWhere(EIA, [WIND]);
    const before = effectiveFilter(HV);
    setSelection({ mode: 'isolate', ids: { [EIA]: ['1:1'] } });
    expect(effectiveFilter(HV)).toEqual(before);
    expect(JSON.stringify(filters[EIA_CIRCLES])).toContain('"1:1"');
    expect(setSelection(null)).toBeNull();
    expect(state.sel).toBeNull();
    expect(JSON.stringify(filters[EIA_CIRCLES])).not.toContain('"1:1"');
  });

  it('refuses a bad selection without touching state or map, and says why', () => {
    const { map } = fakeMap(SUB_ML);
    setSelection({ mode: 'keep', ids: { [EIA]: ['1:1'] } });
    map.setFilter.mockClear();
    const ids = Array.from({ length: 501 }, (_, i) => `${i}:1`);
    expect(setSelection({ mode: 'keep', ids: { [EIA]: ids } })).toMatch(/at most 500/);
    expect(setSelection({ mode: 'keep', ids: { [SUBS]: [12345678900] } })).toMatch(/feature id/);
    expect(state.sel).toEqual({ mode: 'keep', ids: { [EIA]: ['1:1'] } });
    expect(map.setFilter).not.toHaveBeenCalled();
  });

  it('never reaches the cluster aggregates or highlight twins', () => {
    fakeMap(['osm-dc-clusters', 'osm-dc-points']);
    setSelection({ mode: 'isolate', ids: { 'osm-datacenters': [1261615731] } });
    expect(JSON.stringify(effectiveFilter('osm-dc-clusters') ?? null)).not.toContain('1261615731');
    expect(JSON.stringify(effectiveFilter('osm-dc-points'))).toContain('1261615731');
  });
});
