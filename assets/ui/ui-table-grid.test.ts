// @vitest-environment jsdom
// The table's grid (Tabulator, a renderer only) and its column filters: rows
// with a frozen check column, a dragged range that Ctrl+C copies as TSV with a
// header line and raw values (full precision, formula-guarded), checks driving
// "Select N", a row click flying to its feature, and the header ▾ — offered on
// fields with operators only — setting the layer's `where` through map-api's
// setWhere (Apply replaces the field's conditions, Clear removes them, a
// refusal is shown and changes nothing), the table reloading to match, and a
// `where` set elsewhere reloading a table that follows the view.
// Deps: ui-table.js (dataset-query.js and map-api.js mocked), test-drawer-env.js,
//       state.js, state-bus.js.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';

const ROWS = [
  { id: 11, props: { name: 'Alpha', nominal_kv: 500.123456, sub_type: 'transmission', operator: '=HYPERLINK("x")' } },
  { id: 21, props: { name: 'Bravo', nominal_kv: 230, sub_type: 'transmission', operator: 'Tab\there' } },
  { id: 31, props: { name: 'Charlie', nominal_kv: 115, sub_type: 'distribution', operator: 'Utility C' } },
  { id: 41, props: { name: 'Delta', nominal_kv: 69, sub_type: 'distribution', operator: null } },
];
const RANGE = ['=', '!=', '<', '<=', '>', '>='];
const FIELDS = [
  { name: 'name', type: 'string', ops: [] },
  { name: 'operator', type: 'string', ops: [] },
  { name: 'nominal_kv', type: 'number', ops: RANGE },
  { name: 'sub_type', type: 'string', ops: ['=', '!=', 'in', 'not_in'], values: ['transmission', 'distribution'] },
];
type Cond = { field: string; op: string; value: unknown };
const test = (c: Cond, v: unknown) => c.op === 'in' ? (c.value as unknown[]).includes(v)
  : c.op === '>=' ? Number(v) >= Number(c.value) : c.op === '<=' ? Number(v) <= Number(c.value) : true;
const pass = (where: Cond[] | undefined) => (r: (typeof ROWS)[number]) =>
  (where ?? []).every(c => test(c, (r.props as Record<string, unknown>)[c.field]));
let complete = true;

vi.mock('../dataset-query.js', async (orig) => ({
  ...(await orig<typeof import('../dataset-query.js')>()),
  describe: (layerId: string) => ({ ok: true, result: { layerId, queryable: true, kind: 'geojson', complete, idField: 'fid', fields: FIELDS } }),
  count: async (_l: string, o: { where?: Cond[] }) => ({ ok: true, result: { complete, total: ROWS.filter(pass(o.where)).length } }),
  aggregate: async (_l: string, o: { where?: Cond[]; groupBy: string }) => {
    const groups = new Map<unknown, number>();
    for (const r of ROWS.filter(pass(o.where))) { const k = (r.props as Record<string, unknown>)[o.groupBy]; groups.set(k, (groups.get(k) ?? 0) + 1); }
    return { ok: true, result: { complete, total: ROWS.filter(pass(o.where)).length, groups: [...groups].map(([key, count]) => ({ key, count, sums: {} })) } };
  },
  query: async (_l: string, o: { where?: Cond[] }) => {
    const rows = ROWS.filter(pass(o.where));
    return { ok: true, result: { complete, total: rows.length, truncated: false, fields: [], rows: rows.map((r, i) => ({
      ...r, feature: { type: 'Feature', properties: r.props, geometry: { type: 'Point', coordinates: [-100 + i, 40] } },
    })) } };
  },
}));

// map-api's setWhere as the app's: a refused call (nominal_kv 999 here)
// changes nothing; an accepted one sets state.where and writes the link once.
vi.mock('../map-api.js', async () => {
  const { state } = await import('../state.js');
  const { emit } = await import('../state-bus.js');
  return {
    setWhere: vi.fn((id: string, conds: Cond[]) => {
      if (conds.some(c => c.value === 999)) return { ok: false, reason: 'outside the declared domain' };
      const where = { ...state.where };
      if (conds.length) where[id] = conds as never; else delete where[id];
      state.where = where;
      emit('url:write');
      return { ok: true, result: { id, conditions: conds.length } };
    }),
  };
});

// jsdom has no CSS.escape.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };

import { showTable, closeTable, clipValue, filterKind, proxPanel } from './ui-table.js';
import { installDrawerEnv, resetDrawerEnv, type DrawerEnv } from './test-drawer-env.js';
import { setWhere } from '../map-api.js';
import { state } from '../state.js';
import { emit } from '../state-bus.js';

const LAYER = 'osm-substations-points';
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const names = () => [...document.querySelectorAll('.td-row')].map(r => r.children[2]?.textContent);
const cell = (row: number, col: number) => document.querySelectorAll<HTMLElement>(`.td-row[data-i="${row}"] .tabulator-cell`)[col];
const open = async () => {
  await showTable({ layerId: LAYER });
  await vi.waitFor(() => expect(names()).toHaveLength(4));
};

describe('table grid', () => {
  let env: DrawerEnv;
  beforeAll(() => { env = installDrawerEnv(); Object.defineProperty(env.container, 'clientHeight', { value: 800, configurable: true }); });
  afterAll(resetDrawerEnv);
  beforeEach(() => { state.where = {}; complete = true; vi.mocked(setWhere).mockClear(); });
  afterEach(() => closeTable());

  it('draws the rows behind a frozen check column; the ▾ is on fields with operators only', async () => {
    await open();
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(document.querySelectorAll('.td-row .td-check input[type=checkbox]')).toHaveLength(4);
    expect(q('.tabulator-col.td-check .td-check-all')).not.toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('.td-sort')].map(b => b.dataset.sort)).toEqual(['name', 'operator', 'nominal_kv', 'sub_type']);
    expect([...document.querySelectorAll<HTMLElement>('.td-filter-btn')].map(b => b.dataset.filter)).toEqual(['nominal_kv', 'sub_type']);
    expect(cell(0, 4).textContent).toBe('500.1');                       // painted
    expect(cell(0, 3).textContent).toBe('=HYPERLINK("x")');              // as text, never markup
  });

  it('keeps its own grid apart from one in the Proximity pane (which comes first in the drawer)', async () => {
    await open();
    proxPanel().innerHTML = '<div class="px-grid"><div class="tabulator-tableholder" tabindex="0"></div></div>';
    q('.td-sort[data-sort="name"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const at = document.activeElement as HTMLElement;
    expect(at.classList.contains('tabulator-tableholder')).toBe(true);
    expect(at.closest('.td-grid')).not.toBeNull();
    proxPanel().replaceChildren();
  });

  it('a dragged range copies with Ctrl+C as TSV: a header line, raw values, formula-guarded text', async () => {
    await open();
    const mouse = (el: Element, type: string) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
    mouse(cell(0, 3), 'mousedown');
    mouse(cell(1, 4), 'mousemove');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    let copied = '';
    let html = 'unset';
    (document as { execCommand?: unknown }).execCommand = () => {
      const ev = new Event('copy', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      ev.clipboardData = { setData: (type: string, v: string) => { if (type === 'text/plain') copied = v; else html = v; } };
      q('.td-grid').dispatchEvent(ev);
      return true;
    };
    q('.td-grid .tabulator-tableholder').dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    expect(copied).toBe('operator\tnominal_kv\n\'=HYPERLINK("x")\t500.123456\nTab here\t230');
    expect(html).toBe('unset');                                          // no HTML flavour
    expect(q('.td-status').textContent).toBe('Copied 2 rows × 2 columns; paste them into a spreadsheet.');
  });

  it('clipValue: numbers at full precision, text one cell and formula-guarded', () => {
    expect(clipValue(0.1 + 0.2)).toBe(0.30000000000000004);
    expect(clipValue(null)).toBe('');
    expect(clipValue(NaN)).toBe('');
    expect(clipValue('-1+2')).toBe("'-1+2");
    expect(clipValue('a\r\nb')).toBe('a b');
    expect(clipValue({ a: 1 })).toBe('{"a":1}');
  });

  it('checks drive Select N; check-all checks every row; a row click makes it active and its arrow flies to it', async () => {
    await open();
    q('.td-row[data-i="2"] .td-check input').click();
    expect(q('.td-select').textContent).toContain('Select 1');
    expect(q('.td-row[data-i="2"]').getAttribute('aria-selected')).toBe('true');
    q<HTMLInputElement>('.td-check-all').click();
    expect(q('.td-select').textContent).toContain('Select 4');
    expect([...document.querySelectorAll('.td-row')].every(r => r.getAttribute('aria-selected') === 'true')).toBe(true);
    env.map.fitBounds.mockClear();
    cell(1, 2).click();
    expect(q('.td-row--active').dataset.i).toBe('1');
    expect(env.map.fitBounds).not.toHaveBeenCalled();
    q('.td-row[data-i="2"] .td-zoom-btn').click();
    expect(q('.td-row--active').dataset.i).toBe('2');
    expect(env.map.fitBounds).toHaveBeenCalledOnce();
  });

  it('Enter on a row\'s zoom button stays with the button (the range never opens an editor)', async () => {
    await open();
    const down = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    down(cell(1, 2));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const errors: unknown[] = [];
    const onErr = (e: ErrorEvent) => { errors.push(e.error ?? e.message); e.preventDefault(); };
    window.addEventListener('error', onErr);
    const btn = q<HTMLButtonElement>('.td-row[data-i="2"] .td-zoom-btn');
    btn.focus();
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    window.removeEventListener('error', onErr);
    expect(errors).toEqual([]);
  });

  it('a values filter sets the layer\'s `where`, the table reloads, the ▾ is marked; Clear removes just that field', async () => {
    await open();
    q('[data-filter="sub_type"]').click();
    const pop = q('.td-filterpop');
    expect(pop.hidden).toBe(false);
    const box = pop.querySelector<HTMLInputElement>('input[value="distribution"]')!;
    box.click();
    q('.td-fp-apply').click();
    expect(setWhere).toHaveBeenLastCalledWith(LAYER, [{ field: 'sub_type', op: 'in', value: ['distribution'] }]);
    await vi.waitFor(() => expect(names()).toEqual(['Charlie', 'Delta']));
    expect(pop.hidden).toBe(true);
    const btn = q('[data-filter="sub_type"]');
    expect(btn.classList.contains('td-filter-btn--on')).toBe(true);
    expect(btn.title).toBe('Filtered: Substation type: distribution');
    expect([...document.querySelectorAll('.td-pill')].map(p => p.textContent)).toContain('Substation type: distribution');

    // A range on another field adds to it (Enter applies).
    q('[data-filter="nominal_kv"]').click();
    const lo = q<HTMLInputElement>('.td-filterpop .td-fp-num');
    lo.value = '100';
    lo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(setWhere).toHaveBeenLastCalledWith(LAYER, [
      { field: 'sub_type', op: 'in', value: ['distribution'] }, { field: 'nominal_kv', op: '>=', value: 100 }]);
    await vi.waitFor(() => expect(names()).toEqual(['Charlie']));

    // Clear on sub_type leaves the range.
    q('[data-filter="sub_type"]').click();
    expect(q<HTMLInputElement>('.td-filterpop input[value="distribution"]').checked).toBe(true);
    q('.td-fp-clear').click();
    expect(setWhere).toHaveBeenLastCalledWith(LAYER, [{ field: 'nominal_kv', op: '>=', value: 100 }]);
    await vi.waitFor(() => expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']));
    expect(q('[data-filter="sub_type"]').classList.contains('td-filter-btn--on')).toBe(false);
  });

  it('a refused filter is shown in the popover and changes nothing', async () => {
    await open();
    q('[data-filter="nominal_kv"]').click();
    q<HTMLInputElement>('.td-filterpop .td-fp-num').value = '999';
    q('.td-fp-apply').click();
    expect(q('.td-fp-err').textContent).toBe('Not applied: outside the declared domain');
    expect(q('.td-filterpop').hidden).toBe(false);
    expect(state.where[LAYER]).toBeUndefined();
    expect(names()).toHaveLength(4);
  });

  it('Esc closes the popover, not the drawer, and focus returns to its ▾', async () => {
    await open();
    const btn = q('[data-filter="sub_type"]');
    btn.click();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    q('.td-filterpop input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(q('.td-filterpop').hidden).toBe(true);
    expect(q('.table-drawer').hidden).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it('a `where` set elsewhere (the row chip, Undo, the chat) reloads a table that follows the view', async () => {
    await open();
    state.where = { [LAYER]: [{ field: 'sub_type', op: 'in', value: ['transmission'] }] };
    emit('url:write');
    await vi.waitFor(() => expect(names()).toEqual(['Alpha', 'Bravo']));
    expect(q('[data-filter="sub_type"]').classList.contains('td-filter-btn--on')).toBe(true);
    state.where = {};
    emit('view:applied');
    await vi.waitFor(() => expect(names()).toHaveLength(4));
  });

  it('on a vector-tile layer the popover says the table covers the current view only', async () => {
    complete = false;
    await open();
    q('[data-filter="sub_type"]').click();
    expect(q('.td-fp-note strong').textContent).toMatch(/current view only/);
  });

  it('filterKind follows the schema: values, ranges, codes, true/false, or none', () => {
    const f = (o: object) => ({ name: 'x', type: 'string', ops: [], ...o }) as Parameters<typeof filterKind>[0];
    expect(filterKind(f({ ops: ['in'], values: ['a'] }))).toBe('values');
    expect(filterKind(f({ type: 'number', ops: RANGE }))).toBe('range');
    expect(filterKind(f({ ops: ['contains', 'contains_any'], list: true, pattern: '^\\d{5}$' }))).toBe('codes');
    expect(filterKind(f({ ops: ['contains', 'contains_any'], list: true, values: ['TX'] }))).toBe('values');
    expect(filterKind(f({ type: 'boolean', ops: ['='] }))).toBe('bool');
    expect(filterKind(f({ ops: [] }))).toBeNull();
  });
});
