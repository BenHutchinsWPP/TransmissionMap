// effectiveFilter / setWhere / applyAllWhere on a recording fake map, plus the
// guard that every setFilter call site in assets/ is a known one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import type { FilterSpecification } from 'maplibre-gl';
import { state } from './state.js';
import { layerById } from '../src/registry/index.js';
import {
  registerBaseFilter, effectiveFilter, setWhere, applyAllWhere,
  applyVoltageFilter, applyGeneratorFilters, whereOwnership,
} from './filters.js';
import { getDiagLog, clearDiagLog } from './diag-log.js';

// ─── Every setFilter writer is accounted for ──────────────────────────────────
// filters.ts writes every feature filter through its single refilter() call,
// which composes base ∧ legend ∧ where. Any other site bypasses that and would
// drop a view's `where` conditions — the ones below write highlight twins that
// no legend filter or `where` targets. A new entry here needs that same reason.
const SETFILTER_SITES: Record<string, number> = {
  'filters.ts': 1,                  // refilter() — the effectiveFilter writer
  'hover.ts': 2,                    // polygon-hover + line click-highlight twins
  'layers/map-layers-wecc.ts': 2,   // wecc-path-lines-highlight (click selection)
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
const KV345_EXPR = ['>=', ['to-number', ['get', 'nominal_kv']], 345];

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
      ['osm-datacenters', [KV345], 'has no field schema'],
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

describe('generator filters keep their flat shape', () => {
  it('is base ∧ fuel ∧ mw ∧ … with where appended last', () => {
    const { filters } = fakeMap(['eia-gen-circles']);
    state.mwFilter = { min: 100, max: 10000 };
    applyGeneratorFilters();
    const mw = ['>=', ['coalesce', ['to-number', ['get', 'nameplate_mw']], 0], 100];
    expect(filters['eia-gen-circles']).toEqual(mw);

    setWhere('eia-generators', [{ field: 'op_year', op: '>=', value: 2000 }]);
    expect(filters['eia-gen-circles']).toEqual(['all', mw, ['>=', ['to-number', ['get', 'op_year']], 2000]]);
    setWhere('eia-generators', []);
    state.mwFilter = { min: 0, max: 10000 };
  });
});
