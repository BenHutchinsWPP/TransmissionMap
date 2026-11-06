// @vitest-environment jsdom
// Characterization of the bottom drawer's panes (ui-table.ts), one row per pane
// (table, Ask, Visualize, Line, Proximity, Grid Ops, Route) for each rule the
// pane code carries: what is open and in view, where focus goes on close, the
// opener captured only while closed, act() and the resuming flags (observed
// through restoreDrawer: an act() makes the restore give way), the default
// height and applyHeight, the Escape choice, the pane orders (tabs, fallback),
// what the tm-drawer snapshot keeps, the "chatting" rule of Show in table, and
// onClose replaced (not kept) by a re-open. These pin today's behaviour so the
// panes can share one record; they are not a statement that every rule is ideal.
// Deps: ui-table.js (dataset-query.js describe scripted), test-drawer-env.js.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import {
  openAsk, closeAsk, askPanel, openViz, closeViz, openLine, closeLine, openProx, closeProx,
  openGops, closeGops, openRoute, closeRoute, routePanel, setRouteTall, showTable, closeTable,
  registerVizSnapshot, drawerChanged, vizOpen, lineOpen, proxOpen, gopsOpen, routeOpen,
} from './ui-table.js';
import { installDrawerEnv, resetDrawerEnv, type DrawerEnv } from './test-drawer-env.js';

const ROWS = [{ id: 1231, props: { name: 'Alpha', nominal_kv: 500 } }];
const FIELDS = [
  { name: 'name', type: 'string', ops: [] },
  { name: 'nominal_kv', type: 'number', ops: ['>='] },
];
vi.mock('../dataset-query.js', async (orig) => ({
  ...(await orig<typeof import('../dataset-query.js')>()),
  describe: (layerId: string) => layerId === 'osm-substations-points'
    ? { ok: true, result: { layerId, queryable: true, kind: 'pmtiles', complete: false, idField: 'fid', fields: FIELDS, credit: 'OSM' } }
    : { ok: false, reason: 'no' },
  count: async () => ({ ok: true, result: { layerId: 'x', complete: false, total: ROWS.length } }),
  aggregate: async () => ({ ok: true, result: { complete: false, total: ROWS.length, groups: [] } }),
  query: async () => ({ ok: true, result: { complete: false, total: ROWS.length, truncated: false, fields: [],
    rows: ROWS.map(r => ({ ...r, feature: { type: 'Feature', properties: r.props, geometry: null } })) } }),
}));
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const drawer = () => q('.table-drawer');
const tabs = () => [...document.querySelectorAll<HTMLElement>('.td-tab')];
const visibleTabs = () => tabs().filter(b => !b.hidden).map(b => b.id);
const selected = () => tabs().filter(b => !b.hidden && b.getAttribute('aria-selected') === 'true').map(b => b.id);
const height = () => drawer().style.height;
const esc = (target: HTMLElement) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const tableTab = () => q('#td-tab');
const openTable = () => showTable({ layerId: 'osm-substations-points' });
const button = () => document.body.appendChild(document.createElement('button'));

type OpenFn = (onClose?: () => void, from?: HTMLElement | null) => void;
interface P { id: string; tab: string; open: OpenFn; close: () => void; isOpen: () => boolean; tall: boolean }
const tabOpen = (tab: string) => () => !q(`#${tab}`).hidden;
const ASK: P = { id: 'ask', tab: 'td-tab-ask', open: openAsk, close: closeAsk, isOpen: tabOpen('td-tab-ask'), tall: false };
const VIZ: P = { id: 'viz', tab: 'td-tab-viz', open: openViz, close: closeViz, isOpen: vizOpen, tall: true };
const LINE: P = { id: 'line', tab: 'td-tab-line', open: openLine, close: closeLine, isOpen: lineOpen, tall: true };
const PROX: P = { id: 'prox', tab: 'td-tab-prox', open: openProx, close: closeProx, isOpen: proxOpen, tall: true };
const GOPS: P = { id: 'gops', tab: 'td-tab-gops', open: openGops, close: closeGops, isOpen: gopsOpen, tall: true };
const ROUTE: P = { id: 'route', tab: 'td-tab-route', open: (cb, from) => openRoute(cb, from), close: closeRoute, isOpen: routeOpen, tall: true };
const PANES = [ASK, VIZ, LINE, PROX, GOPS, ROUTE];

function setVisibility(v: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
}

let env: DrawerEnv;
beforeAll(() => {
  env = installDrawerEnv();
  Object.defineProperty(env.container, 'clientHeight', { value: 800, configurable: true });
  routePanel();   // builds the drawer
  const input = document.createElement('input');
  input.className = 'chat-input';
  askPanel().append(input);
  registerVizSnapshot(() => ({ layer: null, cards: [] }));
});
afterAll(resetDrawerEnv);
afterEach(() => {
  setVisibility('visible');
  for (const p of PANES) p.close();
  closeTable();
  (document.activeElement as HTMLElement | null)?.blur();
  sessionStorage.clear();
  document.querySelectorAll('body > button').forEach(b => b.remove());
});

describe('open, close, which pane is in view', () => {
  for (const p of PANES) {
    it(`${p.id}: alone, its tab is the only one, selected; closing hides the drawer`, () => {
      p.open();
      expect(drawer().hidden).toBe(false);
      expect(visibleTabs()).toEqual([p.tab]);
      expect(selected()).toEqual([p.tab]);
      p.close();
      expect(drawer().hidden).toBe(true);
    });
  }

  it('the last pane opened is in view; closing it falls back table, ask, viz, line, prox, gops, route', async () => {
    ROUTE.open(); GOPS.open(); PROX.open(); LINE.open(); VIZ.open(); ASK.open();
    await openTable();
    expect(visibleTabs()).toEqual(['td-tab-ask', 'td-tab', 'td-tab-viz', 'td-tab-line', 'td-tab-prox', 'td-tab-gops', 'td-tab-route']);   // tab order
    expect(selected()).toEqual(['td-tab']);
    const seen: string[] = [];
    closeTable(); seen.push(selected()[0]);
    ASK.close(); seen.push(selected()[0]);
    VIZ.close(); seen.push(selected()[0]);
    LINE.close(); seen.push(selected()[0]);
    PROX.close(); seen.push(selected()[0]);
    GOPS.close(); seen.push(selected()[0]);
    expect(seen).toEqual(['td-tab-ask', 'td-tab-viz', 'td-tab-line', 'td-tab-prox', 'td-tab-gops', 'td-tab-route']);
    ROUTE.close();
    expect(drawer().hidden).toBe(true);
  });

  it('closing a pane that is not in view leaves the one in view alone', () => {
    ASK.open(); LINE.open();
    ASK.close();
    expect(selected()).toEqual(['td-tab-line']);
  });

  it('closing a pane that is not open does nothing', () => {
    LINE.open();
    for (const p of [ASK, VIZ, PROX, GOPS, ROUTE]) p.close();
    expect(selected()).toEqual(['td-tab-line']);
  });

  it('Route in the background opens its tab but leaves the pane in view, when the drawer is shown', async () => {
    await openTable();
    openRoute(undefined, null, { background: true });
    expect(routeOpen()).toBe(true);
    expect(visibleTabs()).toEqual(['td-tab', 'td-tab-route']);
    expect(selected()).toEqual(['td-tab']);
  });

  it('Route in the background with the drawer hidden comes into view', () => {
    openRoute(undefined, null, { background: true });
    expect(selected()).toEqual(['td-tab-route']);
    expect(drawer().hidden).toBe(false);
  });

  it('a foreground Route open takes the view from the table', async () => {
    await openTable();
    openRoute();
    expect(selected()).toEqual(['td-tab-route']);
  });
});

describe('focus on close', () => {
  for (const p of PANES) {
    it(`${p.id}: back to the opener passed as from`, () => {
      const b = button();
      p.open(undefined, b);
      p.close();
      expect(document.activeElement).toBe(b);
    });

    it(`${p.id}: back to the focused element when from is omitted`, () => {
      const b = button();
      b.focus();
      p.open();
      p.close();
      expect(document.activeElement).toBe(b);
    });

    it(`${p.id}: the opener is captured only while the pane is closed`, () => {
      const b1 = button(), b2 = button();
      p.open(undefined, b1);
      p.open(undefined, b2);
      p.close();
      expect(document.activeElement).toBe(b1);
    });

    it(`${p.id}: an opener inside the drawer is ignored; the map takes focus`, () => {
      p.open(undefined, q('.td-grip'));
      p.close();
      expect(document.activeElement).toBe(env.canvas);
    });

    it(`${p.id}: no opener, drawer empty: the map canvas`, () => {
      p.open();
      p.close();
      expect(document.activeElement).toBe(env.canvas);
    });
  }

  it('Route in the background captures no opener and does not move focus', () => {
    const b = button();
    b.focus();
    openRoute(undefined, null, { background: true });
    expect(document.activeElement).toBe(b);
    closeRoute();
    expect(document.activeElement).toBe(env.canvas);
  });

  it('the table: back to the element focused when it opened', async () => {
    const b = button();
    b.focus();
    await openTable();
    closeTable();
    expect(document.activeElement).toBe(b);
  });

  it('closing Ask with the table behind it focuses the grid, not the tab', async () => {
    await openTable();
    ASK.open();
    ASK.close();
    expect(selected()).toEqual(['td-tab']);
    expect(document.activeElement).not.toBe(tableTab());
    expect(document.activeElement).not.toBe(document.body);
    expect(q('.td-grid').contains(document.activeElement)).toBe(true);
  });

  for (const p of [VIZ, LINE, PROX, GOPS, ROUTE]) {
    it(`closing ${p.id} with the table behind it focuses the table's tab`, async () => {
      await openTable();
      p.open();
      p.close();
      expect(document.activeElement).toBe(tableTab());
    });
  }

  it('closing the table with Ask behind it focuses the chat input', async () => {
    ASK.open();
    await openTable();
    closeTable();
    expect(selected()).toEqual(['td-tab-ask']);
    expect(document.activeElement).toBe(q('.chat-input'));
  });

  it('closing the table with another pane behind it focuses that pane\'s tab', async () => {
    VIZ.open();
    await openTable();
    closeTable();
    expect(document.activeElement).toBe(q('#td-tab-viz'));
  });

  it('closing a pane with Ask behind it focuses Ask\'s tab (toTab), not the chat input', () => {
    ASK.open();
    LINE.open();
    LINE.close();
    expect(document.activeElement).toBe(q('#td-tab-ask'));
  });

  it('the opener wins over the pane left behind', async () => {
    await openTable();
    const b = button();
    VIZ.open(undefined, b);
    VIZ.close();
    expect(document.activeElement).toBe(b);
  });
});

describe('onClose', () => {
  for (const p of PANES) {
    it(`${p.id}: runs once on close`, () => {
      const cb = vi.fn();
      p.open(cb);
      expect(cb).not.toHaveBeenCalled();
      p.close();
      expect(cb).toHaveBeenCalledOnce();
    });

    it(`${p.id}: re-opening without a callback clears the old one`, () => {
      const cb = vi.fn();
      p.open(cb);
      p.open();
      p.close();
      expect(cb).not.toHaveBeenCalled();
    });

    it(`${p.id}: re-opening with another callback replaces the old one`, () => {
      const a = vi.fn(), b = vi.fn();
      p.open(a);
      p.open(b);
      p.close();
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledOnce();
    });
  }

  it('Route: a background re-open without a callback clears it too', () => {
    const cb = vi.fn();
    openRoute(cb);
    openRoute(undefined, null, { background: true });
    closeRoute();
    expect(cb).not.toHaveBeenCalled();
  });

  it('the pane is already closed, and the drawer still shown, when onClose runs; then the drawer hides', () => {
    const seen: Record<string, [boolean, boolean]> = {};
    const flag: Record<string, () => boolean> = { viz: vizOpen, line: lineOpen, prox: proxOpen, gops: gopsOpen, route: routeOpen };
    for (const p of [VIZ, LINE, PROX, GOPS, ROUTE]) {
      p.open(() => { seen[p.id] = [flag[p.id](), drawer().hidden === true]; });
      p.close();
      expect(drawer().hidden).toBe(true);
    }
    expect(seen).toEqual({ viz: [false, false], line: [false, false], prox: [false, false], gops: [false, false], route: [false, false] });
  });

  it('Route: the tall setting is already off when onClose runs', () => {
    let during = '';
    openRoute(() => { during = height(); });
    setRouteTall(true);
    expect(height()).toBe('540px');
    closeRoute();
    expect(during).not.toBe('540px');
  });
});

describe('default height and applyHeight', () => {
  it('the table opens at the plain default (40 % of 800 px, up to 320)', async () => {
    await openTable();
    expect(height()).toBe('320px');
  });

  it('Ask from a closed drawer opens at the plain default', () => {
    ASK.open();
    expect(height()).toBe('320px');
  });

  for (const p of [VIZ, LINE, PROX, GOPS, ROUTE]) {
    it(`${p.id} from a closed drawer opens taller (410 px)`, () => {
      p.open();
      expect(height()).toBe('410px');
    });

    it(`${p.id} over the table raises the drawer to 410 px`, async () => {
      await openTable();
      expect(height()).toBe('320px');
      p.open();
      expect(height()).toBe('410px');
    });
  }

  it('Ask never recomputes the height (a drawer already showing keeps what it has)', async () => {
    await openTable();
    VIZ.open();
    expect(height()).toBe('410px');
    VIZ.close();
    expect(height()).toBe('410px');   // closing a tall pane (not Route) does not recompute
    ASK.open();
    expect(height()).toBe('410px');   // ... and opening Ask does not either
  });

  it('Route recomputes on close (setRouteTall(false) reapplies the height)', async () => {
    await openTable();
    ROUTE.open();
    expect(height()).toBe('410px');
    ROUTE.close();
    expect(height()).toBe('320px');
  });

  it('the table\'s open() applies the height, which stays tall while a tall pane is open', async () => {
    LINE.open();
    expect(height()).toBe('410px');
    await openTable();
    expect(height()).toBe('410px');   // the tall pane is still open
  });
});

describe('Escape', () => {
  for (const p of [VIZ, LINE, PROX, GOPS, ROUTE]) {
    it(`${p.id} in view: Esc closes it alone, whatever else is open`, async () => {
      await openTable();
      ASK.open();
      p.open();
      esc(q('.td-tabs'));
      expect(p.isOpen()).toBe(false);
      expect(visibleTabs()).toEqual(['td-tab-ask', 'td-tab']);
    });
  }

  it('Ask in view with the table open and focus outside Ask: Esc closes the table', async () => {
    await openTable();
    ASK.open();
    expect(selected()).toEqual(['td-tab-ask']);
    esc(q('.td-tabs'));
    expect(visibleTabs()).toEqual(['td-tab-ask']);
  });

  it('Esc from inside Ask closes Ask, not the table', async () => {
    await openTable();
    ASK.open();
    esc(q('.chat-input'));
    expect(visibleTabs()).toEqual(['td-tab']);
  });

  it('Ask with no table: Esc closes Ask', () => {
    ASK.open();
    esc(q('.td-tabs'));
    expect(drawer().hidden).toBe(true);
  });

  it('Ask with Route open and no table: Esc closes Ask', () => {
    ROUTE.open();
    ASK.open();
    esc(q('.td-tabs'));
    expect(visibleTabs()).toEqual(['td-tab-route']);
  });

  it('the table in view: Esc closes the table, Ask and Route stay', async () => {
    ASK.open();
    ROUTE.open();
    await openTable();
    expect(selected()).toEqual(['td-tab']);
    esc(q('.td-tabs'));
    expect(visibleTabs()).toEqual(['td-tab-ask', 'td-tab-route']);
  });

  it('the table in view with Route behind it: Esc closes the table', async () => {
    ROUTE.open();
    await openTable();
    esc(q('.td-tabs'));
    expect(visibleTabs()).toEqual(['td-tab-route']);
  });

  it('Esc already handled is left alone', () => {
    LINE.open();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    ev.preventDefault();
    q('.td-tabs').dispatchEvent(ev);
    expect(lineOpen()).toBe(true);
  });
});

describe('Show in table while the chat has focus', () => {
  it('focus in Ask: the table opens behind Ask, which stays in view and keeps focus', async () => {
    ASK.open();
    const input = q<HTMLInputElement>('.chat-input');
    input.focus();
    await openTable();
    expect(visibleTabs()).toEqual(['td-tab-ask', 'td-tab']);
    expect(selected()).toEqual(['td-tab-ask']);
    expect(document.activeElement).toBe(input);
  });

  it('focus elsewhere: the table comes into view', async () => {
    ASK.open();
    await openTable();
    expect(selected()).toEqual(['td-tab']);
    expect(document.activeElement).not.toBe(q('.chat-input'));
  });

  it('focus in the Ask panel but Ask closed: the table comes into view', async () => {
    q<HTMLInputElement>('.chat-input').focus();
    await openTable();
    expect(selected()).toEqual(['td-tab']);
  });

  it('focus in Ask with Route open: Ask stays in view (the table does not take it)', async () => {
    ROUTE.open();
    ASK.open();
    q<HTMLInputElement>('.chat-input').focus();
    await openTable();
    expect(selected()).toEqual(['td-tab-ask']);
  });
});

describe('the tm-drawer snapshot', () => {
  const saved = () => {
    setVisibility('hidden');
    drawerChanged();
    const raw = sessionStorage.getItem('tm-drawer');
    return raw ? JSON.parse(raw).data as { ask: boolean; pane: string; table: unknown; viz?: unknown } : null;
  };

  for (const p of [LINE, PROX, GOPS, ROUTE]) {
    it(`${p.id} alone: nothing is kept`, () => {
      p.open();
      expect(saved()).toBeNull();
    });
  }

  it('Ask alone: kept, Ask in view', () => {
    ASK.open();
    expect(saved()).toMatchObject({ ask: true, pane: 'ask', table: null });
  });

  it('Visualize alone: kept with its part, in view', () => {
    VIZ.open();
    const s = saved()!;
    expect(s.pane).toBe('viz');
    expect(s.viz).toEqual({ layer: null, cards: [] });
    expect(s.ask).toBe(false);
  });

  it('the table: kept, in view', async () => {
    await openTable();
    const s = saved()!;
    expect(s.pane).toBe('table');
    expect(s.table).not.toBeNull();
    expect(s.ask).toBe(false);
  });

  for (const p of [LINE, PROX, GOPS, ROUTE]) {
    it(`${p.id} in view over the table and Ask: the pane kept is the table`, async () => {
      ASK.open();
      await openTable();
      p.open();
      expect(selected()).toEqual([p.tab]);
      const s = saved()!;
      expect(s.pane).toBe('table');
      expect(s.ask).toBe(true);
      expect(JSON.stringify(s)).not.toContain(p.id === 'route' ? 'route' : `"${p.id}"`);
    });

    it(`${p.id} in view over Ask and Visualize: the pane kept is Ask`, () => {
      VIZ.open();
      ASK.open();
      p.open();
      expect(saved()!.pane).toBe('ask');
    });

    it(`${p.id} in view over Visualize alone: the pane kept is Visualize`, () => {
      VIZ.open();
      p.open();
      expect(saved()!.pane).toBe('viz');
    });
  }

  it('Visualize in view over Ask: Visualize is kept in view', () => {
    ASK.open();
    VIZ.open();
    expect(saved()!.pane).toBe('viz');
  });

  it('Ask in view over Visualize: Ask is kept in view', () => {
    VIZ.open();
    ASK.open();
    expect(saved()!.pane).toBe('ask');
  });
});

describe('act() and the resuming flags, seen through restoreDrawer', () => {
  type Mods = { t: typeof import('./ui-table.js'); env: typeof import('./test-drawer-env.js') };

  async function load(): Promise<Mods> {
    vi.resetModules();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' } as unknown as PerformanceEntry]);
    document.body.replaceChildren();
    const e = await import('./test-drawer-env.js');
    const { state } = await import('../state.js');
    const ee = e.installDrawerEnv();
    Object.defineProperty(ee.container, 'clientHeight', { value: 800, configurable: true });
    Object.assign(state.map!, { loaded: () => true, once: () => {} });
    return { t: await import('./ui-table.js'), env: e };
  }
  const put = (extra: { ask?: boolean; viz?: unknown }) => sessionStorage.setItem('tm-drawer', JSON.stringify({
    v: 1, hash: location.hash, at: 1, data: {
      v: 1, ask: !!extra.ask, pane: 'table', frac: 0, collapsed: false, ...(extra.viz ? { viz: extra.viz } : {}),
      table: { req: { layerId: 'osm-substations-points' }, barFilter: null, shown: [], checked: [], active: null, scrollTop: 0 },
    },
  }));
  const settle = () => new Promise(r => setTimeout(r, 0));
  const VIZ_PART = { layer: null, cards: [] };

  beforeEach(() => { sessionStorage.clear(); history.replaceState(null, '', '#3/40/-100?l=a'); });
  afterEach(async () => { vi.restoreAllMocks(); (await import('./test-drawer-env.js')).resetDrawerEnv(); });

  /** Whether the table came back after `during` ran inside the restore's Ask (or Visualize) step. */
  async function restored(during: (t: Mods['t']) => void, via: 'ask' | 'viz'): Promise<boolean> {
    put(via === 'ask' ? { ask: true } : { viz: VIZ_PART });
    const { t } = await load();
    const step = async () => { during(t); };
    await (via === 'ask' ? t.restoreDrawer(step) : t.restoreDrawer(async () => {}, step));
    await settle(); await settle();
    return !!document.querySelector<HTMLElement>('.td-tab-name')!.dataset.i18n;   // set only when a table opens
  }

  it('Ask opened by the restore\'s Ask step is not the visitor\'s: the table comes back', async () => {
    expect(await restored(t => t.openAsk(), 'ask')).toBe(true);
  });

  it('Visualize opened by the restore\'s Visualize step is not the visitor\'s: the table comes back', async () => {
    expect(await restored(t => t.openViz(), 'viz')).toBe(true);
  });

  it('Route never calls act(): opened in the restore\'s step, the table comes back', async () => {
    expect(await restored(t => t.openRoute(), 'ask')).toBe(true);
  });

  it('Route opened and closed in the restore\'s step: still no act(), the table comes back', async () => {
    expect(await restored(t => { t.openRoute(); t.closeRoute(); }, 'ask')).toBe(true);
  });

  it('Visualize opened in the Ask step is the visitor\'s (only Ask\'s flag is up): the restore gives way', async () => {
    expect(await restored(t => t.openViz(), 'ask')).toBe(false);
  });

  it('Ask opened in the Visualize step is the visitor\'s (only Visualize\'s flag is up): the restore gives way', async () => {
    expect(await restored(t => t.openAsk(), 'viz')).toBe(false);
  });

  it('Ask opened then closed in the Ask step: closing calls act(), the restore gives way', async () => {
    expect(await restored(t => { t.openAsk(); t.closeAsk(); }, 'ask')).toBe(false);
  });

  it('Visualize opened then closed in its step: closing calls act(), the restore gives way', async () => {
    expect(await restored(t => { t.openViz(); t.closeViz(); }, 'viz')).toBe(false);
  });

  for (const [name, open] of [
    ['Line', (t: Mods['t']) => t.openLine()],
    ['Proximity', (t: Mods['t']) => t.openProx()],
    ['Grid Ops', (t: Mods['t']) => t.openGops()],
  ] as const) {
    it(`${name} calls act() on open: the restore gives way`, async () => {
      expect(await restored(open, 'ask')).toBe(false);
    });
  }

  it('closeTable calls act()', async () => {
    expect(await restored(t => t.closeTable(), 'ask')).toBe(false);
  });

  it('a tab click calls act()', async () => {
    expect(await restored(t => { t.openRoute(); document.querySelector<HTMLElement>('#td-tab-route')!.click(); }, 'ask')).toBe(false);
  });
});
