// @vitest-environment jsdom
// The table's "Copy N checked to My Data" button: shown only for a layer whose
// copy is honest and only once copyAvailable has answered true (GeoJSON layers
// at once, a line layer once its line files answer, a tiled layer without line
// files never), disabled above 1,000 checked, one copyRows call per click on
// the checked rows; ui-table.ts imports neither copy-rows nor line-copy
// statically (they are lazy chunks).
// Deps: ui-table.js (dataset-query.js mocked, copy-rows.js spied, lines/line-read.js mocked),
//       test-drawer-env.js.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

let rowCount = 3;
vi.mock('../dataset-query.js', async (orig) => ({
  ...(await orig<typeof import('../dataset-query.js')>()),
  describe: (layerId: string) => ({ ok: true, result: { layerId, queryable: true, kind: 'geojson', complete: true, idField: 'fid',
    fields: [{ name: 'name', type: 'string', ops: [] }] } }),
  count: async () => ({ ok: true, result: { complete: true, total: rowCount } }),
  aggregate: async () => ({ ok: true, result: { complete: true, total: rowCount, groups: [] } }),
  query: async () => ({ ok: true, result: { complete: true, total: rowCount, truncated: false, fields: [],
    rows: Array.from({ length: rowCount }, (_, i) => ({
      id: i + 1, props: { name: `N${i}` },
      feature: { type: 'Feature', properties: { name: `N${i}` }, geometry: { type: 'Point', coordinates: [-100 + i / 100, 40] } },
    })) } }),
}));

let lineOk = true;
let lineOffline = false;   // the files cannot be reached this time: not cached, asked again
vi.mock('../lines/line-read.js', async (orig) => ({
  ...(await orig<typeof import('../lines/line-read.js')>()),
  lineDataset: async () => (lineOffline ? { ok: false, reason: 'offline' } : lineOk ? { ok: true, result: {} } : { ok: false, reason: 'unavailable' }),
}));

const copyRowsSpy = vi.fn();
vi.mock('../user-data/copy-rows.js', async (orig) => {
  const m = await orig<typeof import('../user-data/copy-rows.js')>();
  return { ...m, copyRows: (...a: unknown[]) => { copyRowsSpy(...a); return Promise.resolve({ kind: 'copied', n: (a[1] as unknown[]).length, simplified: 0 }); } };
});

(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };

import { showTable, closeTable } from './ui-table.js';
import { installDrawerEnv, resetDrawerEnv } from './test-drawer-env.js';

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const rows = () => document.querySelectorAll('.td-row').length;
const settle = () => new Promise(r => setTimeout(r, 30));
const open = async (layerId: string, n = rowCount) => {
  await showTable({ layerId });
  await vi.waitFor(() => expect(rows()).toBeGreaterThan(0));
  await settle();
  return n;
};

describe('table copy button', () => {
  beforeAll(() => { const env = installDrawerEnv(); Object.defineProperty(env.container, 'clientHeight', { value: 800, configurable: true }); });
  afterAll(resetDrawerEnv);
  beforeEach(() => { rowCount = 3; lineOk = true; lineOffline = false; copyRowsSpy.mockClear(); });
  afterEach(() => closeTable());

  it('is shown on a GeoJSON layer', async () => {
    await open('hifld-substations');
    await vi.waitFor(() => expect(q('.td-copy').hidden).toBe(false));
    expect(q('.td-copy').textContent).toBe('＋ Copy 0 checked to My Data');
    expect(q<HTMLButtonElement>('.td-copy').disabled).toBe(true);
  });

  it('is hidden on a tiled polygon layer (PAD-US) until its files answer, then shown', async () => {
    lineOffline = true;
    await open('padus');
    await settle();
    expect(q('.td-copy').hidden).toBe(true);
    lineOffline = false;
    await open('padus');
    await vi.waitFor(() => expect(q('.td-copy').hidden).toBe(false));
  });

  it('a tiled point layer shows it with the features wording, files or not', async () => {
    lineOk = false;
    await open('osm-substations-points');
    await vi.waitFor(() => expect(q('.td-copy').hidden).toBe(false));
    expect(q('.td-copy').textContent).toBe('＋ Copy 0 checked to My Data');
  });

  it('a polygon dataset stays hidden while its files cannot be read, and shows with the features wording once they answer', async () => {
    lineOffline = true;
    await open('osm-substations-polygons');
    await settle();   // the files' answer (offline) has arrived and was not cached
    expect(q('.td-copy').hidden).toBe(true);
    lineOffline = false;
    await open('osm-substations-polygons');
    await vi.waitFor(() => expect(q('.td-copy').hidden).toBe(false));
    expect(q('.td-copy').textContent).toBe('＋ Copy 0 checked to My Data');
  });

  it('a line layer shows it with its own wording once its line files answer', async () => {
    await open('osm-transmission-lines');
    await vi.waitFor(() => expect(q('.td-copy').hidden).toBe(false));
    expect(q('.td-copy').textContent).toBe('＋ Copy 0 checked lines');
  });

  it('a line layer stays hidden while lineDataset is unavailable', async () => {
    lineOk = false;
    await open('hifld-transmission-lines');
    expect(q('.td-copy').hidden).toBe(true);
  });

  it('a click copies the checked rows in one copyRows call', async () => {
    await open('hifld-substations');
    await vi.waitFor(() => expect(q('.td-copy').hidden).toBe(false));
    document.querySelectorAll<HTMLInputElement>('.td-row .td-check input').forEach((c, i) => { if (i < 2) c.click(); });
    expect(q<HTMLButtonElement>('.td-copy').disabled).toBe(false);
    expect(q('.td-copy').textContent).toBe('＋ Copy 2 checked to My Data');
    q('.td-copy').click();
    await vi.waitFor(() => expect(copyRowsSpy).toHaveBeenCalledTimes(1));
    const [layerId, picked, name] = copyRowsSpy.mock.calls[0];
    expect(layerId).toBe('hifld-substations');
    expect((picked as { id: number }[]).map(r => r.id)).toEqual([1, 2]);
    expect(name).toMatch(/: 2 features$/);
  });

  it('is disabled above 1,000 checked, titled with the cap', async () => {
    rowCount = 1001;
    await open('hifld-substations');
    await vi.waitFor(() => expect(q('.td-copy').hidden).toBe(false));
    q<HTMLInputElement>('.td-check-all').click();
    expect(q<HTMLButtonElement>('.td-copy').disabled).toBe(true);
    expect(q('.td-copy').title).toBe('at most 1,000 features at a time');
  });

  it('ui-table.ts imports neither copy-rows nor line-copy statically', () => {
    const src = readFileSync('assets/ui/ui-table.ts', 'utf8');
    expect(src).not.toMatch(/from '[^']*(copy-rows|line-copy|line-read)/);
    expect(src).toMatch(/import\('\.\.\/user-data\/copy-rows\.js'\)/);
  });
});
