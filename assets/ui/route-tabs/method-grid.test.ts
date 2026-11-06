// @vitest-environment jsdom
// ─── method-grid.test.ts ─────────────────────────────────────────────────────
// Role: tests for the Method grid (method-grid.ts) on the real tm-default preset, under the drawer's size stubs.
//       Expected values are hand-written literals; rows are found by their Tabulator index (`data-key`) and
//       cells by field position (f0 Excl., f1 Map, f2 Category, f3 Group, f4 Applies, f5 Routing weight,
//       f6 Cost x, f7–f10 the four cost sets, f11 Map data from, f12 Weight & cost from).
// Deps: method-grid.js, test-drawer-env.js, grid-copy.js and user-data-export.js (spied).
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { installDrawerEnv, resetDrawerEnv } from '../test-drawer-env.js';
import { routePreset, type RoutePreset } from '../../../src/registry/route-presets.js';
import type { PresetPatch } from '../../route/preset-patch.js';
import type { RowPick } from '../../route/route.js';
import { mountMethodGrid, type MethodGrid, type MethodGridOpts } from './method-grid.js';
import { loadRouteStrings } from '../../../src/i18n/index.js';

beforeAll(() => loadRouteStrings());

const copied: string[] = [];
vi.mock('../grid-copy.js', async (orig) => ({
  ...(await orig<typeof import('../grid-copy.js')>()),
  copyText: vi.fn((text: string, done: () => void) => { copied.push(text); done(); }),
}));
const downloads: { data: string; name: string }[] = [];
vi.mock('../../user-data/user-data-export.js', async (orig) => ({
  ...(await orig<typeof import('../../user-data/user-data-export.js')>()),
  downloadFile: vi.fn((data: string, name: string) => { downloads.push({ data, name }); }),
}));

const base = routePreset('tm-default')!;
const idx = (note: string) => base.rows.findIndex((r) => r.note === note);
const GAP1 = idx('GAP 1');
const MIL = [idx('military (PAD-US DOD)'), idx('military (OSM landuse=military)')];
const PHMA = idx('sage-grouse PHMA/IHMA');
const FOREST = base.rows.findIndex((r) => r.band === 'landcover' && 'codes' in r.match && r.match.codes[0] === 41);

let host: HTMLElement;
let mg: MethodGrid | null = null;
let changes: (PresetPatch | null)[] = [];
let lastPicks: RowPick[] = [];

function mount(over: Partial<MethodGridOpts> = {}, preset: RoutePreset = base): HTMLElement {
  changes = [];
  mg = mountMethodGrid(host, {
    preset, base, patch: null, highlight: [],
    onChange: (p) => { changes.push(p); },
    onHighlight: (p) => { lastPicks = p; },
    ...over,
  });
  return host;
}
const q = <T extends Element = HTMLElement>(s: string) => host.querySelector<T>(s)!;
const filter = (text: string) => { const i = q<HTMLInputElement>('.rm-mg-q'); i.value = text; i.dispatchEvent(new Event('input', { bubbles: true })); };
const rowEl = (key: string) => host.querySelector<HTMLElement>(`.tabulator-row[data-key="${key}"]`);
const cellEl = (key: string, f: number) => rowEl(key)?.querySelector<HTMLElement>(`.tabulator-cell[tabulator-field="f${f}"]`) ?? null;
const keys = () => [...host.querySelectorAll<HTMLElement>('.tabulator-row')].map((r) => r.dataset.key);
const ready = (key: string) => vi.waitFor(() => expect(rowEl(key)).not.toBeNull());
const mouse = (el: Element, type: string) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));

beforeAll(() => { installDrawerEnv(); });
afterAll(resetDrawerEnv);
beforeAll(() => { host = document.createElement('div'); document.body.append(host); });
afterEach(() => { mg?.destroy(); mg = null; copied.length = 0; downloads.length = 0; lastPicks = []; });

describe('cells are text', () => {
  it('a note with markup stays text in every cell', async () => {
    const preset: RoutePreset = structuredClone(base);
    preset.rows[GAP1].note = 'GAP <b>1</b>';
    preset.rows[GAP1].src = '<img src=x onerror=alert(1)> ours';
    mount({}, preset);
    filter('GAP');
    await ready(`r:${GAP1}`);
    const row = rowEl(`r:${GAP1}`)!;
    expect(row.querySelector('b, img')).toBeNull();
    expect(cellEl(`r:${GAP1}`, 2)!.textContent).toBe('GAP <b>1</b>');
    expect(cellEl(`r:${GAP1}`, 12)!.textContent).toBe('Wu 2023');                        // the short reference
    expect(cellEl(`r:${GAP1}`, 12)!.title).toBe('<img src=x onerror=alert(1)> ours');  // the full src, as a title
  });

  it('every formatter returns a node, never an HTML string', async () => {
    mount();
    await ready(`r:${FOREST}`);
    // A string would be set as innerHTML: its tags would become elements. Every cell's children are our spans.
    for (const c of host.querySelectorAll('.tabulator-row .tabulator-cell')) {
      for (const k of c.children) expect(['SPAN', 'INPUT', 'BUTTON']).toContain(k.tagName);
    }
  });
});

describe('Excl. column', () => {
  it('ticking GAP 1 sets routing weight 1000, shows rm-excl and "was 100"', async () => {
    mount();
    filter('GAP 1');
    await ready(`r:${GAP1}`);
    const box = cellEl(`r:${GAP1}`, 0)!.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(box.checked).toBe(false);
    box.click();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ rows: [{ row: GAP1, band: 'protect', note: 'GAP 1', route_w: 1000 }] });
    await vi.waitFor(() => expect(cellEl(`r:${GAP1}`, 5)!.classList.contains('rm-excl')).toBe(true));
    expect(cellEl(`r:${GAP1}`, 5)!.textContent).toContain('1000');
    expect(cellEl(`r:${GAP1}`, 5)!.textContent).toContain('was 100');
  });

  it('the two military rows tick together', async () => {
    mount();
    filter('military');
    await ready(`r:${MIL[0]}`);
    cellEl(`r:${MIL[0]}`, 0)!.querySelector<HTMLInputElement>('input')!.click();
    const rows = changes[0]!.rows!;
    expect(rows.map((r) => [r.row, r.route_w])).toEqual([[MIL[0], 1000], [MIL[1], 1000]]);
  });

  it('Wild & Scenic River: an unchecked excl cell; a click emits route_w 1000', async () => {
    mount();
    filter('Wild & Scenic');
    const WSR = idx('Wild & Scenic River corridor');
    await ready(`r:${WSR}`);
    const box = cellEl(`r:${WSR}`, 0)!.querySelector<HTMLInputElement>('input')!;
    expect(box.checked).toBe(false);
    box.click();
    expect(changes[0]!.rows![0]).toMatchObject({ row: WSR, route_w: 1000 });
  });

  it('NPS unit named Preserve: an unchecked excl cell; a click emits route_w 1000', async () => {
    mount();
    filter('NPS unit named Preserve');
    const NP = base.rows.findIndex((r) => r.note?.startsWith('NPS unit named Preserve'));
    await ready(`r:${NP}`);
    const box = cellEl(`r:${NP}`, 0)!.querySelector<HTMLInputElement>('input')!;
    expect(box.checked).toBe(false);
    box.click();
    expect(changes[0]!.rows![0]).toMatchObject({ row: NP, route_w: 1000 });
  });

  it('an exemption checkbox turns that entry off', async () => {
    mount();
    filter('sage-grouse PHMA');
    await ready(`x:${PHMA}:0`);
    const box = cellEl(`x:${PHMA}:0`, 0)!.querySelector<HTMLInputElement>('input')!;
    expect(box.checked).toBe(true);
    box.click();
    expect(changes[0]!.rows![0]).toMatchObject({ row: PHMA, except: [false, false, false] });
  });

  it('a patch given at mount shows the row excluded', async () => {
    mount({ patch: { rows: [{ row: GAP1, band: 'protect', note: 'GAP 1', route_w: 1000 }] } });
    filter('GAP 1');
    await ready(`r:${GAP1}`);
    expect(cellEl(`r:${GAP1}`, 0)!.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    expect(q('.rm-mg-status').textContent).toBe('58 rows · 3 excluded · 0 on the map');
  });
});

describe('editing', () => {
  const edit = async (key: string, f: number, value: string) => {
    cellEl(key, f)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = await vi.waitFor(() => { const i = cellEl(key, f)!.querySelector<HTMLInputElement>('input'); expect(i).not.toBeNull(); return i!; });
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('an accepted edit reaches onChange and marks the cell with "was"', async () => {
    mount();
    filter('Forest');
    await ready(`r:${FOREST}`);
    const cell = cellEl(`r:${FOREST}`, 5)!;
    expect(cell.getAttribute('aria-label')).toBe(`Routing weight for ${base.rows[FOREST].note ?? base.rows[FOREST].band}`);
    await edit(`r:${FOREST}`, 5, '3');
    expect(changes[0]!.rows![0]).toMatchObject({ row: FOREST, route_w: 3 });
    await vi.waitFor(() => expect(cellEl(`r:${FOREST}`, 5)!.classList.contains('rm-edit')).toBe(true));
    expect(cellEl(`r:${FOREST}`, 5)!.textContent).toContain('was 2.25');
  });

  it('a refused edit puts the old value back and shows the reason', async () => {
    mount();
    filter('Forest');
    await ready(`r:${FOREST}`);
    await edit(`r:${FOREST}`, 5, '20000');
    expect(changes).toHaveLength(0);
    const alert = q('[role=alert]');
    expect(alert.hidden).toBe(false);
    expect(alert.textContent!.length).toBeGreaterThan(0);
    expect(cellEl(`r:${FOREST}`, 5)!.textContent).toContain('2.25');
    expect(cellEl(`r:${FOREST}`, 5)!.classList.contains('rm-edit')).toBe(false);
  });

  it('a drag over routing-weight cells makes a range and opens no editor', async () => {
    mount();
    await ready(`r:${FOREST}`);
    const keys0 = keys();
    mouse(cellEl(keys0[1]!, 5)!, 'mousedown');
    mouse(cellEl(keys0[3]!, 5)!, 'mousemove');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(host.querySelector('.tabulator-editing')).toBeNull();
    expect(host.querySelector('.tabulator-cell input[type=text]')).toBeNull();
  });
});

describe('filter and view', () => {
  it('"ours" lists the rows whose source says ours', async () => {
    const preset: RoutePreset = structuredClone(base);
    preset.rows.forEach((r) => { r.src = 'B&V 2014'; });
    preset.rows[FOREST].src = 'ours: a guess';
    mount({}, preset);
    filter('ours');
    await vi.waitFor(() => expect(keys().filter((k) => k!.startsWith('r:'))).toEqual([`r:${FOREST}`]));
  });

  it('"No rows match" shows when the filter finds nothing', async () => {
    mount();
    filter('zzzzqqq');
    await vi.waitFor(() => expect(q('.rm-mg-none').hidden).toBe(false));
    expect(q('.rm-mg-none').textContent).toBe('No rows match');
  });

  it('Flat list drops the group headers', async () => {
    mount();
    await ready(`r:${base.rows.findIndex((r) => !r.group)}`.replace(/r:-1/, 'r:0'));
    expect(keys().some((k) => k!.startsWith('g:'))).toBe(true);
    const chip = host.querySelectorAll<HTMLButtonElement>('.rm-mg-chip')[0];
    chip.click();
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await vi.waitFor(() => expect(keys().some((k) => k!.startsWith('g:'))).toBe(false));
  });

  it('Edited only lists the edited rows', async () => {
    mount({ patch: { rows: [{ row: FOREST, band: 'landcover', note: base.rows[FOREST].note, route_w: 3 }] } });
    const chip = host.querySelectorAll<HTMLButtonElement>('.rm-mg-chip')[1];
    chip.click();
    await vi.waitFor(() => expect(keys().filter((k) => k!.startsWith('r:'))).toEqual([`r:${FOREST}`]));
  });

  it('a header click sorts, a second click reverses, a third clears', async () => {
    mount();
    await ready(`r:${FOREST}`);
    const head = host.querySelector<HTMLButtonElement>('.tabulator-col[tabulator-field="f2"] .rm-head')!;
    head.click();
    expect(head.textContent).toContain('▲');
    head.click();
    expect(head.textContent).toContain('▼');
    head.click();
    expect(head.textContent).not.toMatch(/[▲▼]/);
  });

  it('a regional cost-set header sorts the rows by that set, descending on a second click', async () => {
    mount();
    await ready(`r:${FOREST}`);
    host.querySelectorAll<HTMLButtonElement>('.rm-mg-chip')[0].click();          // Flat list
    await vi.waitFor(() => expect(keys().some((k) => k!.startsWith('g:'))).toBe(false));
    const head = host.querySelector<HTMLButtonElement>('.tabulator-col[tabulator-field="f8"] .rm-head')!;   // the second set, SCE
    const sce = () => [...host.querySelectorAll<HTMLElement>('.tabulator-row')]
      .filter((r) => r.dataset.key!.startsWith('r:'))
      .map((r) => parseFloat(r.querySelector('.tabulator-cell[tabulator-field="f8"]')!.textContent!))
      .filter((n) => Number.isFinite(n));
    head.click();
    await vi.waitFor(() => expect(head.textContent).toContain('▲'));
    const up = sce();
    expect(up.length).toBeGreaterThan(5);
    expect(up).toEqual([...up].sort((a, b) => a - b));
    expect(up[0]).toBeLessThan(up[up.length - 1]);
    head.click();
    await vi.waitFor(() => expect(head.textContent).toContain('▼'));
    const down = sce();
    expect(down).toEqual([...down].sort((a, b) => b - a));
    expect(down[0]).toBe(3);
  });
});

/** Only the Forest row shown: it carries the one edit, and Edited only hides the rest. */
async function onlyForest() {
  mount({ patch: { rows: [{ row: FOREST, band: 'landcover', note: base.rows[FOREST].note, route_w: 3 }] } });
  host.querySelectorAll<HTMLButtonElement>('.rm-mg-chip')[1].click();
  await vi.waitFor(() => expect(keys().filter((k) => k!.startsWith('r:'))).toEqual([`r:${FOREST}`]));
}

describe('copy and CSV', () => {
  it('Ctrl+C on a dragged range copies a TSV with a header line', async () => {
    mount();
    filter('GAP 1');
    await ready(`r:${GAP1}`);
    mouse(cellEl(`r:${GAP1}`, 2)!, 'mousedown');
    mouse(cellEl(`r:${GAP1}`, 5)!, 'mousemove');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    q('.tabulator-tableholder').dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    expect(copied).toHaveLength(1);
    const [head, line] = copied[0].split('\n');
    expect(head).toBe('Category\tGroup\tApplies to\tRouting weight');
    expect(line).toBe('GAP 1\tprotection\tGAP 1\t100');
    expect(q('.rm-mg-status').textContent).toBe('Copied 1 × 4 cells');
  });

  it('Copy table copies every shown data row under the full header', async () => {
    await onlyForest();
    host.querySelectorAll<HTMLButtonElement>('.rm-mg-btn')[0].click();
    const lines = copied[0].split('\n');
    expect(lines[0]).toBe('Excl.\tMap\tCategory\tGroup\tApplies to\tMatches\tRouting weight\tCost x\tCost x TEPPC\tCost x SCE\tCost x MISO\tCost x Southeast\tMap data from\tWeight & cost from');
    expect(lines).toHaveLength(2);
    expect(lines[1].split('\t').slice(0, 8)).toEqual(['', '', 'forest', 'terrain', 'Deciduous forest; Evergreen forest; Mixed forest', 'landcover 41, 42, 43', '3', '1']);
    expect(q('.rm-mg-status').textContent).toBe('Copied 1 rows');
  });

  it('CSV: records keyed by unique localized labels, credit from the preset, <id>-method.csv', async () => {
    await onlyForest();
    q('[data-act=csv]').click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe('tm-default-method.csv');
    expect(downloads[0].data.startsWith('\uFEFF')).toBe(true);   // UTF-8 BOM, so Excel keeps ≥, °, ² and → intact
    const lines = downloads[0].data.slice(1).split('\r\n');
    expect(lines[0]).toBe('Excl.,Map,Category,Group,Applies to,Matches,Routing weight,Cost x,Cost x TEPPC,Cost x SCE,Cost x MISO,Cost x Southeast,Map data from,Weight & cost from');
    expect(new Set(lines[0].split(',')).size).toBe(14);
    expect(lines[1].split(',').slice(0, 3)).toEqual(['', '', 'forest']);
    expect(lines[1]).toContain('Deciduous forest; Evergreen forest; Mixed forest,"landcover 41, 42, 43"');
    expect(lines[2]).toMatch(/^"?Source: /);
  });
});

describe('Map column', () => {
  it('takes the next free slot, with the palette colour, and the 9th is refused', async () => {
    mount();
    await ready(`r:${FOREST}`);
    const toggles = () => [...host.querySelectorAll<HTMLButtonElement>('.rm-map')];
    const first = toggles().slice(0, 9);
    first.slice(0, 8).forEach((b) => b.click());
    await vi.waitFor(() => expect(lastPicks).toHaveLength(8));
    expect(lastPicks.map((p) => p.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(q('.rm-mg-status').textContent).toBe('58 rows · 2 excluded · 8 on the map');
    await vi.waitFor(() => expect(toggles().filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(8));
    expect(toggles().find((b) => b.getAttribute('aria-pressed') === 'true')!.style.color).toBe('rgb(225, 29, 72)');
    const ninth = toggles().find((b) => b.getAttribute('aria-pressed') === 'false')!;
    ninth.click();
    expect(lastPicks).toHaveLength(8);
    expect(q('.rm-mg-status').textContent).toBe('Up to 8 rows at once');
  });

  it('turning one off frees its slot for the next', async () => {
    mount({ highlight: [{ row: 0, band: base.rows[0].band, slot: 0 }, { row: 1, band: base.rows[1].band, slot: 1 }] });
    await ready('r:2');
    const on = host.querySelectorAll<HTMLButtonElement>('.rm-map[aria-pressed=true]');
    expect(on).toHaveLength(2);
    on[0].click();
    host.querySelectorAll<HTMLButtonElement>('.rm-map[aria-pressed=false]')[0].click();
    expect(lastPicks.map((p) => [p.row, p.slot])).toEqual([[1, 1], [0, 0]]);
  });

  it('is disabled when onHighlight is null, and setHighlight can enable it', async () => {
    mount({ onHighlight: null });
    await ready(`r:${FOREST}`);
    const b = host.querySelector<HTMLButtonElement>('.rm-map')!;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Find a route to show rows on the map');
    mg!.setHighlight([], true);
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('.rm-map')!.disabled).toBe(false));
  });
});

describe('accessibility and regions', () => {
  it('editable cells and checkboxes carry aria-labels; barrier rows are not editable', async () => {
    mount();
    filter('GAP 1');
    await ready(`r:${GAP1}`);
    expect(cellEl(`r:${GAP1}`, 5)!.getAttribute('aria-label')).toBe('Routing weight for GAP 1');
    expect(cellEl(`r:${GAP1}`, 6)!.getAttribute('aria-label')).toBe('Cost multiplier for GAP 1');
    expect(cellEl(`r:${GAP1}`, 0)!.querySelector('input')!.getAttribute('aria-label')).toBe('Exclude GAP 1');
    expect(cellEl(`r:${GAP1}`, 1)!.querySelector('button')!.getAttribute('aria-label')).toBe('Show GAP 1 on the map');
    filter('military');
    await ready(`r:${MIL[0]}`);
    expect(cellEl(`r:${MIL[0]}`, 0)!.querySelector('input')!.getAttribute('aria-label')).toMatch(/^Exclude .* \(and the rows linked to it\)$/);
  });

  it('setRegionM marks the crossed set columns', async () => {
    mount({ regionM: { SCE: 1200 } });
    await ready(`r:${FOREST}`);
    const head = (f: number) => host.querySelector(`.tabulator-col[tabulator-field="f${f}"]`)!;
    await vi.waitFor(() => expect(head(8).classList.contains('rm-crossed')).toBe(true));
    expect(head(7).classList.contains('rm-crossed')).toBe(false);
    expect(head(8).querySelector('.rm-head')!.getAttribute('title')).toBe('The shown route was costed with this set');
    mg!.setRegionM({ TEPPC: 5 });
    expect(head(7).classList.contains('rm-crossed')).toBe(true);
    expect(head(8).classList.contains('rm-crossed')).toBe(false);
  });

  it('setPatch shows the patch from outside', async () => {
    mount();
    filter('Forest');
    await ready(`r:${FOREST}`);
    mg!.setPatch({ rows: [{ row: FOREST, band: 'landcover', note: base.rows[FOREST].note, route_w: 3 }] });
    await vi.waitFor(() => expect(cellEl(`r:${FOREST}`, 5)!.classList.contains('rm-edit')).toBe(true));
  });
});

describe('a re-solve keeps what the visitor is doing', () => {
  it('update-style setHighlight with unchanged picks keeps an open cell editor, its text and focus', async () => {
    mount();
    filter('Forest');
    await ready(`r:${FOREST}`);
    cellEl(`r:${FOREST}`, 5)!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = await vi.waitFor(() => { const i = cellEl(`r:${FOREST}`, 5)!.querySelector<HTMLInputElement>('input'); expect(i).not.toBeNull(); return i!; });
    input.focus();
    input.value = '7';
    mg!.setHighlight([], true);
    mg!.setRegionM({});
    await new Promise((r) => setTimeout(r, 30));
    expect(cellEl(`r:${FOREST}`, 5)!.querySelector('input')).toBe(input);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('7');
    expect(document.activeElement).toBe(input);
  });

  it('a half-typed contingency value survives setHighlight with unchanged picks', async () => {
    mount();
    await ready(`r:${FOREST}`);
    const c = q<HTMLInputElement>('[data-field=contingency]');
    c.focus();
    c.value = '35';
    mg!.setHighlight([], true);
    expect(c.value).toBe('35');
    expect(document.activeElement).toBe(c);
  });
});

describe('focus after a rebuild', () => {
  it('an Excl. tick leaves keyboard focus on that row\'s Excl. checkbox', async () => {
    mount();
    filter('GAP 1');
    await ready(`r:${GAP1}`);
    const box = cellEl(`r:${GAP1}`, 0)!.querySelector<HTMLInputElement>('input')!;
    box.focus();
    box.click();
    await vi.waitFor(() => {
      const now = cellEl(`r:${GAP1}`, 0)!.querySelector<HTMLInputElement>('input')!;
      expect(now.checked).toBe(true);
      expect(document.activeElement).toBe(now);
    });
  });

  it('a Map click leaves focus on that row\'s Map button', async () => {
    mount({}, base);
    mg!.setHighlight([], true);
    filter('GAP 1');
    await ready(`r:${GAP1}`);
    const b = cellEl(`r:${GAP1}`, 1)!.querySelector<HTMLButtonElement>('button')!;
    b.focus();
    b.click();
    await vi.waitFor(() => {
      const now = cellEl(`r:${GAP1}`, 1)!.querySelector<HTMLButtonElement>('button')!;
      expect(now.getAttribute('aria-pressed')).toBe('true');
      expect(document.activeElement).toBe(now);
    });
  });

  it('a Map click keeps the grid where it was scrolled', async () => {
    mount({}, base);
    mg!.setHighlight([], true);
    filter('GAP 1');
    await ready(`r:${GAP1}`);
    const holder = document.querySelector<HTMLElement>('.tabulator-tableholder')!;
    holder.scrollTop = 120;
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const b = cellEl(`r:${GAP1}`, 1)!.querySelector<HTMLButtonElement>('button')!;
    b.focus();
    holder.scrollTop = 120;
    focus.mockClear();
    b.click();
    await vi.waitFor(() => expect(cellEl(`r:${GAP1}`, 1)!.querySelector('button')!.getAttribute('aria-pressed')).toBe('true'));
    await vi.waitFor(() => expect(focus).toHaveBeenCalled());
    expect(focus.mock.calls.every(([o]) => (o as FocusOptions | undefined)?.preventScroll === true)).toBe(true);
    expect(holder.scrollTop).toBe(120);
    focus.mockRestore();
  });

  it('scrolls inside its own height, so the header row stays in view', async () => {
    mount({}, base);
    await ready(`r:${GAP1}`);
    expect(q<HTMLElement>('.rm-grid').style.height).not.toBe('100%');
  });

  it('keeps its scroll when a clicked control takes no focus, and a filter goes back to the top', async () => {
    mount({}, base);
    mg!.setHighlight([], true);
    filter('GAP 1');
    await ready(`r:${GAP1}`);
    const holder = document.querySelector<HTMLElement>('.tabulator-tableholder')!;
    holder.scrollTop = 120;
    (document.activeElement as HTMLElement | null)?.blur();
    cellEl(`r:${GAP1}`, 1)!.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(cellEl(`r:${GAP1}`, 1)!.querySelector('button')!.getAttribute('aria-pressed')).toBe('true'));
    expect(holder.scrollTop).toBe(120);
    filter('GAP');
    await vi.waitFor(() => expect(holder.scrollTop).toBe(0));
  });
});
