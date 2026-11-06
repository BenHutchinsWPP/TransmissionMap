// @vitest-environment jsdom
// A restore of a table over a COLUMNS_DATASETS layer reads the site's own data/analysis/ files
// (index and columns file, by range) to rebuild its rows, and fetches nothing else.
// Deps: ui-table.js and dataset-query.js (real), columns/fixtures (served by a fetch stub),
//       test-drawer-env.js, state.js.

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const FIX = `${process.cwd()}/assets/columns/fixtures/analysis/`;
const LAYER = 'osm-substations-points';
const fetched: string[] = [];

function serve(url: string, init?: RequestInit): Response {
  fetched.push(url);
  if (!url.startsWith('data/analysis/')) return new Response('', { status: 404 });
  let bytes: Buffer;
  try { bytes = readFileSync(FIX + url.slice('data/analysis/'.length)); } catch { return new Response('', { status: 404 }); }
  const m = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/);
  if (!m) return new Response(new Uint8Array(bytes), { status: 200 });
  return new Response(new Uint8Array(bytes.subarray(Number(m[1]), Number(m[2]) + 1)), { status: 206 });
}

(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

async function restore() {
  vi.resetModules();
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' } as unknown as PerformanceEntry]);
  document.body.replaceChildren();
  const env = await import('./test-drawer-env.js');
  const { state } = await import('../state.js');
  const e = env.installDrawerEnv();
  Object.defineProperty(e.container, 'clientHeight', { value: 800, configurable: true });
  Object.assign(state.map!, { loaded: () => true, once: () => {} });
  const resetRangeIo = (await import('../parquet/range-io.js')).resetRangeIo;
  resetRangeIo();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => serve(url, init)));
  const t = await import('./ui-table.js');
  await t.restoreDrawer(async () => {});
  await vi.waitFor(() => expect(document.querySelector('.td-row')).not.toBeNull());
}

beforeEach(() => {
  fetched.length = 0;
  sessionStorage.setItem('tm-drawer', JSON.stringify({ v: 1, hash: (location.hash = '#3/40/-100?l=a', location.hash), at: 1, data: {
    v: 1, ask: false, pane: 'table', frac: 0.5, collapsed: false, table: {
      req: { layerId: LAYER }, sort: null, groupBy: '', sumField: '', barFilter: null, shown: ['name'], checked: [], active: null, scrollTop: 0,
    } } }));
});
afterEach(async () => { (await import('./test-drawer-env.js')).resetDrawerEnv(); });

describe('restore over a columns file', () => {
  it('fetches only data/analysis/ paths', async () => {
    await restore();
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.filter(u => !u.startsWith('data/analysis/'))).toEqual([]);
  });
});
