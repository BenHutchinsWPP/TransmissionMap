// @vitest-environment jsdom
// The drawer's tab snapshot (sessionStorage tm-drawer): saved on hidden with
// the layout and the table's state; after a reload of the same link
// restoreDrawer brings back Ask (through resumeAsk), the table's sort,
// grouping, bar filter, columns, checks, active row and scroll, without moving
// focus or fetching; a vector-tile table waits for the map's idle; fields the
// layer no longer has fall back to defaults; garbage restores nothing.
// Each "page load" is a fresh module graph (vi.resetModules) over the same
// sessionStorage, as a reload in the same tab.
// Deps: ui-table.js (dataset-query.js's describe / query / aggregate / count
//       scripted), test-drawer-env.js, session-snapshot.js, state.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ROWS = [
  { id: 1231, props: { name: 'Alpha', nominal_kv: 500, sub_type: 'transmission' } },
  { id: 2341, props: { name: 'Bravo', nominal_kv: 230, sub_type: 'transmission' } },
  { id: 3451, props: { name: 'Charlie', nominal_kv: 115, sub_type: 'distribution' } },
  { id: 4561, props: { name: 'Delta', nominal_kv: 69, sub_type: 'distribution' } },
];
const FIELDS = [
  { name: 'name', type: 'string', ops: [] },
  { name: 'nominal_kv', type: 'number', ops: ['>='] },
  { name: 'sub_type', type: 'string', ops: ['in'], values: ['transmission', 'distribution'] },
  { name: 'operator', type: 'string', ops: [] },
];
type Cond = { field: string; op: string; value: unknown[] };
type Row = (typeof ROWS)[number];
const pass = (where: Cond[] | undefined) => (r: Row) => (where ?? [])
  .every(c => c.op !== 'in' || c.value.includes((r.props as Record<string, unknown>)[c.field]));

vi.mock('../dataset-query.js', async (orig) => ({
  ...(await orig<typeof import('../dataset-query.js')>()),
  describe: (layerId: string) => layerId === 'osm-substations-points'
    ? { ok: true, result: { layerId, queryable: true, kind: 'pmtiles', complete: false, idField: 'fid', fields: FIELDS, credit: 'OSM' } }
    : { ok: false, reason: 'no' },
  count: async () => ({ ok: true, result: { layerId: 'x', complete: false, total: ROWS.length } }),
  aggregate: async (_l: string, o: { groupBy: string }) => {
    const groups = new Map<unknown, number>();
    for (const r of ROWS) { const k = (r.props as Record<string, unknown>)[o.groupBy]; groups.set(k, (groups.get(k) ?? 0) + 1); }
    return { ok: true, result: { complete: false, total: ROWS.length, groups: [...groups].map(([key, count]) => ({ key, count, sums: {} })) } };
  },
  query: async (_l: string, o: { where?: Cond[]; orderBy?: { field: string; desc?: boolean } }) => {
    let rows = ROWS.filter(pass(o.where));
    if (o.orderBy) {
      const f = o.orderBy.field, s = o.orderBy.desc ? -1 : 1;
      rows = [...rows].sort((a, b) => String((a.props as Record<string, unknown>)[f]).localeCompare(String((b.props as Record<string, unknown>)[f]), 'en', { numeric: true }) * s);
    }
    return { ok: true, result: { complete: false, total: rows.length, truncated: false, fields: [], rows: rows.map(r => ({ ...r, feature: { type: 'Feature', properties: r.props, geometry: null } })) } };
  },
}));

// jsdom has no CSS.escape.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };

type Mods = { t: typeof import('./ui-table.js'); env: typeof import('./test-drawer-env.js'); state: typeof import('../state.js')['state'] };

/** A page load in this tab: the same link, fresh modules, a fresh map container. */
async function load(nav = 'reload', mapLoaded = true): Promise<Mods & { idle: () => void }> {
  vi.resetModules();
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: nav } as unknown as PerformanceEntry]);
  document.body.replaceChildren();
  const env = await import('./test-drawer-env.js');
  const { state } = await import('../state.js');
  const e = env.installDrawerEnv();
  Object.defineProperty(e.container, 'clientHeight', { value: 800, configurable: true });
  let idleFn = () => {};
  Object.assign(state.map!, { loaded: () => mapLoaded, once: (ev: string, fn: () => void) => { if (ev === 'idle') idleFn = fn; } });
  const t = await import('./ui-table.js');
  return { t, env, state, idle: () => idleFn() };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const stored = () => sessionStorage.getItem('tm-drawer');
const grid = () => q('.td-grid .tabulator-tableholder');
const names = () => [...document.querySelectorAll('.td-row')].map(r => r.children[2]?.textContent);
const checkedNames = () => [...document.querySelectorAll('.td-row')].filter(r => r.getAttribute('aria-selected') === 'true').map(r => r.children[2]?.textContent);
const settle = () => new Promise(r => setTimeout(r, 0));

/** Open the table and Ask, then sort by name ▼, group by sub_type with the
 *  "distribution" bar, check Delta, make Charlie active, hide operator, scroll. */
async function savedDrawer() {
  const { t } = await load();
  t.openAsk();
  await t.showTable({ layerId: 'osm-substations-points' });
  q<HTMLSelectElement>('.td-groupby').value = 'sub_type';
  q('.td-groupby').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.querySelector('[data-bar="distribution"]')).not.toBeNull());
  q('[data-bar="distribution"]').click();
  await vi.waitFor(() => expect(names()).toEqual(['Charlie', 'Delta']));
  q('[data-sort="name"]').click();                                     // ▲
  await vi.waitFor(() => expect(names()).toEqual(['Charlie', 'Delta']));
  q('[data-sort="name"]').click();                                     // ▼
  await vi.waitFor(() => expect(names()).toEqual(['Delta', 'Charlie']));
  q('.td-row[data-i="0"] .td-check input').click();                    // check Delta
  q('.td-row[data-i="1"] .tabulator-cell:nth-child(3)').click();       // Charlie active
  q<HTMLInputElement>('.td-cols').click();
  const op = q<HTMLInputElement>('[data-col="operator"]');
  if (op.checked) { op.checked = false; op.dispatchEvent(new Event('change', { bubbles: true })); }
  grid().scrollTop = 40;
  grid().dispatchEvent(new Event('scroll'));
  setHidden(true);
  setHidden(false);
}

beforeEach(() => { sessionStorage.clear(); history.replaceState(null, '', '#3/40/-100?l=a'); vi.restoreAllMocks(); setHidden(false); });
afterEach(async () => { (await import('./test-drawer-env.js')).resetDrawerEnv(); });

describe('drawer snapshot', () => {
  it('saves the layout and the table state on hidden', async () => {
    await savedDrawer();
    const s = JSON.parse(stored()!);
    expect(s).toMatchObject({ v: 1, hash: location.hash, data: { v: 1, ask: true, frac: 0, collapsed: false } });
    expect(s.data.table).toMatchObject({
      req: { layerId: 'osm-substations-points' }, sort: { field: 'name', desc: true }, groupBy: 'sub_type',
      barFilter: 'distribution', checked: [4561], active: 3451, scrollTop: 40,
    });
    expect(s.data.table.shown).not.toContain('operator');
  });

  it('restores it after a reload of the same link: Ask first, no focus, no fetch, no link write', async () => {
    await savedDrawer();
    const hash = location.hash;
    const { t } = await load();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const resumeAsk = vi.fn(async () => { t.openAsk(); });
    await t.restoreDrawer(resumeAsk);
    await vi.waitFor(() => expect(names()).toEqual(['Delta', 'Charlie']));
    expect(resumeAsk).toHaveBeenCalledOnce();
    expect(q('#td-tab-ask').hidden).toBe(false);
    expect(q<HTMLSelectElement>('.td-groupby').value).toBe('sub_type');
    expect(q('[data-bar="distribution"]').getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-sort="name"]').closest('[role="columnheader"]')!.getAttribute('aria-sort')).toBe('descending');
    expect(checkedNames()).toEqual(['Delta']);
    expect(q('.td-row--active').children[2].textContent).toBe('Charlie');
    expect(document.querySelector('[data-col]')).toBeNull();          // the Columns panel stays closed
    expect([...document.querySelectorAll('.td-sort')].map(b => b.getAttribute('data-sort'))).not.toContain('operator');
    expect(grid().scrollTop).toBe(40);
    expect(q('.td-status').textContent).toMatch(/loaded|tiles/i);     // the vector-tile partial note
    expect(document.activeElement).toBe(document.body);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(location.hash).toBe(hash);
  });

  it('a vector-tile table waits for the map to go idle', async () => {
    await savedDrawer();
    const { t, idle } = await load('reload', false);
    const done = t.restoreDrawer(async () => { t.openAsk(); });
    await settle();
    expect(document.querySelector('.td-row')).toBeNull();
    idle();
    await done;
    await vi.waitFor(() => expect(names()).toEqual(['Delta', 'Charlie']));
  });

  it('fields the layer no longer has fall back to the defaults; a checked id that is gone stays unchecked', async () => {
    sessionStorage.setItem('tm-drawer', JSON.stringify({ v: 1, hash: location.hash, at: 1, data: {
      v: 1, ask: false, pane: 'table', frac: 0.5, collapsed: false, table: {
        req: { layerId: 'osm-substations-points' }, sort: { field: 'gone', desc: true }, groupBy: 'gone', sumField: 'gone',
        barFilter: 'nope', shown: ['gone'], checked: [9991], active: 9991, scrollTop: 0,
      } } }));
    const { t } = await load();
    const resumeAsk = vi.fn(async () => {});
    await t.restoreDrawer(resumeAsk);
    await vi.waitFor(() => expect(names()).toHaveLength(4));
    expect(resumeAsk).not.toHaveBeenCalled();
    expect(q<HTMLSelectElement>('.td-groupby').value).toBe('sub_type');   // the default group-by
    expect(q('[data-sort="nominal_kv"]').closest('[role="columnheader"]')!.getAttribute('aria-sort')).toBe('descending');
    expect(checkedNames()).toEqual([]);
    expect(document.querySelector('.td-row--active')).toBeNull();
    expect(document.querySelectorAll('.td-sort').length).toBeGreaterThan(1);
  });

  it('garbage, an unknown layer or a fresh navigation restores nothing and removes the key', async () => {
    const put = (data: unknown) => sessionStorage.setItem('tm-drawer', JSON.stringify({ v: 1, hash: location.hash, at: 1, data }));
    for (const [data, nav] of [
      ['<img src=x onerror=alert(1)>', 'reload'],
      [{ v: 1, ask: false, pane: 'table', table: { req: { layerId: 'evil<script>' } } }, 'reload'],
      [{ v: 9, ask: true }, 'reload'],
      [{ v: 1, ask: false, pane: 'table', table: { req: { layerId: 'osm-substations-points' } } }, 'navigate'],
    ] as const) {
      put(data);
      const { t } = await load(nav);
      const resumeAsk = vi.fn(async () => {});
      await t.restoreDrawer(resumeAsk);
      expect(resumeAsk).not.toHaveBeenCalled();
      expect(document.querySelector('.table-drawer:not([hidden])')).toBeNull();
      expect(document.querySelector('img')).toBeNull();
      expect(stored()).toBeNull();
    }
  });

  it('removes the snapshot when no pane is open', async () => {
    await savedDrawer();
    const { t } = await load();
    await t.restoreDrawer(async () => { t.openAsk(); });
    t.closeAsk();
    t.closeTable();
    setHidden(true);
    expect(stored()).toBeNull();
  });

  it('what the visitor does while the restore waits for the map stands, and saves are not blocked meanwhile', async () => {
    await savedDrawer();
    const { t, idle } = await load('reload', false);
    const done = t.restoreDrawer(async () => { t.openAsk(); });
    await settle();
    t.closeAsk();                                      // the visitor closes Ask while the map is still loading
    setHidden(true);
    expect(stored()).toBeNull();                       // their save went through (nothing open)
    setHidden(false);
    idle();
    await done;
    expect(document.querySelector('.td-row')).toBeNull();
    expect(document.querySelector('.table-drawer.td--open')).toBeNull();
  });

  it('a save while the restore waits keeps the table it will bring back', async () => {
    await savedDrawer();
    const { t, idle } = await load('reload', false);
    const done = t.restoreDrawer(async () => { t.openAsk(); });
    await settle();
    setHidden(true);
    expect(JSON.parse(stored()!).data.table).toMatchObject({ req: { layerId: 'osm-substations-points' }, barFilter: 'distribution' });
    setHidden(false);
    idle();
    await done;
    await vi.waitFor(() => expect(names()).toEqual(['Delta', 'Charlie']));
  });

  it('a save that cannot be written removes the older one', async () => {
    await savedDrawer();
    expect(stored()).not.toBeNull();
    const { t } = await load();
    await t.restoreDrawer(async () => { t.openAsk(); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    setHidden(true);
    expect(stored()).toBeNull();
  });
});
