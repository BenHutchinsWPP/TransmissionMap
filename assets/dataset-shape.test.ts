// @vitest-environment jsdom
// dataset-query.ts shapeRows(), the template data pass, on synthetic fixtures:
// no 5,000-row cut on a 34k-unit layer, cuts reported, kV classes binned as
// kvBucketOf bins them, region lists exploded, years read from numbers and
// free text, the base filter applied (a layer without one passes all), a
// tiled layer's view scope (tiers hidden, symbol-only layers, refusals, one count and one length per feature across tile
// pieces), refusal hints, and the timing on 34k / 55k features.
import { describe as group, it, expect, beforeEach } from 'vitest';
import { state } from './state.js';
import { seedView } from './view-state.js';
import { shapeRows, shapeSlots, yearOf, monthOf, binEdges, binIndex, binStats, count, mergeViewPieces, SHAPE_MAX_FEATURES, QUERY_MAX_ROWS, type ShapeResult } from './dataset-query.js';
import { conditionForBin } from './templates/template-actions.js';
import { STATE_TO_ADMIN1 } from '../src/registry/region-codes.js';
import { layerSourceId } from './layers/layer-source.js';
import { registerBaseFilter, BASE_LAYER_FILTERS } from './layers/base-filters.js';
import { kvBucketOf } from '../src/colors/buckets.js';
import { haversineKm, ringAreaKm2 } from './sandbox/geo-kit.js';

const EIA = 'eia-generators', HIFLD = 'hifld-substations', OSM_TL = 'osm-transmission-lines';
const FUELS = ['NG', 'SUN', 'WND', 'COL', 'NUC', 'WAT'];
const STATES = ['|TX|', '|NM|TX|', '|CA|', '|AZ|NM|', '|none|'];

const point = (i: number, properties: Record<string, unknown>): GeoJSON.Feature =>
  ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-120 + (i % 500) * 0.05, 30 + (i % 300) * 0.05] }, properties });

const eia = (n: number) => Array.from({ length: n }, (_, i) => point(i, {
  fid: `${i}:1`, plant_name: `P${i}`, energy_source: FUELS[i % FUELS.length], gen_status: 'existing',
  nameplate_mw: (i % 100) + 0.5, op_year: i % 50 === 0 ? 0 : 1950 + (i % 70), states: STATES[i % STATES.length],
}));
const KVS = [null, '', -1, 0, 12, 69, 99.9, 100, 138, 230, 345, 499, 500, 549, 550, 765, '115', 'n/a'];
const hifld = (n: number) => Array.from({ length: n }, (_, i) => point(i, {
  hifld_id: `h${i}`, name: `S${i}`, max_kv: KVS[i % KVS.length], states: STATES[i % STATES.length],
}));

function loadGeojson(layerId: string, features: GeoJSON.Feature[]) {
  const src = layerSourceId(layerId);
  state.sourcesData[src] = features;
  state.sourcesLoaded[src] = true;
}

type FakeLayer = { source: string; sourceLayer?: string; minzoom?: number; maxzoom?: number; type?: string };
function fakeMap(layers: Record<string, FakeLayer>, tiles: Record<string, GeoJSON.Feature[]> = {}, zoom = 6,
  bounds: [number, number, number, number] = [-180, -85, 180, 85]) {
  state.map = {
    getLayer: (id: string) => layers[id],
    getSource: () => ({ setData: () => {} }),
    getZoom: () => zoom,
    getBounds: () => ({ getWest: () => bounds[0], getSouth: () => bounds[1], getEast: () => bounds[2], getNorth: () => bounds[3] }),
    querySourceFeatures: (src: string) => tiles[src] ?? [],
    setFilter: () => {},
    on: () => {},
  } as unknown as typeof state.map;
  state.mapReady = true;
}

const ok = (r: Awaited<ReturnType<typeof shapeRows>>): ShapeResult => {
  if (!r.ok) throw new Error(r.reason);
  return r.result;
};
const refusal = (r: Awaited<ReturnType<typeof shapeRows>>) => (r.ok ? '' : r.reason);

beforeEach(() => {
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

group('GeoJSON layers: the whole file, uncut', () => {
  it(`groups all 34,000 units, not the first ${QUERY_MAX_ROWS}, in under 300 ms`, async () => {
    loadGeojson(EIA, eia(34_000));
    fakeMap({});
    await shapeRows(EIA, { by: ['energy_source'] });   // warm the featureFilter chunk
    const t0 = performance.now();
    const r = ok(await shapeRows(EIA, { by: ['energy_source'], measure: 'nameplate_mw' }));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(300);
    expect(r).toMatchObject({ scope: 'area', complete: true, truncated: false, unit: 'MW', measure: 'nameplate_mw' });
    expect(r.totals.count).toBe(34_000);
    expect(r.rows.reduce((a, x) => a + x.count, 0)).toBe(34_000);
    expect(r.rows.map(x => x.energy_source).sort()).toEqual([...FUELS].sort());
    expect(r.rows[0].sum).toBeGreaterThanOrEqual(r.rows[1].sum!);
    expect(r.features).toBeUndefined();
  });

  it('bins 55,000 substations by kV class exactly as kvBucketOf does, in under 300 ms', async () => {
    const feats = hifld(55_000);
    loadGeojson(HIFLD, feats);
    fakeMap({});
    await shapeRows(HIFLD, {});
    const t0 = performance.now();
    const r = ok(await shapeRows(HIFLD, { by: ['max_kv'] }));
    expect(performance.now() - t0).toBeLessThan(300);
    const want = new Map<string, number>();
    for (const f of feats) { const k = kvBucketOf(f.properties!.max_kv); want.set(k, (want.get(k) ?? 0) + 1); }
    expect(new Map(r.rows.map(x => [x.max_kv as string, x.count]))).toEqual(want);
    expect(want.get('unknown')).toBeGreaterThan(0);
  });

  it('caps features at 50,000 and says so; limitFeatures cuts earlier; rows stay whole', async () => {
    loadGeojson(HIFLD, hifld(55_000));
    fakeMap({});
    const r = ok(await shapeRows(HIFLD, { by: ['max_kv'], geometry: 'point' }));
    expect(r.features).toHaveLength(SHAPE_MAX_FEATURES);
    expect(r).toMatchObject({ truncated: true, truncation: `features: ${SHAPE_MAX_FEATURES} of 55000 kept` });
    expect(r.rows.reduce((a, x) => a + x.count, 0)).toBe(55_000);
    expect(r.features![0]).toMatchObject({ id: 'h0', geometry: { type: 'Point' }, properties: { name: 'S0', max_kv: 'unknown' } });
    const few = ok(await shapeRows(HIFLD, { geometry: 'full', limitFeatures: 10 }));
    expect(few.features).toHaveLength(10);
    expect(few.truncated).toBe(true);
    const all = ok(await shapeRows(HIFLD, { geometry: 'point', where: [{ field: 'max_kv', op: '>=', value: 700 }] }));
    expect(all.truncated).toBe(false);
  });

  it('counts a feature under each region tag; totals count it once', async () => {
    loadGeojson(EIA, eia(10));
    fakeMap({});
    const r = ok(await shapeRows(EIA, { by: ['states'], measure: 'nameplate_mw' }));
    const tx = r.rows.find(x => x.states === 'TX')!;
    expect(tx.count).toBe(4);   // |TX| ×2, |NM|TX| ×2
    expect(r.rows.find(x => x.states === 'NM')!.count).toBe(4);
    expect(r.totals.count).toBe(10);
    expect(r.rows.reduce((a, x) => a + x.count, 0)).toBe(14);
  });

  it('groups two ways and by year, sorted by year; a sentinel year is null', async () => {
    loadGeojson(EIA, eia(200));
    fakeMap({});
    const r = ok(await shapeRows(EIA, { by: ['energy_source', 'states'], time: { field: 'op_year', bin: 'year' } }));
    expect(r.time).toBe('op_year');
    expect(r.rows[0].op_year).toBe(1950);
    expect(r.rows.at(-1)!.op_year).toBeNull();
    expect(r.rows.every(x => 'energy_source' in x && 'states' in x)).toBe(true);
    expect(r.rows.filter(x => x.op_year === null).reduce((a, x) => a + x.count, 0)).toBeGreaterThan(0);
  });

  it('applies where and area like the map, and the base filter of the layer\'s map layers', async () => {
    loadGeojson(EIA, eia(60));
    fakeMap({ 'eia-gen-circles': { source: EIA, type: 'circle' }, 'eia-gen-heat': { source: EIA, type: 'heatmap' } });
    const where = [{ field: 'energy_source', op: '=' as const, value: 'NG' }];
    expect(ok(await shapeRows(EIA, { where })).totals.count).toBe(10);
    expect(ok(await shapeRows(EIA, { where, area: { kind: 'states', codes: ['CA'] } })).totals.count).toBe(2);
    registerBaseFilter('eia-gen-circles', ['==', ['get', 'energy_source'], 'SUN']);
    registerBaseFilter('eia-gen-heat', ['==', ['get', 'energy_source'], 'WND']);
    expect(ok(await shapeRows(EIA, {})).totals.count).toBe(20);
  });
});

group('numeric bins', () => {
  const inOne = (edges: number[], xs: number[]) => xs.every(v => {
    const hits = edges.slice(0, -1).filter((lo, i) => v >= lo && v < edges[i + 1]).length;
    return hits === 1 && binIndex(edges, v) === edges.findIndex((lo, i) => v >= lo && v < edges[i + 1]);
  });

  it('aims for about the requested number of bins', () => {
    const xs = Array.from({ length: 500 }, (_, i) => i * 0.37);
    const n = (t: number) => binEdges(xs, 'lin', t).edges.length - 1;
    expect(n(5)).toBeLessThan(n(10));
    expect(n(10)).toBeLessThan(n(40));
    expect(n(40)).toBeLessThanOrEqual(60);
  });

  it('puts every value in exactly one [lo, hi) bin, linear or log, on nice edges', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(rnd() * 300), spread = 10 ** Math.floor(rnd() * 8 - 3), shift = rnd() < 0.3 ? -spread * rnd() : 0;
      const xs = Array.from({ length: n }, () => rnd() < 0.1 ? 0 : shift + (rnd() < 0.5 ? rnd() : rnd() ** 6) * spread);
      for (const scale of ['auto', 'lin', 'log'] as const) {
        const { edges } = binEdges(xs, scale);
        expect(edges.length, `${k} ${scale}`).toBeGreaterThan(1);
        expect(edges.every((e, i) => i === 0 || e > edges[i - 1])).toBe(true);
        expect(inOne(edges, xs), `${k} ${scale}`).toBe(true);
        expect(edges.length).toBeLessThanOrEqual(60);
      }
    }
  });

  it('linear: 1/2/5 steps, whole steps for whole numbers; log when skewed; none without values', () => {
    expect(binEdges([0.1, 0.35, 1.9])).toEqual({ scale: 'lin', edges: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2] });
    expect(binEdges([1990, 1994, 1999]).edges).toEqual([1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000]);
    expect(binEdges([5, 5, 5])).toEqual({ scale: 'lin', edges: [5, 6] });
    const log = binEdges([0, 0.5, 1, 1, 2, 3, 4, 5000]);
    expect(log).toEqual({ scale: 'log', edges: [0, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000] });
    expect(binEdges([-1, 1, 5000]).scale).toBe('lin');   // a negative value: no log
    expect(binEdges([], 'log')).toEqual({ scale: 'lin', edges: [] });
    expect(binIndex([], 1)).toBe(-1);
    // Quantiles by nearest rank over the values themselves; nulls skipped.
    expect(binStats([null, 5, 1, 3, 2, 4, 6, 7, 8, 9, 10])).toEqual({ n: 10, p10: 1, median: 5, p90: 9 });
    expect(binStats([null])).toBeNull();
    expect(binIndex([0, 1, 2], Number.NaN)).toBe(-1);
    expect(binIndex([0, 1, 2], 2)).toBe(-1);
  });

  it('shapeSlots offers levels, length / area and years to bin, never count', () => {
    expect(shapeSlots(HIFLD)!.bins).toEqual(['max_kv', 'min_kv']);
    expect(shapeSlots(EIA)!.bins).toEqual(['nameplate_mw', 'op_year', 'retirement_year']);
    expect(shapeSlots('ogf-planned-transmission')!.bins).toContain('length_km');
    expect(shapeSlots('padus')!.bins).toContain('area_km2');
  });

  it('bins a level with missing and non-numeric values; each bin\'s where matches exactly its rows', async () => {
    loadGeojson(HIFLD, hifld(1800));
    fakeMap({});
    const r = ok(await shapeRows(HIFLD, { bins: { field: 'max_kv' }, by: ['states'], geometry: 'point' }));
    expect(r.bins).toMatchObject({ field: 'max_kv', scale: 'lin' });
    // null, '', 'n/a' and a kV of 0 or less (the data's "unknown") have no value: the row with bin null, never dropped.
    const none = r.rows.filter(x => x.bin === null);
    expect(none.every(x => x.lo === undefined && x.hi === undefined)).toBe(true);
    const once = ok(await shapeRows(HIFLD, { bins: { field: 'max_kv' } }));
    expect(once.rows.reduce((a, x) => a + x.count, 0)).toBe(1800);
    expect(once.rows.find(x => x.bin === null)!.count).toBe(500);
    expect(once.bins!.stats!.n).toBe(1300);
    expect(once.rows.map(x => x.bin)).toEqual([...once.rows.map(x => x.bin)].sort((a, b) => a === null ? 1 : b === null ? -1 : Number(a) - Number(b)));
    for (const row of once.rows.filter(x => x.bin !== null)) {
      expect(row.lo).toBe(once.bins!.edges[row.bin as number]);
      const where = conditionForBin(HIFLD, 'max_kv', row.bin!, { lo: row.lo, hi: row.hi });
      if (!where.ok) throw new Error(where.reason);
      const c = await count(HIFLD, { where: where.result });
      expect(c.ok && c.result.total, `bin ${row.lo}–${row.hi}`).toBe(row.count);
    }
    expect(r.features![0].properties).toHaveProperty('max_kv');
  });

  it('bins length on a line layer and an amount on points, summing a measure per bin', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [0.01 * (i + 1), 0]] },
      properties: { RecordID: i, Project: `L${i}` } }) as GeoJSON.Feature);
    loadGeojson('ogf-planned-transmission', lines);
    fakeMap({});
    const l = ok(await shapeRows('ogf-planned-transmission', { bins: { field: 'length_km' }, measure: 'length_km' }));
    expect(l.rows.reduce((a, x) => a + x.count, 0)).toBe(50);
    expect(l.rows.reduce((a, x) => a + x.sum!, 0)).toBeCloseTo(l.totals.sum!, 6);
    loadGeojson(EIA, eia(500));
    const e = ok(await shapeRows(EIA, { bins: { field: 'nameplate_mw' }, measure: 'nameplate_mw' }));
    expect(e.rows.reduce((a, x) => a + x.count, 0)).toBe(500);
    expect(e.rows.every(x => x.bin !== null)).toBe(true);
  });

  it('refuses a field it cannot bin, and count', async () => {
    loadGeojson(EIA, eia(5));
    fakeMap({});
    expect(refusal(await shapeRows(EIA, { bins: { field: 'energy_source' } }))).toMatch(/"energy_source" cannot be binned on "eia-generators": bins take nameplate_mw, op_year, retirement_year/);
    expect(refusal(await shapeRows(EIA, { bins: { field: 'count' } }))).toMatch(/cannot be binned/);
  });
});

group('month bins', () => {
  const DCM = 'dc-moratoriums';
  const DATES = ['2024-01-15', '2024-01-31', '2024-02-01', '2024-12-31', '2025-01-01', '', 'unknown', '2024-13-01', '2024-12-00', '2024-12-15T10:00'];
  const dcm = () => DATES.map((d, i) => point(i, { fid: i, name: `J${i}`, cls: 'ban', last_event: d || null }));

  it('reads "YYYY-MM" from a date, null otherwise', () => {
    expect(['2024-03-09', '1999-12-31'].map(monthOf)).toEqual(['2024-03', '1999-12']);
    expect(['2024-13-01', '2024-03', '2024-03-00', '1999-12-31T00:00', '24-03-01', '', null, 2024].map(monthOf)).toEqual(Array(8).fill(null));
  });

  it('groups a date field by month; each month\'s where (and a year\'s) matches exactly its rows', async () => {
    loadGeojson(DCM, dcm());
    fakeMap({});
    const r = ok(await shapeRows(DCM, { time: { field: 'last_event', bin: 'month' } }));
    expect(r.timeBin).toBe('month');
    expect(r.rows.map(x => [x.last_event, x.count])).toEqual([['2024-01', 2], ['2024-02', 1], ['2024-12', 1], ['2025-01', 1], [null, 5]]);
    for (const row of r.rows.filter(x => x.last_event !== null)) {
      const where = conditionForBin(DCM, 'last_event', row.last_event!);
      if (!where.ok) throw new Error(where.reason);
      const c = await count(DCM, { where: where.result });
      expect(c.ok && c.result.total, String(row.last_event)).toBe(row.count);
    }
    const y = conditionForBin(DCM, 'last_event', 2024);
    expect(y).toEqual({ ok: true, result: [{ field: 'last_event', op: '>=', value: '2024-01-01' }, { field: 'last_event', op: '<=', value: '2024-12-31' }] });
    const years = ok(await shapeRows(DCM, { time: { field: 'last_event', bin: 'year' } }));
    expect(years.rows.map(x => [x.last_event, x.count])).toEqual([[2024, 5], [2025, 1], [null, 4]]);   // 2024-12-00 is in 2024, in no month
    for (const row of years.rows.filter(x => x.last_event !== null)) {
      const where = conditionForBin(DCM, 'last_event', row.last_event!);
      const c = await count(DCM, { where: where.ok ? where.result : [] });
      expect(c.ok && c.result.total, String(row.last_event)).toBe(row.count);
    }
  });

  it('a point shape pass keeps the jurisdiction polygons, each at its centre', async () => {
    const county: GeoJSON.Feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-100, 30], [-98, 30], [-98, 32], [-100, 32], [-100, 30]]] },
      properties: { fid: 'county:1', name: 'C', cls: 'ban', last_event: null } };
    loadGeojson(DCM, [point(0, { fid: 'point:1', name: 'P', cls: 'ban', last_event: null }), county]);
    fakeMap({});
    const r = ok(await shapeRows(DCM, { geometry: 'point' }));
    expect(r.features).toHaveLength(2);
    expect(r.features!.find(f => f.id === 'county:1')!.geometry).toEqual({ type: 'Point', coordinates: [-99, 31] });
    expect(r.truncated).toBe(false);
  });

  it('reads WECC path markers only: the corridors are a drawing of a path, not a row', async () => {
    const W = 'wecc-paths';
    registerBaseFilter('wecc-path-corridors', ['==', ['get', 'isCorridor'], true]);
    registerBaseFilter('wecc-paths-circles', ['!=', ['get', 'isCorridor'], true]);
    const corridor: GeoJSON.Feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-120, 40], [-121, 41]] },
      properties: { id: '66c', number: 66, isCorridor: true } };
    loadGeojson(W, [point(0, { id: '66', number: 66, status: 'Revised', isCorridor: false }),
      point(1, { id: '65', number: 65, status: 'Added', isCorridor: false }), corridor]);
    registerBaseFilter('wecc-path-corridors-outline', ['==', ['get', 'isCorridor'], true]);
    registerBaseFilter('wecc-path-lines-highlight', ['==', ['get', 'number'], -1]);
    fakeMap({ 'wecc-path-corridors': { type: 'line', source: 'wecc-paths' }, 'wecc-path-corridors-outline': { type: 'line', source: 'wecc-paths' },
      'wecc-path-lines-highlight': { type: 'line', source: 'wecc-paths' }, 'wecc-paths-circles': { type: 'circle', source: 'wecc-paths' }, 'wecc-paths-label': { type: 'symbol', source: 'wecc-paths' } });
    const c = await count(W, {});
    expect(c.ok && c.result.total).toBe(2);
    const r = ok(await shapeRows(W, { geometry: 'point' }));
    expect(r.features!.map(f => f.id).sort()).toEqual(['65', '66']);
    expect(r.truncated).toBe(false);
  });

  it('refuses month bins on a year field', async () => {
    loadGeojson(EIA, eia(5));
    fakeMap({});
    expect(refusal(await shapeRows(EIA, { time: { field: 'op_year', bin: 'month' } }))).toMatch(/"op_year" holds years, so it bins by year only/);
  });
});

group('a layer read whole (a second layer)', () => {
  it('keeps every feature of a GeoJSON layer, past 50,000', async () => {
    loadGeojson(HIFLD, hifld(51_000));
    fakeMap({});
    const r = ok(await shapeRows(HIFLD, { geometry: 'point', complete: true }));
    expect(r.features).toHaveLength(51_000);
    expect(r.truncated).toBe(false);
  });

  it('refuses a tiled layer', async () => {
    fakeMap({ 'osm-substations-points-circles': { source: 'osm-substations-points', sourceLayer: 'osm_substations_points' } });
    state.layerVisibility['osm-substations-points'] = true;
    expect(refusal(await shapeRows('osm-substations-points', { geometry: 'point', complete: true }))).toMatch(/is a tiled layer: .*needs the whole layer/);
  });
});

group('states on a world layer (the admin1 alias)', () => {
  const OSM = 'osm-plants-points';
  const US = Object.entries(STATE_TO_ADMIN1);
  // One plant per US state or territory, one in two states, two abroad, one untagged.
  const plants = () => [
    ...US.map(([, a1], i) => point(i, { fid: i * 10 + 1, name: `P${i}`, source: 'solar', admin1: `|${a1}|`, countries: '|USA|' })),
    point(900, { fid: 9001, name: 'Border', source: 'wind', admin1: `|${STATE_TO_ADMIN1.TX}|MEX5|`, countries: '|USA|MEX|' }),
    point(901, { fid: 9011, name: 'Paris', source: 'solar', admin1: '|FRA1|', countries: '|FRA|' }),
    point(902, { fid: 9021, name: 'Ontario', source: 'solar', admin1: '|CAN8|', countries: '|CAN|' }),
    point(903, { fid: 9031, name: 'Nowhere', source: 'solar', admin1: '|none|', countries: '|none|' }),
  ];

  it('offers states to group by on a world layer only', () => {
    expect(shapeSlots(OSM)!.by).toContain('states');
    expect(shapeSlots(EIA)!.by.filter(f => f === 'states')).toHaveLength(1);
  });

  it('reads every US state and territory from its admin-1 tag; a non-US admin-1 never maps, and those features are left out', async () => {
    loadGeojson(OSM, plants());
    fakeMap({});
    const r = ok(await shapeRows(OSM, { by: ['states'], geometry: 'point' }));
    const keys = r.rows.map(x => x.states);
    expect(keys.length).toBeGreaterThanOrEqual(50);
    expect(new Set(keys)).toEqual(new Set(US.map(([s]) => s)));
    expect(r.rows.find(x => x.states === 'TX')!.count).toBe(2);
    expect(r.totals.count).toBe(US.length + 1);
    expect(r.usOnly).toBe(true);
    expect(r.features!.find(f => f.properties!.name === 'Border')!.properties!.states).toBe('|TX|');
    expect(r.features!.some(f => f.properties!.name === 'Paris')).toBe(false);
    // Without the alias every feature is read, and admin1 keeps its own codes.
    const a1 = ok(await shapeRows(OSM, { by: ['admin1'] }));
    expect(a1.totals.count).toBe(US.length + 4);
    expect(a1.usOnly).toBeUndefined();
  });

  it('a state\'s where (admin1 code) matches exactly its row', async () => {
    loadGeojson(OSM, plants());
    fakeMap({});
    const r = ok(await shapeRows(OSM, { by: ['states'] }));
    for (const code of ['TX', 'CA', 'PR']) {
      const where = conditionForBin(OSM, 'states', code);
      if (!where.ok) throw new Error(where.reason);
      expect(where.result).toEqual([{ field: 'admin1', op: 'contains_any', value: [STATE_TO_ADMIN1[code]] }]);
      const c = await count(OSM, { where: where.result });
      expect(c.ok && c.result.total, code).toBe(r.rows.find(x => x.states === code)!.count);
    }
    expect(conditionForBin(OSM, 'states', 'ZZ').ok).toBe(false);
  });
});

group('years', () => {
  it('reads a number in range or the first year in free text', () => {
    expect([2019, 0, 9999, 1955.5, '2019', '05/2019', '~1955', '1955;2001', '20190109', 'unknown', null].map(yearOf))
      .toEqual([2019, null, null, 1955, 2019, 2019, 1955, 1955, null, null, null]);
  });

  it('bins OSM start_date text by year', async () => {
    loadGeojson('osm-plants-points', ['2019-05', '05/2019', '~1955', '', 'unknown'].map((d, i) =>
      point(i, { fid: i, name: `p${i}`, source: 'solar', output_mw: 1, start_date: d })));
    fakeMap({});
    const r = ok(await shapeRows('osm-plants-points', { time: { field: 'start_date', bin: 'year' } }));
    expect(r.rows.map(x => [x.start_date, x.count])).toEqual([[1955, 1], [2019, 2], [null, 2]]);
  });
});

group('refusals name what each slot takes', () => {
  it('lists the fields of the slot', async () => {
    loadGeojson(EIA, eia(5));
    fakeMap({});
    expect(refusal(await shapeRows(EIA, { by: ['plant_name'] }))).toMatch(/by takes energy_source, .*states/);
    expect(refusal(await shapeRows(EIA, { by: ['a', 'b', 'c'] }))).toMatch(/up to 2/);
    expect(refusal(await shapeRows(EIA, { measure: 'energy_source' }))).toMatch(/measure takes count, nameplate_mw/);
    expect(refusal(await shapeRows(EIA, { measure: 'length_km' }))).toMatch(/measure takes count, nameplate_mw/);
    expect(refusal(await shapeRows(EIA, { time: { field: 'nameplate_mw', bin: 'year' } }))).toMatch(/time takes op_year, retirement_year/);
    expect(refusal(await shapeRows(HIFLD, { time: { field: 'max_kv', bin: 'year' } }))).toMatch(/none on this layer/);
    expect(refusal(await shapeRows(HIFLD, { measure: 'max_kv' }))).toMatch(/a level, not an amount: group by it instead\): measure takes count$/);
    expect(refusal(await shapeRows(EIA, { limitFeatures: 60_000 }))).toMatch(/limitFeatures/);
    expect(refusal(await shapeRows('basemap-nope', {}))).toMatch(/not a layer id/);
  });

  it('shapeSlots offers kV fields to group by, never to sum', () => {
    expect(shapeSlots(OSM_TL)).toEqual({ by: expect.arrayContaining(['nominal_kv', 'countries', 'operator']), measure: ['count', 'length_km'], time: [], bins: ['nominal_kv', 'length_km'] });
    expect(shapeSlots('nerc-regions')!.measure).toEqual(['count', 'area_km2']);
  });
});

// ─── Tiled layers ────────────────────────────────────────────────────────────
// z8 tiles: x 128 spans lng 0–1.40625°, x 129 the next; y 127 spans lat 0–1.4°.
const Y = 0.5;
const piece = (id: number, kv: number, coords: number[][], x?: number, z = 8): GeoJSON.Feature =>
  ({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords }, properties: { nominal_kv: kv },
    ...(x !== undefined && { _x: x, _y: 127, _z: z }) }) as GeoJSON.Feature;

const TL_LAYERS: Record<string, FakeLayer> = {
  'osm-transmission-lines-hv': { source: 'tl', minzoom: 2, type: 'line' },
  'osm-transmission-lines-lv': { source: 'tl', minzoom: 9, type: 'line' },
  'osm-transmission-lines-unknown': { source: 'tl', minzoom: 5, type: 'line' },
  'osm-transmission-lines-label': { source: 'tl', minzoom: 2, type: 'symbol' },
};
function tlBaseFilters() {
  registerBaseFilter('osm-transmission-lines-hv', ['>=', ['to-number', ['get', 'nominal_kv'], -1], 100]);
  registerBaseFilter('osm-transmission-lines-lv', ['all', ['>', ['to-number', ['get', 'nominal_kv'], -1], 0], ['<', ['to-number', ['get', 'nominal_kv'], -1], 50]]);
  registerBaseFilter('osm-transmission-lines-unknown', ['<=', ['to-number', ['get', 'nominal_kv'], -1], 0]);
  registerBaseFilter('osm-transmission-lines-label', ['has', 'name']);
}

group('tiled layers: the current view', () => {
  const tiles = {
    'tl': [
      piece(7, 33, [[0.4, Y], [0.6, Y]], 128), piece(8, 0, [[0.4, Y], [0.9, Y]], 128),
      piece(5, 345, [[0.1, Y], [1.5, Y]], 128),        // runs into tile 129's buffer
      piece(5, 345, [[1.3, Y], [2.0, Y]], 129),        // starts in tile 128's buffer
      piece(5, 345, [[1.3, Y], [2.0, Y]], 129),        // the same tile again (overzoom)
      piece(6, 500, [[0.2, Y], [0.3, Y]], 128),
    ],
  };

  it('reads the view once per line, km counted once across tile pieces, and names the tiers this zoom hides', async () => {
    fakeMap(TL_LAYERS, tiles, 6);
    tlBaseFilters();
    state.layerVisibility[OSM_TL] = true;
    const r = ok(await shapeRows(OSM_TL, { by: ['nominal_kv'], measure: 'length_km' }));
    expect(r).toMatchObject({ scope: 'view', complete: false, tiersHidden: ['lv'], unit: 'km' });
    expect(r.reason).toMatch(/current view only/);
    expect(r.totals.count).toBe(3);     // 5, 6 and the unknown-kV 8; the lv 7 is not drawn at z6
    const km = (a: number, b: number) => haversineKm([a, Y], [b, Y]);
    expect(r.totals.sum).toBeCloseTo(km(0.1, 2.0) + km(0.2, 0.3) + km(0.4, 0.9), 6);
    expect(r.rows.find(x => x.nominal_kv === '300-499')!.sum).toBeCloseTo(km(0.1, 2.0), 6);
    expect(r.rows.find(x => x.nominal_kv === 'unknown')!.count).toBe(1);
  });

  it('clips to the view; zoomed in, no tier is hidden', async () => {
    fakeMap(TL_LAYERS, tiles, 10, [0, -1, 1.0, 1]);
    tlBaseFilters();
    state.layerVisibility[OSM_TL] = true;
    const r = ok(await shapeRows(OSM_TL, { measure: 'length_km', geometry: 'full' }));
    expect(r.tiersHidden).toEqual([]);
    expect(r.totals.count).toBe(4);
    expect(r.totals.sum).toBeCloseTo(haversineKm([0.1, Y], [1.0, Y]) + haversineKm([0.2, Y], [0.3, Y])
      + haversineKm([0.4, Y], [0.6, Y]) + haversineKm([0.4, Y], [0.9, Y]), 6);
    expect(r.features!.find(f => f.id === 5)!.geometry).toEqual({ type: 'MultiLineString', coordinates: [[[0.1, Y], [1.0, Y]]] });
  });

  it('refuses an area, a layer that is off, and a zoom that draws none of it', async () => {
    fakeMap(TL_LAYERS, tiles, 6);
    state.layerVisibility[OSM_TL] = false;
    expect(refusal(await shapeRows(OSM_TL, {}))).toBe(`"${OSM_TL}" is off: switch the layer on to use it in a template`);
    state.layerVisibility[OSM_TL] = true;
    expect(refusal(await shapeRows(OSM_TL, { area: { kind: 'states', codes: ['TX'] } }))).toMatch(/tiled layers cover the current view only/);
    fakeMap(TL_LAYERS, tiles, 1);
    expect(refusal(await shapeRows(OSM_TL, {}))).toMatch(/not drawn at zoom 1\.0: zoom in to 2/);
  });

  it('reads a symbol-only layer whose icons are its own features (osm-generators), but not a label companion', async () => {
    const gen = (id: number, source: string, x: number): GeoJSON.Feature =>
      ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [x, Y] }, properties: { source, output_mw: 10 }, _x: 128, _y: 127, _z: 8 }) as GeoJSON.Feature;
    fakeMap({ 'osm-gen-circles': { source: 'gen', sourceLayer: 'g', minzoom: 4, type: 'symbol' } },
      { gen: [gen(1, 'solar', 0.1), gen(2, 'wind', 0.2), gen(3, 'solar', 0.3)] }, 6);
    state.layerVisibility['osm-generators'] = true;
    const r = ok(await shapeRows('osm-generators', { by: ['source'], measure: 'output_mw' }));
    expect(r.totals).toMatchObject({ count: 3, sum: 30 });
    fakeMap({ 'osm-gen-circles': { source: 'gen', minzoom: 4, type: 'symbol' } }, {}, 2);
    expect(refusal(await shapeRows('osm-generators', {}))).toMatch(/not drawn at zoom 2\.0: zoom in to 4/);
    // A layer whose shown map layers are labels only draws nothing to read, and says so (no "zoom in to Infinity").
    fakeMap({ 'osm-transmission-lines-label': { source: 'tl', type: 'symbol' } }, {}, 6);
    state.layerVisibility[OSM_TL] = true;
    const msg = refusal(await shapeRows(OSM_TL, {}));
    expect(msg).toMatch(/draws no features/);
    expect(msg).not.toMatch(/Infinity/);
  });

  it('on the GeoJSON path a feature-drawing map layer with no registered filter passes every feature', async () => {
    loadGeojson(EIA, eia(20));
    registerBaseFilter('eia-gen-circles', ['==', ['get', 'energy_source'], 'NG']);
    // eia-gen-heat (no registered filter) draws every unit: nothing is dropped.
    expect(ok(await shapeRows(EIA, {})).totals.count).toBe(20);
  });

  it('merges a polygon\'s tile pieces, each clipped to its tile, so the area counts once', () => {
    const sq = (x0: number, x1: number) => [[[x0, 0.1], [x1, 0.1], [x1, 0.5], [x0, 0.5], [x0, 0.1]]];
    const poly = (x0: number, x1: number, x: number) =>
      ({ type: 'Feature', id: 9, geometry: { type: 'Polygon', coordinates: sq(x0, x1) }, properties: {}, _x: x, _y: 127, _z: 8 }) as GeoJSON.Feature;
    const [f] = mergeViewPieces('osm-plants-polygons', [poly(1.0, 1.5, 128), poly(1.3, 2.0, 129)], [-180, -85, 180, 85]);
    let km2 = 0;
    for (const p of (f.geometry as GeoJSON.MultiPolygon).coordinates) km2 += ringAreaKm2(p[0]);
    expect(km2).toBeCloseTo(ringAreaKm2(sq(1.0, 2.0)[0]), 6);
  });
});
