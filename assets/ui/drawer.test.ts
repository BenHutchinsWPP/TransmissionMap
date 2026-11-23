// @vitest-environment jsdom
// The drawer shell (drawer.ts) with a fake table pane and no table chunk:
// Tabulator, dataset-query and map-api are mocked to throw if anything loads
// them. Covers open/close and focus return, a background open, the fallback
// order, Esc, collapse, both height rules (a pane's defaultMinPx and the
// Route floor) with and without a prior grip resize, and the restore order —
// Ask, Visualize, the table's prepare then start, then the pane in view —
// including a visitor act meanwhile (moved()), a pending size prompt and a
// table chunk that fails to load (its table stays in tm-drawer).
// Deps: drawer.ts, test-drawer-env.ts, state.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TableSnapshot } from './drawer-snapshot.js';

vi.mock('tabulator-tables', () => { throw new Error('the shell loaded Tabulator'); });
vi.mock('../query/dataset-query.js', () => { throw new Error('the shell loaded dataset-query'); });
vi.mock('../map-api.js', () => { throw new Error('the shell loaded map-api'); });

type D = typeof import('./drawer.js');
let d: D;
let canvas: HTMLCanvasElement;

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const drawer = () => q('.table-drawer');
const inView = () => q('.td-tab[aria-selected="true"]')?.id ?? null;
const height = () => drawer().style.height;
const button = (label = 'opener') => {
  const b = document.createElement('button');
  b.textContent = label;
  document.body.append(b);
  b.focus();
  return b;
};
const esc = (target: Element = drawer()) => {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
};
const gripUp = () => q('.td-grip').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));

/** A stand-in for ui-table.ts: open/closed, its own opener, a focus target, a size prompt flag. */
function fakeTable() {
  let open = false;
  let opener: HTMLElement | null = null;
  const log: string[] = [];
  const t = {
    log,
    sizePending: false,
    get open() { return open; },
    show() {
      if (!open) { const a = document.activeElement as HTMLElement | null; opener = a && a !== document.body ? a : null; }
      d.panel('table');
      open = true;
      d.openPane('table');
    },
  };
  d.bindTable({
    isOpen: () => open,
    onShow: () => { log.push('onShow'); },
    focusTarget: () => drawer().querySelector<HTMLElement>('.td-grid'),
    close: () => { open = false; log.push('close'); const b = opener; opener = null; return b; },
    sizePromptPending: () => t.sizePending,
    mount: root => { log.push('mount'); root.querySelector<HTMLElement>('.td-grid')!.tabIndex = 0; },
  });
  return t;
}

beforeEach(async () => {
  vi.resetModules();
  document.body.replaceChildren();
  sessionStorage.clear();
  history.replaceState(null, '', '#3/40/-100');
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' } as unknown as PerformanceEntry]);
  const env = (await import('./test-drawer-env.js')).installDrawerEnv();
  Object.defineProperty(env.container, 'clientHeight', { value: 800, configurable: true });
  canvas = env.canvas;
  const { state } = await import('../state.js');
  Object.assign(state.map!, { loaded: () => true, once: () => {} });
  d = await import('./drawer.js');
});
afterEach(async () => {
  vi.restoreAllMocks();
  (await import('./test-drawer-env.js')).resetDrawerEnv();
});

describe('open, close and focus return', () => {
  it('a pane opens the drawer in view; closing it hides the drawer, runs onClose and returns focus to the opener', () => {
    const from = button();
    const onClose = vi.fn();
    d.openPane('viz', onClose);
    expect(drawer().hidden).toBe(false);
    expect(drawer().classList.contains('td--open')).toBe(true);
    expect(q('.map-container').classList.contains('has-drawer')).toBe(true);
    expect(inView()).toBe('td-tab-viz');
    expect(d.panel('viz').hidden).toBe(false);
    expect(d.paneOpen('viz')).toBe(true);
    d.closePane('viz');
    expect(onClose).toHaveBeenCalledOnce();
    expect(d.paneOpen('viz')).toBe(false);
    expect(drawer().hidden).toBe(true);
    expect(q('.map-container').classList.contains('has-drawer')).toBe(false);
    expect(document.activeElement).toBe(from);
  });

  it('with no opener, focus goes to the map; `from` wins over the focused element', () => {
    d.openPane('line');
    d.closePane('line');
    expect(document.activeElement).toBe(canvas);
    const from = button('from');
    button('other');
    d.openPane('prox', undefined, from);
    d.closePane('prox');
    expect(document.activeElement).toBe(from);
  });

  it('closing a pane with another left focuses that pane\'s tab; the table pane gets onShow and its focus target', () => {
    const tb = fakeTable();
    tb.show();
    expect(tb.log).toEqual(['mount']);
    d.openPane('gops');
    d.closePane('gops');
    expect(inView()).toBe('td-tab');
    expect(tb.log).toContain('onShow');
    expect(document.activeElement).toBe(q('#td-tab'));   // toTab: a side pane's close goes to the tab
    d.openPane('ask');
    d.closePane('ask');
    expect(document.activeElement).toBe(q('.td-grid'));   // Ask's close goes into the table
  });

  it('the table\'s close returns focus to its own opener and hides the drawer', () => {
    const tb = fakeTable();
    const from = button();
    tb.show();
    d.closePane('table');
    expect(tb.log).toEqual(['mount', 'close']);
    expect(drawer().hidden).toBe(true);
    expect(document.activeElement).toBe(from);
  });

  it('mount runs once, when the drawer is built, also for a table bound after the drawer exists', () => {
    d.openPane('ask');
    const tb = fakeTable();
    expect(tb.log).toEqual(['mount']);
    tb.show();
    expect(tb.log).toEqual(['mount']);
  });

  it('headerSlot shows only while Route is in view', () => {
    d.openPane('route');
    expect(d.headerSlot('route').hidden).toBe(false);
    d.openPane('ask');
    expect(d.headerSlot('route').hidden).toBe(true);
  });
});

describe('background open', () => {
  it('with the drawer shown, the pane in view stays in view and focus stays', () => {
    d.openPane('ask');
    const from = button();
    d.openPane('route', undefined, undefined, { background: true });
    expect(inView()).toBe('td-tab-ask');
    expect(q('#td-tab-route').hidden).toBe(false);
    expect(d.panel('route').hidden).toBe(true);
    expect(document.activeElement).toBe(from);
    d.closePane('route');
    expect(document.activeElement).toBe(q('#td-tab-ask'));   // no opener captured: Ask's tab
  });

  it('with the drawer hidden, the pane comes into view', () => {
    d.openPane('route', undefined, undefined, { background: true });
    expect(inView()).toBe('td-tab-route');
  });
});

describe('fallback order', () => {
  it('closing the pane in view brings the table, then Ask, Visualize, Line, Proximity, Grid Ops, Route', () => {
    const tb = fakeTable();
    tb.show();
    for (const p of ['ask', 'viz', 'line', 'prox', 'gops', 'route'] as const) d.openPane(p);
    expect(inView()).toBe('td-tab-route');
    const seen: (string | null)[] = [];
    for (const p of ['route', 'table', 'ask', 'viz', 'line', 'prox'] as const) {
      d.closePane(p);
      seen.push(inView());
    }
    expect(seen).toEqual(['td-tab', 'td-tab-ask', 'td-tab-viz', 'td-tab-line', 'td-tab-prox', 'td-tab-gops']);
    d.closePane('gops');
    expect(drawer().hidden).toBe(true);
  });

  it('the tabs follow the pane order, and only open panes show a tab and its ×', () => {
    d.openPane('route');
    d.openPane('ask');
    expect([...drawer().querySelectorAll('.td-tab')].map(b => b.id))
      .toEqual(['td-tab-ask', 'td-tab', 'td-tab-viz', 'td-tab-line', 'td-tab-prox', 'td-tab-gops', 'td-tab-route']);
    expect([...drawer().querySelectorAll<HTMLElement>('.td-tab')].filter(b => !b.hidden).map(b => b.id)).toEqual(['td-tab-ask', 'td-tab-route']);
    expect([...drawer().querySelectorAll<HTMLElement>('.td-tab-x')].filter(b => !b.hidden).map(b => b.dataset.pane)).toEqual(['ask', 'route']);
    q('.td-tab-x[data-pane="route"]').click();
    expect(d.paneOpen('route')).toBe(false);
  });
});

describe('Esc', () => {
  it('a side pane in view (not Ask) closes', () => {
    d.openPane('ask');
    d.openPane('line');
    expect(esc().defaultPrevented).toBe(true);
    expect(d.paneOpen('line')).toBe(false);
    expect(d.paneOpen('ask')).toBe(true);
  });

  it('Ask in view with the table open: Esc from outside Ask closes the table, from inside Ask closes Ask', () => {
    const tb = fakeTable();
    tb.show();
    d.openPane('ask');
    esc(q('#td-tab-ask'));
    expect(tb.open).toBe(false);
    expect(d.paneOpen('ask')).toBe(true);
    tb.show();
    d.openPane('ask');
    const inAsk = document.createElement('input');
    d.panel('ask').append(inAsk);
    esc(inAsk);
    expect(d.paneOpen('ask')).toBe(false);
    expect(tb.open).toBe(true);
  });

  it('Ask with no table closes; the table closes even with Route behind it; Route goes last', () => {
    d.openPane('ask');
    esc();
    expect(d.paneOpen('ask')).toBe(false);
    const tb = fakeTable();
    d.openPane('route');
    tb.show();
    esc();
    expect(tb.open).toBe(false);
    expect(d.paneOpen('route')).toBe(true);
    esc();
    expect(d.paneOpen('route')).toBe(false);
  });

  it('an Esc already handled is left alone', () => {
    d.openPane('viz');
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    ev.preventDefault();
    drawer().dispatchEvent(ev);
    expect(d.paneOpen('viz')).toBe(true);
  });
});

describe('collapse', () => {
  it('the collapse button folds the drawer to its head and back to the height it had', () => {
    d.openPane('viz');
    expect(height()).toBe('410px');
    q('.td-collapse').click();
    expect(drawer().classList.contains('td--min')).toBe(true);
    expect(height()).toBe('');
    expect(q('.td-collapse').getAttribute('aria-expanded')).toBe('false');
    expect(q('.td-collapse').dataset.i18nAriaLabel).toBe('table.expand');
    expect(q('.td-collapse').textContent).toBe('▴');
    q('.td-collapse').click();
    expect(drawer().classList.contains('td--min')).toBe(false);
    expect(height()).toBe('410px');
  });

  it('opening a pane expands a collapsed drawer', () => {
    d.openPane('ask');
    q('.td-collapse').click();
    d.openPane('line');
    expect(drawer().classList.contains('td--min')).toBe(false);
  });
});

describe('height rules', () => {
  it('defaultMinPx: the table and Ask open at the layout default; a tall pane lifts it to 410 px while open', () => {
    const tb = fakeTable();
    tb.show();
    expect(height()).toBe('320px');   // 40 % of 800, up to 320
    d.openPane('viz');
    expect(height()).toBe('410px');
    d.closePane('viz');
    expect(height()).toBe('410px');   // a close does not recompute
    tb.show();
    expect(height()).toBe('320px');   // the table's open does
  });

  it('defaultMinPx after a grip resize: the resize wins', () => {
    const tb = fakeTable();
    tb.show();
    gripUp();
    expect(height()).toBe('344px');
    d.openPane('viz');
    expect(height()).toBe('344px');
  });

  it('the Route floor wins over the default and is dropped on Route\'s close', () => {
    d.setPaneFloor('route', 540);
    d.openPane('route');
    expect(height()).toBe('540px');
    d.setPaneFloor('route', 0);
    expect(height()).toBe('410px');
    d.setPaneFloor('route', 540);
    d.openPane('ask');
    d.closePane('route');
    expect(height()).toBe('320px');   // floor off, no tall pane left
  });

  it('the Route floor after a grip resize: the floor wins, and the resize comes back once it is off', () => {
    d.openPane('route');
    gripUp();
    expect(height()).toBe('434px');
    d.setPaneFloor('route', 540);
    expect(height()).toBe('540px');
    d.setPaneFloor('route', 0);
    expect(height()).toBe('434px');
  });

  it('compact screens take no defaultMinPx', async () => {
    (await import('./test-drawer-env.js')).installDrawerEnv({ compact: true });
    d.openPane('viz');
    expect(height()).toBe('640px');   // the env answers every query: a short screen's 80 % of 800
  });
});

describe('restoreDrawer', () => {
  const TABLE: TableSnapshot = { req: { layerId: 'osm-substations-points' }, barFilter: null, shown: [], checked: [], active: null, scrollTop: 0 };
  const put = (data: Record<string, unknown>) => sessionStorage.setItem('tm-drawer', JSON.stringify({
    v: 1, hash: location.hash, at: 1,
    data: { v: 1, ask: false, table: null, pane: 'table', frac: 0, collapsed: false, ...data },
  }));

  function resume(tb: ReturnType<typeof fakeTable>, log: string[], over: {
    prepare?: () => Promise<boolean>; start?: () => void; ask?: () => void;
  } = {}) {
    return {
      ask: async () => { log.push('ask'); d.openPane('ask'); over.ask?.(); },
      viz: async () => { log.push('viz'); d.openPane('viz'); },
      table: {
        prepare: async () => { log.push('prepare'); return over.prepare ? over.prepare() : true; },
        start: async () => { log.push(`start:${inView()}`); tb.show(); over.start?.(); },
      },
    };
  }

  it('Ask, Visualize, prepare, start, then the pane in view, collapse and height; the restore\'s opens are not the visitor\'s', async () => {
    put({ ask: true, viz: { layer: null, cards: [] }, table: TABLE, pane: 'ask', frac: 0.5, collapsed: true });
    const tb = fakeTable();
    const log: string[] = [];
    await d.restoreDrawer(resume(tb, log));
    expect(log).toEqual(['ask', 'viz', 'prepare', 'start:td-tab-viz']);
    expect(tb.open).toBe(true);
    expect(inView()).toBe('td-tab-ask');   // start put the table in view; the snapshot's pane wins after it
    expect(drawer().classList.contains('td--min')).toBe(true);
    q('.td-collapse').click();
    expect(height()).toBe('400px');   // frac 0.5 of 800
  });

  it('no table in the snapshot: prepare is never called', async () => {
    put({ ask: true, pane: 'ask' });
    const tb = fakeTable();
    const log: string[] = [];
    await d.restoreDrawer(resume(tb, log));
    expect(log).toEqual(['ask']);
    expect(inView()).toBe('td-tab-ask');
  });

  it('prepare false: no start, but the pane and collapse still apply', async () => {
    put({ ask: true, table: TABLE, pane: 'table', collapsed: true });
    const tb = fakeTable();
    const log: string[] = [];
    await d.restoreDrawer(resume(tb, log, { prepare: async () => false }));
    expect(log).toEqual(['ask', 'prepare']);
    expect(inView()).toBe('td-tab-ask');
    expect(drawer().classList.contains('td--min')).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('tm-drawer')!).data).toMatchObject({ ask: true, table: null });
  });

  it('prepare rejects (the table chunk failed): Ask restores, and tm-drawer keeps the table, its pane and collapse until the visitor acts', async () => {
    put({ ask: true, table: TABLE, pane: 'table', collapsed: true });
    const tb = fakeTable();
    const log: string[] = [];
    await d.restoreDrawer(resume(tb, log, { prepare: async () => { throw new Error('table chunk'); } }));
    expect(log).toEqual(['ask', 'prepare']);
    expect(inView()).toBe('td-tab-ask');
    const saved = () => JSON.parse(sessionStorage.getItem('tm-drawer') ?? 'null')?.data;
    window.dispatchEvent(new Event('pagehide'));
    expect(saved()).toMatchObject({ ask: true, table: TABLE, pane: 'table', collapsed: true });
    d.noteVisitorAct();
    window.dispatchEvent(new Event('pagehide'));
    expect(saved()).toMatchObject({ ask: true, table: null, pane: 'ask' });
  });

  it('prepare rejects after a visitor act: the visitor\'s drawer stands and the table is not kept', async () => {
    put({ ask: true, table: TABLE, pane: 'table' });
    const tb = fakeTable();
    await d.restoreDrawer(resume(tb, [], { prepare: async () => { d.openPane('line'); throw new Error('table chunk'); } }));
    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(sessionStorage.getItem('tm-drawer')!).data).toMatchObject({ ask: true, table: null });
  });

  it('moved(): a visitor act while prepare waits leaves the table, the pane and the collapse alone', async () => {
    put({ ask: true, table: TABLE, pane: 'ask', collapsed: true });
    const tb = fakeTable();
    const log: string[] = [];
    await d.restoreDrawer(resume(tb, log, { prepare: async () => { d.openPane('line'); return true; } }));
    expect(log).toEqual(['ask', 'prepare']);
    expect(tb.open).toBe(false);
    expect(inView()).toBe('td-tab-line');
    expect(drawer().classList.contains('td--min')).toBe(false);
  });

  it('a visitor\'s open during the Ask step (not Ask itself) is an act: the restore gives way', async () => {
    put({ ask: true, table: TABLE, pane: 'ask' });
    const tb = fakeTable();
    const log: string[] = [];
    await d.restoreDrawer(resume(tb, log, { ask: () => d.openPane('viz') }));
    expect(log).toEqual(['ask', 'prepare']);
  });

  it('a pending size prompt keeps the table in view', async () => {
    put({ ask: true, table: TABLE, pane: 'ask' });
    const tb = fakeTable();
    const log: string[] = [];
    await d.restoreDrawer(resume(tb, log, { start: () => { tb.sizePending = true; } }));
    expect(inView()).toBe('td-tab');
  });

  it('a bad snapshot is removed and nothing is built', async () => {
    sessionStorage.setItem('tm-drawer', JSON.stringify({ v: 1, hash: location.hash, at: 1, data: { v: 99 } }));
    const tb = fakeTable();
    await d.restoreDrawer(resume(tb, []));
    expect(sessionStorage.getItem('tm-drawer')).toBeNull();
    expect(document.querySelector('.table-drawer')).toBeNull();
  });
});
