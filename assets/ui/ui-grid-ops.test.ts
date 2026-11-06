// @vitest-environment jsdom
// The Grid Ops tab over a mocked grid-ops.ts paint: the opener's cached import and
// retry, the header, figures and ties (exporter first, short codes), the metered
// note, the node table (sorted by load, nulls last; top fuel), a row's ease above
// the drawer, "Inside the area" (grouping, fit, the pending member pick), focus kept
// across a repaint, closing when the layer goes off, nothing written to tm-drawer,
// and the bubble tap's toolOwnsTap guard (the real grid-ops.ts initGridOps).
// Deps: ui-grid-ops.js (grid-ops.js, panel-mirror.js syncPanel mocked), grid-ops-open.js,
//       test-drawer-env.js, ui-table.js, popup.js (toolOwnsTap), map-input.js (onMapTap captured).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installDrawerEnv, resetDrawerEnv, type DrawerEnv } from './test-drawer-env.js';
import type { GridShown, PaintedNode } from '../grid-ops/grid-ops.js';

const mocks = vi.hoisted(() => ({
  shown: null as GridShown | null,
  listeners: new Set<(s: GridShown | null) => void>(),
  setGridGroup: vi.fn(),
  syncPanel: vi.fn(),
  tapOpen: null as null | ((id: string | null, from?: unknown) => Promise<void>),
  taps: [] as { layer: string; fn: (e: unknown, f: { properties: Record<string, unknown> }[]) => void }[],
}));
vi.mock('../grid-ops/grid-ops.js', async (orig) => ({
  ...(await orig<typeof import('../grid-ops/grid-ops.js')>()),
  gridShown: () => mocks.shown,
  onGridPaint: (cb: (s: GridShown | null) => void) => { mocks.listeners.add(cb); return () => { mocks.listeners.delete(cb); }; },
  setGridGroup: mocks.setGridGroup,
}));
vi.mock('./panel-mirror.js', async (orig) => ({
  ...(await orig<typeof import('./panel-mirror.js')>()),
  syncPanel: mocks.syncPanel,
}));
vi.mock('./grid-ops-open.js', async (orig) => {
  const real = await orig<typeof import('./grid-ops-open.js')>();
  return { openGridOps: (id: string | null, from?: HTMLElement | null) => mocks.tapOpen ? mocks.tapOpen(id, from) : real.openGridOps(id, from) };
});
vi.mock('../map-input.js', async (orig) => {
  const real = await orig<typeof import('../map-input.js')>();
  return {
    ...real,
    onMapTap: (a: unknown, b?: unknown) => {
      if (typeof a === 'string') { mocks.taps.push({ layer: a, fn: b as (typeof mocks.taps)[number]['fn'] }); return () => {}; }
      return real.onMapTap(a as (e: import('../map-input.js').MapPointerEvent) => void);
    },
  };
});

const { state } = await import('../state.js');
const { emit } = await import('../state-bus.js');
const { loadDictionary, setLocale } = await import('../../src/i18n/index.js');
const go = await import('./ui-grid-ops.js');
const { gopsPanel, gopsOpen, closeGops } = await import('./ui-table.js');

const AT = Date.UTC(2026, 9, 30, 18);
function node(id: string, o: Partial<PaintedNode['properties']> & { at?: [number, number] } = {}): PaintedNode {
  const { at = [-120, 45], ...p } = o;
  return {
    type: 'Feature', geometry: { type: 'Point', coordinates: at },
    properties: {
      id, name: id, kind: 'ba', tag: id, load: 100, gen: 100, net: 0, short: id, cover: 1, offArea: '',
      size: 100, members: '[]', fuels: '[]', ties: '[]', exp: true, r: 10, ...p,
    },
  };
}
// A40 (NW) exports 300 to A65 (BS) and imports 120 from CISO.
const AREA = node('A40', {
  name: 'Northwest', short: 'NW', load: 10000, gen: 12000, net: 1800, members: JSON.stringify(['BPAT', 'PACW']),
  fuels: JSON.stringify([['hydro', 9000], ['gas', 2500], ['battery', -50]]),
  ties: JSON.stringify([{ with: 'A65', mw: 300, mine: 300, theirs: 310 }, { with: 'CISO', mw: -120, mine: -120, theirs: -118 }]),
});
const A65 = node('A65', { name: 'Basin', short: 'BS', load: 5000, gen: 4000, net: -300, fuels: JSON.stringify([['coal', 3000], ['wind', 900]]), at: [-112, 41] });
const CISO = node('CISO', { name: 'California ISO', load: 25000, gen: 20000, net: -5000, at: [-119, 37] });
const EXT = node('AESO', { kind: 'external', load: null, gen: null, net: null, at: [-114, 51] });

const paint = (s: GridShown | null) => { mocks.shown = s; for (const cb of [...mocks.listeners]) cb(s); };
const wecc = (): GridShown => ({ at: AT, group: 'wecc', nodes: [AREA, A65, CISO, EXT] });
const q = <T extends HTMLElement = HTMLElement>(sel: string) => gopsPanel().querySelector<T>(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';
const rows = () => [...gopsPanel().querySelectorAll('.td-gops-table tbody tr')].map(r => [...r.children].map(c => c.textContent));

let env: DrawerEnv;
let easeTo: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  setLocale('en');
  await loadDictionary('en');
  env = installDrawerEnv();
  easeTo = vi.fn();
  (state.map as unknown as { easeTo: unknown }).easeTo = easeTo;
  state.layerVisibility['ba-interchange'] = true;
  mocks.shown = wecc();
  mocks.setGridGroup.mockReset();
  mocks.syncPanel.mockReset();
});
afterEach(() => { closeGops(); resetDrawerEnv(); delete state.layerVisibility['ba-interchange']; vi.restoreAllMocks(); });

describe('the node view', () => {
  it('shows the header, the hour and three figures', () => {
    go.openGridOps('A40');
    expect(gopsOpen()).toBe(true);
    expect(text('.gops-name')).toBe('Northwest (A40)');
    expect(text('.gops-hour')).toMatch(/^Hour ending .*2026/);
    const figs = [...gopsPanel().querySelectorAll('.gops-fig')].map(f => [f.children[0].textContent, f.children[1].textContent]);
    expect(figs).toEqual([['Load', '10,000 MW'], ['Generation', '12,000 MW'], ['Net export', '1,800 MW']]);
    go.openGridOps('A65');
    expect(text('.gops-fig:nth-child(3) .gops-fig-k')).toBe('Net import');
    expect(text('.gops-fig:nth-child(3) .gops-fig-v')).toBe('300 MW');
  });

  it('lists the ties by |MW|, exporter first, with short codes and bars to scale', () => {
    go.openGridOps('A40');
    const ties = [...gopsPanel().querySelectorAll('.gops-tie')];
    expect(ties.map(li => li.textContent)).toEqual(['NW → BS 300 MW', 'CISO → NW 120 MW']);
    expect(ties.map(li => (li.querySelector('.gops-tie-bar') as HTMLElement).style.width)).toEqual(['100%', '40%']);
    expect(text('.gops-note')).toMatch(/metered flow/);
  });

  it('says so when a node has no ties', () => {
    go.openGridOps('CISO');
    expect(gopsPanel().querySelector('.gops-tie')).toBeNull();
    expect(gopsPanel().textContent).toContain('No ties reported this hour');
  });

  it('builds text only: a name with markup stays text', () => {
    mocks.shown = { at: AT, group: 'ba', nodes: [node('X', { name: '<img src=x onerror=alert(1)>' })] };
    go.openGridOps('X');
    expect(gopsPanel().querySelector('img')).toBeNull();
    expect(text('.gops-name')).toContain('<img');
  });
});

describe('the node table', () => {
  it('lists every node by load, nulls last, with signed net and top fuel', () => {
    go.openGridOps('A40');
    expect(text('.td-gops-table thead')).toBe('NameLoad (MW)Generation (MW)Net (MW)Top fuel');
    expect(rows()).toEqual([
      ['California ISO (CISO)', '25,000', '20,000', '-5,000', '–'],
      ['Northwest (A40)', '10,000', '12,000', '+1,800', 'Hydro'],
      ['Basin (A65)', '5,000', '4,000', '-300', 'Coal'],
      ['AESO', '–', '–', '–', '–'],
    ]);
  });

  it('a row button selects the node and eases the map above the drawer', () => {
    go.openGridOps('A40');
    q<HTMLButtonElement>('[data-id="row:A65"]')!.click();
    expect(text('.gops-name')).toBe('Basin (A65)');
    expect(easeTo).toHaveBeenCalledTimes(1);
    const arg = easeTo.mock.calls[0][0];
    expect(arg.center).toEqual([-112, 41]);
    expect(arg.duration).toBe(600);
    expect(arg.padding).toBeUndefined();
    expect(arg.offset).toEqual([expect.any(Number), expect.any(Number)]);
    expect(q('[data-id="row:A65"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Inside the area', () => {
  it('is offered only for a node of two or more BAs', () => {
    go.openGridOps('CISO');
    expect(q('.gops-inside')).toBeNull();
    go.openGridOps('A40');
    expect(q('.gops-inside')).not.toBeNull();
  });

  it('groups by BA, fits the members and picks the largest member on the next paint', () => {
    go.openGridOps('A40');
    q<HTMLButtonElement>('.gops-inside')!.click();
    expect(mocks.setGridGroup).toHaveBeenCalledWith('ba');
    expect(mocks.syncPanel).toHaveBeenCalledWith('ba-interchange');
    expect(env.map.fitBounds).toHaveBeenCalledTimes(1);
    const [bounds, opts] = env.map.fitBounds.mock.calls[0];
    expect(bounds[0][0]).toBeLessThan(bounds[1][0]);
    expect(opts.maxZoom).toBe(7);
    expect(opts.padding.top).toBe(100);
    // A paint that still holds the area changes nothing yet.
    paint(wecc());
    expect(text('.gops-name')).toBe('Northwest (A40)');
    paint({ at: AT, group: 'ba', nodes: [node('BPAT', { load: 6000 }), node('PACW', { load: 2500 }), CISO] });
    expect(text('.gops-name')).toBe('BPAT');
    // The pick is made once.
    q<HTMLButtonElement>('[data-id="row:PACW"]')!.click();
    paint({ at: AT, group: 'ba', nodes: [node('BPAT', { load: 6000 }), node('PACW', { load: 2500 })] });
    expect(text('.gops-name')).toBe('PACW');
  });
});

describe('repaints', () => {
  it('re-renders on a paint, keeping the selection and focus', () => {
    go.openGridOps('A40');
    q<HTMLButtonElement>('[data-id="row:A65"]')!.focus();
    const next = wecc();
    next.nodes[1] = node('A65', { name: 'Basin', short: 'BS', load: 5100, at: [-112, 41] });
    paint(next);
    expect(rows()[2][1]).toBe('5,100');
    expect(document.activeElement).toBe(q('[data-id="row:A65"]'));
    expect(text('.gops-name')).toBe('Northwest (A40)');
  });

  it('shows the pick hint when the node is gone and the no-data line on a null paint', () => {
    go.openGridOps('A40');
    paint({ at: AT, group: 'ba', nodes: [CISO] });
    expect(text('.gops-msg')).toBe('Click a bubble on the map to see its ties.');
    expect(rows()).toHaveLength(1);
    paint(null);
    expect(gopsOpen()).toBe(true);
    expect(text('.gops-msg')).toBe('No EIA-930 data for this hour');
  });

  it('closes when the layer is switched off', () => {
    go.openGridOps('A40');
    state.layerVisibility['ba-interchange'] = false;
    emit('layer:visibility', { id: 'ba-interchange', visible: false });
    expect(gopsOpen()).toBe(false);
    go.openGridOps('A40');
    paint(null);
    expect(gopsOpen()).toBe(false);
    expect(mocks.listeners.size).toBe(0);
  });

  it('follows the language', async () => {
    go.openGridOps('A40');
    await loadDictionary('fr');
    setLocale('fr');
    emit('lang:changed', { lang: 'fr' } as never);
    expect(text('.gops-fig-k')).not.toBe('Load');
    setLocale('en');
  });

  it('writes nothing to tm-drawer or the link', () => {
    const hash = location.hash;
    go.openGridOps('A40');
    q<HTMLButtonElement>('[data-id="row:A65"]')!.click();
    window.dispatchEvent(new Event('pagehide'));
    for (let i = 0; i < sessionStorage.length; i++) expect(sessionStorage.getItem(sessionStorage.key(i)!) ?? '').not.toMatch(/gops|A65/);
    expect(location.hash).toBe(hash);
  });
});

describe('the bubble tap', () => {
  it('opens the tab unless a tool owns the tap', async () => {
    const spy = vi.fn(async () => {});
    mocks.tapOpen = spy;
    const real = await vi.importActual<typeof import('../grid-ops/grid-ops.js')>('../grid-ops/grid-ops.js');
    (state.map as unknown as { once: unknown }).once = () => {};
    real.initGridOps();
    const tap = mocks.taps.find(x => x.layer === 'bai-bubbles')!;
    expect(tap).toBeTruthy();
    const f = [{ properties: { id: 'A40' } }];
    state.measure.active = true;
    tap.fn({}, f);
    state.measure.active = false;
    state.editMode = 'edit';
    tap.fn({}, f);
    expect(spy).not.toHaveBeenCalled();
    state.editMode = 'view';
    tap.fn({}, f);
    expect(spy).toHaveBeenCalledWith('A40', expect.anything());
    mocks.tapOpen = null;
  });
});

// Last: vi.resetModules gives later imports fresh module instances.
describe('the opener', () => {
  it('caches the chunk and retries after a failed load', async () => {
    vi.resetModules();
    let fails = 1, loads = 0;
    const open = vi.fn();
    vi.doMock('./ui-grid-ops.js', () => {
      loads++;
      if (fails-- > 0) throw new Error('offline');
      return { openGridOps: open };
    });
    let diagEvents = 0;
    const onDiag = () => { diagEvents++; };
    window.addEventListener('tm:diagerror', onDiag);
    const opener = await import('./grid-ops-open.js');
    await opener.openGridOps('A40');
    expect(open).not.toHaveBeenCalled();
    expect(diagEvents).toBe(1);
    window.removeEventListener('tm:diagerror', onDiag);
    await opener.openGridOps('A40');
    await opener.openGridOps('CISO', null);
    expect(open.mock.calls).toEqual([['A40', undefined], ['CISO', null]]);
    expect(loads).toBe(2);
    vi.doUnmock('./ui-grid-ops.js');
    vi.resetModules();
  });
});
