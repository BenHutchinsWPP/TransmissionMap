// @vitest-environment jsdom
// Template actions on a recording fake map built by the real layer builders:
// conditionForBin builds each role's condition (kV range, fuel codes, facet
// values, region code, category), mergeWhere replaces only the fields it adds,
// and a frame's handler refuses what the page did not send (other layer, bad
// field or group, ids it never sent, > 500 ids, a fly outside its features,
// unknown kinds), commits each where / select as one url:write and one undo
// step with an Undo toast, rate-limits commits, flies without a toast and opens
// the table through table-open.ts. Real map-api / undo / filters.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';

vi.mock('../basemap.js', () => ({ switchBasemap: vi.fn(), switchProjection: vi.fn(), setBasemapLabels: vi.fn() }));
vi.mock('../terrain.js', () => ({ setTerrain3d: vi.fn(), setBuildings3d: vi.fn(), setHillshade: vi.fn() }));
vi.mock('../ui/table-open.js', () => ({ openTable: vi.fn(async () => {}), zoomToSelection: vi.fn(async () => {}) }));
vi.mock('../services/service-render.js', () => ({ renderServices: vi.fn() }));

import { state } from '../state.js';
import { addAllLayers } from '../layers/add-all-layers.js';
import { seedView, currentView } from '../view-state.js';
import { emit, on } from '../state-bus.js';
import { formatUrlState } from '../url-state-codec.js';
import '../url-state.js';
import { undo } from '../undo.js';
import { setWhere } from '../map-api.js';
import { openTable } from '../ui/table-open.js';
import { conditionForBin, mergeWhere, templateActions, flyBox, RATE_MAX, RATE_MS, MIN_SPAN } from './template-actions.js';
import type { TemplateAction } from '../sandbox/canvas-host.js';

type Spec = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown };
const fitBounds = vi.fn();

function recordingMap() {
  const layers = new Map<string, Spec>();
  const sources = new Set<string>();
  const known: Record<string, unknown> = {
    on: () => {}, off: () => {},
    addLayer: (spec: Spec) => { layers.set(spec.id, structuredClone(spec)); },
    addSource: (id: string) => { sources.add(id); },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => (sources.has(id) ? { setUrl: () => {} } : undefined),
    getZoom: () => 5, getCenter: () => ({ lat: 39.5, lng: -98.35 }), getBearing: () => 0, getPitch: () => 0,
    fitBounds, getContainer: () => document.createElement('div'),
    getPaintProperty: (id: string, p: string) => layers.get(id)?.paint?.[p],
    getLayoutProperty: (id: string, p: string) => layers.get(id)?.layout?.[p],
    setPaintProperty: (id: string, p: string, v: unknown) => { const l = layers.get(id)!; l.paint = { ...l.paint, [p]: v }; },
    setLayoutProperty: (id: string, p: string, v: unknown) => { const l = layers.get(id)!; l.layout = { ...l.layout, [p]: v }; },
    setFilter: (id: string, f: unknown) => { const l = layers.get(id)!; l.filter = f ?? undefined; },
  };
  state.map = new Proxy(known, { get: (t, k: string) => t[k] ?? vi.fn() }) as unknown as typeof state.map;
  state.mapReady = true;
  addAllLayers();
}

const snap = () => formatUrlState(currentView()).join('&');
let writes = 0;
on('url:write', () => { writes++; });

beforeEach(() => {
  vi.useFakeTimers();
  state.map = null;
  state.mapReady = false;
  state.layerVisibility = {};
  state.legendFilters = {};
  state.layerFilters = {};
  state.genMode = {};
  seedView({});
  recordingMap();
  emit('map:ready');
  vi.advanceTimersByTime(500);
  fitBounds.mockClear();
  vi.mocked(openTable).mockClear();
  document.body.replaceChildren();
  writes = 0;
});
afterEach(() => { vi.useRealTimers(); });

const GEN = 'eia-generators';
const pt = (id: string | number, x: number, y: number) => ({ type: 'Feature' as const, id, geometry: { type: 'Point' as const, coordinates: [x, y] }, properties: {} });
const PAYLOAD = {
  rows: [
    { energy_source: 'gas', count: 3, sum: 10 }, { energy_source: 'coal', count: 2, sum: 5 },
    { energy_source: 'other', count: 1, sum: 1 }, { energy_source: null, count: 1, sum: 1 },
  ],
  roles: { by: [{ field: 'energy_source', role: 'category' as const }], measure: { name: 'nameplate_mw' } },
  labels: { 'value.energy_source.gas': 'Gas' } as Record<string, string>,
  features: [pt('1:1', -100, 40), pt('1:2', -99, 41), pt('2:1', -98, 42)],
};
const toast = () => document.querySelector('.tpl-toast');
const make = (over: Partial<Parameters<typeof templateActions>[0]> = {}) => templateActions({ templateId: 'composition', layer: GEN, payload: PAYLOAD, ...over });
const act = (h: (a: TemplateAction) => void, kind: TemplateAction['kind'], payload: unknown) => h({ kind, payload });
const act2 = (h: ReturnType<typeof templateActions>, kind: TemplateAction['kind'], payload: unknown, reset: () => void, release: () => void = () => {}) => h({ kind, payload }, { reset, release });

describe('conditionForBin', () => {
  const c = (layer: string, field: string, bin: unknown) => conditionForBin(layer, field, bin);
  it('a kV class → its numeric range; unknown and non-classes refused', () => {
    expect(c('osm-transmission-lines', 'nominal_kv', '300-499')).toEqual({ ok: true, result: [
      { field: 'nominal_kv', op: '>=', value: 300 }, { field: 'nominal_kv', op: '<', value: 500 }] });
    expect(c('osm-transmission-lines', 'nominal_kv', '550+')).toEqual({ ok: true, result: [{ field: 'nominal_kv', op: '>=', value: 550 }] });
    expect(c('hifld-transmission-lines', 'VOLTAGE', '<100')).toEqual({ ok: true, result: [
      { field: 'VOLTAGE', op: '>', value: 0 }, { field: 'VOLTAGE', op: '<', value: 100 }] });
    expect(c('osm-transmission-lines', 'nominal_kv', 'unknown').ok).toBe(false);
    expect(c('osm-transmission-lines', 'nominal_kv', '345').ok).toBe(false);
    expect(c('osm-transmission-lines', 'nominal_kv', 'constructor').ok).toBe(false);
  });
  it('a fuel bucket → `in` its EIA codes / OSM values; other → `not_in` the rest', () => {
    expect(c(GEN, 'energy_source', 'coal')).toEqual({ ok: true, result: [{ field: 'energy_source', op: 'in', value: ['BIT', 'SUB', 'LIG', 'PC'] }] });
    expect(c('osm-plants-points', 'source', 'oil')).toEqual({ ok: true, result: [{ field: 'source', op: 'in', value: ['oil', 'diesel'] }] });
    const other = c(GEN, 'energy_source', 'other');
    expect(other.ok && other.result[0].op).toBe('not_in');
    expect(other.ok && other.result[1]).toEqual({ field: 'energy_source', op: 'has' });      // a feature with no value is not "other"
    expect(other.ok && (other.result[0].value as string[])).toEqual(expect.arrayContaining(['NG', 'WND', 'BIT']));
    expect(c(GEN, 'energy_source', 'pumped_storage').ok).toBe(false);
    expect(c(GEN, 'energy_source', 'plutonium').ok).toBe(false);
  });
  it("another facet's bucket → `in` its values", () => {
    expect(c(GEN, 'sector_name', 'ipp')).toEqual({ ok: true, result: [{ field: 'sector_name', op: 'in', value: ['IPP Non-CHP', 'IPP CHP'] }] });
  });
  it('a region code → contains_any; a category → =; a field with no condition refused', () => {
    expect(c(GEN, 'states', 'TX')).toEqual({ ok: true, result: [{ field: 'states', op: 'contains_any', value: ['TX'] }] });
    expect(c(GEN, 'gen_status', 'OP')).toEqual({ ok: true, result: [{ field: 'gen_status', op: '=', value: 'OP' }] });
    expect(c(GEN, 'technology', 'Solar').ok).toBe(false);          // a display field
    expect(c(GEN, 'energy_source', { $gt: 1 }).ok).toBe(false);
    expect(c('no-such-layer', 'x', 'y').ok).toBe(false);
  });
});

describe('conditionForBin: bins and dates', () => {
  it('a numeric bin → >= lo ∧ < hi from its own edges; bad edges and non-number fields refused', () => {
    expect(conditionForBin(GEN, 'nameplate_mw', 3, { lo: 20, hi: 50 })).toEqual({ ok: true, result: [
      { field: 'nameplate_mw', op: '>=', value: 20 }, { field: 'nameplate_mw', op: '<', value: 50 }] });
    expect(conditionForBin('hifld-substations', 'max_kv', 0, { lo: 100, hi: 200 }).ok).toBe(true);
    for (const r of [{ lo: 5, hi: 5 }, { lo: 'a', hi: 3 }, { lo: 0, hi: Infinity }, { lo: Number.NaN, hi: 1 }]) {
      expect(conditionForBin(GEN, 'nameplate_mw', 0, r).ok, JSON.stringify(r)).toBe(false);
    }
    expect(conditionForBin(GEN, 'gen_status', 0, { lo: 0, hi: 1 }).ok).toBe(false);
  });
  it('a month or a year of a date field → its first day to its last, as ISO text', () => {
    expect(conditionForBin('dc-moratoriums', 'last_event', '2025-02')).toEqual({ ok: true, result: [
      { field: 'last_event', op: '>=', value: '2025-02-01' }, { field: 'last_event', op: '<=', value: '2025-02-31' }] });
    expect(conditionForBin('dc-moratoriums', 'last_event', 2025).ok).toBe(true);
    for (const bad of ['2025-13', '2025-2', 'x', '1700']) expect(conditionForBin('dc-moratoriums', 'last_event', bad).ok, bad).toBe(false);
  });
});

describe('templateActions: a binned field', () => {
  const BINNED = {
    rows: [
      { bin: 0, lo: 0, hi: 10, count: 4, sum: 20 }, { bin: 1, lo: 10, hi: 20, count: 2, sum: 30 }, { bin: null, count: 1, sum: 0 },
    ],
    roles: { by: [], measure: { name: 'nameplate_mw' }, bins: { field: 'nameplate_mw', scale: 'lin' as const } },
    labels: {} as Record<string, string>, features: PAYLOAD.features,
  };
  it('where on a bin → its own range; a bin it was not sent, or no-value, refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = make({ templateId: 'distribution', payload: BINNED as never });
    act(h, 'where', { field: 'nameplate_mw', bin: 7 });
    act(h, 'where', { field: 'nameplate_mw', bin: null });
    expect(writes).toBe(0);
    act(h, 'where', { field: 'nameplate_mw', bin: 1 });
    expect(state.where[GEN]).toEqual([{ field: 'nameplate_mw', op: '>=', value: 10 }, { field: 'nameplate_mw', op: '<', value: 20 }]);
    expect(writes).toBe(1);
    // A time field is not a group a frame may filter by (a net timeline's retirement rows sit under the opening year).
    const tl = make({ templateId: 'timeline', payload: { ...PAYLOAD, rows: [{ op_year: 2020, count: 1 }], roles: { ...PAYLOAD.roles, by: [], time: { field: 'op_year', bin: 'year' as const } } } as never });
    act(tl, 'where', { field: 'op_year', bin: 2020 });
    expect(writes).toBe(1);
    warn.mockRestore();
  });
});

describe('conditionForBin: a value-less "other" bucket', () => {
  it('→ not_in every other bucket\'s values plus a has guard', () => {
    const r = conditionForBin('osm-pipelines-lines', 'substance', 'other');
    expect(r.ok && r.result.map(x => x.op)).toEqual(['not_in', 'has']);
    expect(r.ok && r.result[0].value).toEqual(expect.any(Array));
  });
});

describe('mergeWhere', () => {
  it('replaces a field in the place it held, so the same group again is the same list', () => {
    const mw = { field: 'nameplate_mw', op: '>=' as const, value: 100 };
    const coal = { field: 'energy_source', op: 'in' as const, value: ['BIT'] };
    const gas = { field: 'energy_source', op: 'in' as const, value: ['NG'] };
    const st = { field: 'gen_status', op: '=' as const, value: 'OP' };
    expect(mergeWhere([coal, mw, st], [gas])).toEqual([gas, mw, st]);
    expect(mergeWhere([gas, mw], [gas])).toEqual([gas, mw]);
    const kv = [{ field: 'k', op: '>=' as const, value: 1 }, { field: 'k', op: '<' as const, value: 2 }];
    expect(mergeWhere([mw, ...kv], kv)).toEqual([mw, ...kv]);
  });
  it('keeps conditions on other fields (AND) and replaces those on the fields it adds', () => {
    const mw = { field: 'nameplate_mw', op: '>=' as const, value: 100 };
    const coal = { field: 'energy_source', op: 'in' as const, value: ['BIT'] };
    const gas = { field: 'energy_source', op: 'in' as const, value: ['NG'] };
    expect(mergeWhere([mw, coal], [gas])).toEqual([mw, gas]);
    expect(mergeWhere([], [gas])).toEqual([gas]);
  });
});

const undoBtn = () => toast()?.querySelector('.tpl-toast-undo') as HTMLButtonElement | null;

describe('templateActions: Undo is for the step the action recorded', () => {
  it('the same group twice: no new step, a neutral toast without Undo, and the frame is told to forget it', () => {
    const reset = vi.fn();
    const h = make();
    act2(h, 'where', { field: 'energy_source', bin: 'gas' }, reset);
    expect(undoBtn()).not.toBeNull();
    expect(reset).not.toHaveBeenCalled();
    const before = snap();
    act2(h, 'where', { field: 'energy_source', bin: 'gas' }, reset);
    expect(snap()).toBe(before);
    expect(toast()?.textContent).toMatch(/already shows this/);
    expect(undoBtn()).toBeNull();
    expect(reset).toHaveBeenCalledOnce();
    expect(undo()).toBe(true);       // exactly one step was recorded
    expect(undo()).toBe(false);
  });

  it('a committed click hands keyboard focus back to the page, so Ctrl+Z reaches its undo', () => {
    // Keys typed while a frame has focus go to the frame's document, never the page's keydown
    // handler: a click in the chart leaves focus there unless the action gives it back.
    const baseline = snap();
    const reset = vi.fn(), release = vi.fn();
    const h = make();
    act2(h, 'where', { field: 'energy_source', bin: 'gas' }, reset, release);
    expect(release).toHaveBeenCalledOnce();
    expect(undo()).toBe(true);
    expect(snap()).toBe(baseline);
    act2(h, 'select', { ids: ['1:1'] }, reset, release);
    expect(release).toHaveBeenCalledTimes(2);
    act2(h, 'select', { ids: ['1:1'] }, reset, release);      // no change: focus stays in the chart
    act2(h, 'fly', { id: '1:1' }, reset, release);            // camera only: nothing to undo
    act2(h, 'where', { field: 'energy_source', bin: 'coal', kb: true }, reset, release);   // focus goes to Undo instead
    expect(release).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(undoBtn());
  });

  it('another change within the toast\'s 6 s takes its Undo away', () => {
    const h = make();
    act(h, 'where', { field: 'energy_source', bin: 'gas' });
    const btn = undoBtn()!;
    vi.advanceTimersByTime(3000);
    emit('url:write');                   // not a change: the button stays
    expect(btn.isConnected).toBe(true);
    setWhere(GEN, [{ field: 'nameplate_mw', op: '>=', value: 10 }]);
    expect(btn.isConnected).toBe(false);
    expect(undoBtn()).toBeNull();
  });

  it('Undo reverts exactly the action and tells the frame; a refusal tells it too', () => {
    const reset = vi.fn();
    const baseline = snap();
    const h = make();
    act2(h, 'where', { field: 'energy_source', bin: 'gas' }, reset);
    undoBtn()!.click();
    expect(snap()).toBe(baseline);
    expect(reset).toHaveBeenCalledOnce();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    act2(h, 'where', { field: 'energy_source', bin: 'wind' }, reset);
    expect(reset).toHaveBeenCalledTimes(2);
    vi.mocked(console.warn).mockRestore();
  });

  it('a select of the same ids again is a no-op without Undo', () => {
    const h = make();
    act(h, 'select', { ids: ['1:1'] });
    act(h, 'select', { ids: ['1:1'] });
    expect(undoBtn()).toBeNull();
    expect(undo()).toBe(true);
    expect(undo()).toBe(false);
  });

  it('a card rendered with its own where keeps those conditions too, and says so; its Area is untouched', () => {
    const mw = { field: 'nameplate_mw', op: '>=' as const, value: 100 };
    state.area = null;
    const h = make({ where: [mw] });
    act(h, 'where', { field: 'energy_source', bin: 'gas' });
    expect(state.where[GEN]).toEqual([mw, { field: 'energy_source', op: 'in', value: ['NG', 'OG'] }]);
    expect(state.area).toBeNull();
    expect(toast()?.textContent).toMatch(/within this chart's filters/);
    act(h, 'where', { field: 'energy_source', bin: 'gas' });
    expect(undoBtn()).toBeNull();
    expect(undo()).toBe(true);
    expect(undo()).toBe(false);
  });
});

describe('toast keyboard and pointer behaviour', () => {
  it('stays while hovered or focused, closes after 6 s otherwise, and Esc closes it', () => {
    const h = make();
    act(h, 'where', { field: 'energy_source', bin: 'gas' });
    const box = toast()!;
    box.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(20_000);
    expect(box.isConnected).toBe(true);
    box.dispatchEvent(new Event('mouseleave'));
    vi.advanceTimersByTime(5900);
    expect(box.isConnected).toBe(true);
    vi.advanceTimersByTime(200);
    expect(box.isConnected).toBe(false);
    act(h, 'where', { field: 'energy_source', bin: 'coal' });
    toast()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(toast()).toBeNull();
  });

  it('an action made by keyboard (kb) moves focus to Undo; a pointer one leaves focus alone', () => {
    const h = make();
    act(h, 'where', { field: 'energy_source', bin: 'gas' });
    expect(document.activeElement).not.toBe(undoBtn());
    act(h, 'where', { field: 'energy_source', bin: 'coal', kb: true });
    expect(document.activeElement).toBe(undoBtn());
  });
});

describe('templateActions', () => {
  it('where: merges the group into the layer\'s conditions, one url:write and one undo step each, with an Undo toast', () => {
    state.where = { [GEN]: [{ field: 'nameplate_mw', op: '>=', value: 100 }] };
    const h = make();
    act(h, 'where', { field: 'energy_source', bin: 'gas' });
    expect(state.where[GEN]).toEqual([{ field: 'nameplate_mw', op: '>=', value: 100 }, { field: 'energy_source', op: 'in', value: ['NG', 'OG'] }]);
    expect(snap()).toContain('vx=');
    act(h, 'where', { layer: GEN, field: 'energy_source', bin: 'coal' });
    expect(state.where[GEN][1]).toEqual({ field: 'energy_source', op: 'in', value: ['BIT', 'SUB', 'LIG', 'PC'] });
    expect(writes).toBe(2);
    expect(toast()?.textContent).toMatch(/Composition: .*coal/);
    // The toast's Undo takes back the last one; undo again the first.
    (toast()!.querySelector('.tpl-toast-undo') as HTMLButtonElement).click();
    expect(state.where[GEN][1].value).toEqual(['NG', 'OG']);
    expect(toast()).toBeNull();
  });

  it('where from a vega frame: the label maps back to its row key; Other (null) is refused', () => {
    const h = make({ labels: new Map([['energy_source', new Map<string, string | number | null>([['Gas', 'gas'], ['Other', null]])]]) });
    act(h, 'where', { field: 'energy_source', bin: 'Gas' });
    expect(state.where[GEN]).toEqual([{ field: 'energy_source', op: 'in', value: ['NG', 'OG'] }]);
    act(h, 'where', { field: 'energy_source', bin: 'Other' });
    act(h, 'where', { field: 'energy_source', bin: 'gas' });      // a key, not a label this frame drew
    expect(writes).toBe(1);
  });

  it('refuses another layer, a field or group the frame was not sent, a bad payload and an unknown kind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = make();
    act(h, 'where', { layer: 'osm-plants-points', field: 'energy_source', bin: 'gas' });
    act(h, 'where', { field: 'gen_status', bin: 'OP' });
    act(h, 'where', { field: 'energy_source', bin: 'wind' });
    act(h, 'where', { field: 'energy_source', bin: null });
    act(h, 'where', 'energy_source=gas');
    act(h, 'select', { ids: ['9:9'] });
    act(h, 'select', { ids: [] });
    act(h, 'select', { ids: [{ toString: 1 }] });
    act(h, 'table', { ids: ['9:9'] });
    h({ kind: 'drop' as never, payload: {} });
    expect(writes).toBe(0);
    expect(state.where[GEN]).toBeUndefined();
    expect(state.sel).toBeNull();
    expect(openTable).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(10);
    expect(toast()?.textContent).toMatch(/cannot be applied/);
    warn.mockRestore();
  });

  it('select: only ids the frame was sent, ≤ 500; replaces the layer\'s ids, one undo step', () => {
    const baseline = snap();
    const h = make();
    act(h, 'select', { ids: ['1:1', '2:1', '1:1'] });
    expect(state.sel).toEqual({ mode: 'isolate', ids: { [GEN]: ['1:1', '2:1'] } });
    expect(toast()?.textContent).toMatch(/selected 2/);
    const many = Array.from({ length: 501 }, (_, i) => `${i}:1`);
    const big = make({ payload: { ...PAYLOAD, features: many.map(id => pt(id, -100, 40)) } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(big, 'select', { ids: many });
    expect(writes).toBe(1);
    expect(undo()).toBe(true);
    expect(snap()).toBe(baseline);
  });

  it('rate-limits committing actions per frame: ≤ RATE_MAX per RATE_MS, then a busy toast', () => {
    const h = make();
    for (let i = 0; i < RATE_MAX + 2; i++) act(h, 'where', { field: 'energy_source', bin: i % 2 ? 'gas' : 'coal' });
    expect(writes).toBe(RATE_MAX);
    expect(toast()?.textContent).toMatch(/too many/);
    act(make(), 'where', { field: 'energy_source', bin: 'gas' });     // another frame has its own budget
    expect(writes).toBe(RATE_MAX + 1);
    vi.advanceTimersByTime(RATE_MS);
    act(h, 'where', { field: 'energy_source', bin: 'coal' });
    expect(writes).toBe(RATE_MAX + 2);
  });

  it('fly: a feature\'s box or a bbox within the features (+10 %), clamped, max zoom 14, no toast, no undo step', () => {
    const h = make();
    act(h, 'fly', { id: '1:2' });
    const [box, opts] = fitBounds.mock.calls[0];
    expect(opts).toMatchObject({ maxZoom: 14 });
    expect(box[1][0] - box[0][0]).toBeCloseTo(MIN_SPAN);
    act(h, 'fly', { bbox: [-500, -100, 500, 100] });
    expect(fitBounds.mock.calls[1][0][0][0]).toBeGreaterThan(-101);
    expect(fitBounds.mock.calls[1][0][1][1]).toBeLessThan(43);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(h, 'fly', { bbox: [10, 10, 20, 20] });                 // nowhere near the features
    act(h, 'fly', { bbox: [0, 0, 'x', 1] });
    act(h, 'fly', { id: 'nope' });
    expect(fitBounds).toHaveBeenCalledTimes(2);
    expect(writes).toBe(0);
    expect(undo()).toBe(false);
  });

  it('nearest: a fly may reach the second layer\'s targets (extent2), but a target is never an id to select, table or fly to', () => {
    const payload = {
      rows: [{ id: '1:1', d_km: 3, to: 0, count: 1 }, { id: '1:2', d_km: 900, to: 1, count: 1 }],
      roles: { by: [], measure: { name: 'count' } }, labels: {},
      features: [pt('1:1', -100, 40), pt('1:2', -99, 41)],
      second: { layer: 'hifld-substations', credit: 'HIFLD', features: [pt('9:1', -100.02, 40.01), pt('9:2', -80, 30)] },
    };
    const h = make({ templateId: 'nearest', layer: GEN, payload });
    act(h, 'fly', { bbox: [-80.02, 29.98, -79.98, 30.02] });   // around a far target: inside extent2
    expect(fitBounds).toHaveBeenCalledTimes(1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(h, 'fly', { id: '9:2' });
    act(h, 'select', { ids: ['9:1'] });
    act(h, 'table', { ids: ['9:2'] });
    expect(fitBounds).toHaveBeenCalledTimes(1);
    expect(state.sel).toBeFalsy();
    expect(openTable).not.toHaveBeenCalled();
    act(h, 'select', { ids: ['1:1', '1:2'] });
    expect(state.sel?.ids[GEN]).toEqual(['1:1', '1:2']);
  });

  it('points-per-polygon: a region row → contains_any its code; a region outline flies, never selects or tables', () => {
    const square = (id: string, x: number, y: number) => ({ type: 'Feature' as const, id, properties: {},
      geometry: { type: 'Polygon' as const, coordinates: [[[x, y], [x + 4, y], [x + 4, y + 3], [x, y + 3], [x, y]]] } });
    const payload = {
      rows: [{ states: 'TX', count: 5 }, { states: 'OH', count: 2 }],
      roles: { by: [{ field: 'states', role: 'region' as const }], measure: { name: 'count' } },
      labels: { 'value.states.TX': 'Texas' } as Record<string, string>,
      features: [square('TX', -104, 28), square('OH', -84, 38)],
    };
    const h = make({ templateId: 'points-per-polygon', layer: 'hifld-substations', payload, regions: true });
    act(h, 'where', { field: 'states', bin: 'TX' });
    expect(state.where['hifld-substations']).toEqual([{ field: 'states', op: 'contains_any', value: ['TX'] }]);
    expect(toast()?.textContent).toMatch(/Texas/);
    act(h, 'fly', { id: 'OH' });
    expect(fitBounds.mock.calls[0][0]).toEqual([[-84, 38], [-80, 41]]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(h, 'select', { ids: ['TX'] });
    act(h, 'table', { ids: ['TX'] });
    act(h, 'where', { field: 'states', bin: 'CA' });            // not a row of this chart
    expect(state.sel).toBeFalsy();
    expect(openTable).not.toHaveBeenCalled();
    expect(writes).toBe(1);
    // By counties (no outlines): a county row → contains_any its GEOID.
    const c = make({ templateId: 'points-per-polygon', layer: 'hifld-substations', regions: true,
      payload: { ...payload, rows: [{ counties: '48201', count: 3 }], roles: { by: [{ field: 'counties', role: 'region' as const }], measure: { name: 'count' } }, features: undefined } });
    act(c, 'where', { field: 'counties', bin: '48201' });
    expect(state.where['hifld-substations']).toEqual([{ field: 'states', op: 'contains_any', value: ['TX'] }, { field: 'counties', op: 'contains_any', value: ['48201'] }]);
  });

  it('a month bar (timeline by month) → its date range; a vega frame sends the month as its key; a split region by its label', () => {
    const payload = {
      rows: [{ last_event: '2025-03', count: 2 }, { last_event: '2025-04', count: 1 }],
      roles: { by: [], measure: { name: 'count' }, time: { field: 'last_event', bin: 'month' as const } },
      labels: {} as Record<string, string>,
    };
    const h = make({ templateId: 'timeline', layer: 'dc-moratoriums', payload, labels: new Map() });
    act(h, 'where', { field: 'last_event', bin: '2025-03' });
    expect(state.where['dc-moratoriums']).toEqual([{ field: 'last_event', op: '>=', value: '2025-03-01' }, { field: 'last_event', op: '<=', value: '2025-03-31' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(h, 'where', { field: 'last_event', bin: '2025-05' });     // not a month this chart was sent
    expect(writes).toBe(1);
    // A year-binned time field takes no pick.
    const y = make({ templateId: 'timeline', layer: 'dc-moratoriums', payload: { ...payload, rows: [{ last_event: 2025, count: 2 }], roles: { ...payload.roles, time: { field: 'last_event', bin: 'year' as const } } } });
    act(y, 'where', { field: 'last_event', bin: 2025 });
    expect(writes).toBe(1);
    // compare-regions: the split field's region arrives as its label.
    const cmp = make({ templateId: 'compare-regions', layer: 'hifld-substations',
      payload: { rows: [{ max_kv: '230-299', states: 'TX', count: 3 }], roles: { by: [{ field: 'max_kv', role: 'category' as const }, { field: 'states', role: 'region' as const }], measure: { name: 'count' } }, labels: { 'value.states.TX': 'Texas' } as Record<string, string> },
      labels: new Map([['max_kv', new Map<string, string | number | null>([['230–299 kV', '230-299']])], ['states', new Map<string, string | number | null>([['Texas', 'TX']])]]) });
    act(cmp, 'where', { field: 'states', bin: 'Texas' });
    expect(state.where['hifld-substations']).toEqual([{ field: 'states', op: 'contains_any', value: ['TX'] }]);
    act(cmp, 'where', { field: 'states', bin: 'TX' });            // a key, not a label this frame drew
    expect(writes).toBe(2);
  });

  it('table: opens the layer through table-open.ts with only the ids sent, writing nothing', () => {
    const h = make();
    act(h, 'table', { ids: ['1:1'] });
    act(h, 'table', {});
    expect(vi.mocked(openTable).mock.calls.map(c => c[0])).toEqual([{ layerId: GEN, ids: ['1:1'] }, { layerId: GEN }]);
    expect(writes).toBe(0);
  });

  it('flyBox clamps to the world and widens a point', () => {
    expect(flyBox([-200, -90, 200, 90], null)).toEqual([-180, -85, 180, 85]);
    const b = flyBox([5, 5, 5, 5], null)!;
    expect(b[2] - b[0]).toBeCloseTo(MIN_SPAN);
    expect(flyBox([10, 10, 20, 20], [0, 0, 1, 1])).toBeNull();
  });
});
