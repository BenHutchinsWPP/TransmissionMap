// @vitest-environment jsdom
// dataset-query.ts in scope 'dataset': a COLUMNS_DATASETS layer read from its columns file
// (assets/columns/fixtures/analysis/, served by a fetch stub) answers exactly as the GeoJSON path
// over the same rows (<ds>.features.json) and as featureFilter applied directly to them, for
// count, aggregate by a region list, query + orderBy and shapeRows (by + bins, Area, base filter);
// length sums and bins read the file's measures; ids / fragments / scope 'view' / geometry 'full'
// stay on the view; a missing index, or a read over the byte cap, answers from the view with a
// reason. Also: no Tier 1 base or applier filter depends on zoom or geometry type, which a columns
// row cannot answer.
import { describe as group, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { state } from './state.js';
import { seedView } from './view-state.js';
import { toMapLibreFilter, type Condition } from '../src/registry/condition-compile.js';
import { areaCondition, type AreaFilter } from '../src/registry/area-filter.js';
import { layerById, LAYERS } from '../src/registry/index.js';
import { layerSourceId } from './layers/layer-source.js';
import { registerBaseFilter, BASE_LAYER_FILTERS } from './layers/base-filters.js';
import { resetRangeIo, requestLog } from './parquet/range-io.js';
import { lengthKm } from './sandbox/geo-kit.js';
import { FACET_APPLIERS, effectiveFilter } from './filters.js';
import { applyLayerPlan, type LayerPlan } from './layers/layer-plan.js';
import {
  planOsmTransmission, planOsmSubstationPoints, planOsmSubstationPolygons, planOsmPlantPolygons,
  planOsmGenerators, planPipelineLines,
} from './layers/map-layers-osm.js';
import { planHifldTransmission, planHifldNatgasLines, planRetailTerritories } from './layers/map-layers-hifld.js';
import { planPadus, planCritHab } from './layers/map-layers-land.js';
import { describe, query, count, aggregate, shapeRows, hasColumns, type ShapeResult, type ShapeOpts } from './dataset-query.js';

// plannedBytes is wrapped so one test can push a read over the cap; every other call is the real one.
const cap = vi.hoisted(() => ({ over: false }));
vi.mock('./columns/columns-read.js', async importOriginal => {
  const m = await importOriginal<typeof import('./columns/columns-read.js')>();
  return { ...m, plannedBytes: async (...a: Parameters<typeof m.plannedBytes>) => cap.over ? 33 * 1024 * 1024 : m.plannedBytes(...a) };
});

const FIX = 'assets/columns/fixtures/';
const TL = 'osm-transmission-lines', RETAIL = 'retail-territories', SUBS = 'osm-substations-points';
const DATASET: Record<string, string> = { [TL]: 'osm_transmission_lines', [RETAIL]: 'retail_territories', [SUBS]: 'osm_substations_points' };
const features = (layerId: string): GeoJSON.Feature[] =>
  JSON.parse(readFileSync(`${FIX}${DATASET[layerId]}.features.json`, 'utf8')).features;

let indexMissing = false;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (!url.startsWith('data/analysis/') || (indexMissing && url.endsWith('index.json'))) return new Response('', { status: 404 });
  let bytes: Buffer;
  try { bytes = readFileSync(FIX + 'analysis/' + url.slice('data/analysis/'.length)); } catch { return new Response('', { status: 404 }); }
  const m = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/);
  if (!m) return new Response(new Uint8Array(bytes), { status: 200 });
  return new Response(new Uint8Array(bytes.subarray(Number(m[1]), Number(m[2]) + 1)), { status: 206 });
});
const indexFetches = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('index.json')).length;

beforeEach(() => {
  resetRangeIo();
  indexMissing = false;
  cap.over = false;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  state.map = null;
  state.mapReady = false;
  state.layerVisibility = {};
  state.legendFilters = {};
  state.layerFilters = {};
  state.genMode = {};
  state.sourcesData = {};
  state.sourcesLoaded = {};
  for (const k of Object.keys(BASE_LAYER_FILTERS)) delete BASE_LAYER_FILTERS[k];
  seedView({});
});
afterEach(() => { vi.unstubAllGlobals(); });

/** `fn` run with `layerId` declared a GeoJSON layer holding `<ds>.features.json`: the GeoJSON path over the same rows. */
async function asGeojson<T>(layerId: string, fn: () => Promise<T>): Promise<T> {
  const entry = layerById(layerId)!;
  const data = entry.data!;
  const src = layerSourceId(layerId);
  state.sourcesData[src] = features(layerId);
  state.sourcesLoaded[src] = true;
  entry.data = { ...data, kind: 'geojson' };
  try { return await fn(); } finally {
    entry.data = data;
    delete state.sourcesData[src];
    delete state.sourcesLoaded[src];
  }
}

/** The rows `where` ∧ `area` pass, by featureFilter on the compiled conditions directly (no dataset-query code). */
function reference(layerId: string, where: Condition[], area?: AreaFilter, extra?: unknown) {
  const ds = DATASET[layerId];
  const conds = [...where];
  const ac = area && areaCondition(ds, area);
  if (ac && ac !== 'all' && !('unfiltered' in ac)) conds.push(ac);
  const parts = [...(conds.length ? [toMapLibreFilter(ds, conds)] : []), ...(extra ? [extra] : [])];
  if (!parts.length) return features(layerId);
  const f = featureFilter((parts.length === 1 ? parts[0] : ['all', ...parts]) as never, 'layers[0].filter');
  return features(layerId).filter(x => f.filter({ zoom: 0 }, { type: 2, properties: x.properties!, id: x.id } as never));
}

const ok = <T>(r: { ok: true; result: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(r.reason);
  return r.result;
};

const TX: AreaFilter = { kind: 'states', codes: ['TX'] };
const HIGH: Condition[] = [{ field: 'nominal_kv', op: '>=', value: 200 }];

group('dataset scope equals the GeoJSON path over the same rows', () => {
  it('count, with and without where and Area', async () => {
    expect(hasColumns(TL)).toBe(true);
    for (const opts of [{}, { where: HIGH }, { area: TX }, { where: HIGH, area: TX }, { area: { kind: 'countries', codes: ['FRA'] } as AreaFilter }]) {
      const d = ok(await count(TL, opts));
      expect(d.complete).toBe(true);
      expect(d.reason).toBeUndefined();
      const g = ok(await asGeojson(TL, () => count(TL, opts)));
      expect(d.total).toBe(g.total);
      expect(d.total).toBe(reference(TL, opts.where ?? [], opts.area).length);
    }
    expect(ok(await count(TL, { where: HIGH, area: TX })).total).toBe(3);   // Alpha, Bravo, Delta
  });

  it('aggregate by a region list (each code once per feature); a kV sum refused on both paths', async () => {
    // Groups of equal size come in file order, which differs (Hilbert) from features.json: compare by key.
    const byKey = (r: { groups: { key: unknown }[] }) => [...r.groups].sort((x, y) => String(x.key).localeCompare(String(y.key)));
    for (const kv of [await aggregate(TL, { groupBy: 'admin1', sum: ['nominal_kv'] }), await asGeojson(TL, () => aggregate(TL, { groupBy: 'admin1', sum: ['nominal_kv'] }))]) {
      expect(!kv.ok && kv.reason).toMatch(/is a level, not an amount/);
    }
    for (const opts of [{ groupBy: 'admin1' }, { groupBy: 'countries' }, { groupBy: 'admin1', where: HIGH, area: TX }]) {
      const d = ok(await aggregate(TL, opts));
      const g = ok(await asGeojson(TL, () => aggregate(TL, opts)));
      expect(d.complete).toBe(true);
      expect(byKey(d)).toEqual(byKey(g));
      expect([d.total, d.groupBy, d.sum]).toEqual([g.total, g.groupBy, g.sum]);
      expect(d.total).toBe(reference(TL, opts.where ?? [], opts.area).length);
    }
    const r = ok(await aggregate(RETAIL, { groupBy: 'type', sum: ['customers'] }));
    const g = ok(await asGeojson(RETAIL, () => aggregate(RETAIL, { groupBy: 'type', sum: ['customers'] })));
    expect(byKey(r)).toEqual(byKey(g));
    expect(r.groups.find(x => x.key === null)).toMatchObject({ count: 1, sums: { customers: 0 } });   // Cedar: no type, no customers
  });

  it('query + orderBy: the same rows in the same order, each a point on the feature', async () => {
    for (const opts of [
      { orderBy: { field: 'nominal_kv', desc: true }, limit: 5, fields: ['name', 'nominal_kv'] },
      { orderBy: { field: 'name' }, area: TX },
      { where: HIGH, orderBy: { field: 'name', desc: true }, limit: 2 },
      { orderBy: { field: 'nominal_kv' }, limit: 1 },
    ]) {
      const d = ok(await query(TL, opts));
      const g = ok(await asGeojson(TL, () => query(TL, opts)));
      expect(d.complete).toBe(true);
      expect(d.rows.map(r => [r.id, r.props])).toEqual(g.rows.map(r => [r.id, r.props]));
      expect([d.total, d.truncated, d.fields]).toEqual([g.total, g.truncated, g.fields]);
      for (const r of d.rows) {
        expect(r.pointOnly).toBe(true);
        expect(r.feature.geometry.type).toBe('Point');
      }
    }
    // A non-native id (retail `id`) is the row id and a field.
    const r = ok(await query(RETAIL, { orderBy: { field: 'customers', desc: true }, limit: 2 }));
    expect(r.rows.map(x => [x.id, x.props.id, x.props.name])).toEqual([['R2', 'R2', 'Birch'], ['R6', 'R6', 'Fir']]);
  });

  it('shapeRows by kV class with bins, under an Area and a base filter, on a layer that is off', async () => {
    const base = ['!=', ['get', 'name'], 'Delta'];
    for (const id of layerById(TL)!.mapLayerIds) registerBaseFilter(id, base as never);
    state.layerVisibility[TL] = false;
    const opts: ShapeOpts = { by: ['nominal_kv'], bins: { field: 'nominal_kv', scale: 'lin', buckets: 5 }, area: TX, where: HIGH };
    const d = ok(await shapeRows(TL, opts));
    const g = ok(await asGeojson(TL, () => shapeRows(TL, opts)));
    expect(d).toMatchObject({ scope: 'area', complete: true, precision: 'whole features (columns file)', truncated: false });
    const strip = (r: ShapeResult) => ({ ...r, precision: 0 });
    expect(strip(d)).toEqual(strip(g));
    expect(d.totals.count).toBe(reference(TL, HIGH, TX, base).length);
    expect(d.totals.count).toBe(2);   // Alpha 345, Bravo 230 (Delta by the base filter)
  });

  it('shapeRows features are points; sums and bins of length read the file\'s length_km', async () => {
    const d = ok(await shapeRows(TL, { measure: 'length_km', bins: { field: 'length_km' }, geometry: 'point' }));
    const want = features(TL).reduce((a, f) => a + lengthKm(f.geometry as never), 0);
    expect(d.totals.sum!).toBeGreaterThan(0);
    expect(Math.abs(d.totals.sum! - want) / want).toBeLessThan(1e-3);   // float32 on the sphere vs geo-kit
    expect(d.bins!.stats!.n).toBe(12);
    expect(d.features).toHaveLength(12);
    expect(d.features!.every(f => f.geometry.type === 'Point' && (f.properties!.length_km as number) > 0)).toBe(true);
  });

  it('keeps every k-th passing feature past the limit, and says so', async () => {
    const all = ok(await shapeRows(TL, { geometry: 'point' })).features!.map(f => f.id);
    expect(all).toHaveLength(12);
    const d = ok(await shapeRows(TL, { geometry: 'point', limitFeatures: 5 }));
    expect(d.totals.count).toBe(12);
    expect(d.features!.map(f => f.id)).toEqual(all.filter((_, i) => i % 3 === 0));   // k = ceil(12 / 5) = 3, in file order
    expect(d).toMatchObject({ truncated: true, truncation: 'features: every 3-th of 12 kept (4)' });
  });
});

group('row-group pruning is a shortcut only', () => {
  it('an Area outside most groups reads fewer bytes for the same answer', async () => {
    const bytes = () => requestLog.reduce((a, r) => a + r.end - r.start, 0);
    const where: Condition[] = [{ field: 'nominal_kv', op: '>', value: 0 }];
    await count(TL, { where });   // footer and index first
    requestLog.length = 0;
    resetRangeIo();
    const all = ok(await count(TL, { where }));
    const whole = bytes();
    resetRangeIo();
    const fra = ok(await count(TL, { where, area: { kind: 'countries', codes: ['FRA'] } }));
    expect(all.total).toBe(10);
    expect(fra.total).toBe(1);
    expect(bytes()).toBeLessThan(whole);
  });

  it('asDrawn prunes on the view\'s Area and where too, and keeps the drawn test', async () => {
    const tiers = layerById(TL)!.mapLayerIds;
    const layers = Object.fromEntries(tiers.map(id => [id, { source: TL, minzoom: id.endsWith('-lv') ? 9 : 0 }]));
    state.map = { getLayer: (id: string) => layers[id], getZoom: () => 6, setFilter: () => {} } as unknown as typeof state.map;
    state.mapReady = true;
    state.layerVisibility[TL] = true;
    state.area = TX;
    state.where = { [TL]: HIGH };
    const d = ok(await count(TL, { asDrawn: true }));
    const g = ok(await asGeojson(TL, () => count(TL, { asDrawn: true })));
    expect(d).toMatchObject({ complete: true, total: g.total });
    expect(d.total).toBeGreaterThan(0);
    state.layerVisibility[TL] = false;
    expect(ok(await count(TL, { asDrawn: true }))).toMatchObject({ total: 0, complete: true, reason: expect.stringMatching(/is off/) });
  });
});

group('asDrawn in dataset scope', () => {
  it('reads the layer\'s filters over the whole dataset at any zoom; the view still follows the zoom', async () => {
    const tiers = layerById(TL)!.mapLayerIds;
    const layers = Object.fromEntries(tiers.map(id => [id, { source: TL, minzoom: 9 }]));
    state.map = { getLayer: (id: string) => layers[id], getZoom: () => 6, setFilter: () => {} } as unknown as typeof state.map;
    state.mapReady = true;
    state.layerVisibility[TL] = true;
    state.area = TX;
    const all = ok(await count(TL, { area: TX })).total;
    expect(all).toBeGreaterThan(0);
    const d = ok(await count(TL, { asDrawn: true }));
    expect(d.total).toBe(all);
    expect(d.reason).toBeUndefined();
    expect(ok(await query(TL, { asDrawn: true })).total).toBe(all);
    const v = ok(await asGeojson(TL, () => count(TL, { asDrawn: true })));
    expect(v.total).toBe(0);
    expect(v.reason).toMatch(/not drawn at zoom/);
  });
});

/** A map whose loaded tiles hold two lines of the layer (one of them also in the file). */
function tileMap() {
  const line = (id: number, kv: number) => ({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { nominal_kv: kv } });
  state.map = {
    getLayer: (id: string) => id === 'osm-transmission-lines-hv' ? { source: TL, sourceLayer: 'osm_transmission_lines' } : undefined,
    getZoom: () => 6,
    querySourceFeatures: () => [line(10000000012, 345), line(99, 500)],
    setFilter: () => {},
  } as unknown as typeof state.map;
  state.mapReady = true;
}

group('what stays on the view', () => {
  it('ids, fragments and scope "view" read the loaded tiles, without the index', async () => {
    tileMap();
    for (const opts of [{ ids: [99] }, { fragments: true }, { scope: 'view' as const }]) {
      const r = ok(await query(TL, opts));
      expect(r.complete).toBe(false);
      expect(r.rows.every(x => !x.pointOnly)).toBe(true);
    }
    expect(ok(await query(TL, { ids: [99] })).rows.map(x => x.id)).toEqual([99]);
    expect(indexFetches()).toBe(0);
  });

  it('shapeRows with geometry "full" reads the view (and must be on)', async () => {
    tileMap();
    state.layerVisibility[TL] = false;
    expect(await shapeRows(TL, { geometry: 'full' })).toMatchObject({ ok: false, reason: expect.stringMatching(/is off/) });
    expect(indexFetches()).toBe(0);
  });

  it('describe says complete for a columns layer, and each call\'s result says what it was', async () => {
    const d = describe(TL);
    expect(d.ok && d.result.queryable && d.result.complete).toBe(true);
    indexMissing = true;
    tileMap();
    const r = ok(await count(TL));
    expect(r).toMatchObject({ complete: false, total: 2 });
    expect(r.reason).toMatch(/current view \(no whole-dataset file is published for it\)/);
  });
});

group('fallback to the view, with the reason', () => {
  it('asDrawn with no columns file keeps the zoom-aware test: a tier out of zoom lists nothing, the zoom reason wins', async () => {
    indexMissing = true;
    const ids = layerById(TL)!.mapLayerIds;
    const line = { type: 'Feature', id: 10000000012, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { nominal_kv: 345 } };
    state.map = {
      getLayer: (id: string) => ids.includes(id) ? { source: TL, sourceLayer: 'osm_transmission_lines', minzoom: 9 } : undefined,
      getZoom: () => 6, querySourceFeatures: () => [line], setFilter: () => {},
    } as unknown as typeof state.map;
    state.mapReady = true;
    state.layerVisibility[TL] = true;
    const r = ok(await count(TL, { asDrawn: true }));
    expect(r).toMatchObject({ total: 0, complete: false });
    expect(r.reason).toMatch(/not drawn at zoom 6/);
  });

  it('index.json 404: count/query/aggregate answer from the view; a shape with an Area is refused', async () => {
    indexMissing = true;
    tileMap();
    const r = ok(await aggregate(TL, { groupBy: 'admin1' }));
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/no whole-dataset file/);
    expect(await shapeRows(TL, { area: TX })).toMatchObject({ ok: false,
      reason: expect.stringMatching(/tiled layers cover the current view only.*no whole-dataset file/) });
  });

  it('a read planned over the byte cap answers from the view and reads no row group', async () => {
    cap.over = true;
    tileMap();
    const r = ok(await count(TL, { where: HIGH }));
    expect(r).toMatchObject({ complete: false, reason: expect.stringMatching(/exceed 32 MiB/) });
    const footerOnly = requestLog.every(x => x.end - x.start <= 4096);
    expect(footerOnly).toBe(true);
  });
});

group('Tier 1 filters need neither zoom nor geometry type', () => {
  // A label companion (a symbol layer the registry does not make clickable) is left out: shapeRows
  // never reads it, and a dataset-scope asDrawn leaves it out too (the view path tests it at the map's zoom).
  it('no base or applier filter of a feature-drawing map layer of a COLUMNS_DATASETS layer reads zoom, $type or geometry-type', () => {
    const added = new Map<string, unknown>();
    const map = {
      getSource: (id: string) => added.get('s:' + id),
      getLayer: (id: string) => added.get('l:' + id),
      addSource: (id: string, spec: unknown) => { added.set('s:' + id, spec); },
      addLayer: (spec: { id: string }) => { added.set('l:' + spec.id, spec); },
      setFilter: () => {}, setLayoutProperty: () => {}, on: () => {}, off: () => {},
    };
    state.map = map as unknown as typeof state.map;
    const plans: LayerPlan = [
      ...planOsmTransmission(), ...planOsmSubstationPoints(), ...planOsmSubstationPolygons(), ...planOsmPlantPolygons(),
      ...planOsmGenerators(), ...planPipelineLines(), ...planHifldTransmission(), ...planHifldNatgasLines(),
      ...planRetailTerritories(), ...planPadus(), ...planCritHab(),
    ];
    applyLayerPlan(map as never, plans);
    for (const apply of Object.values(FACET_APPLIERS)) apply();
    const tier1 = LAYERS.filter(l => hasColumns(l.id));
    expect(tier1).toHaveLength(11);
    const bad: string[] = [];
    for (const l of tier1) {
      for (const id of l.mapLayerIds) {
        if (!(id in BASE_LAYER_FILTERS)) bad.push(`${id}: not built`);
        const spec = added.get('l:' + id) as { type?: string } | undefined;
        if (spec?.type === 'symbol' && !Object.hasOwn(l.clickPriority ?? {}, id)) continue;
        const json = JSON.stringify(effectiveFilter(id));
        for (const tok of ['"zoom"', '"$type"', '"geometry-type"']) if (json.includes(tok)) bad.push(`${id}: ${tok}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
