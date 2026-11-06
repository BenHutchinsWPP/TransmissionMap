// @vitest-environment jsdom
// map-api runAnalysis over mocked rows and a mocked sandbox: registry dataset
// layers only, fields limited to the allowlist, inputs carry only those fields,
// `complete` follows the inputs' coverage, Stop reaches the sandbox, and the
// sandbox's refusals pass through. layerRows (the same path, for the chat's
// canvas) takes its own layer cap and names the partial layers. No view change:
// nothing is written.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  runs: [] as { code: string; inputs: Record<string, { features: { id?: unknown; properties: Record<string, unknown>; geometry: unknown }[] }>; signal?: AbortSignal }[],
  sandbox: null as null | ((code: string, inputs: unknown, o: { signal?: AbortSignal }) => unknown),
  queries: [] as [string, Record<string, unknown>][],
  complete: true, truncated: false,
}));

vi.mock('./ui/table-open.js', () => ({ openTable: vi.fn(), zoomToSelection: vi.fn() }));
vi.mock('./ui/ui-geocoder.js', () => ({ findPlaces: vi.fn(), placeSearchOn: () => false }));
vi.mock('./sandbox/sandbox-host.js', () => ({
  runInSandbox: async (code: string, inputs: never, o: { signal?: AbortSignal }) => {
    m.runs.push({ code, inputs, signal: o.signal });
    return m.sandbox ? m.sandbox(code, inputs, o) : { ok: true, result: { value: 7, ms: 3 } };
  },
}));
vi.mock('./dataset-query.js', () => ({
  QUERY_MAX_ROWS: 5000,
  allowedFields: (id: string) => id === 'gen' ? ['plant_name', 'mw'] : id === 'geo' ? ['name'] : [],
  describe: (id: string) => id === 'gen' || id === 'geo'
    ? { ok: true, result: { layerId: id, queryable: true } }
    : id === 'railroads' ? { ok: true, result: { layerId: id, queryable: false, reason: '"railroads" has no field schema, so it takes no query' } }
      : { ok: false, reason: `"${id}" is not a layer id` },
  query: async (id: string, o: Record<string, unknown>) => {
    m.queries.push([id, o]);
    if (Array.isArray(o.where) && o.where.some((c: { field: string }) => c.field === 'nope')) return { ok: false, reason: 'unknown field "nope"' };
    return { ok: true, result: {
      layerId: id, complete: m.complete, ...(!m.complete && { reason: 'vector tiles: loaded only' }),
      fields: [], total: m.truncated ? 9000 : 1, truncated: m.truncated,
      // A row may carry more than the allowlist; the input must not.
      rows: [{ id: 'a:1', props: { plant_name: 'Alpha', mw: 5, secret: 'x' }, feature: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } } }],
    } };
  },
}));

import { runAnalysis, layerRows } from './map-api.js';

const run = (code: string, inputs: unknown, o?: { signal?: AbortSignal }) => runAnalysis(code, inputs as never, o);
const reason = (r: unknown) => (r as { reason: string }).reason;

beforeEach(() => { m.runs = []; m.queries = []; m.sandbox = null; m.complete = true; m.truncated = false; });

describe('runAnalysis refusals (nothing runs)', () => {
  it.each([
    ['a layer that is not in the registry', 'return 1', [{ layer: 'my-service' }], /not a layer id/],
    ['a layer with no field schema', 'return 1', [{ layer: 'railroads' }], /no field schema/],
    ['a disallowed field', 'return 1', [{ layer: 'gen', fields: ['secret'] }], /"secret" is not a field of "gen"/],
    ['a bad where', 'return 1', [{ layer: 'gen', where: [{ field: 'nope', op: '=', value: 1 }] }], /unknown field/],
    ['too-long code', 'x'.repeat(20_001), [{ layer: 'gen' }], /code must be/],
    ['empty code', '   ', [{ layer: 'gen' }], /code must be/],
    ['no inputs', 'return 1', [], /1–3 inputs/],
    ['four inputs', 'return 1', ['a', 'b', 'c', 'd'].map(layer => ({ layer })), /1–3 inputs/],
    ['a layer listed twice', 'return 1', [{ layer: 'gen' }, { layer: 'gen' }], /listed twice/],
  ])('%s', async (_n, code, inputs, why) => {
    const r = await run(code, inputs);
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(why);
    expect(m.runs).toHaveLength(0);
  });
});

describe('runAnalysis', () => {
  it('builds inputs of the allowed fields and geometry, keyed by layer', async () => {
    const r = await run('return input.gen.features.length', [{ layer: 'gen', limit: 10 }, { layer: 'geo' }]);
    expect(r).toEqual({ ok: true, result: { value: 7, ms: 3, complete: true, inputs: [{ layer: 'gen', rows: 1, total: 1 }, { layer: 'geo', rows: 1, total: 1 }] } });
    expect(m.runs[0].code).toBe('return input.gen.features.length');
    expect(Object.keys(m.runs[0].inputs)).toEqual(['gen', 'geo']);
    const f = m.runs[0].inputs.gen.features[0];
    expect(f.properties).toEqual({ plant_name: 'Alpha', mw: 5 });
    expect(f.geometry).toEqual({ type: 'Point', coordinates: [1, 2] });
    expect(f.id).toBe('a:1');
    expect(m.runs[0].inputs.geo.features[0].properties).toEqual({});   // 'geo' allows only `name`; the row had none of it
    expect(m.queries[0][1]).toMatchObject({ limit: 10 });
  });

  it('keeps only the requested fields', async () => {
    await run('return 1', [{ layer: 'gen', fields: ['mw'] }]);
    expect(m.runs[0].inputs.gen.features[0].properties).toEqual({ mw: 5 });
  });

  it('is incomplete when an input is vector-tile or capped', async () => {
    m.complete = false;
    let r = await run('return 1', [{ layer: 'gen' }]);
    expect(r).toMatchObject({ ok: true, result: { complete: false, reason: expect.stringMatching(/vector tiles/) } });
    m.complete = true; m.truncated = true;
    r = await run('return 1', [{ layer: 'gen' }]);
    expect(r).toMatchObject({ ok: true, result: { complete: false, reason: expect.stringMatching(/only the first 1 were read/) } });
  });

  it('hands the Stop signal to the sandbox and passes its answer back', async () => {
    const ctl = new AbortController();
    m.sandbox = (_c, _i, o) => (ctl.abort(), o.signal?.aborted ? { ok: false, reason: 'Stopped.' } : { ok: true, result: { value: 1, ms: 1 } });
    const r = await run('while(true){}', [{ layer: 'gen' }], { signal: ctl.signal });
    expect(m.runs[0].signal).toBe(ctl.signal);
    expect(r).toEqual({ ok: false, reason: 'Stopped.' });
  });

  it('passes the unavailable text through', async () => {
    m.sandbox = () => ({ ok: false, reason: "Analysis isn't available in this browser" });
    expect(reason(await run('return 1', [{ layer: 'gen' }]))).toBe("Analysis isn't available in this browser");
  });

  it('passes a runtime error through', async () => {
    m.sandbox = () => ({ ok: false, reason: 'ReferenceError: x is not defined' });
    expect(reason(await run('x', [{ layer: 'gen' }]))).toMatch(/ReferenceError/);
  });
});

describe('layerRows (shared with showCanvas)', () => {
  it('takes the caller\'s layer cap and the same validators', async () => {
    expect(reason(await layerRows(['a', 'b', 'c', 'd', 'e'].map(layer => ({ layer })), 4))).toMatch(/1–4 inputs/);
    expect(reason(await layerRows([{ layer: 'gen', fields: ['secret'] }], 4))).toMatch(/"secret" is not a field of "gen"/);
    expect(reason(await layerRows([{ layer: 'my-service' }], 4))).toMatch(/not a layer id/);
    expect((await layerRows(['gen', 'geo'].map(layer => ({ layer })), 4)).ok).toBe(true);
  });

  it('names each layer read only in part, and only those', async () => {
    let r = await layerRows([{ layer: 'gen' }], 4);
    expect(r).toMatchObject({ ok: true, result: { partial: [] } });
    expect(r.ok && r.result.reason).toBeFalsy();
    m.complete = false;
    r = await layerRows([{ layer: 'gen' }], 4);
    expect(r).toMatchObject({ ok: true, result: { partial: ['gen'], reason: expect.stringMatching(/vector tiles/) } });
    m.complete = true; m.truncated = true;
    r = await layerRows([{ layer: 'gen' }], 4);
    expect(r).toMatchObject({ ok: true, result: { partial: ['gen'] } });
    expect(r.ok && r.result.fc.gen.features[0].properties).toEqual({ plant_name: 'Alpha', mw: 5 });
  });
});
