// @vitest-environment jsdom
// Tests for the map chat's route path (ui-route.ts routeForChat): end resolution (exact names,
// ambiguity with candidates, a below-floor note, swapped and outside points, an eastern point),
// the one-end refusal, busy and replaced-by-visitor refusals, Stop cancelling only the chat's own
// solve, prefs left unsaved, Ask staying in view, an index load failure then a retry, and recall.
// Deps: ui-route.js, ui-table.js; route-open.js / map-input.js / layer-data.js / popup.js /
//       maplibre-gl (mocked), test-drawer-env.js, route-tabs/fixture.js, route-prefs.js, state.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RouteRequest, RouteResult } from '../route/route.js';
import type { Outcome } from '../dataset-query.js';

type Call = { req: RouteRequest; res: (o: Outcome<RouteResult>) => void };
const solver = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock('../route/route-open.js', () => ({
  routeLine: vi.fn((req: RouteRequest) => new Promise((res) => solver.calls.push({ req, res }))),
  inspectCell: vi.fn(() => new Promise(() => {})),
  repaintWeight: vi.fn(() => new Promise(() => {})),
  dropWindow: vi.fn(),
  cancelRoute: vi.fn(() => {
    const open = solver.calls.splice(0);
    for (const c of open) c.res({ ok: false, reason: 'cancelled' });
    return open.length > 0;
  }),
}));
vi.mock('../popup.js', () => ({ setRouteTapClaims: vi.fn() }));
vi.mock('../map-input.js', () => ({
  onMapTap: () => () => {}, onMapPoint: () => () => {}, onMapHover: () => () => {}, onMapPointLeave: () => () => {},
}));
vi.mock('maplibre-gl', async () => {
  const Marker = (await import('./test-drawer-env.js')).mockMarker();
  return { Marker, default: { Marker } };
});
const sub = (id: string, name: string, kv: string, st: string, at: [number, number]) =>
  ({ type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { hifld_id: id, name, max_kv: kv, states: `|${st}|`, ba: '' } });
const SUBS = vi.hoisted(() => [] as unknown[]);
const load = vi.hoisted(() => ({ fail: 0, calls: 0 }));
vi.mock('../layers/layer-data.js', async () => {
  const { state } = await import('../state.js');
  const { layerSourceId } = await import('../layers/layer-source.js');
  return {
    loadSource: async () => {
      load.calls++;
      if (load.fail > 0) { load.fail--; throw new Error('offline'); }
      state.sourcesData[layerSourceId('hifld-substations')] = SUBS;
    },
  };
});

import { routeForChat, openRoutePanel, _pane } from './ui-route.js';
import { _resetSubstationIndex } from './substation-index.js';
import { closeRoute, closeAsk, openAsk, askPanel } from './ui-table.js';
import { routeLine, cancelRoute } from '../route/route-open.js';
import { installDrawerEnv, resetDrawerEnv } from './test-drawer-env.js';
import { FIXTURE_RESULT } from './route-tabs/fixture.js';
import { ROUTE_PREFS_KEY } from '../route/route-prefs.js';
import { state } from '../state.js';
import { acceptNotice, forgetNotice, noticeAccepted, ROUTE_NOTICE_VERSION } from './notice-gate.js';

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

function fakeMap(base: Record<string, unknown>) {
  const layers = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, { setData: (d: unknown) => void }>();
  return {
    ...base, layers, sources,
    doubleClickZoom: { enable: vi.fn(), disable: vi.fn() },
    addSource: (id: string) => { sources.set(id, { setData: () => {} }); },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (spec: Record<string, unknown>) => { layers.set(spec.id as string, spec); },
    getLayer: (id: string) => layers.get(id),
    setPaintProperty: () => {},
    removeLayer: (id: string) => { layers.delete(id); },
    queryRenderedFeatures: () => [],
    once: vi.fn(),
    triggerRepaint: vi.fn(),
  };
}
let map: ReturnType<typeof fakeMap>;

beforeEach(() => {
  _resetSubstationIndex();
  acceptNotice('route', ROUTE_NOTICE_VERSION);
  const env = installDrawerEnv();
  map = fakeMap(env.map as unknown as Record<string, unknown>);
  state.map = map as unknown as typeof state.map;
  state.sourcesData = {};
  state.routePick = false;
  solver.calls.length = 0;
  load.fail = 0;
  load.calls = 0;
  SUBS.splice(0, SUBS.length,
    sub('1', 'MIDWAY', '500', 'CA', [-119.40, 35.40]),
    sub('2', 'MIDWAY-SUNSET', '230', 'CA', [-119.50, 35.20]),
    sub('3', 'Twin', '345', 'TX', [-97.0, 31.0]),
    sub('4', 'Twin', '345', 'TX', [-98.0, 32.0]),
    sub('5', 'Lowly', '69', 'OR', [-120.0, 44.0]),
    sub('6', 'Hemingway', '500', 'ID', [-116.80, 43.20]),
    sub('7', 'Split', '500', 'NV', [-117.0, 39.0]),
    sub('8', 'Split', '69', 'NV', [-117.5, 39.5]),
  );
  vi.mocked(routeLine).mockClear();
  vi.mocked(cancelRoute).mockClear();
  localStorage.removeItem(ROUTE_PREFS_KEY);
});
afterEach(() => { closeRoute(); closeAsk(); resetDrawerEnv(); localStorage.removeItem(ROUTE_PREFS_KEY); });

/** Start a chat route and wait for its routeLine call. */
async function started(req: Parameters<typeof routeForChat>[0], signal?: AbortSignal) {
  const out = routeForChat(req, signal);
  await flush();
  return { out };   // wrapped: an async function would otherwise wait for the route itself
}
const answer = async (result: RouteResult = FIXTURE_RESULT) => { solver.calls[0].res({ ok: true, result }); await flush(); };
const refusal = (o: Outcome<unknown>) => (o.ok ? '' : o.reason);

describe('routeForChat: ends', () => {
  it('an exact name places that substation (not the substring sibling) and returns the summary', async () => {
    const { out } = await started({ from: 'midway', to: 'Hemingway' });
    expect(solver.calls).toHaveLength(1);
    expect(solver.calls[0].req).toMatchObject({ from: [-119.40, 35.40], to: [-116.80, 43.20], profile: true, alternatives: 0, surface: false, terminals: ['position', 'position'] });
    await answer();
    const o = await out;
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.result.a).toMatchObject({ name: 'MIDWAY', kv: 500 });
    expect(o.result.b.name).toBe('Hemingway');
    expect(o.result.notes.at(-1)).toMatch(/rough early estimate/);
  });

  it('no exact match refuses with ≤ 5 candidates and never solves', async () => {
    const o = await routeForChat({ from: 'Mid', to: 'Hemingway' });
    expect(refusal(o)).toMatch(/ambiguous end A/);
    expect(refusal(o)).toContain('MIDWAY (500 kV, CA)');
    expect(refusal(o)).toContain('MIDWAY-SUNSET (230 kV, CA)');
    expect(routeLine).not.toHaveBeenCalled();
  });

  it('a name shared by several substations is ambiguous', async () => {
    const o = await routeForChat({ from: 'Hemingway', to: 'twin' });
    expect(refusal(o)).toMatch(/ambiguous end B "twin": 2 substations have this name/);
    expect(refusal(o).match(/Twin \(345 kV, TX\)/g)).toHaveLength(2);
    expect(routeLine).not.toHaveBeenCalled();
  });

  it('two exact matches are ambiguous even when only one is at or above the floor', async () => {
    const o = await routeForChat({ from: 'Split', to: 'Hemingway' });
    expect(refusal(o)).toMatch(/ambiguous end A "Split": 2 substations have this name/);
    expect(routeLine).not.toHaveBeenCalled();
  });

  it('a single exact match below the floor is used, with a note', async () => {
    const { out } = await started({ from: 'Lowly', to: 'Hemingway' });
    expect(solver.calls[0].req.from).toEqual([-120.0, 44.0]);
    expect(solver.calls[0].req.terminals).toEqual(['new', 'position']);   // a 69 kV end gets a new station, never a line position
    await answer();
    const o = await out;
    expect(o.ok && o.result.notes.some((n) => /end A: the substation is below the line type's kV/.test(n))).toBe(true);
  });

  it('refuses swapped and outside points, accepts an eastern point', async () => {
    expect(refusal(await routeForChat({ from: [35.4, -119.4], to: 'Hemingway' }))).toMatch(/\[lng, lat\]/);
    expect(refusal(await routeForChat({ from: [-150, 60], to: 'Hemingway' }))).toMatch(/outside the contiguous US/);
    expect(routeLine).not.toHaveBeenCalled();
    const { out } = await started({ from: [-77, 39], to: 'Hemingway' });
    expect(solver.calls[0].req.from).toEqual([-77, 39]);
    await answer();
    expect((await out).ok).toBe(true);
  });

  it('refuses exactly one end, and an unknown line type with the valid ids', async () => {
    expect(refusal(await routeForChat({ from: 'MIDWAY' }))).toMatch(/both from and to/);
    expect(refusal(await routeForChat({ from: 'MIDWAY', to: 'Hemingway', lineType: 'ac999' }))).toMatch(/ac500.*ac345/);
    expect(routeLine).not.toHaveBeenCalled();
  });

  it('a failed substation load is a refusal, and the next call retries', async () => {
    load.fail = 1;
    expect(refusal(await routeForChat({ from: 'MIDWAY', to: 'Hemingway' }))).toMatch(/could not be loaded/);
    const { out } = await started({ from: 'MIDWAY', to: 'Hemingway' });
    expect(load.calls).toBe(2);
    expect(solver.calls).toHaveLength(1);
    await answer();
    expect((await out).ok).toBe(true);
  });
});

describe('routeForChat: solving', () => {
  it('refuses while a solve is running', async () => {
    void started({ from: 'MIDWAY', to: 'Hemingway' });
    await flush();
    expect(refusal(await routeForChat({ from: 'Lowly', to: 'Hemingway' }))).toMatch(/being solved/);
    expect(solver.calls).toHaveLength(1);
  });

  it('a visitor solve replacing the chat call is a refusal; Stop then cancels nothing', async () => {
    const ctl = new AbortController();
    const { out } = await started({ from: 'MIDWAY', to: 'Hemingway' }, ctl.signal);
    const visitor = _pane()!.ctx.resolve(null);   // the visitor's Re-solve
    expect(refusal(await out)).toBe('the visitor started another route');
    vi.mocked(cancelRoute).mockClear();
    ctl.abort();
    expect(cancelRoute).not.toHaveBeenCalled();
    solver.calls[0].res({ ok: true, result: FIXTURE_RESULT });
    await visitor;
  });

  it('Stop cancels the chat\'s own solve', async () => {
    const ctl = new AbortController();
    const { out } = await started({ from: 'MIDWAY', to: 'Hemingway' }, ctl.signal);
    ctl.abort();
    expect(cancelRoute).toHaveBeenCalledTimes(1);
    expect(refusal(await out)).toBe('cancelled');
  });

  it('alternatives are capped at 2 and do not touch the saved prefs', async () => {
    const { out } = await started({ from: 'MIDWAY', to: 'Hemingway', lineType: 'ac345', alternatives: 5 });
    expect(solver.calls[0].req.lineType).toBe('ac345');
    await answer();
    expect(solver.calls).toHaveLength(2);
    expect(solver.calls[1].req).toMatchObject({ alternatives: 2, surface: true });
    solver.calls[1].res({ ok: true, result: { ...FIXTURE_RESULT, alternatives: FIXTURE_RESULT.alternatives ?? [] } });
    await flush();
    expect((await out).ok).toBe(true);
    expect(localStorage.getItem(ROUTE_PREFS_KEY)).toBeNull();
    expect(_pane()!.session.inputs.lineType).toBe('ac345');
  });

  it('the chat\'s line type is not saved by a later visitor change; the visitor\'s own pick is', async () => {
    const { out } = await started({ from: 'MIDWAY', to: 'Hemingway', lineType: 'ac345' });
    await answer();
    expect((await out).ok).toBe(true);
    const ctx = _pane()!.ctx;
    ctx.setColourMode(ctx.session.colour === 'plain' ? 'cost' : 'plain');
    const saved = JSON.parse(localStorage.getItem(ROUTE_PREFS_KEY)!);
    expect(saved.lineType).not.toBe('ac345');
    const btn = (id: string) => document.querySelector<HTMLButtonElement>(`.ri-seg-btn[data-id="${id}"]`)!;
    btn(saved.lineType).click();
    btn('ac345').click();
    expect(JSON.parse(localStorage.getItem(ROUTE_PREFS_KEY)!).lineType).toBe('ac345');
  });

  it('opens Route in the background: Ask stays in view and keeps focus, the route is on the map', async () => {
    openAsk();
    const input = document.createElement('input');
    askPanel().append(input);
    input.focus();
    const { out } = await started({ from: 'MIDWAY', to: 'Hemingway' });
    expect(document.querySelector<HTMLElement>('#td-ask')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#td-route')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#td-tab-route')!.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    await answer();
    expect((await out).ok).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(document.querySelector<HTMLElement>('#td-ask')!.hidden).toBe(false);
    expect([...map.layers.keys()].some((id) => id.startsWith('rp-route'))).toBe(true);
  });

  it('no arguments: refuses before a route, then recalls the shown one (a visitor\'s too)', async () => {
    expect(refusal(await routeForChat({}))).toBe('no route yet');
    openRoutePanel();
    expect(refusal(await routeForChat({}))).toBe('no route yet');
    const { out } = await started({ from: 'MIDWAY', to: 'Hemingway' });
    await answer();
    const first = await out;
    const again = await routeForChat({});
    expect(again).toEqual(first);
  });

  it('no arguments while a solve is running refuses as busy', async () => {
    const { out } = await started({ from: 'MIDWAY', to: 'Hemingway' });
    await answer();
    await out;
    void started({ from: 'MIDWAY', to: 'Hemingway' });
    await flush();
    expect(refusal(await routeForChat({}))).toMatch(/being solved/);
  });
});

describe('route usage notice', () => {
  beforeEach(() => { forgetNotice('route'); document.querySelectorAll('dialog').forEach((d) => d.remove()); });
  const dlg = () => document.querySelector<HTMLDialogElement>('dialog.disclaimer-dialog');

  it('routeForChat shows the notice first; Cancel refuses, builds no pane and solves nothing', async () => {
    const out = routeForChat({ from: 'MIDWAY', to: 'Hemingway' });
    await flush();
    expect(dlg()).not.toBeNull();
    expect(_pane()).toBeUndefined();
    dlg()!.querySelectorAll('button')[0].click();
    expect(refusal(await out)).toBe('the visitor declined the route usage notice; no route was planned');
    expect(_pane()).toBeUndefined();
    expect(routeLine).not.toHaveBeenCalled();
    expect(noticeAccepted('route', ROUTE_NOTICE_VERSION)).toBe(false);
  });

  it('routeForChat: accepting the notice opens the pane in the background and solves', async () => {
    const out = routeForChat({ from: 'midway', to: 'Hemingway' });
    await flush();
    dlg()!.querySelectorAll('button')[1].click();
    await flush();
    expect(_pane()).toBeDefined();
    expect(solver.calls).toHaveLength(1);
    await answer();
    expect((await out).ok).toBe(true);
  });

  it('routeForChat: a call stopped while the notice is open refuses and leaves the notice unaccepted', async () => {
    const ac = new AbortController();
    const out = routeForChat({ from: 'midway', to: 'Hemingway' }, ac.signal);
    await flush();
    ac.abort();
    dlg()!.querySelectorAll('button')[1].click();
    expect(refusal(await out)).toBe('cancelled');
    expect(_pane()).toBeUndefined();
    expect(noticeAccepted('route', ROUTE_NOTICE_VERSION)).toBe(false);
  });

  it('routeForChat recalling with no ends and no pane asks nothing', async () => {
    expect(refusal(await routeForChat({}))).toBe('no route yet');
    expect(dlg()).toBeNull();
  });

  it('openRoutePanel shows the notice; Cancel opens no pane', async () => {
    openRoutePanel();
    await flush();
    expect(dlg()).not.toBeNull();
    dlg()!.querySelectorAll('button')[0].click();
    await flush();
    expect(dlg()).toBeNull();
    expect(_pane()).toBeUndefined();
    expect(noticeAccepted('route', ROUTE_NOTICE_VERSION)).toBe(false);
  });

  it('accepting opens the pane and the chat path then works, until the pane closes, then asks again', async () => {
    openRoutePanel();
    await flush();
    dlg()!.querySelectorAll('button')[1].click();
    await flush();
    expect(_pane()).toBeDefined();
    expect(localStorage.getItem('tm-notice-route')).toBeNull();
    const { out } = await started({ from: 'midway', to: 'Hemingway' });
    expect(solver.calls).toHaveLength(1);
    await answer();
    expect((await out).ok).toBe(true);
    closeRoute();
    void routeForChat({ from: 'MIDWAY', to: 'Hemingway' });
    await flush();
    expect(dlg()).not.toBeNull();
  });
});
