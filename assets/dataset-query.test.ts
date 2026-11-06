// @vitest-environment jsdom
// dataset-query.ts: the pure core on fixtures (group-by, where/area parity
// with featureFilter, field allowlist, limit, model-facing caps), asDrawn on
// wantedLayout, the vector-tile dedupe, and a query on a layer that is off
// leaving the view and the URL alone.
import { describe as group, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { state } from './state.js';
import { on } from './state-bus.js';
import { seedView, currentView } from './view-state.js';
import { formatUrlState } from './url-state-codec.js';
import { toMapLibreFilter } from '../src/registry/condition-compile.js';
import {
  describe, query, count, aggregate, summarise, buildTest, runQuery, runAggregate, drawnFilters,
  allowedFields, DISPLAY_FIELDS, QUERY_MAX_ROWS, type QueryResult, type AggregateResult,
} from './dataset-query.js';
import { readFileSync } from 'node:fs';
import { layerById } from '../src/registry/index.js';

const EIA = 'eia-generators';
const unit = (fid: string, energy_source: string, gen_status: string, nameplate_mw: number | string, states: string, plant_name = 'P' + fid) =>
  ({ type: 'Feature', id: undefined, geometry: { type: 'Point', coordinates: [-97, 31] },
    properties: { fid, energy_source, gen_status, nameplate_mw, states, plant_name, junk_tag: 'x' } }) as GeoJSON.Feature;

const FIXTURE = [
  unit('1:1', 'NG', 'existing', 500, '|TX|'),
  unit('1:2', 'NG', 'retired', 300, '|TX|'),
  unit('2:1', 'WND', 'existing', 200, '|TX|'),
  unit('3:1', 'WND', 'proposed', 900, '|TX|'),
  unit('4:1', 'SUN', 'existing', '150', '|NM|TX|'),
  unit('5:1', 'NG', 'existing', 400, '|NM|'),
];

const testFor = (opts: Parameters<typeof buildTest>[1], drawn?: Parameters<typeof buildTest>[4]) => {
  const t = buildTest(EIA, opts, featureFilter, 8, drawn);
  if (typeof t !== 'function') throw new Error(t.reason);
  return t;
};

group('aggregate (pure)', () => {
  it('sums nameplate MW by fuel over existing units only', () => {
    const t = testFor({ where: [{ field: 'gen_status', op: '=', value: 'existing' }], area: { kind: 'states', codes: ['TX'] } });
    const r = runAggregate(EIA, FIXTURE, t, { groupBy: 'energy_source', sum: ['nameplate_mw'] });
    expect(r.ok && r.result).toEqual({
      groupBy: 'energy_source', sum: ['nameplate_mw'], total: 3,
      groups: [
        { key: 'NG', count: 1, sums: { nameplate_mw: 500 } },
        { key: 'WND', count: 1, sums: { nameplate_mw: 200 } },
        { key: 'SUN', count: 1, sums: { nameplate_mw: 150 } },
      ],
    });
  });

  it('counts a feature under each code of a region list', () => {
    const r = runAggregate(EIA, FIXTURE, () => true, { groupBy: 'states' });
    expect(r.ok && r.result.groups.map(g => [g.key, g.count])).toEqual([['TX', 5], ['NM', 2]]);
  });

  it('refuses an unknown or non-number sum field', () => {
    expect(runAggregate(EIA, FIXTURE, () => true, { groupBy: 'junk_tag' })).toMatchObject({ ok: false });
    const r = runAggregate(EIA, FIXTURE, () => true, { groupBy: 'states', sum: ['energy_source'] });
    expect(!r.ok && r.reason).toMatch(/not a number field/);
  });
});

group('where and area are the map\'s filter', () => {
  it('pass exactly the features featureFilter passes on the compiled expression', () => {
    const where = [{ field: 'energy_source', op: 'in' as const, value: ['NG', 'SUN'] }];
    const area = { kind: 'states' as const, codes: ['NM'] };
    const expr = ['all', toMapLibreFilter('eia_generators', where),
      toMapLibreFilter('eia_generators', [{ field: 'states', op: 'contains_any', value: ['NM'] }])];
    const direct = featureFilter(expr as never, 'layers[0].filter');
    const expected = FIXTURE.filter(f => direct.filter({ zoom: 8 }, { type: 1, properties: f.properties! } as never));
    const r = runQuery(EIA, FIXTURE, testFor({ where, area }));
    expect(r.ok && r.result.rows.map(x => x.feature)).toEqual(expected);
    expect(expected.map(f => f.properties!.fid)).toEqual(['4:1', '5:1']);
  });

  it('ids keeps only the listed features, ANDed with where', () => {
    const fids = (t: (f: GeoJSON.Feature) => boolean) => FIXTURE.filter(t).map(f => f.properties!.fid);
    expect(fids(testFor({ ids: ['1:1', '2:1', '5:1'] }))).toEqual(['1:1', '2:1', '5:1']);
    expect(fids(testFor({ ids: ['1:1', '2:1'], where: [{ field: 'energy_source', op: '=', value: 'WND' }] }))).toEqual(['2:1']);
    expect(fids(testFor({ ids: [] }))).toEqual([]);
  });

  it('refuses a bad where, a bad area, and an area that cannot reach the layer', () => {
    expect(buildTest(EIA, { where: [{ field: 'nope', op: '=', value: 1 }] }, featureFilter, 8)).toEqual({ reason: expect.stringMatching(/nope/) });
    expect(buildTest(EIA, { area: { kind: 'states', codes: ['XX'] } }, featureFilter, 8)).toEqual({ reason: expect.stringMatching(/not a states code/) });
    expect(buildTest('osm-transmission-lines', { area: { kind: 'retail', codes: ['1'] } }, featureFilter, 8))
      .toEqual({ reason: expect.stringMatching(/does not reach/), code: 'area-unreachable' });
  });

  it('asDrawn ANDs with where and ORs the drawn map layers; none drawn passes nothing', () => {
    const wind = ['==', ['get', 'energy_source'], 'WND'] as never;
    const exist = ['==', ['get', 'gen_status'], 'existing'] as never;
    const ids = (t: (f: GeoJSON.Feature) => boolean) => FIXTURE.filter(t).map(f => f.properties!.fid);
    expect(ids(testFor({}, [wind]))).toEqual(['2:1', '3:1']);
    expect(ids(testFor({ where: [{ field: 'gen_status', op: '=', value: 'existing' }] }, [wind]))).toEqual(['2:1']);
    expect(ids(testFor({}, [wind, exist]))).toEqual(['1:1', '2:1', '3:1', '4:1', '5:1']);
    expect(ids(testFor({}, []))).toEqual([]);
    expect(ids(testFor({}, [null]))).toHaveLength(FIXTURE.length);
  });
});

group('rows', () => {
  it('carry only allowed fields; an unknown field is refused with a reason', () => {
    expect(allowedFields(EIA)).toContain('plant_name');
    expect(allowedFields(EIA)).toContain('fid');
    expect(allowedFields(EIA)).not.toContain('junk_tag');
    const r = runQuery(EIA, FIXTURE, () => true);
    expect(r.ok && Object.keys(r.result.rows[0].props)).not.toContain('junk_tag');
    expect(r.ok && r.result.rows[0].id).toBe('1:1');
    const bad = runQuery(EIA, FIXTURE, () => true, { fields: ['junk_tag'] });
    expect(!bad.ok && bad.reason).toMatch(/"junk_tag" is not a field/);
  });

  it('order numerically (strings too), empties last, and cap at the limit', () => {
    const r = runQuery(EIA, FIXTURE, () => true, { fields: ['fid'], orderBy: { field: 'nameplate_mw', desc: true }, limit: 2 });
    expect(r.ok && r.result.rows.map(x => x.props.fid)).toEqual(['3:1', '1:1']);
    expect(r.ok && [r.result.total, r.result.truncated]).toEqual([6, true]);
    expect(runQuery(EIA, FIXTURE, () => true, { limit: QUERY_MAX_ROWS + 1 })).toMatchObject({ ok: false });
    expect(runQuery(EIA, FIXTURE, () => true, { limit: 0 })).toMatchObject({ ok: false });
  });
});

group('summarise', () => {
  it('sends a 5,000-row result as ≤ 50 rows in ≤ 8 KB, strings clipped, and says it cut', () => {
    const many = Array.from({ length: 5000 }, (_, i) => unit(`${i}:1`, 'NG', 'existing', i, '|TX|', 'n'.repeat(500)));
    const r = runQuery(EIA, many, () => true);
    const full: QueryResult = { layerId: EIA, complete: true, ...(r.ok ? r.result : ({} as never)) };
    expect(full.rows).toHaveLength(5000);
    const s = summarise(full);
    expect(new TextEncoder().encode(JSON.stringify(s)).length).toBeLessThanOrEqual(8 * 1024);
    expect((s.rows as unknown[]).length).toBeLessThanOrEqual(50);
    expect(s).toMatchObject({ total: 5000, truncated: true });
    expect(String((s.rows as Record<string, unknown>[])[0].plant_name).length).toBeLessThanOrEqual(121);
    expect(JSON.stringify(s)).not.toContain('"feature"');
  });

  it('cuts an aggregate at 200 groups', () => {
    const groups = Array.from({ length: 300 }, (_, i) => ({ key: i, count: 1, sums: {} }));
    const r: AggregateResult = { layerId: EIA, complete: true, groupBy: 'op_year', sum: [], groups, total: 300 };
    expect(summarise(r)).toMatchObject({ groupCount: 300, truncated: true, note: '+100 more groups' });
    expect((summarise(r).groups as unknown[]).length).toBe(200);
  });

  it('trims a 24 KB aggregate to 8 KB, keeping the largest groups and saying how many it cut', () => {
    const sum = ['nameplate_mw', 'summer_mw', 'winter_mw', 'op_year', 'plant_id'];
    const groups = Array.from({ length: 200 }, (_, i) => ({
      key: 'k'.repeat(116) + String(i).padStart(4, '0'), count: 200 - i,
      sums: Object.fromEntries(sum.map(f => [f, 1234.5000000001 * (200 - i)])),
    }));
    const r: AggregateResult = { layerId: EIA, complete: true, groupBy: 'plant_name', sum, groups, total: 9000 };
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeGreaterThan(24 * 1024);
    const s = summarise(r);
    const kept = s.groups as { count: number; sums: Record<string, number> }[];
    expect(new TextEncoder().encode(JSON.stringify(s)).length).toBeLessThanOrEqual(8 * 1024);
    expect(kept.length).toBeGreaterThan(0);
    expect(s).toMatchObject({ groupCount: 200, returned: kept.length, truncated: true, note: `+${200 - kept.length} more groups` });
    expect(kept[0]).toMatchObject({ count: 200, sums: { nameplate_mw: 246900 } });
    expect(r.groups[0].sums.nameplate_mw).toBe(1234.5000000001 * 200);           // the input is untouched
  });
});

group('describe', () => {
  it('lists fields, ops and domains for a dataset layer', () => {
    const d = describe(EIA);
    expect(d.ok && d.result.queryable).toBe(true);
    if (!d.ok || !d.result.queryable) return;
    expect(d.result).toMatchObject({ kind: 'geojson', complete: true, idField: 'fid' });
    const status = d.result.fields.find(f => f.name === 'gen_status')!;
    expect(status.values).toEqual(['existing', 'retirement', 'retired', 'proposed']);
    expect(d.result.fields.find(f => f.name === 'plant_name')!.ops).toEqual([]);
    expect(d.result.fields.find(f => f.name === 'ba')!.valueCount).toBeGreaterThan(60);
  });

  it('says a layer without a dataset is not queryable, and why', () => {
    expect(describe('nexrad-radar')).toEqual({ ok: true, result: {
      layerId: 'nexrad-radar', queryable: false, reason: '"nexrad-radar" has no field schema, so it takes no query' } });
    expect(describe('nope')).toMatchObject({ ok: false });
  });

  it('marks a vector-tile layer with a columns file complete (each call\'s result says what it read)', () => {
    const d = describe('osm-transmission-lines');
    expect(d.ok && d.result.queryable && d.result).toMatchObject({ kind: 'pmtiles', complete: true });
  });
});

// ─── Map-facing ──────────────────────────────────────────────────────────────
function fakeMap(layers: Record<string, { source: string; sourceLayer?: string; minzoom?: number; maxzoom?: number }>,
  tiles: Record<string, GeoJSON.Feature[]> = {}, zoom = 2) {
  const setData = vi.fn();
  state.map = {
    getLayer: (id: string) => layers[id],
    getSource: () => ({ setData }),
    getZoom: () => zoom,
    querySourceFeatures: (src: string) => tiles[src] ?? [],
    setFilter: vi.fn(),
    on: vi.fn(),
  } as unknown as typeof state.map;
  state.mapReady = true;
  return { setData };
}

beforeEach(() => {
  state.map = null;
  state.mapReady = false;
  state.layerVisibility = {};
  state.legendFilters = {};
  state.layerFilters = {};
  state.genMode = {};
  state.sourcesData = {};
  state.sourcesLoaded = {};
  seedView({});
});
afterEach(() => { vi.unstubAllGlobals(); });

group('drawnFilters', () => {
  it('follows wantedLayout: heat mode draws the heat layer only, off draws nothing', () => {
    fakeMap({ 'eia-gen-circles': { source: EIA }, 'eia-gen-heat': { source: EIA } });
    expect(drawnFilters(EIA)).toEqual([]);
    state.layerVisibility[EIA] = true;
    state.genMode[EIA] = 'heat';
    expect(drawnFilters(EIA)).toHaveLength(1);
    state.genMode[EIA] = 'both';
    expect(drawnFilters(EIA)).toHaveLength(2);
  });

  it('skips a map layer outside its zoom range, and asDrawn says why it lists nothing', async () => {
    state.sourcesData[EIA] = FIXTURE;
    state.sourcesLoaded[EIA] = true;
    fakeMap({ 'eia-gen-circles': { source: EIA, minzoom: 3 }, 'eia-gen-heat': { source: EIA, maxzoom: 9 } }, {}, 2);
    state.layerVisibility[EIA] = true;
    state.genMode[EIA] = 'icons';
    expect(drawnFilters(EIA)).toEqual([]);
    const r = await count(EIA, { asDrawn: true });
    expect(r.ok && r.result).toMatchObject({ total: 0, reason: '"eia-generators" is not drawn at zoom 2.0' });
    state.genMode[EIA] = 'both';
    expect(drawnFilters(EIA)).toHaveLength(1);
  });
});

group('vector-tile layers', () => {
  it('merges the tile pieces of a polygon only with fragments: true', async () => {
    const sq = (x0: number, x1: number) => [[[x0, 0], [x1, 0], [x1, 1], [x0, 1], [x0, 0]]];
    const piece = (x0: number, x1: number) => ({ type: 'Feature', id: 7, geometry: { type: 'Polygon', coordinates: sq(x0, x1) }, properties: {} }) as GeoJSON.Feature;
    fakeMap({ 'osm-plants-polygons-fill': { source: 'osm-plants-polygons', sourceLayer: 'osm_plants_polygons' } },
      { 'osm-plants-polygons': [piece(0, 1), piece(1, 2)] });
    const first = await query('osm-plants-polygons', { scope: 'view' });
    expect(first.ok && first.result.rows).toHaveLength(1);
    expect(first.ok && first.result.rows[0].feature.geometry.type).toBe('Polygon');
    const merged = await query('osm-plants-polygons', { fragments: true });
    expect(merged.ok && merged.result.rows).toHaveLength(1);
    expect(merged.ok && merged.result.rows[0].feature.geometry).toMatchObject({ type: 'MultiPolygon', coordinates: [sq(0, 1), sq(1, 2)] });
  });

  it('read the loaded tiles once per stable id and say they are incomplete', async () => {
    const line = (id: number, kv: number) => ({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      properties: { nominal_kv: kv } }) as GeoJSON.Feature;
    // Several map layers on one source: the source is read once, ids deduplicated.
    fakeMap({
      'osm-transmission-lines-hv': { source: 'osm-transmission-lines', sourceLayer: 'osm_transmission_lines' },
      'osm-transmission-lines-dc': { source: 'osm-transmission-lines', sourceLayer: 'osm_transmission_lines' },
      'osm-transmission-lines-mv': { source: 'osm-transmission-lines', sourceLayer: 'osm_transmission_lines' },
    }, {
      'osm-transmission-lines': [line(12, 345), line(12, 345), line(22, 500), line(32, 230)],
    });
    const r = await count('osm-transmission-lines', { scope: 'view' });
    expect(r).toMatchObject({ ok: true, result: { total: 3, complete: false } });
    const q = await query('osm-transmission-lines', { scope: 'view', where: [{ field: 'nominal_kv', op: '>=', value: 400 }] });
    expect(q.ok && q.result.rows.map(x => x.id)).toEqual([22]);
  });
});

group('a query on a layer that is off', () => {
  it('loads the file past fromZoom and leaves visibility, the view and the URL alone', async () => {
    const fc = { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { fid: 11, name: 'A', source: 'solar', output_mw: 5 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { fid: 21, name: 'B', source: 'wind', output_mw: 50 } },
    ] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(gzipSync(JSON.stringify(fc)))));
    const { setData } = fakeMap({ 'osm-plant-icons': { source: 'osm-plants-points' } });
    const before = formatUrlState(currentView()).join('&');
    const vis = { ...state.layerVisibility };
    let writes = 0;
    on('url:write', () => { writes++; });

    const r = await query('osm-plants-points', { orderBy: { field: 'output_mw', desc: true } });
    expect(r.ok && r.result.rows.map(x => x.props.name)).toEqual(['B', 'A']);
    expect(r.ok && r.result.complete).toBe(true);
    expect(setData).toHaveBeenCalledTimes(1);
    expect(state.layerVisibility).toEqual(vis);
    expect(formatUrlState(currentView()).join('&')).toBe(before);
    expect(writes).toBe(0);

    const drawn = await count('osm-plants-points', { asDrawn: true });
    expect(drawn).toMatchObject({ ok: true, result: { total: 0, reason: expect.stringMatching(/is off/) } });
  });

  it('refuses a layer without a schema', async () => {
    expect(await aggregate('us-states', { groupBy: 'name' })).toMatchObject({ ok: false });
  });
});

// ─── Display fields ↔ tile manifest ──────────────────────────────────────────
// A display field the build does not keep would be an always-empty column.
group('DISPLAY_FIELDS are in the tiles', () => {
  // jsdom gives import.meta.url an http: scheme; vitest runs from the repo root.
  const text = readFileSync('scripts/tile_manifest.yaml', 'utf8');
  const select = new Map<string, string[]>();
  for (const block of text.split(/^ {2}- id:/m).slice(1)) {
    const m = block.match(/^ {4}select:\s*\[([^\]]*)\]/m);
    if (m) select.set(block.match(/^\s*(\S+)/)![1], m[1].split(',').map(x => x.trim()));
  }
  it('every display field of a layer with a manifest select: list is in it', () => {
    const missing: string[] = [];
    for (const [layerId, fields] of Object.entries(DISPLAY_FIELDS)) {
      const sel = select.get(layerById(layerId)!.dataset!);
      if (sel) for (const f of fields) if (!sel.includes(f)) missing.push(`${layerId}.${f}`);
    }
    expect(missing).toEqual([]);
    expect(select.get('eia_generators')).toContain('utility_name');
    expect(select.get('osm_substations_points')).toContain('sub_type');
  });
});
