// @vitest-environment jsdom
// The table over a layer with a columns file (dataset scope): the partial note follows each
// query result's `complete`; the size prompt uses the file's planned bytes; a `pointOnly` row
// highlights and fits its loaded tile feature, else the camera goes to its point and the
// highlight is retried once at the map's next `idle` (the stand-in point is never drawn).
// Deps: ui-table.js (dataset-query.js query / count scripted; columns-read.js and highlights.js
//       mocked), test-drawer-env.js, state.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const LAYER = 'osm-substations-points';
const FIELDS = [
  { name: 'name', type: 'string', ops: [] },
  { name: 'nominal_kv', type: 'number', ops: ['>='] },
];
const h = vi.hoisted(() => ({ complete: true, planned: 0, queries: 0, pointOnly: true }));

vi.mock('../dataset-query.js', async (orig) => ({
  ...(await orig<typeof import('../dataset-query.js')>()),
  describe: (layerId: string) => ({ ok: true, result: { layerId, queryable: true, kind: 'pmtiles', complete: true, idField: 'fid', fields: FIELDS, credit: 'OSM' } }),
  count: async () => ({ ok: true, result: { layerId: LAYER, complete: h.complete, total: 1 } }),
  query: async () => {
    h.queries++;
    return { ok: true, result: { layerId: LAYER, complete: h.complete, total: 1, truncated: false, fields: [], rows: [{
      id: 77, props: { name: 'Alpha', nominal_kv: 230 }, ...(h.pointOnly && { pointOnly: true }),
      feature: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-100, 40] } },
    }] } };
  },
}));
vi.mock('../columns/columns-read.js', () => ({
  columnsEntry: async () => ({ ok: true, result: {} }),
  columnsMeta: async () => ({}),
  pruneGroups: () => [0],
  columnsFor: () => ['fid'],
  plannedBytes: async () => { await new Promise(r => setTimeout(r, 20)); return h.planned; },
}));
vi.mock('../highlights.js', () => ({ setHighlightFeatures: vi.fn(), clearHighlights: vi.fn() }));

(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const PIECE = { type: 'Feature', id: 77, probe() { /* not cloneable */ }, properties: {}, geometry: { type: 'LineString', coordinates: [[-101, 39], [-99, 41]] } };

// MapLibre's tile features do not cross to the worker; the highlight gets a plain copy.
const PLAIN = { type: 'Feature', properties: {}, geometry: PIECE.geometry };

async function open() {
  vi.resetModules();
  document.body.replaceChildren();
  const env = await import('./test-drawer-env.js');
  const { state } = await import('../state.js');
  const e = env.installDrawerEnv();
  Object.defineProperty(e.container, 'clientHeight', { value: 800, configurable: true });
  const hl = await import('../highlights.js');
  let idle: (() => void) | null = null;
  let pieces: unknown[] = [];
  Object.assign(state.map!, {
    getLayer: () => ({ source: 'src', sourceLayer: 'sl' }),
    querySourceFeatures: () => pieces,
    once: (ev: string, fn: () => void) => { if (ev === 'idle') idle = fn; },
  });
  const t = await import('./ui-table.js');
  return { t, e, hl, runIdle: () => idle?.(), setPieces: (p: unknown[]) => { pieces = p; }, idleSet: () => idle !== null };
}

beforeEach(() => { sessionStorage.clear(); h.complete = true; h.planned = 0; h.queries = 0; h.pointOnly = true; vi.clearAllMocks(); });
afterEach(async () => { (await import('./test-drawer-env.js')).resetDrawerEnv(); });

describe('partial note', () => {
  it('shows only when the result is not complete', async () => {
    h.complete = true;
    let c = await open();
    await c.t.showTable({ layerId: LAYER });
    await vi.waitFor(() => expect(document.querySelector('.td-row')).not.toBeNull());
    expect(q('.td-status').hidden).toBe(true);
    c.t.closeTable();
    h.complete = false;
    c = await open();
    await c.t.showTable({ layerId: LAYER });
    await vi.waitFor(() => expect(q('.td-status').hidden).toBe(false));
    expect(q('.td-status').dataset.kind).toBe('warn');
  });
});

describe('size prompt on planned bytes', () => {
  it('asks above 2 MiB and loads only after Load; no prompt below', async () => {
    h.planned = 3 * 1048576;
    const c = await open();
    const done = c.t.showTable({ layerId: LAYER });
    await vi.waitFor(() => expect(q('.td-status button')).not.toBeNull());
    expect(q('.td-status').textContent).toMatch(/3(\.0)? MB/);
    expect(h.queries).toBe(0);
    q<HTMLButtonElement>('.td-status button').click();
    await done;
    expect(h.queries).toBe(1);
    c.t.closeTable();
    h.planned = 1048576;
    h.queries = 0;
    const c2 = await open();
    await c2.t.showTable({ layerId: LAYER });
    expect(h.queries).toBe(1);
  });
});

describe('pointOnly rows', () => {
  async function opened() {
    const c = await open();
    await c.t.showTable({ layerId: LAYER });
    await vi.waitFor(() => expect(document.querySelector('.td-zoom-btn')).not.toBeNull());
    return c;
  }

  it('use the loaded tile feature with the row id for highlight and fit', async () => {
    const c = await opened();
    c.setPieces([PIECE, { ...PIECE, id: 5 }]);
    vi.mocked(c.hl.setHighlightFeatures).mockClear();
    q('.td-zoom-btn').click();
    expect(c.hl.setHighlightFeatures).toHaveBeenCalledWith([PLAIN], 'table');
    expect(() => structuredClone(vi.mocked(c.hl.setHighlightFeatures).mock.calls[0][0])).not.toThrow();
    expect(c.e.map.fitBounds).toHaveBeenLastCalledWith([[-101, 39], [-99, 41]], expect.objectContaining({ maxZoom: 13 }));
  });

  it('without a loaded feature: no stand-in highlight, fly to the point, retry once at idle', async () => {
    const c = await opened();
    vi.mocked(c.hl.setHighlightFeatures).mockClear();
    q('.td-zoom-btn').click();
    expect(c.hl.setHighlightFeatures).not.toHaveBeenCalled();
    expect(c.hl.clearHighlights).toHaveBeenCalledWith('table');
    expect(c.e.map.fitBounds).toHaveBeenLastCalledWith([[-100, 40], [-100, 40]], expect.objectContaining({ maxZoom: 9 }));
    expect(c.idleSet()).toBe(true);
    c.setPieces([PIECE]);
    c.runIdle();
    expect(c.hl.setHighlightFeatures).toHaveBeenCalledOnce();
    expect(c.hl.setHighlightFeatures).toHaveBeenCalledWith([PLAIN], 'table');
    expect(c.e.map.fitBounds).toHaveBeenCalledTimes(1);     // the retry moves no camera
  });

  it('a row that is not pointOnly keeps its own feature', async () => {
    h.pointOnly = false;
    const c = await opened();
    vi.mocked(c.hl.setHighlightFeatures).mockClear();
    q('.td-zoom-btn').click();
    expect(c.hl.setHighlightFeatures).toHaveBeenCalledWith([expect.objectContaining({ geometry: { type: 'Point', coordinates: [-100, 40] } })], 'table');
  });
});
