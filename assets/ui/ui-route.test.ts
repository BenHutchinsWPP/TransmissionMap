// @vitest-environment jsdom
// Tests for the route pane shell: opening shows the inputs, Find builds the request
// from the snapped ends, the progress list follows the worker's steps, stale outcomes
// are dropped, Cancel returns quietly, a refusal shows its reason, a result shows the
// sub-tabs and badge, the colour mode rewrites the route's data, Find alternatives
// merges only the alternatives, closing the pane removes every rp- layer/source, and "List crossings by
// name" keeps its reply only for the shown route (markers move to its points; a refusal is one line, a cancel none).
// Deps: ui-route.js, ui-table.js; route-open.js / map-input.js / layer-data.js /
//       maplibre-gl (mocked), test-drawer-env.js, route-tabs/fixture.js, state.js, i18n.
import { UPLOAD_BUDGET_MSG } from '../route/preset-patch.js';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, onTestFinished } from 'vitest';
import type { RouteRequest, RouteResult, RouteStep } from '../route/route.js';
import type { Outcome } from '../dataset-query.js';

type Call = { req: RouteRequest; onProgress?: (s: RouteStep) => void; res: (o: Outcome<RouteResult>) => void };
const solver = vi.hoisted(() => ({ calls: [] as Call[], inspects: [] as { req: unknown; res: (o: unknown) => void }[], repaints: [] as { req: unknown; res: (o: unknown) => void }[], rows: [] as { req: unknown; res: (o: unknown) => void }[], autoRows: null as null | ((n: number) => unknown), exacts: [] as { req: unknown; res: (o: unknown) => void }[] }));
vi.mock('../route/route-open.js', () => ({
  routeLine: vi.fn((req: RouteRequest, onProgress?: (s: RouteStep) => void) =>
    new Promise((res) => solver.calls.push({ req, onProgress, res }))),
  inspectCell: vi.fn((req: unknown) => new Promise((res) => solver.inspects.push({ req, res }))),
  repaintWeight: vi.fn((req: unknown) => new Promise((res) => solver.repaints.push({ req, res }))),
  repaintRows: vi.fn((req: unknown) => solver.autoRows ? Promise.resolve(solver.autoRows(solver.rows.push({ req, res: () => {} }))) : new Promise((res) => solver.rows.push({ req, res }))),
  exactCrossings: vi.fn((req: unknown) => new Promise((res) => solver.exacts.push({ req, res }))),
  dropWindow: vi.fn(),
  cancelRoute: vi.fn(() => {
    const open = solver.calls.splice(0);
    for (const c of open) c.res({ ok: false, reason: 'cancelled' });
    return open.length > 0;
  }),
}));
const hover = vi.hoisted(() => new Set<(e: unknown) => void>());
const leave = vi.hoisted(() => new Set<() => void>());
const taps = vi.hoisted(() => new Set<(e: unknown) => void>());
vi.mock('../popup.js', () => ({ setRouteTapClaims: vi.fn() }));
const batchMount = vi.hoisted(() => ({ calls: [] as { root: HTMLElement; host: { presetId: string; lineType: string; snapKm: number; close(): void } }[], dispose: vi.fn() }));
vi.mock('./route-batch.js', () => ({
  mountBatch: (root: HTMLElement, host: { presetId: string; lineType: string; snapKm: number; close(): void }) => {
    batchMount.calls.push({ root, host });
    root.replaceChildren(Object.assign(document.createElement('p'), { className: 'fake-batch', textContent: 'batch view' }));
    return { dispose: batchMount.dispose };
  },
}));
vi.mock('../map-input.js', () => ({
  onMapTap: (f: (e: unknown) => void) => { taps.add(f); return () => taps.delete(f); },
  onMapPoint: (f: (e: unknown) => void) => { hover.add(f); return () => hover.delete(f); },
  onMapHover: () => () => {},
  onMapPointLeave: (f: () => void) => { leave.add(f); return () => leave.delete(f); },
}));
vi.mock('maplibre-gl', async () => {
  const Marker = (await import('./test-drawer-env.js')).mockMarker();
  return { Marker, default: { Marker } };
});
const SUBS = vi.hoisted(() => [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-119.30, 45.94] }, properties: { hifld_id: '1', name: 'McNary', max_kv: '500.0', states: '|OR|', ba: '|BPAT|' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-116.80, 43.20] }, properties: { hifld_id: '2', name: 'Hemingway', max_kv: '500.0', states: '|ID|', ba: '|IPCO|' } },
]);
vi.mock('../layers/layer-data.js', async () => {
  const { state } = await import('../state.js');
  const { layerSourceId } = await import('../layers/layer-source.js');
  return { loadSource: async () => { state.sourcesData[layerSourceId('hifld-substations')] = SUBS; } };
});

import { mergePatch } from './route-request.js';
import { openRoutePanel, _pane, routeFeatures, maskSurface, pixelClasses } from './ui-route.js';
import { closeRoute, routePanel, routeActions } from './ui-table.js';
import { routeLine, cancelRoute, inspectCell, repaintWeight, repaintRows, dropWindow, exactCrossings } from '../route/route-open.js';
import { routePreset } from '../../src/registry/route-presets.js';
import { holeAt } from './ui-route.js';
import { setRouteTapClaims } from '../popup.js';
import { installDrawerEnv, resetDrawerEnv } from './test-drawer-env.js';
import { FIXTURE_RESULT } from './route-tabs/fixture.js';
import { SURFACE_PALETTE } from '../route/route.js';
import { state } from '../state.js';
import { loadRoutePrefs, localStorageAdapter, ROUTE_PREFS_KEY } from '../route/route-prefs.js';
import { t, loadRouteStrings } from '../../src/i18n/index.js';
import { on } from '../state-bus.js';
import { acceptNotice, ROUTE_NOTICE_VERSION } from './notice-gate.js';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

interface FakeSource { data: unknown; setData: ReturnType<typeof vi.fn> }
function fakeMap(base: { fitBounds: ReturnType<typeof vi.fn> } & Record<string, unknown>) {
  const layers = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, FakeSource>();
  const order: string[] = [];
  const map = {
    ...base,
    layers, sources, order,
    doubleClickZoom: { enable: vi.fn(), disable: vi.fn() },
    addSource: vi.fn((id: string, spec: { data?: unknown }) => {
      if (sources.has(id)) throw new Error(`source ${id} exists`);
      const s: FakeSource = { data: spec.data, setData: vi.fn((d: unknown) => { s.data = d; }) };
      sources.set(id, s);
    }),
    getSource: (id: string) => sources.get(id),
    removeSource: vi.fn((id: string) => {
      if ([...layers.values()].some((l) => l.source === id)) throw new Error(`source ${id} in use`);
      sources.delete(id);
    }),
    addLayer: vi.fn((spec: Record<string, unknown>, before?: string) => {
      const id = spec.id as string;
      if (layers.has(id)) throw new Error(`layer ${id} exists`);
      if (!sources.has(spec.source as string)) throw new Error(`no source for ${id}`);
      layers.set(id, spec);
      const i = before ? order.indexOf(before) : -1;
      if (i >= 0) order.splice(i, 0, id); else order.push(id);
    }),
    getLayer: (id: string) => layers.get(id),
    setPaintProperty: vi.fn((id: string, prop: string, v: unknown) => { const l = layers.get(id); if (l) l.paint = { ...(l.paint as object), [prop]: v }; }),
    removeLayer: vi.fn((id: string) => { layers.delete(id); order.splice(order.indexOf(id), 1); }),
    queryRenderedFeatures: vi.fn(() => [] as unknown[]),
    once: vi.fn(),
    triggerRepaint: vi.fn(),
  };
  return map;
}
let map: ReturnType<typeof fakeMap>;

beforeEach(() => {
  acceptNotice('route', ROUTE_NOTICE_VERSION);
  const env = installDrawerEnv();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-width: 520px)', media: q, addEventListener() {}, removeEventListener() {} }));   // the Method tab's stacked table (these tests edit its inputs)
  map = fakeMap(env.map as unknown as Parameters<typeof fakeMap>[0]);
  state.map = map as unknown as typeof state.map;
  state.sourcesData = {};
  state.routePick = false;
  solver.calls.length = 0;
  solver.inspects.length = 0;
  solver.repaints.length = 0;
  solver.rows.length = 0;
  solver.autoRows = null;
  solver.exacts.length = 0;
  vi.mocked(exactCrossings).mockClear();
  vi.mocked(inspectCell).mockClear();
  vi.mocked(repaintWeight).mockClear();
  vi.mocked(repaintRows).mockClear();
  vi.mocked(dropWindow).mockClear();
  vi.mocked(routeLine).mockClear();
  vi.mocked(cancelRoute).mockClear();
});
afterEach(() => { closeRoute(); resetDrawerEnv(); localStorage.removeItem(ROUTE_PREFS_KEY); });

const main = () => routePanel().querySelector<HTMLElement>('.rp-main')!;
const findBtn = () => routePanel().querySelector<HTMLButtonElement>('.ri-primary')!;
const rpIds = () => [...map.layers.keys(), ...map.sources.keys()].filter((id) => id.startsWith('rp-'));

async function openWithEnds(): Promise<void> {
  openRoutePanel({ lngLat: [-119.31, 45.95], end: 'A' });
  await flush();
  openRoutePanel({ lngLat: [-116.81, 43.21], end: 'B' });
  await flush();
}
async function solved(result: RouteResult = FIXTURE_RESULT): Promise<void> {
  await openWithEnds();
  findBtn().click();
  solver.calls[0].res({ ok: true, result });
  await flush();
}

describe('route pane shell', () => {
  it('opens with the input column and an idle hint', () => {
    openRoutePanel();
    expect(routePanel().querySelector('.rp-inputs.ri')).not.toBeNull();
    expect(main().textContent).toContain(t('route.idle'));
  });

  it('Find sends the snapped ends, line type and profile:true (no surface, no alternatives)', async () => {
    await openWithEnds();
    expect(findBtn().disabled).toBe(false);
    findBtn().click();
    expect(routeLine).toHaveBeenCalledTimes(1);
    const req = solver.calls[0].req;
    expect(req).toMatchObject({ from: [-119.30, 45.94], to: [-116.80, 43.20], preset: 'tm-default', lineType: 'ac500', profile: true, surface: false, alternatives: 0 });
    expect(cancelRoute).not.toHaveBeenCalled();
    // chord + search area while solving
    expect(map.layers.has('rp-chord')).toBe(true);
    expect(map.layers.has('rp-area-fill')).toBe(true);
  });

  it('shows the five steps and restarts them when "read" comes again', async () => {
    await openWithEnds();
    findBtn().click();
    const steps = () => [...main().querySelectorAll('.rp-step')].map((li) => li.className.replace('rp-step rp-step--', ''));
    expect(main().querySelector('.rp-steps')?.getAttribute('aria-live')).toBe('polite');
    expect(steps()).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    expect(document.activeElement).toBe(main().querySelector('.rp-cancel'));
    const step = solver.calls[0].onProgress!;
    step('read');
    expect(steps()).toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
    step('surfaces'); step('solve');
    expect(steps()).toEqual(['done', 'done', 'active', 'pending', 'pending']);
    step('read');
    expect(steps()).toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
    expect(main().querySelector('.rp-error')).toBeNull();
  });

  it('drops a stale outcome when a newer solve was started', async () => {
    await openWithEnds();
    findBtn().click();
    const first = solver.calls[0];
    const newer = { ...FIXTURE_RESULT, lengthMi: 199.9 };
    const p = _pane()!.ctx.resolve(null);
    expect(cancelRoute).toHaveBeenCalledTimes(1);   // one was pending
    // the mock's cancel resolved the first call as cancelled; a late ok answer must be ignored too
    first.res({ ok: true, result: { ...FIXTURE_RESULT, lengthMi: 1 } });
    solver.calls[0].res({ ok: true, result: newer });
    await p;
    await flush();
    expect(_pane()!.session.result?.lengthMi).toBe(199.9);
    expect(_pane()!.session.status.kind).toBe('result');
  });

  it('Cancel stops the solve and returns to idle with no error', async () => {
    await openWithEnds();
    findBtn().click();
    main().querySelector<HTMLButtonElement>('.rp-cancel')!.click();
    await flush();
    expect(cancelRoute).toHaveBeenCalledTimes(1);
    expect(_pane()!.session.status.kind).toBe('idle');
    expect(main().querySelector('.rp-error')).toBeNull();
    expect(main().textContent).toContain(t('route.idle'));
    expect(rpIds()).toEqual([]);
  });

  it('shows the engine refusal text', async () => {
    await openWithEnds();
    findBtn().click();
    solver.calls[0].res({ ok: false, reason: 'from point is outside the routing grid' });
    await flush();
    const err = main().querySelector('.rp-error')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain('from point is outside the routing grid');
  });

  it('the upload-budget refusal shows as route.err.uploadBudget with its numbers', async () => {
    await openWithEnds();
    findBtn().click();
    solver.calls[0].res({ ok: false, reason: `${UPLOAD_BUDGET_MSG}: 12 layers × 3000000 cells = 34332 MiB, at most 512 MiB` });
    await flush();
    expect(main().querySelector('.rp-error')!.textContent).toContain(t('route.err.uploadBudget', { n: '12', mib: '34,332', max: '512' }));
    expect(main().querySelector('.rp-error')!.textContent).toContain('12 layers');
  });

  it('a result shows the six sub-tabs, the badge and the route on the map', async () => {
    await solved();
    const tabs = [...main().querySelectorAll('[role=tab]')];
    expect(tabs.map((b) => b.id)).toEqual(['summary', 'cost', 'profile', 'crossings', 'alternatives', 'method'].map((x) => `rp-tab-${x}`));
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(main().querySelector('.rp-badge')?.textContent).toBe('Lowest routing score within the search area');
    expect(main().querySelector('[role=tabpanel] .rp-kpis')).not.toBeNull();
    expect(map.layers.has('rp-route')).toBe(true);
    expect(map.layers.has('rp-route-casing')).toBe(true);
    expect(map.layers.has('rp-cross')).toBe(true);
    expect(map.layers.has('rp-chord')).toBe(false);
    expect(map.order.indexOf('rp-route-casing')).toBeLessThan(map.order.indexOf('rp-route'));
    expect(map.fitBounds).toHaveBeenCalled();
    expect(routeActions().querySelectorAll("button").length).toBe(4);
    expect(routePanel().querySelector('.ri-strip-extra')?.textContent).toContain('250.1');
  });

  it('a straight-line result disables Profile, Crossings and Alternatives with a reason', async () => {
    await solved({ ...FIXTURE_RESULT, optimality: 'not-solved', profile: null, alternatives: undefined });
    for (const id of ['profile', 'crossings', 'alternatives']) {
      const b = main().querySelector(`#rp-tab-${id}`)!;
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.getAttribute('title')).toBeTruthy();
    }
  });

  it('switching the colour mode rewrites the route data', async () => {
    await solved();
    const src = map.sources.get('rp-route')!;
    const colours = () => (src.data as GeoJSON.FeatureCollection).features.map((f) => f.properties!.color as string);
    const cost = colours();
    main().querySelector<HTMLButtonElement>('[data-mode=driver]')!.click();
    expect(src.setData).toHaveBeenCalled();
    expect(colours()).not.toEqual(cost);
    expect(_pane()!.session.colour).toBe('driver');
    _pane()!.ctx.setColourMode('plain');
    expect(new Set(colours()).size).toBe(1);
  });

  it('findAlternatives merges only alternatives/surface and keeps path and profile', async () => {
    await solved({ ...FIXTURE_RESULT, alternatives: undefined, altFound: undefined });
    _pane()!.ctx.findAlternatives();
    const call = solver.calls.at(-1)!;
    expect(call.req).toMatchObject({ surface: true, alternatives: 3, profile: false });
    const other: RouteResult = { ...FIXTURE_RESULT, path: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, profile: null, lengthMi: 9 };
    call.res({ ok: true, result: other });
    await flush();
    const r = _pane()!.session.result!;
    expect(r.path).toBe(FIXTURE_RESULT.path);
    expect(r.profile).toBe(FIXTURE_RESULT.profile);
    expect(r.lengthMi).toBe(FIXTURE_RESULT.lengthMi);
    expect(r.alternatives).toBe(FIXTURE_RESULT.alternatives);
    expect(r.altFound).toBe(2);
    expect(map.layers.has('rp-alts')).toBe(true);
  });

  it('showCrossings re-adds the marker layer with the new filter', async () => {
    await solved();
    _pane()!.ctx.showCrossings(['pipeline'], true);
    expect(JSON.stringify(map.layers.get('rp-cross')!.filter)).toContain('pipeline');
    _pane()!.ctx.showCrossings(['pipeline'], false);
    expect(JSON.stringify(map.layers.get('rp-cross')!.filter)).not.toContain('pipeline');
  });

  it('closing the pane removes every rp- layer and source and the header actions', async () => {
    await solved();
    _pane()!.ctx.setProfileMarker(100, 'mi 100 · 1,134 m');
    _pane()!.ctx.setGhost(FIXTURE_RESULT.path);
    expect(rpIds().length).toBeGreaterThan(4);
    closeRoute();
    expect(rpIds()).toEqual([]);
    expect(_pane()).toBeUndefined();
    expect(routeActions().children.length).toBe(0);
    expect(document.querySelector('.rp-legend')).toBeNull();
  });

  it('asks for the usage notice again on the next open after a close', async () => {
    openRoutePanel();
    expect(_pane()).toBeDefined();
    closeRoute();
    openRoutePanel();
    const dlg = document.querySelector<HTMLElement>('dialog[aria-labelledby="route-notice-title"]');
    expect(dlg).not.toBeNull();
    expect(_pane()).toBeUndefined();
    dlg!.querySelector<HTMLButtonElement>('.disclaimer-accept')!.click();
    await flush();
    expect(_pane()).toBeDefined();
  });

  it('closing while solving cancels the pending call', async () => {
    await openWithEnds();
    findBtn().click();
    closeRoute();
    expect(cancelRoute).toHaveBeenCalledTimes(1);
  });
});

describe('Batch… action', () => {
  beforeEach(() => { batchMount.calls.length = 0; batchMount.dispose.mockClear(); });

  it('is in the header before any result, opens the lazy view in .rp-main and Back restores the idle view', async () => {
    openRoutePanel();
    const btn = routeActions().querySelector<HTMLButtonElement>('.rp-batch')!;
    expect(btn.textContent).toBe(t('route.act.batch'));
    btn.click();
    await flush();
    expect(batchMount.calls).toHaveLength(1);
    expect(batchMount.calls[0].host).toMatchObject({ presetId: _pane()!.session.inputs.presetId, lineType: _pane()!.session.inputs.lineType });
    expect(main().querySelector('.fake-batch')).not.toBeNull();
    _pane()!.ctx.rerender();   // a re-render of the pane leaves the batch view alone
    expect(main().querySelector('.fake-batch')).not.toBeNull();
    batchMount.calls[0].host.close();
    expect(main().textContent).toContain(t('route.idle'));
    expect(main().querySelector('.fake-batch')).toBeNull();
  });

  it('closing the pane disposes the batch view', async () => {
    openRoutePanel();
    routeActions().querySelector<HTMLButtonElement>('.rp-batch')!.click();
    await flush();
    closeRoute();
    expect(batchMount.dispose).toHaveBeenCalledOnce();
  });
});

describe('route pane lifecycle', () => {
  it('the Find button reads Re-solve as soon as a result lands (busy cleared after the result is stored)', async () => {
    await openWithEnds();
    expect(findBtn().textContent).toBe(t('route.in.find'));
    findBtn().click();
    expect(findBtn().disabled).toBe(true);
    solver.calls[0].res({ ok: true, result: FIXTURE_RESULT });
    await flush();
    expect(findBtn().disabled).toBe(false);
    expect(findBtn().getAttribute('aria-busy')).toBe('false');
    expect(findBtn().textContent).toBe(t('route.in.resolve'));
  });

  it('a failed or cancelled solve frees the Find button too', async () => {
    await openWithEnds();
    findBtn().click();
    solver.calls[0].res({ ok: false, reason: 'nope' });
    await flush();
    expect(findBtn().disabled).toBe(false);
    findBtn().click();
    main().querySelector<HTMLButtonElement>('.rp-cancel')!.click();
    await flush();
    expect(findBtn().disabled).toBe(false);
  });

  it('close then reopen leaves exactly one hover subscription and a bounded set of markers', async () => {
    await openWithEnds();
    expect(hover.size).toBe(1);
    const markerEls = () => document.querySelectorAll('.ri-pin').length;
    expect(markerEls()).toBe(2);
    closeRoute();
    expect(hover.size).toBe(0);
    expect(markerEls()).toBe(0);
    acceptNotice('route', ROUTE_NOTICE_VERSION);
    await openWithEnds();
    expect(hover.size).toBe(1);
    expect(markerEls()).toBe(2);
  });

  it('Esc during pick, from the focused input in the real drawer, ends the pick and keeps Route open', async () => {
    openRoutePanel();
    const inputs = routePanel().querySelector<HTMLElement>('.ri-ep-pick')!;
    inputs.click();
    expect(state.routePick).toBe(true);
    const focused = document.activeElement as HTMLElement;
    expect(routePanel().contains(focused)).toBe(true);
    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(state.routePick).toBe(false);
    expect(_pane()).toBeDefined();
    expect(routePanel().querySelector('.rp')).not.toBeNull();
  });

  it('making Alt 2 the result badges it, lists the lowest-scoring route as "Lowest routing score", and switches back', async () => {
    await solved();
    const alts = FIXTURE_RESULT.alternatives!;
    _pane()!.ctx.makeAltResult(1);
    const s = _pane()!.session;
    expect(s.result!.path).toBe(alts[1].path);
    expect(s.fromAlt).toBe(2);
    expect(s.optimal).toBe(FIXTURE_RESULT);
    expect(main().querySelector('.rp-badge')!.textContent).toBe(`Alt 2 · +${alts[1].pctRoute.toFixed(1)} % routing score`);
    const names = (map.sources.get('rp-alts')!.data as GeoJSON.FeatureCollection).features.map((f) => f.properties!.name);
    expect(names).toEqual(['Lowest routing score', 'Alt 1']);   // numbering kept, the shown one left out
    expect(document.querySelector('.rp-legend')!.textContent).toContain('Lowest routing score');
    expect(document.querySelector('.rp-legend')!.textContent).not.toContain(t('route.legend.route'));   // the shown route is Alt 2
    main().querySelector<HTMLButtonElement>('#rp-tab-alternatives')!.click();
    const rows = [...main().querySelectorAll('.ra-row')].map((r) => r.textContent);
    expect(rows[0]).toMatch(/^Alt 2 · /);
    expect(rows[1]).toMatch(/^Lowest routing score · 250\.1 mi/);
    main().querySelector<HTMLButtonElement>('[data-make="-1"]')!.click();
    expect(s.result).toBe(FIXTURE_RESULT);
    expect(s.fromAlt).toBeUndefined();
    expect(main().querySelector('.rp-badge')!.textContent).toBe('Lowest routing score within the search area');
    expect(s.previous).toEqual({ path: alts[1].path, lengthMi: alts[1].lengthMi, cost: alts[1].cost });
  });

  it('runSolves does not call onEach after the pane closed', async () => {
    await solved();
    const onEach = vi.fn();
    const spec = { patch: null, profile: false, alternatives: 0, surface: false };
    const h = _pane()!.ctx.runSolves([spec], onEach);
    closeRoute();
    solver.calls.splice(0).forEach((c) => c.res({ ok: true, result: FIXTURE_RESULT }));
    await h.done;
    expect(onEach).not.toHaveBeenCalled();
  });
});

describe('route pane live re-solve', () => {
  const methodTab = async () => {
    await solved();
    main().querySelector<HTMLButtonElement>('#rp-tab-method')!.click();
    return main().querySelector<HTMLInputElement>('input[data-row="9"][data-field="cost_x"]')!;
  };

  it('a re-solve with a result keeps the result view and the focused weight input, with a header chip', async () => {
    const cell = await methodTab();
    const panel = main().querySelector('#rp-panel');
    cell.focus();
    cell.value = '2';
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    const done = _pane()!.ctx.resolve(_pane()!.session.inputs.patch);
    expect(main().querySelector('.rp-steps')).toBeNull();
    expect(main().querySelector('#rp-panel')).toBe(panel);
    const chip = main().querySelector('.rp-resolving')!;
    expect(chip.textContent).toContain(t('route.solve.chip'));
    solver.calls.at(-1)!.onProgress!('solve');
    expect(main().querySelector('.rp-resolving')!.textContent).toContain(t('route.solve.solve'));
    expect(document.activeElement).toBe(cell);
    solver.calls.at(-1)!.res({ ok: true, result: { ...FIXTURE_RESULT, lengthMi: 251.3 } });
    await done;
    await flush();
    expect(main().querySelector('.rp-resolving')).toBeNull();
    expect(main().querySelector('#rp-panel')).toBe(panel);
    expect(cell.isConnected).toBe(true);
    expect(document.activeElement).toBe(cell);
    expect(main().querySelector('.rm-delta')!.textContent).toContain('+1.2 mi');
    const prev = _pane()!.session.previous!;
    expect(prev).toEqual({ path: FIXTURE_RESULT.path, lengthMi: FIXTURE_RESULT.lengthMi, cost: FIXTURE_RESULT.cost });
    expect(prev).not.toHaveProperty('surface');      // no images kept alive by the delta chip
    expect(prev).not.toHaveProperty('weightImage');
  });

  it('chip Cancel and a refused re-solve keep the shown route', async () => {
    await methodTab();
    const p1 = _pane()!.ctx.resolve(null);
    main().querySelector<HTMLButtonElement>('.rp-resolving-cancel')!.click();
    await p1;
    await flush();
    expect(_pane()!.session.result).toBe(FIXTURE_RESULT);
    expect(main().querySelector('.rp-resolving')).toBeNull();
    const p2 = _pane()!.ctx.resolve(null);
    solver.calls.at(-1)!.res({ ok: false, reason: 'no path' });
    await p2;
    await flush();
    expect(_pane()!.session.result).toBe(FIXTURE_RESULT);
    expect(main().querySelector('.rp-error')).toBeNull();
    expect(main().querySelector('.rp-resolving--err')!.textContent).toContain('no path');
    expect(main().querySelector('.rm')).not.toBeNull();
  });

  it('new ends show the full progress view and drop the previous result for the delta', async () => {
    await solved();
    _pane()!.session.inputs.b = { lngLat: [-117.5, 44.0], hit: null };
    findBtn().click();
    expect(main().querySelector('.rp-steps')).not.toBeNull();
    solver.calls.at(-1)!.res({ ok: true, result: FIXTURE_RESULT });
    await flush();
    expect(_pane()!.session.previous).toBeNull();
  });

  it('the Method error count reaches the input column', async () => {
    const cell = await methodTab();
    cell.value = '-1';
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    const err = routePanel().querySelector<HTMLElement>('.ri-errors');
    expect(findBtn().disabled).toBe(true);
    expect(err?.hidden).toBe(false);
    main().querySelector<HTMLButtonElement>('.rm-reset')!.click();
    expect(findBtn().disabled).toBe(false);
  });

  it('crossing markers follow session.crossingKinds; Find alternatives sends the session stretch', async () => {
    await solved();
    const s = _pane()!.session;
    expect(s.crossingKinds).toEqual(['river', 'road', 'rail']);
    _pane()!.ctx.showCrossings(['road'], false);
    expect(s.crossingKinds).toEqual(['river', 'rail']);
    expect(JSON.stringify(map.layers.get('rp-cross')!.filter)).not.toContain('road');
    s.altStretch = 0.35;
    _pane()!.ctx.findAlternatives();
    expect(solver.calls.at(-1)!.req.altStretch).toBe(0.35);
  });
});

describe('route pane exact crossings', () => {
  const ok = { ok: true, bytes: 1, groups: 1, rowsDecoded: 1, rowsKept: 1, ms: 1 };
  const EXACT = {
    routes: [{ points: [{ kind: 'road', mi: 12.5, lngLat: [-118.5, 45.1], name: 'US 395', detail: 'trunk' }],
      counts: { river: 0, road: 1, rail: 0, pipeline: 0, line230: 0, line100: 0 }, dupDropped: 0 }],
    status: { road: ok, river: ok, rail: ok, pipeline: ok, line: ok },
    exact: ['road'],
  };
  const markers = () => (map.sources.get('rp-cross')!.data as GeoJSON.FeatureCollection).features;
  const listed = async () => {
    _pane()!.ctx.listExactCrossings();
    solver.exacts.at(-1)!.res({ ok: true, result: EXACT });
    await flush();
  };

  it('sends only the shown route, keeps the reply and moves the road markers to its points', async () => {
    await solved();
    _pane()!.ctx.listExactCrossings();
    expect(_pane()!.session.exactBusy).toBe(true);
    const req = vi.mocked(exactCrossings).mock.calls[0][0];
    expect(req.polylines).toHaveLength(1);
    expect(req.polylines[0]).toHaveLength(FIXTURE_RESULT.path.coordinates.length);
    expect(req.lengthsMi).toEqual([FIXTURE_RESULT.lengthMi]);
    solver.exacts[0].res({ ok: true, result: EXACT });
    await flush();
    const s = _pane()!.session;
    expect(s.exactBusy).toBe(false);
    expect(s.exact?.routes[0].points[0].name).toBe('US 395');
    const roads = markers().filter((f) => f.properties!.kind === 'road');
    expect(roads.map((f) => (f.geometry as GeoJSON.Point).coordinates)).toEqual([[-118.5, 45.1]]);
    const grid = FIXTURE_RESULT.profile!.crossings.points.filter((c) => c.kind !== 'road');
    expect(markers().filter((f) => f.properties!.kind !== 'road')).toHaveLength(grid.length);
  });

  it('a new solve, Make Alt n, back to Optimal and new alternatives each clear it', async () => {
    await solved();
    await listed();
    const s = _pane()!.session;
    _pane()!.ctx.makeAltResult(0);
    expect(s.exact).toBeNull();
    await listed();
    _pane()!.ctx.makeAltResult(-1);
    expect(s.exact).toBeNull();
    await listed();
    _pane()!.ctx.findAlternatives();
    solver.calls.at(-1)!.res({ ok: true, result: FIXTURE_RESULT });
    await flush();
    expect(s.exact).toBeNull();
    await listed();
    expect(s.exact).not.toBeNull();
    findBtn().click();
    solver.calls.at(-1)!.res({ ok: true, result: FIXTURE_RESULT });
    await flush();
    expect(s.exact).toBeNull();
  });

  it('drops a reply that lands after the shown path changed', async () => {
    await solved();
    _pane()!.ctx.listExactCrossings();
    _pane()!.ctx.makeAltResult(0);
    _pane()!.ctx.listExactCrossings();                    // asked again for Alt 1
    solver.exacts[0].res({ ok: true, result: EXACT });    // the Optimal route's reply
    await flush();
    const s = _pane()!.session;
    expect(s.exact).toBeNull();
    expect(s.exactBusy).toBe(true);
    expect(markers().some((f) => (f.geometry as GeoJSON.Point).coordinates[0] === -118.5)).toBe(false);
    solver.exacts[1].res({ ok: true, result: EXACT });
    await flush();
    expect(s.exact).not.toBeNull();
  });

  it('drops an old reply when a newer request has identical route geometry', async () => {
    await solved();
    const s = _pane()!.session;
    _pane()!.ctx.listExactCrossings();
    _pane()!.ctx.makeAltResult(0);
    _pane()!.ctx.makeAltResult(-1);
    _pane()!.ctx.listExactCrossings();
    expect(solver.exacts).toHaveLength(2);
    solver.exacts[0].res({ ok: true, result: EXACT });
    await flush();
    expect(s.exact).toBeNull();
    expect(s.exactBusy).toBe(true);
    solver.exacts[1].res({ ok: true, result: EXACT });
    await flush();
    expect(s.exact).not.toBeNull();
    expect(s.exactBusy).toBe(false);
  });

  it('drops a report when an interior vertex changes with the same ends and length', async () => {
    await solved();
    const s = _pane()!.session;
    const coordinates = s.result!.path.coordinates;
    s.result = { ...s.result!, path: { type: 'LineString', coordinates: [coordinates[0], [-118, 44], coordinates.at(-1)!] } };
    _pane()!.ctx.listExactCrossings();
    s.result = { ...s.result, path: { type: 'LineString', coordinates: [coordinates[0], [-117, 44], coordinates.at(-1)!] } };
    solver.exacts[0].res({ ok: true, result: EXACT });
    await flush();
    expect(s.exact).toBeNull();
  });

  it('a refusal is one line and frees the button; a cancel only frees it', async () => {
    await solved();
    main().querySelector<HTMLButtonElement>('#rp-tab-crossings')!.click();
    _pane()!.ctx.listExactCrossings();
    solver.exacts[0].res({ ok: false, reason: 'report files missing' });
    await flush();
    const s = _pane()!.session;
    expect(s.exactBusy).toBe(false);
    expect(s.exactError).toBe('report files missing');
    expect(main().querySelector('.rx-exact')!.textContent).toContain('report files missing');
    _pane()!.ctx.listExactCrossings();
    expect(s.exactError).toBeNull();
    solver.exacts[1].res({ ok: false, reason: 'cancelled' });
    await flush();
    expect(s.exactBusy).toBe(false);
    expect(s.exactError).toBeNull();
    expect(s.exact).toBeNull();
    const btn = main().querySelector<HTMLButtonElement>('.rx-exact-btn')!;
    expect(btn.disabled).toBe(false);
    expect(main().querySelector('.rx-exact')!.textContent).not.toContain('cancelled');
  });
});

describe('route pane similar-cost surface', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reuses one canvas across threshold changes, rewrites alpha and replays the canvas source', async () => {
    const canvases = new Set<unknown>();
    const puts: number[][] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvases.add(this);
      return {
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: (img: { data: Uint8ClampedArray }) => { puts.push([3, 7, 11, 15].map((i) => img.data[i])); },
      } as unknown as CanvasRenderingContext2D;
    } as never);
    const rgba = new Uint8ClampedArray([1, 2, 3, 4].flatMap((k) => [...SURFACE_PALETTE[k]]));
    const surface = {
      bands: [0.02, 0.05, 0.1, 0.2], cellsByBand: [1, 1, 1, 1], clipped: false, edgeCellsInBands: 0, bufferM: 0,
      classes: new Uint8Array(4), window: { c0: 0, r0: 0, c1: 1, r1: 1 },
      image: { rgba, width: 2, height: 2, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] },
    } as unknown as RouteResult['surface'];
    await solved({ ...FIXTURE_RESULT, surface });
    expect(map.sources.has('rp-surface')).toBe(true);
    const src = map.sources.get('rp-surface') as unknown as { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };
    src.play = vi.fn();
    src.pause = vi.fn();
    const added = map.addSource.mock.calls.filter((c) => c[0] === 'rp-surface').length;
    puts.length = 0;
    _pane()!.ctx.setThreshold(0.02);
    _pane()!.ctx.setThreshold(0.10);
    expect(canvases.size).toBe(1);
    expect(puts.length).toBe(2);
    expect(puts[0]).not.toEqual(puts[1]);
    expect(src.play).toHaveBeenCalledTimes(2);
    expect(map.triggerRepaint).toHaveBeenCalled();
    expect(map.addSource.mock.calls.filter((c) => c[0] === 'rp-surface').length).toBe(added);
  });
});

describe('route pane helpers', () => {

  it('merges a session patch over a saved method', () => {
    const m = mergePatch({ rows: [{ row: 1, band: 'x', route_w: 2 }], contingency: 0.3 }, { rows: [{ row: 1, band: 'x', cost_x: 3 }, { row: 2, band: 'y', route_w: 5 }] });
    expect(m).toEqual({ rows: [{ row: 1, band: 'x', route_w: 2, cost_x: 3 }, { row: 2, band: 'y', route_w: 5 }], contingency: 0.3 });
  });

  it('cuts the route into one feature per profile run, ends joined', () => {
    const fc = routeFeatures(FIXTURE_RESULT, 'cost');
    expect(fc.features.length).toBe(FIXTURE_RESULT.profile!.runs.length);
    const g = (i: number) => (fc.features[i].geometry as GeoJSON.LineString).coordinates;
    expect(g(0)[0]).toEqual(FIXTURE_RESULT.path.coordinates[0]);
    expect(g(1)[0][0]).toBeCloseTo(g(0).at(-1)![0], 9);
    const usd = fc.features.reduce((s, f) => s + (f.properties!.usdNom as number), 0);
    expect(usd).toBeCloseTo(FIXTURE_RESULT.cost.lineUsdNominal, 0);
  });

  it('masks surface classes above the threshold from the untouched RGBA', () => {
    const px = [1, 2, 3, 4].flatMap((k) => [...SURFACE_PALETTE[k]]);
    const orig = new Uint8ClampedArray([...px, 0, 0, 0, 0]);
    const cls = pixelClasses(orig);
    expect([...cls]).toEqual([1, 2, 3, 4, 0]);
    const out = new Uint8ClampedArray(orig.length);
    maskSurface(orig, cls, [0.02, 0.05, 0.1, 0.2], 0.05, out);
    expect([3, 7, 11, 15].map((i) => out[i])).toEqual([SURFACE_PALETTE[1][3], SURFACE_PALETTE[2][3], 0, 0]);
    expect(orig[11]).toBe(SURFACE_PALETTE[3][3]);
  });
});

beforeAll(() => loadRouteStrings());

describe('route pane cell inspector', () => {
  afterEach(() => vi.restoreAllMocks());
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const hoverAt = (lng: number, lat: number, x = 50, y = 60) => { for (const f of hover) f({ point: { x, y }, lngLat: { lng, lat } }); };
  const itip = () => document.querySelector<HTMLElement>('.rp-itip')!;
  const card = () => document.querySelector<HTMLElement>('.rp-icard')!;
  const tapAt = (lng: number, lat: number, x = 50, y = 60) => { for (const f of taps) f({ point: { x, y }, lngLat: { lng, lat } }); };
  const reply = (cause: string, cell: [number, number] = [100, 200]) => ({
    ok: true, result: {
      values: { flags: 4 }, cell, grid: { x0: -2493045, y0: 3310005, cell: 250 },
      decoded: [{ band: 'flags', value: 4, label: { k: 'route.insp.band.flags' }, text: [{ k: 'route.cat.flags_2' }] }],
      explain: {
        routeW: 100, costX: 1.2, barrier: null, cause, head: 'Public airfield ≤ 5 km · routing ×100',
        rows: [{ row: 1, label: { k: 'route.cat.flags_2' }, note: 'public airfield ≤ 5 km', r: 100, c: 1.2, winsRoute: true, winsCost: true, rule: 'multiply' }],
        exempted: [{ row: 2, label: { k: 'route.cat.flags2_0' }, exceptLabel: 'inside Section 368 corridors' }],
      },
    },
  });

  it('Inspect subscribes hover to the worker after 120 ms and shows the cause first; the same cell is not asked again', async () => {
    await solved();
    expect(main().querySelector('.rp-insp')!.getAttribute('aria-checked')).toBe('false');
    hoverAt(-118, 45);
    await wait(150);
    expect(inspectCell).not.toHaveBeenCalled();             // off: the route readout only
    main().querySelector<HTMLButtonElement>('.rp-insp')!.click();
    expect(main().querySelector('.rp-insp')!.getAttribute('aria-checked')).toBe('true');
    hoverAt(-118, 45);
    hoverAt(-118.0001, 45);                                  // debounced: one request
    await wait(150);
    expect(inspectCell).toHaveBeenCalledTimes(1);
    expect(solver.inspects[0].req).toMatchObject({ lngLat: [-118.0001, 45], preset: 'tm-default', lineType: 'ac500', from: [-119.30, 45.94], to: [-116.80, 43.20] });
    const { albersForward } = await import('../route/grid.js');
    const [x, y] = albersForward(-118.0001, 45);
    const cell: [number, number] = [Math.floor((x + 2493045) / 250), Math.floor((3310005 - y) / 250)];
    solver.inspects[0].res(reply('Public airfield ≤ 5 km · routing weight ×100', cell));
    await flush();
    expect(itip().hidden).toBe(false);
    expect(itip().textContent).toBe('Public airfield ≤ 5 km · routing ×100');   // a one-line preview: no rows, no values
    expect(itip().querySelector('ul, dl')).toBeNull();
    hoverAt(-118.0001, 45, 70, 80);                          // same cell: answered from the last reply
    expect(itip().style.left).toBe('86px');
    await wait(150);
    expect(inspectCell).toHaveBeenCalledTimes(1);
    for (const f of leave) f();
    expect(itip().hidden).toBe(true);
    // Esc turns Inspect off
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(main().querySelector('.rp-insp')!.getAttribute('aria-checked')).toBe('false');
    // "i" in the pane turns it on again
    main().dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
    expect(main().querySelector('.rp-insp')!.getAttribute('aria-checked')).toBe('true');
    expect(state.routeInspect).toBe(true);                   // a tap reads the cell, not a feature popup
  });

  describe('pinned card', () => {
    const detail = (over: Record<string, unknown> = {}, decoded?: unknown[]) => {
      const r = reply('x') as unknown as { ok: true; result: Record<string, unknown> & { explain: Record<string, unknown>; decoded: unknown } };
      r.result.explain = { ...r.result.explain, head: 'Sage-grouse PHMA · routing ×40', ...over };
      r.result.decoded = decoded ?? [
        { band: 'flags2', value: 1, label: { k: 'route.insp.band.flags2' }, text: [{ k: 'route.cat.flags2_0' }] },
        { band: 'agency', value: 2, label: { k: 'route.insp.band.agency' }, text: [{ k: 'route.lbl.agency.2' }] },
        { band: 'wildfire', value: 0, label: { k: 'route.insp.band.wildfire' }, text: [{ k: 'route.insp.nodata' }] },
        { band: 'osm_maxkv', value: 0, label: { k: 'route.insp.band.osm_maxkv' }, text: [{ k: 'route.insp.none' }] },
        { band: 'flags', value: 0, label: { k: 'route.insp.band.flags' }, text: [{ k: 'route.insp.none' }] },
      ];
      return r;
    };
    const pin = async (r: unknown = detail(), lng = -118, lat = 45) => {
      tapAt(lng, lat);
      await flush();
      solver.inspects.at(-1)!.res(r);
      await flush();
    };
    const on = async () => { await solved(); main().querySelector<HTMLButtonElement>('.rp-insp')!.click(); };

    it('a tap with Inspect on pins a card; nothing opens with Inspect off', async () => {
      await solved();
      tapAt(-118, 45);
      await flush();
      expect(inspectCell).not.toHaveBeenCalled();
      main().querySelector<HTMLButtonElement>('.rp-insp')!.click();
      await pin();
      expect(card().hidden).toBe(false);
      expect(card().getAttribute('role')).toBe('dialog');
      expect(document.getElementById(card().getAttribute('aria-labelledby')!)!.textContent).toBe('Sage-grouse PHMA · routing ×40');
      expect([...card().querySelectorAll('.rp-ic-chip')].map((c) => c.textContent)).toEqual(['Routing ×100', 'Cost ×1.2']);
    });

    it('x and Esc close the card, and Inspect stays on; Esc then turns Inspect off', async () => {
      await on();
      await pin();
      card().querySelector<HTMLButtonElement>('.rp-ic-x')!.click();
      expect(card().hidden).toBe(true);
      expect(main().querySelector('.rp-insp')!.getAttribute('aria-checked')).toBe('true');
      await pin();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(card().hidden).toBe(true);
      expect(state.routeInspect).toBe(true);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(state.routeInspect).toBe(false);
    });

    it('a tap on another cell re-pins the card to that cell', async () => {
      await on();
      await pin();
      await pin(detail({ head: 'Floodplain · routing ×2' }), -117.5, 45);
      expect(card().querySelectorAll('.rp-ic-head')).toHaveLength(1);
      expect(card().querySelector('.rp-ic-head')!.textContent).toBe('Floodplain · routing ×2');
    });

    it('"What\'s here" lists only present facts, with a swatch where a class colour exists', async () => {
      await on();
      await pin();
      const items = [...card().querySelectorAll('.rp-ic-facts li')];
      const text = items.map((li) => li.textContent);
      expect(text).toEqual(['Sage-grouse PHMA', expect.stringContaining('Land manager')]);
      expect(text.join(' ')).not.toMatch(/none|no data/i);
      expect((items[0].querySelector('.rp-ic-sw') as HTMLElement).style.background).not.toBe('');
    });

    it('slope codes 4-8 take the mountain colour and 2-3 the rolling colour', async () => {
      await on();
      const colourOf = async (value: number) => {
        await pin(detail({}, [{ band: 'slope', value, label: { k: 'route.insp.band.slope' }, text: [{ k: 'route.insp.fact', v: value }] }]));
        const sw = card().querySelector('.rp-ic-facts li .rp-ic-sw') as HTMLElement | null;
        return sw?.style.background;
      };
      const mountain = await colourOf(4);
      expect(mountain).toBeTruthy();
      for (const v of [5, 6, 7, 8]) expect(await colourOf(v)).toBe(mountain);
      const rolling = await colourOf(2);
      expect(rolling).toBeTruthy();
      expect(rolling).not.toBe(mountain);
      expect(await colourOf(3)).toBe(rolling);
    });

    it('a cell with nothing present says so; a barrier shows a Blocked chip', async () => {
      await on();
      await pin(detail({ barrier: { k: 'route.insp.barrier.unknown' }, head: 'Blocked: hard barrier' }, []));
      expect(card().querySelector('.rp-ic-facts')).toBeNull();
      expect(card().textContent).toContain('Nothing notable in this cell');
      expect([...card().querySelectorAll('.rp-ic-chip')].map((c) => c.textContent)).toEqual(['Blocked', 'Cost ×1.2']);
    });

    it('rules list the winner first; exempted rows are struck through; raw values are folded', async () => {
      await on();
      const r = detail() as unknown as { result: { explain: { rows: unknown[] } } };
      r.result.explain.rows = [
        { row: 3, label: 'Shrub', r: 1, c: 1, winsRoute: false, winsCost: false, rule: 'multiply' },
        { row: 1, label: 'PHMA', r: 40, c: 1.2, winsRoute: true, winsCost: true, rule: 'multiply' },
      ];
      await pin(r);
      const rules = [...card().querySelectorAll('.rp-ic-rules li')];
      expect(rules[0].textContent).toContain('PHMA');
      expect(rules[0].querySelector('.rp-ic-x2')!.textContent).toContain('×40');
      expect(card().querySelector('.rp-it-exempt s')!.textContent).toBe('Sage-grouse PHMA');
      const raw = card().querySelector<HTMLDetailsElement>('.rp-ic-raw')!;
      expect(raw.open).toBe(false);
      expect(raw.querySelector('summary')!.textContent).toBe('Raw cell values');
    });

    it('the card is text only: HTML-looking labels render literally', async () => {
      await on();
      const evil = '<img src=x onerror=alert(1)>';
      await pin(detail({ head: evil }, [{ band: 'isoreg', value: 1, label: { k: 'route.insp.band.isoreg' }, text: [evil] }]));
      expect(card().querySelector('img')).toBeNull();
      expect(card().querySelector('.rp-ic-head')!.textContent).toBe(evil);
      expect(card().querySelector('.rp-ic-facts')!.textContent).toContain(evil);
    });

    it('a narrow or hover:none screen docks the card full width and shows no hover preview', async () => {
      const before = window.matchMedia;
      window.matchMedia = ((q: string) => ({ matches: q.includes('hover: none'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
      try {
        await on();
        hoverAt(-118, 45);
        await wait(150);
        expect(inspectCell).not.toHaveBeenCalled();
        await pin();
        expect(card().classList.contains('rp-icard--dock')).toBe(true);
        expect(itip().hidden).toBe(true);
      } finally { window.matchMedia = before; }
    });

    it('a docked card follows the drawer when it is resized', async () => {
      const before = window.matchMedia, RO = globalThis.ResizeObserver;
      let fire = () => {};
      globalThis.ResizeObserver = class { constructor(cb: () => void) { fire = cb; } observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
      window.matchMedia = ((q: string) => ({ matches: q.includes('hover: none'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
      try {
        await on();
        await pin();
        expect(card().style.bottom).toMatch(/px$/);
        card().style.bottom = '';
        fire();                                              // the drawer moved: the offset is recomputed
        expect(card().style.bottom).toMatch(/px$/);
      } finally { window.matchMedia = before; globalThis.ResizeObserver = RO; }
    });

    it('the desktop card is not docked', async () => {
      await on();
      await pin();
      expect(card().classList.contains('rp-icard--dock')).toBe(false);
    });
  });

  it('Show cell weights switches Inspect with the overlay, so a tap on a phone reads the cell', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
    }) as unknown as CanvasRenderingContext2D);
    await solved();
    const insp = () => main().querySelector('.rp-insp')!.getAttribute('aria-checked');
    main().querySelector<HTMLButtonElement>('.rp-wt')!.click();
    expect(insp()).toBe('true');
    expect(state.routeInspect).toBe(true);
    const weightImage = { rgba: new Uint8ClampedArray(16), width: 2, height: 2, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] };
    solver.calls[1].res({ ok: true, result: { ...FIXTURE_RESULT, weightImage } as RouteResult });
    await flush();
    hoverAt(-118, 45);                                       // a tap reaches onMapPoint like a mouse move
    await wait(150);
    expect(inspectCell).toHaveBeenCalledTimes(1);
    main().querySelector<HTMLButtonElement>('.rp-wt')!.click();
    expect(insp()).toBe('false');
    expect(state.routeInspect).toBe(false);
  });

  it('a hole in the similar-cost areas is inspected with Inspect off, prefixed with the threshold', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
    }) as unknown as CanvasRenderingContext2D);
    const c1 = [...SURFACE_PALETTE[1]], none = [0, 0, 0, 0];
    const rgba = new Uint8ClampedArray([c1, c1, c1, c1, none, c1, c1, c1, c1].flat());   // a 3 × 3 ring
    const surface = {
      bands: [0.02, 0.05, 0.1, 0.2], cellsByBand: [8, 0, 0, 0], clipped: false, edgeCellsInBands: 0, bufferM: 0,
      classes: new Uint8Array(9), window: { col0: 0, row0: 0, cols: 3, rows: 3 },
      image: { rgba, width: 3, height: 3, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] },
    } as unknown as RouteResult['surface'];
    await solved({ ...FIXTURE_RESULT, surface });
    hoverAt(0.2, 0.8);                                        // a drawn pixel: no inspect
    await wait(150);
    expect(inspectCell).not.toHaveBeenCalled();
    hoverAt(0.5, 0.5);                                        // the hole
    await wait(150);
    expect(inspectCell).toHaveBeenCalledTimes(1);
    solver.inspects[0].res(reply('Public airfield ≤ 5 km · routing weight ×100'));
    await flush();
    expect(itip().querySelector('.rp-it-cause')!.textContent).toBe('Not within 10 % of the lowest routing score — Public airfield ≤ 5 km · routing ×100');
    tapAt(0.5, 0.5);                                          // a click on the hole pins the card
    await flush();
    solver.inspects[1].res(reply('Public airfield ≤ 5 km · routing weight ×100'));
    await flush();
    expect(card().hidden).toBe(false);
    expect(itip().hidden).toBe(true);                         // no hover preview under a pinned card
    const claims = vi.mocked(setRouteTapClaims).mock.calls.at(-1)![0]!;
    const ev = (lng: number, lat: number) => ({ point: { x: 1, y: 1 }, lngLat: { lng, lat } }) as never;
    expect(claims(ev(0.5, 0.5))).toBe(true);                  // the feature popup stays shut on the hole
    expect(claims(ev(0.2, 0.8))).toBe(false);
    expect(card().querySelector('.rp-ic-head')!.textContent).toBe('Not within 10 % of the lowest routing score — Public airfield ≤ 5 km · routing ×100');
  });

  it('holeAt: only a transparent pixel enclosed on four sides', () => {
    const on = [1, 1, 1, 255], off = [0, 0, 0, 0];
    const img = { data: new Uint8ClampedArray([on, on, on, on, off, on, on, on, off].flat()), width: 3, height: 3 };
    const geo = { coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] } as never;
    expect(holeAt(img, geo, [0.5, 0.5])).toBe(true);
    expect(holeAt(img, geo, [0.9, 0.1])).toBe(false);         // transparent, but open to the edge
    expect(holeAt(img, geo, [0.1, 0.9])).toBe(false);         // drawn
    expect(holeAt(img, geo, [2, 0.5])).toBe(false);           // outside
  });

  it('Show routing weight solves once for the image, draws rp-weight under the route with a legend, and closing releases it', async () => {
    const canvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return {
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: () => {},
      } as unknown as CanvasRenderingContext2D;
    } as never);
    await solved();
    main().querySelector<HTMLButtonElement>('.rp-wt')!.click();
    expect(solver.calls).toHaveLength(2);
    expect(solver.calls[1].req).toMatchObject({ weightImage: true, profile: false, surface: false, alternatives: 0 });
    expect(main().querySelector<HTMLButtonElement>('.rp-wt')!.disabled).toBe(true);
    const weightImage = { rgba: new Uint8ClampedArray(16), width: 2, height: 2, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] };
    solver.calls[1].res({ ok: true, result: { ...FIXTURE_RESULT, path: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, weightImage } as RouteResult });
    await flush();
    const s = _pane()!.session;
    expect(s.result!.weightImage).toBe(weightImage);
    expect(s.result!.path).toBe(FIXTURE_RESULT.path);         // only the image is merged
    expect(map.sources.has('rp-weight')).toBe(true);
    expect(map.order.indexOf('rp-weight')).toBeLessThan(map.order.indexOf('rp-route-casing'));
    expect(document.querySelector('.rp-legend')!.textContent).toContain('Routing weight');
    expect(document.querySelector('.rp-legend')!.textContent).toContain('blocked');
    // Find with the box on asks for the image itself
    findBtn().click();
    expect(solver.calls.at(-1)!.req).toMatchObject({ weightImage: true, profile: true });
    solver.calls.at(-1)!.res({ ok: true, result: { ...FIXTURE_RESULT, weightImage } as RouteResult });
    await flush();
    closeRoute();
    expect(rpIds()).toEqual([]);
    expect(canvases.every((c) => c.width === 0)).toBe(true);
    expect(document.querySelector('.rp-itip')).toBeNull();
  });

  it('Esc is left to pick mode, dialogs and menus while Inspect is on', async () => {
    await solved();
    main().querySelector<HTMLButtonElement>('.rp-insp')!.click();
    const pressed = () => main().querySelector('.rp-insp')!.getAttribute('aria-checked');
    state.routePick = true;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(pressed()).toBe('true');
    state.routePick = false;
    for (const html of ['<dialog open><button>x</button></dialog>', '<div role="menu"><button>x</button></div>', '<div role="listbox"><button>x</button></div>']) {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.append(host);
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      host.querySelector('button')!.dispatchEvent(ev);
      expect(pressed()).toBe('true');
      expect(ev.defaultPrevented).toBe(false);
      host.remove();
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(pressed()).toBe('false');
  });

  it('Show routing weight waits for a pending solve, and a cancel is not an error', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
    }) as unknown as CanvasRenderingContext2D);
    await solved();
    const box = () => main().querySelector<HTMLButtonElement>('.rp-wt')!;
    const weightImage = () => ({ rgba: new Uint8ClampedArray(16).fill(9), width: 2, height: 2, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
    // a refine solve is pending: the weight fetch waits instead of cancelling it or running beside it
    const done = _pane()!.ctx.resolve(null);
    expect(solver.calls).toHaveLength(2);
    box().click();
    expect(solver.calls).toHaveLength(2);
    expect(cancelRoute).not.toHaveBeenCalled();
    expect(box().disabled).toBe(true);
    solver.calls[1].res({ ok: true, result: { ...FIXTURE_RESULT, lengthMi: 251 } });
    await done;
    await flush();
    expect(solver.calls).toHaveLength(3);                     // now, for the new result
    expect(solver.calls[2].req).toMatchObject({ weightImage: true, profile: false });
    // a newer solve cancels it: the box stays on, no error, and the newer solve brings the image
    const again = _pane()!.ctx.resolve(null);
    await flush();
    expect(box().getAttribute('aria-checked')).toBe('true');
    expect(_pane()!.session.result!.lengthMi).toBe(251);
    expect(main().querySelector('.rp-wt')!.getAttribute('title')).toBe('');
    const last = solver.calls.at(-1)!;
    expect(last.req).toMatchObject({ weightImage: true, profile: true });
    const img = weightImage();
    last.res({ ok: true, result: { ...FIXTURE_RESULT, weightImage: img } as RouteResult });
    await again;
    await flush();
    expect(vi.mocked(routeLine).mock.calls.filter(([r]) => r.weightImage)).toHaveLength(2);   // the cancelled fetch + the solve: no third
    expect(map.sources.has('rp-weight')).toBe(true);
    expect(img.rgba.length).toBe(0);                          // drawn: the canvas keeps the pixels
    // off and on again: the same canvas, no new solve
    box().click();
    expect(map.sources.has('rp-weight')).toBe(false);
    const n = solver.calls.length;
    box().click();
    expect(solver.calls.length).toBe(n);
    expect(map.sources.has('rp-weight')).toBe(true);
  });

  it('the legend card stacks in #legendContainer and starts collapsed on a phone', async () => {
    closeRoute();
    resetDrawerEnv();
    const env = installDrawerEnv({ compact: true });
    map = fakeMap(env.map as unknown as Parameters<typeof fakeMap>[0]);
    state.map = map as unknown as typeof state.map;
    const lc = document.createElement('div');
    lc.id = 'legendContainer';
    lc.hidden = true;
    document.body.append(lc);
    try {
      await solved();
      const card = lc.querySelector<HTMLElement>(':scope > .rp-legend')!;
      expect(card).not.toBeNull();
      expect(card.hidden).toBe(false);
      expect(lc.hidden).toBe(false);
      expect(card.classList.contains('collapsed')).toBe(true);
      expect(card.querySelector('.legend-title-label')!.textContent).toBe(t('route.legend.cost'));
      closeRoute();
      expect(lc.querySelector('.rp-legend')).toBeNull();
      expect(lc.hidden).toBe(true);
    } finally { lc.remove(); }
  });
});

describe('route pane live cell-weight repaint', () => {
  afterEach(() => vi.restoreAllMocks());
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const coords = [[0, 1], [1, 1], [1, 0], [0, 0]];
  const image = (fill: number, mode: 'route' | 'cost' | 'cause' = 'route') => ({ rgba: new Uint8ClampedArray(16).fill(fill), width: 2, height: 2, coordinates: coords, mode });
  let canvases: Set<unknown>, puts: number[];

  /** A result with the overlay on (mode route), its canvas source replayable. */
  async function overlayOn() {
    canvases = new Set();
    puts = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvases.add(this);
      return {
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: (img: { data: Uint8ClampedArray }) => { puts.push(img.data[0]); },
      } as unknown as CanvasRenderingContext2D;
    } as never);
    await solved();
    main().querySelector<HTMLButtonElement>('.rp-wt')!.click();
    solver.calls[1].res({ ok: true, result: { ...FIXTURE_RESULT, weightImage: image(1) } as unknown as RouteResult });
    await flush();
    const src = map.sources.get('rp-weight') as unknown as { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; setCoordinates: ReturnType<typeof vi.fn> };
    src.play = vi.fn();
    src.pause = vi.fn();
    src.setCoordinates = vi.fn();
    return src;
  }
  const grass = (w: number) => ({ rows: [{ row: 7, band: 'landcover', route_w: w }] });

  it('previewPatch repaints once 150 ms after a burst, into the same canvas, before any solve', async () => {
    const src = await overlayOn();
    const ctx = _pane()!.ctx, solves = solver.calls.length;
    ctx.previewPatch!(grass(2));
    ctx.previewPatch!(grass(3));
    ctx.previewPatch!(grass(4));
    await wait(100);
    expect(repaintWeight).not.toHaveBeenCalled();
    await wait(80);
    expect(repaintWeight).toHaveBeenCalledTimes(1);
    expect(solver.repaints[0].req).toMatchObject({ preset: 'tm-default', mode: 'route', presetPatch: grass(4) });
    const next = image(7);
    solver.repaints[0].res({ ok: true, result: { image: next, mode: 'route' } });
    await flush();
    expect(_pane()!.session.result!.weightImage).toBe(next);
    expect(canvases.size).toBe(1);
    expect(puts.at(-1)).toBe(7);
    expect(src.play).toHaveBeenCalledOnce();
    expect(map.addSource.mock.calls.filter((c) => c[0] === 'rp-weight')).toHaveLength(1);
    expect(solver.calls.length).toBe(solves);
    expect(_pane()!.repaintMs).not.toBeNull();
  });

  it('drops a stale repaint reply, and is a no-op with the overlay off', async () => {
    await overlayOn();
    const ctx = _pane()!.ctx;
    ctx.previewPatch!(grass(2));
    await wait(180);
    ctx.previewPatch!(grass(5));
    await wait(180);
    expect(solver.repaints).toHaveLength(2);
    solver.repaints[1].res({ ok: true, result: { image: image(5), mode: 'route' } });
    await flush();
    solver.repaints[0].res({ ok: true, result: { image: image(2), mode: 'route' } });
    await flush();
    expect(puts.at(-1)).toBe(5);
    main().querySelector<HTMLButtonElement>('.rp-wt')!.click();
    ctx.previewPatch!(grass(9));
    await wait(180);
    expect(solver.repaints).toHaveLength(2);
  });

  it("switching to What constrains repaints in 'cause' mode and lists the present categories as text", async () => {
    await overlayOn();
    const modes = main().querySelector<HTMLElement>('.rp-wtmode')!;
    expect([...modes.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.dataset.mode)).toEqual(['route', 'cost', 'cause', 'rows']);
    expect(modes.querySelector('[data-mode="cause"]')!.textContent).toBe(t('route.insp.mode.cause'));
    modes.querySelector<HTMLButtonElement>('[data-mode="cause"]')!.click();
    expect(solver.repaints[0].req).toMatchObject({ mode: 'cause' });
    const cause = { present: [{ key: 'flags2:0', colour: '#f362dd', labelKey: 'route.cat.flags2_0', share: 0.7 }, { key: 'terrain:slope', colour: '#575f6c', labelKey: 'route.cat.terrain_slope', share: 0.3 }], barrier: true };
    solver.repaints[0].res({ ok: true, result: { image: { ...image(4), mode: 'cause', cause }, mode: 'cause' } as never });
    await flush();
    const legend = document.querySelector('.rp-legend')!.textContent!;
    expect(legend).toContain(t('route.insp.legendCause'));
    expect(legend).toContain(t('route.cat.flags2_0'));
    expect(legend).toContain(t('route.cat.terrain_slope'));
    expect(legend).toContain(t('route.insp.legend.blocked'));
    expect(legend).toContain(t('route.insp.legendCauseNote'));
  });

  it('switching to Cost × repaints from the window without a solve, with its own legend; refused, it solves once', async () => {
    await overlayOn();
    const solves = solver.calls.length;
    const modes = main().querySelector<HTMLElement>('.rp-wtmode')!;
    expect(modes.hidden).toBe(false);
    expect(modes.getAttribute('role')).toBe('group');
    modes.querySelector<HTMLButtonElement>('[data-mode="cost"]')!.click();
    expect(solver.repaints[0].req).toMatchObject({ mode: 'cost' });
    solver.repaints[0].res({ ok: true, result: { image: image(3, 'cost'), mode: 'cost' } });
    await flush();
    expect(solver.calls.length).toBe(solves);
    const legend = document.querySelector('.rp-legend')!.textContent!;
    expect(legend).toContain(t('route.insp.legendCost'));
    expect(legend).toContain('×1.5');
    expect(legend).toContain('×3+');
    // back to Routing weight with no window in the worker: one solve asks for the image in that mode
    modes.querySelector<HTMLButtonElement>('[data-mode="route"]')!.click();
    solver.repaints[1].res({ ok: false, reason: 'no cached window' });
    await flush();
    expect(solver.calls.length).toBe(solves + 1);
    expect(solver.calls.at(-1)!.req).toMatchObject({ weightImage: true, weightMode: 'route' });
  });

  it('while a new mode\'s image is pending the overlay is dimmed and the label and legend say so', async () => {
    await overlayOn();
    const paint = () => (map.getLayer('rp-weight') as unknown as { paint: Record<string, number> }).paint['raster-opacity'];
    expect(paint()).toBe(0.8);
    main().querySelector<HTMLButtonElement>('.rp-wtmode [data-mode="cost"]')!.click();
    expect(main().querySelector('.rp-wt')!.textContent).toBe(t('route.insp.weightLoading'));
    expect(paint()).toBeLessThan(0.8);
    const legend = document.querySelector('.rp-legend')!.textContent!;
    expect(legend).toContain(t('route.insp.weightLoading'));
    expect(legend).not.toContain('×1000+');
    solver.repaints[0].res({ ok: true, result: { image: image(3, 'cost'), mode: 'cost' } });
    await flush();
    expect(paint()).toBe(0.8);
    expect(main().querySelector('.rp-wt')!.textContent).toBe(t('route.insp.weight'));
    expect(document.querySelector('.rp-legend')!.textContent).toContain(t('route.insp.legendCost'));
  });

  it('Reset to preset previews the preset, and a later mode switch repaints with no patch', async () => {
    await overlayOn();
    main().querySelector<HTMLButtonElement>('#rp-tab-method')!.click();
    const cell = main().querySelector<HTMLInputElement>('input[data-row="9"][data-field="cost_x"]')!;
    cell.value = '2';
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    expect(_pane()!.session.inputs.patch).not.toBeNull();
    main().querySelector<HTMLButtonElement>('.rm-reset')!.click();
    await wait(180);
    expect(solver.repaints.at(-1)!.req).not.toHaveProperty('presetPatch');
    const n = solver.repaints.length;
    main().querySelector<HTMLButtonElement>('.rp-wtmode [data-mode="cost"]')!.click();
    expect(solver.repaints).toHaveLength(n + 1);
    expect(solver.repaints.at(-1)!.req).toMatchObject({ mode: 'cost' });
    expect(solver.repaints.at(-1)!.req).not.toHaveProperty('presetPatch');
  });

  it("a new method found for the same ends repaints with that method's patch, not the last preview's", async () => {
    await overlayOn();
    const s = _pane()!.session;
    _pane()!.ctx.previewPatch!(grass(4));
    await wait(180);
    solver.repaints[0].res({ ok: true, result: { image: image(4), mode: 'route' } });
    await flush();
    s.inputs.presetId = 'pnas-wu2023';
    s.inputs.patch = null;
    findBtn().click();
    solver.calls.at(-1)!.res({ ok: true, result: { ...FIXTURE_RESULT, weightImage: image(6) } as unknown as RouteResult });
    await flush();
    main().querySelector<HTMLButtonElement>('.rp-wtmode [data-mode="cost"]')!.click();
    expect(solver.repaints.at(-1)!.req).toMatchObject({ preset: 'pnas-wu2023', mode: 'cost' });
    expect(solver.repaints.at(-1)!.req).not.toHaveProperty('presetPatch');
  });

  it('a repaint names the shown route, and its reply is dropped once the ends move', async () => {
    await overlayOn();
    const s = _pane()!.session;
    _pane()!.ctx.previewPatch!(grass(2));
    await wait(180);
    expect(solver.repaints[0].req).toMatchObject({ from: s.resultInputs!.a!.lngLat, to: s.resultInputs!.b!.lngLat, lineType: s.resultInputs!.lineType });
    s.inputs.b = { lngLat: [-117.5, 44.0], hit: null };
    findBtn().click();
    const moved = image(9);
    solver.calls.at(-1)!.res({ ok: true, result: { ...FIXTURE_RESULT, weightImage: moved } as unknown as RouteResult });
    await flush();
    solver.repaints[0].res({ ok: true, result: { image: image(2), mode: 'route' } });
    await flush();
    expect(s.result!.weightImage).toBe(moved);
    expect(puts.at(-1)).toBe(9);
    expect(solver.repaints).toHaveLength(1);
  });

  it('closing the pane and new ends release the worker window', async () => {
    await overlayOn();
    expect(dropWindow).toHaveBeenCalledTimes(1);           // the first Find: new ends
    closeRoute();
    expect(dropWindow).toHaveBeenCalledTimes(2);
    expect(canvases.size).toBe(1);
    expect([...canvases].every((c) => (c as HTMLCanvasElement).width === 0)).toBe(true);
  });
});

describe('route pane saved defaults', () => {
  const save = (o: Record<string, unknown>) => localStorage.setItem('tm-route-prefs', JSON.stringify({ v: 1, ...o }));
  afterEach(() => localStorage.removeItem('tm-route-prefs'));

  it('a new session starts from the saved method, line type, colour, surface, stretch and snap radius', () => {
    save({ presetId: 'straight-line-quick', lineType: 'ac345', colour: 'plain', showSurface: false, altStretch: 0.2, snapKm: 5 });
    openRoutePanel();
    expect(_pane()!.session).toMatchObject({
      inputs: { presetId: 'straight-line-quick', lineType: 'ac345' }, colour: 'plain', showSurface: false, altStretch: 0.2, snapKm: 5,
    });
    expect(routePanel().querySelector<HTMLSelectElement>('.ri-select')!.value).toBe('straight-line-quick');
  });

  it('runs Find alternatives after a successful Find route when the default is on, with the saved count', async () => {
    save({ autoAlternatives: true, altCount: 2 });
    await openWithEnds();
    findBtn().click();
    solver.calls[0].res({ ok: true, result: FIXTURE_RESULT });
    await flush();
    expect(solver.calls).toHaveLength(2);
    expect(solver.calls[1].req).toMatchObject({ surface: true, alternatives: 2, profile: false });
  });

  it('auto-alternatives follow only a Find that landed a result: not a cancelled or refused re-solve', async () => {
    save({ autoAlternatives: true });
    await openWithEnds();
    findBtn().click();
    solver.calls[0].res({ ok: true, result: FIXTURE_RESULT });
    await flush();
    expect(routeLine).toHaveBeenCalledTimes(2);
    solver.calls[1].res({ ok: false, reason: 'busy' });
    await flush();
    findBtn().click();                       // Re-solve, same ends: cancelled from the header chip
    expect(routeLine).toHaveBeenCalledTimes(3);
    main().querySelector<HTMLButtonElement>('.rp-resolving-cancel')!.click();
    await flush();
    expect(routeLine).toHaveBeenCalledTimes(3);
    findBtn().click();                       // refused
    solver.calls.at(-1)!.res({ ok: false, reason: 'no path' });
    await flush();
    expect(routeLine).toHaveBeenCalledTimes(4);
    findBtn().click();                       // lands: one alternatives solve
    solver.calls.at(-1)!.res({ ok: true, result: { ...FIXTURE_RESULT } });
    await flush();
    expect(routeLine).toHaveBeenCalledTimes(6);
    expect(solver.calls.at(-1)!.req).toMatchObject({ surface: true, alternatives: 3 });
  });

  it('remembers the method and line type chosen in the panel for the next route', async () => {
    openRoutePanel();
    const sel = routePanel().querySelector<HTMLSelectElement>('.ri-select')!;
    sel.value = 'straight-line-quick';
    sel.dispatchEvent(new Event('change'));
    expect(loadRoutePrefs(localStorageAdapter())).toMatchObject({ presetId: 'straight-line-quick' });
    closeRoute();
    acceptNotice('route', ROUTE_NOTICE_VERSION);
    openRoutePanel();
    expect(_pane()!.session.inputs.presetId).toBe('straight-line-quick');
  });

  it('does not run alternatives on its own by default', async () => {
    await solved();
    expect(solver.calls).toHaveLength(1);
  });
});

describe('route result header Map menu', () => {
  it('keeps the sub-tabs and badge in the header and the map controls in a Map menu', async () => {
    await solved();
    const head = main().querySelector('.rp-head')!;
    expect(head.querySelectorAll('.rp-tab')).toHaveLength(6);
    expect(head.querySelector(':scope > .rp-wt, :scope > .rp-insp, :scope > .rp-wtmode')).toBeNull();
    const btn = head.querySelector<HTMLButtonElement>('.rp-mapbtn')!;
    const menu = head.querySelector<HTMLElement>('[role="menu"]')!;
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(menu.hidden).toBe(true);
    expect(menu.querySelector('.rp-wt')!.getAttribute('role')).toBe('menuitemcheckbox');
  });

  it('opens on click, moves with arrows, and Esc closes it and returns focus without touching Inspect', async () => {
    await solved();
    const btn = main().querySelector<HTMLButtonElement>('.rp-mapbtn')!;
    const menu = main().querySelector<HTMLElement>('[role="menu"]')!;
    main().querySelector<HTMLButtonElement>('.rp-insp')!.click();    // Inspect on
    btn.click();
    expect(menu.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(menu.querySelector('.rp-wt'));
    menu.querySelector('.rp-wt')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(menu.querySelector('.rp-insp'));   // the mode switch is hidden while weights are off
    menu.querySelector('.rp-insp')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
    expect(menu.querySelector('.rp-insp')!.getAttribute('aria-checked')).toBe('true');
  });

  it('a rebuilt header reopens the menu on the same item; a detached menu leaves the document alone', async () => {
    await solved();
    main().querySelector<HTMLButtonElement>('#rp-tab-method')!.click();
    const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener');
    main().querySelector<HTMLButtonElement>('.rp-mapbtn')!.click();
    main().querySelector('.rp-wt')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const old = main().querySelector('.rp-head')!;
    const done = _pane()!.ctx.resolve(null);            // a refine solve: refreshResult replaces the header
    solver.calls.at(-1)!.res({ ok: true, result: { ...FIXTURE_RESULT, lengthMi: 251.3 } });
    await done;
    await flush();
    const head = main().querySelector('.rp-head')!;
    expect(head).not.toBe(old);
    expect(head.querySelector<HTMLElement>('[role="menu"]')!.hidden).toBe(false);
    expect(document.activeElement).toBe(head.querySelector('.rp-insp'));
    const listeners = (spy: typeof add) => spy.mock.calls.filter((c) => c[0] === 'keydown' || c[0] === 'pointerdown').length;
    expect(listeners(add) - listeners(remove)).toBe(2);   // only the open menu's pair
    const esc = () => { const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e; };
    expect(esc().defaultPrevented).toBe(true);           // closes the reopened menu
    expect(esc().defaultPrevented).toBe(false);
    expect(listeners(add) - listeners(remove)).toBe(0);
    // A menu taken out of the page with its listeners on: the next Esc passes through and unhooks them.
    main().querySelector<HTMLButtonElement>('.rp-mapbtn')!.click();
    main().querySelector('.rp-head')!.remove();
    expect(esc().defaultPrevented).toBe(false);
    expect(listeners(add) - listeners(remove)).toBe(0);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe('route pane Method-grid row highlight', () => {
  afterEach(() => vi.restoreAllMocks());
  const coords = [[0, 1], [1, 1], [1, 0], [0, 0]];
  const rowsImage = () => ({ rgba: new Uint8ClampedArray(16).fill(2), width: 2, height: 2, coordinates: coords, mode: 'rows' as const });
  const weightResult = (): RouteResult => ({
    ...FIXTURE_RESULT, weightImage: { rgba: new Uint8ClampedArray(16).fill(1), width: 2, height: 2, coordinates: coords, mode: 'route' as const },
  } as unknown as RouteResult);
  const picks = [{ row: 3, band: 'landcover' as const, note: 'Wetland', slot: 0 }, { row: 5, band: 'slope' as const, slot: 1 }];
  const wtFetches = () => vi.mocked(routeLine).mock.calls.filter(([r]) => r.weightImage);

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      return {
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: () => {},
      } as unknown as CanvasRenderingContext2D;
    } as never);
  });

  it('with a held window a pick sends one repaintRows, no solve, draws rp-weight and lists the picks; no url:write', async () => {
    const wrote = vi.fn();
    on('url:write', wrote);
    await solved();
    _pane()!.ctx.highlightRows!(picks);
    expect(solver.rows).toHaveLength(1);
    expect(solver.rows[0].req).toMatchObject({ lineType: _pane()!.session.inputs.lineType, rows: picks });
    solver.rows[0].res({ ok: true, result: { image: rowsImage() } });
    await flush();
    expect(solver.calls).toHaveLength(1);
    expect(map.sources.has('rp-weight')).toBe(true);
    const legend = document.querySelector('.rp-legend')!.textContent!;
    expect(legend).toContain(t('route.legend.rows'));
    expect(legend).toContain('Wetland');
    expect(legend).toContain('slope');
    expect(legend).toContain(t('route.legend.rowsThin'));
    expect(wrote).not.toHaveBeenCalled();
  });

  it('a result with uploaded layers sends their add_rows and hashes with the repaint (the window is theirs); none, no uploads key', async () => {
    await solved();
    _pane()!.ctx.highlightRows!(picks);
    expect(solver.rows[0].req).not.toHaveProperty('uploads');
    const H = 'ab12cd34ef56ab78', add_rows = [{ layer: H, label: 'Corridor', route_w: 3, cost_x: 1 }];
    _pane()!.session.resultInputs!.patch = { add_rows };
    _pane()!.ctx.highlightRows!([picks[0]]);
    expect(solver.rows.at(-1)!.req).toMatchObject({ presetPatch: { add_rows }, uploads: [H] });
  });

  it('a Map pick turns Inspect on with the overlay, and clearing the picks turns both off', async () => {
    await solved();
    expect(state.routeInspect).toBe(false);
    _pane()!.ctx.highlightRows!(picks);
    expect(state.routeInspect).toBe(true);
    _pane()!.ctx.highlightRows!([]);
    expect(state.routeInspect).toBe(false);
  });

  it('a refusal that is not a window problem spends no weight fetch and shows the reason', async () => {
    await solved();
    const reason = 'the adj band is read only by an exemption that is off: turn the exemption on to show this row';
    solver.autoRows = () => ({ ok: false, reason });
    _pane()!.ctx.highlightRows!(picks);
    await flush();
    expect(wtFetches()).toHaveLength(0);
    expect(document.querySelector('.rp-legend')!.textContent).toContain(t('route.mg.hlRefused', { reason }));
  });

  it('with no window in the worker: exactly one weight fetch (mode route), then one more repaintRows', async () => {
    await solved();
    _pane()!.ctx.highlightRows!(picks);
    solver.rows[0].res({ ok: false, reason: 'no cached window' });
    await flush();
    expect(wtFetches()).toHaveLength(1);
    expect(solver.calls[1].req).toMatchObject({ weightImage: true, weightMode: 'route' });
    solver.calls[1].res({ ok: true, result: weightResult() });
    await flush();
    expect(solver.rows).toHaveLength(2);
    solver.rows[1].res({ ok: true, result: { image: rowsImage() } });
    await flush();
    expect(map.sources.has('rp-weight')).toBe(true);
    expect(wtFetches()).toHaveLength(1);
  });

  it('a pick while a solve is pending: after it settles, one fetch, then repaintRows', async () => {
    await solved();
    const done = _pane()!.ctx.resolve(null);               // a re-solve of the shown route, left pending
    expect(solver.calls).toHaveLength(2);
    _pane()!.ctx.highlightRows!(picks);
    solver.rows[0].res({ ok: false, reason: 'no cached window' });
    await flush();
    expect(wtFetches()).toHaveLength(0);                    // the fetch waits for the pending solve
    solver.calls[1].res({ ok: true, result: FIXTURE_RESULT });
    await done;
    await flush();
    const fetches = vi.mocked(routeLine).mock.calls.length;
    expect(solver.calls).toHaveLength(fetches);
    const open = solver.calls.at(-1)!;
    expect(open.req).toMatchObject({ weightImage: true, weightMode: 'route' });
    const before = solver.rows.length;
    open.res({ ok: true, result: weightResult() });
    await flush();
    expect(solver.rows.length).toBeGreaterThan(before);
    expect(solver.rows.length).toBeLessThanOrEqual(before + 1);
  });

  it('a window refused twice: one fetch in all, the refusal line, no third call', async () => {
    await solved();
    let n = 0;
    solver.autoRows = (count) => { n = count; return count > 6 ? { ok: true, result: { image: rowsImage() } } : { ok: false, reason: 'no cached window' }; };
    const orig = vi.mocked(routeLine).getMockImplementation()!;
    onTestFinished(() => { vi.mocked(routeLine).mockImplementation(orig); });
    vi.mocked(routeLine).mockImplementation(((req: RouteRequest) => Promise.resolve({ ok: true, result: req.weightImage ? weightResult() : FIXTURE_RESULT })) as never);
    _pane()!.ctx.highlightRows!(picks);
    await flush();
    expect(n).toBe(2);
    expect(vi.mocked(repaintRows)).toHaveBeenCalledTimes(2);
    expect(wtFetches()).toHaveLength(1);
    expect(document.querySelector('.rp-legend')!.textContent).toContain(t('route.mg.hlRefused', { reason: 'no cached window' }));
  });

  it('a re-solve of the same route spends no second window fetch', async () => {
    await solved();
    const orig = vi.mocked(routeLine).getMockImplementation()!;
    onTestFinished(() => { vi.mocked(routeLine).mockImplementation(orig); });
    vi.mocked(routeLine).mockImplementation(((req: RouteRequest) => Promise.resolve({ ok: true, result: req.weightImage ? weightResult() : FIXTURE_RESULT })) as never);
    solver.autoRows = () => ({ ok: false, reason: 'no cached window' });
    _pane()!.ctx.highlightRows!(picks);
    await flush();
    const afterFirst = vi.mocked(routeLine).mock.calls.length;
    expect(vi.mocked(repaintRows)).toHaveBeenCalledTimes(2);
    await _pane()!.ctx.resolve(null);
    await flush();
    expect(vi.mocked(routeLine).mock.calls.length).toBe(afterFirst + 1);   // the solve itself, no extra weight fetch
    expect(document.querySelector('.rp-legend')!.textContent).toContain(t('route.mg.hlRefused', { reason: 'no cached window' }));
  });

  it('an exemption pick is named as the exemption of its row in the legend', async () => {
    await solved();
    const pr = routePreset(_pane()!.session.inputs.presetId)!;
    const row = pr.rows.findIndex((r) => r.except?.length);
    const r = pr.rows[row];
    _pane()!.ctx.highlightRows!([{ row, band: r.band, ...(r.note !== undefined ? { note: r.note } : {}), except: 0, slot: 0 }]);
    solver.rows[0].res({ ok: true, result: { image: rowsImage() } });
    await flush();
    expect(document.querySelector('.rp-legend')!.textContent).toContain(t('route.mg.aria.except', { label: r.except![0].label, row: r.note ?? r.band }));
  });

  it("a Find in rows mode asks for 'route'", async () => {
    await solved();
    _pane()!.ctx.highlightRows!(picks);
    solver.rows[0].res({ ok: true, result: { image: rowsImage() } });
    await flush();
    findBtn().click();
    expect(solver.calls.at(-1)!.req).toMatchObject({ weightImage: true, weightMode: 'route' });
  });

  it('empty picks turn the overlay off; Map ▾ rows is disabled while empty and enabled with picks', async () => {
    await solved();
    const rowsBtn = () => main().querySelector<HTMLButtonElement>('.rp-wtmode [data-mode="rows"]')!;
    expect(rowsBtn().disabled).toBe(true);
    _pane()!.ctx.highlightRows!(picks);
    solver.rows[0].res({ ok: true, result: { image: rowsImage() } });
    await flush();
    expect(rowsBtn().disabled).toBe(false);
    expect(rowsBtn().getAttribute('aria-checked')).toBe('true');
    _pane()!.ctx.highlightRows!([]);
    await flush();
    expect(map.sources.has('rp-weight')).toBe(false);
    expect(main().querySelector('.rp-wt')!.getAttribute('aria-checked')).toBe('false');
    expect(rowsBtn().disabled).toBe(true);
    expect(main().querySelector('.rp-wtmode [data-mode="route"]')!.getAttribute('aria-checked')).toBe('true');
  });

  it('another mode keeps the picks; a base-preset change clears them, Save as custom (same base) keeps them', async () => {
    localStorage.setItem('tm-route-presets', JSON.stringify({ v: 1, items: [{ id: 'c1', name: 'Mine', base: 'tm-default', patch: {}, savedAt: '2026-10-29T00:00:00Z' }] }));
    await solved();
    const pn = _pane()!, s = pn.session;
    s.inputs.presetId = 'tm-default';
    pn.ctx.rerender();
    pn.ctx.highlightRows!(picks);
    solver.rows[0].res({ ok: true, result: { image: rowsImage() } });
    await flush();
    main().querySelector<HTMLButtonElement>('.rp-wtmode [data-mode="cost"]')!.click();
    expect(s.highlight).toEqual(picks);
    s.inputs.presetId = 'custom:c1';
    pn.ctx.rerender();
    expect(s.highlight).toEqual(picks);
    s.inputs.presetId = 'pnas-wu2023';
    pn.ctx.rerender();
    expect(s.highlight).toEqual([]);
  });
});
