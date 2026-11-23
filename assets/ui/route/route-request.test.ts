// Tests for route-request.ts: requests equal hand-written RouteRequest literals; mergePatch cases, add_rows by hash;
// explainEnds' codes in their order and the explicit terminal choice (refusal of Existing without a figure).
// Deps: route-request.ts; preset-patch.ts (validatePresetPatch, uploadHashes); route-presets.ts; custom-presets.ts (CustomPreset, type only).
import { describe, it, expect, beforeAll } from 'vitest';
import { explainEnds, makeRequestBuilder, mergePatch } from './route-request.js';
import type { CustomPreset } from '../../route/custom-presets.js';
import type { RouteEnd, RouteInputs, SolveSpec, TermChoice } from './tabs/types.js';
import { uploadHashes, validatePresetPatch, type AddRow, type PresetPatch } from '../../route/preset-patch.js';
import { routePreset } from '../../../src/registry/route-presets.js';
import { loadRouteStrings, t } from '../../../src/i18n/index.js';
import type { SnapHit } from '../../route/snap.js';

const custom = (patch: unknown, status: 'ok' | 'needs-review' = 'ok'): CustomPreset =>
  ({ id: 'c1', name: 'mine', base: 'tm-default', patch, savedAt: 'x', status });
const inputs = (presetId: string, patch: PresetPatch | null = null): RouteInputs => ({
  a: { lngLat: [-119.8, 39.5], hit: null }, b: { lngLat: [-119.2, 39.9], hit: null },
  lineType: 'ac-500', presetId, patch,
});
const spec = (o: Partial<SolveSpec> = {}): SolveSpec => ({ patch: null, profile: false, alternatives: 0, surface: false, ...o });

describe('requestFor', () => {
  const none = makeRequestBuilder(() => []);

  it('built-in method, Find request', () => {
    expect(none.requestFor(inputs('tm-default'), spec({ profile: true }))).toEqual({
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500', terminals: ['new', 'new'],
      profile: true, surface: false, alternatives: 0,
    });
  });

  it('session patch rides as presetPatch', () => {
    const patch = { contingency: 0.3 } as PresetPatch;
    expect(none.requestFor(inputs('tm-default'), spec({ patch, alternatives: 2, surface: true }))).toEqual({
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500', terminals: ['new', 'new'],
      presetPatch: { contingency: 0.3 }, profile: false, surface: true, alternatives: 2,
    });
  });

  it('weight overlay: weightImage + mode, rows paints as route', () => {
    const base = { from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500', terminals: ['new', 'new'], profile: false, surface: false, alternatives: 0 };
    expect(none.requestFor(inputs('tm-default'), spec(), 'cost')).toEqual({ ...base, weightImage: true, weightMode: 'cost' });
    expect(none.requestFor(inputs('tm-default'), spec(), 'rows')).toEqual({ ...base, weightImage: true, weightMode: 'route' });
  });

  it('custom method: base preset, saved patch under the session patch', () => {
    const b = makeRequestBuilder(() => [custom({ rows: [{ row: 1, band: 'x', route_w: 2 }], contingency: 0.1 })]);
    const session = { rows: [{ row: 1, band: 'x', cost_x: 3 }], contingency: 0.3 } as PresetPatch;
    expect(b.requestFor(inputs('custom:c1'), spec({ patch: session }))).toEqual({
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500', terminals: ['new', 'new'],
      presetPatch: { rows: [{ row: 1, band: 'x', route_w: 2, cost_x: 3 }], contingency: 0.3 },
      profile: false, surface: false, alternatives: 0,
    });
  });

  it('refusals are strings', () => {
    const b = makeRequestBuilder(() => [custom({}, 'needs-review')]);
    expect(typeof b.requestFor(inputs('custom:c1'), spec())).toBe('string');
    expect(typeof b.requestFor(inputs('custom:gone'), spec())).toBe('string');
    expect(typeof none.requestFor({ ...inputs('tm-default'), b: null }, spec())).toBe('string');
  });
});

describe('mergePatch', () => {
  it('passes one side through, merges rows by index and combine', () => {
    expect(mergePatch(null, null)).toBeUndefined();
    const p = { contingency: 0.2 } as PresetPatch;
    expect(mergePatch(p, null)).toBe(p);
    expect(mergePatch(null, p)).toBe(p);
    const m = mergePatch({ rows: [{ row: 1, band: 'x', route_w: 2 }] } as PresetPatch,
      { rows: [{ row: 1, band: 'x', cost_x: 3 }, { row: 2, band: 'y', route_w: 5 }] } as PresetPatch);
    expect(m?.rows).toEqual([{ row: 1, band: 'x', route_w: 2, cost_x: 3 }, { row: 2, band: 'y', route_w: 5 }]);
  });
});

describe('mergePatch: uploaded-layer rows by hash', () => {
  const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc';
  const r = (layer: string, o: Partial<AddRow> = {}): AddRow => ({ layer, label: layer.slice(0, 1), route_w: 2, cost_x: 1, ...o });
  const saved = { add_rows: [r(A), r(B)] } as PresetPatch;

  it('a session edit of a base hash lands in the base position; a new hash is appended', () => {
    const m = mergePatch(saved, { add_rows: [{ layer: C, label: 'c', route_w: 4, cost_x: 1 }, { layer: A, route_w: 50 }] } as PresetPatch);
    expect(m?.add_rows).toEqual([r(A, { route_w: 50 }), r(B), r(C, { label: 'c', route_w: 4 })]);
    expect(uploadHashes(m)).toEqual([A, B, C]);
  });

  it('remove drops the base entry (later ones shift down a band); a remove of an absent hash is a no-op', () => {
    expect(mergePatch(saved, { add_rows: [{ layer: A, remove: true }] } as PresetPatch)?.add_rows).toEqual([r(B)]);
    expect(mergePatch(saved, { add_rows: [{ layer: C, remove: true }] } as PresetPatch)?.add_rows).toEqual([r(A), r(B)]);
    const none = mergePatch(saved, { add_rows: [{ layer: A, remove: true }, { layer: B, remove: true }] } as PresetPatch);
    expect(none).toEqual({});
    expect(mergePatch(null, { add_rows: [{ layer: A, remove: true }], contingency: 0.2 } as PresetPatch)).toEqual({ contingency: 0.2 });
  });

  it('the merged list never carries remove, and five layers validate (no count cap)', () => {
    const m = mergePatch({ add_rows: [r(A), r(B), r(C), r('dddddddddddddddd')] } as PresetPatch, { add_rows: [r('eeeeeeeeeeeeeeee')] } as PresetPatch);
    expect(m?.add_rows).toHaveLength(5);
    const v = validatePresetPatch(routePreset('tm-default')!, m);
    expect(v.ok).toBe(true);
    const only = mergePatch(saved, { add_rows: [{ layer: A, route_w: 9 }, { layer: B, remove: true }] } as PresetPatch);
    expect(only?.add_rows?.some((x) => 'remove' in x)).toBe(false);
    expect(validatePresetPatch(routePreset('tm-default')!, only).ok).toBe(true);
  });

  it('save after edit: merge, store, merge with an empty session keeps the edit', () => {
    const stored = JSON.parse(JSON.stringify(mergePatch(saved, { add_rows: [{ layer: B, route_w: 70, barrier: true }] } as PresetPatch)));
    expect(validatePresetPatch(routePreset('tm-default')!, stored).ok).toBe(true);
    expect(mergePatch(stored, {})?.add_rows).toEqual([r(A), r(B, { route_w: 70, barrier: true })]);
    expect(mergePatch(stored, null)?.add_rows).toEqual([r(A), r(B, { route_w: 70, barrier: true })]);
  });

  it('a request names its uploads by hash only, in band order', () => {
    const b = makeRequestBuilder(() => [custom(saved)]);
    expect(b.requestFor(inputs('custom:c1'), spec({ patch: { add_rows: [{ layer: A, remove: true }, r(C)] } as PresetPatch }))).toEqual({
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500', terminals: ['new', 'new'],
      presetPatch: { add_rows: [r(B), r(C)] }, uploads: [B, C],
      profile: false, surface: false, alternatives: 0,
    });
    expect(none().requestFor(inputs('tm-default'), spec({ patch: { add_rows: [r(A)] } as PresetPatch }))).toEqual({
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500', terminals: ['new', 'new'],
      presetPatch: { add_rows: [r(A)] }, uploads: [A], profile: false, surface: false, alternatives: 0,
    });
  });
});
const none = () => makeRequestBuilder(() => []);

describe('requestFor: terminal kinds (auto resolves at request time)', () => {
  const none = makeRequestBuilder(() => []);
  const hit = (maxKv: number | null): SnapHit => ({ id: 'S', name: 'S', lngLat: [-119.8, 39.5], maxKv, kvUnknown: maxKv === null, distanceKm: 0.2, states: [], ba: [], source: 'hifld' });
  const at = (lineType: string, a: number | null | 'raw', b: number | null | 'raw', presetId = 'tm-default', patch: PresetPatch | null = null): RouteInputs => ({
    a: { lngLat: [-119.8, 39.5], hit: a === 'raw' ? null : hit(a) }, b: { lngLat: [-119.2, 39.9], hit: b === 'raw' ? null : hit(b) },
    lineType, presetId, patch,
  });
  const kinds = (inp: RouteInputs) => {
    const r = none.requestFor(inp, spec({ patch: inp.patch }));
    if (typeof r === 'string') throw new Error(r);
    return r.terminals;
  };

  it('a 500 kV line snapped to a 345 kV substation is a new station', () => {
    expect(kinds(at('ac500', 345, 345))).toEqual(['new', 'new']);
  });
  it('a substation of unknown kV is a new station', () => {
    expect(kinds(at('ac500', null, null))).toEqual(['new', 'new']);
  });
  it('a 345 kV line snapped to a 500 kV substation is a line position (tm-default prices one)', () => {
    expect(kinds(at('ac345', 500, 345))).toEqual(['position', 'position']);
    expect(kinds(at('ac345', 345, 230))).toEqual(['position', 'new']);
  });
  it('a raw point is a new station', () => {
    expect(kinds(at('ac345', 'raw', 'raw'))).toEqual(['new', 'new']);
    expect(kinds(at('ac345', 500, 'raw'))).toEqual(['position', 'new']);
  });
  it('an HVDC line has no position figure: new', () => {
    expect(kinds(at('dc500', 500, 500))).toEqual(['new', 'new']);
  });
  it('a study method with no position figure is new', () => {
    expect(kinds(at('ac500', 500, 500, 'pnas-wu2023'))).toEqual(['new', 'new']);
  });
  it('the request carries the patch, which route() validates', () => {
    const patch: PresetPatch = { contingency: 0.2 };
    const r = none.requestFor(at('ac345', 500, 500, 'tm-default', patch), spec({ patch }));
    expect(typeof r === 'string' ? r : r.presetPatch).toEqual(patch);
  });
});

describe('explainEnds', () => {
  const hit = (maxKv: number | null): SnapHit => ({ id: 'S', name: 'S', lngLat: [-119.8, 39.5], maxKv, kvUnknown: maxKv === null, distanceKm: 0.2, states: [], ba: [], source: 'hifld' });
  const end = (kv: number | null | 'raw', term?: TermChoice): RouteEnd =>
    ({ lngLat: [-119.8, 39.5], hit: kv === 'raw' ? null : hit(kv), ...(term ? { term } : {}) });
  const ex = (lineType: string, a: RouteEnd | null, preset = 'tm-default', patch?: PresetPatch) =>
    explainEnds(preset, patch, lineType, a, end('raw'))[0];

  it('auto codes', () => {
    expect(ex('ac345', end(500))).toEqual({ kind: 'position', why: 'snapped', kv: 500 });
    expect(ex('ac345', end(345))).toEqual({ kind: 'position', why: 'snapped', kv: 345 });
    expect(ex('ac345', end(230))).toEqual({ kind: 'new', why: 'lowKv', kv: 230 });
    expect(ex('ac345', end(null))).toEqual({ kind: 'new', why: 'kvUnknown', kv: null });
    expect(ex('ac500', end('raw'))).toEqual({ kind: 'new', why: 'noSub', kv: 345 });
    expect(ex('ac345', null)).toEqual({ kind: 'new', why: 'noSub', kv: 230 });
    expect(ex('dc500', end(500))).toEqual({ kind: 'new', why: 'noPositionFigure', kv: null });
    expect(ex('nope', end(500))).toEqual({ kind: 'new', why: 'noPositionFigure', kv: null });
    expect(ex('ac500', end(500), 'pnas-wu2023')).toEqual({ kind: 'new', why: 'noPositionFigure', kv: null });
    expect(ex('ac345', end(500), 'no-such-preset')).toEqual({ kind: 'new', why: 'noPositionFigure', kv: null });
  });

  it('auto order: no figure comes before no substation and before unknown kV', () => {
    expect(ex('dc500', end('raw')).why).toBe('noPositionFigure');
    expect(ex('dc500', end(null)).why).toBe('noPositionFigure');
  });

  it('explicit new and none are kept, whatever the substation', () => {
    expect(ex('ac345', end(500, 'new'))).toEqual({ kind: 'new', why: 'chosen', kv: 500 });
    expect(ex('ac345', end('raw', 'none'))).toEqual({ kind: 'none', why: 'chosen', kv: null });
    expect(ex('ac500', end(500, 'none'), 'pnas-wu2023')).toEqual({ kind: 'none', why: 'chosen', kv: 500 });
  });

  it('explicit position: kept with a figure even with no substation or a low kV; unavailable without one', () => {
    expect(ex('ac345', end('raw', 'position'))).toEqual({ kind: 'position', why: 'chosen', kv: null });
    expect(ex('ac345', end(69, 'position'))).toEqual({ kind: 'position', why: 'chosen', kv: 69 });
    expect(ex('ac500', end(500, 'position'), 'pnas-wu2023')).toEqual({ kind: 'new', why: 'positionUnavailable', kv: null });
    expect(ex('dc500', end(500, 'position'))).toEqual({ kind: 'new', why: 'positionUnavailable', kv: null });
  });
});

describe('requestFor: explicit terminal choice', () => {
  beforeAll(() => loadRouteStrings());
  const b = makeRequestBuilder(() => []);
  const inp = (lineType: string, ta: TermChoice | undefined, tb: TermChoice | undefined, presetId = 'tm-default'): RouteInputs => ({
    a: { lngLat: [-119.8, 39.5], hit: null, ...(ta ? { term: ta } : {}) },
    b: { lngLat: [-119.2, 39.9], hit: null, ...(tb ? { term: tb } : {}) },
    lineType, presetId, patch: null,
  });
  const kinds = (i: RouteInputs) => { const r = b.requestFor(i, spec()); if (typeof r === 'string') throw new Error(r); return r.terminals; };

  it('carries explicit kinds to the engine', () => {
    expect(kinds(inp('ac345', 'position', 'none'))).toEqual(['position', 'none']);
    expect(kinds(inp('ac345', 'new', 'auto'))).toEqual(['new', 'new']);
    expect(kinds(inp('ac500', 'none', 'new', 'pnas-wu2023'))).toEqual(['none', 'new']);
  });

  it('refuses an explicit Existing on a method or line type with no position figure, naming the end', () => {
    expect(b.requestFor(inp('ac500', 'auto', 'position', 'pnas-wu2023'), spec())).toBe(t('route.err.termPosition', { end: 'B' }));
    expect(b.requestFor(inp('dc500', 'position', 'auto'), spec())).toBe(t('route.err.termPosition', { end: 'A' }));
    expect(b.requestFor(inp('dc500', 'position', 'position'), spec())).toBe(t('route.err.termPosition', { end: 'A, B' }));
    expect(t('route.err.termPosition', { end: 'A' })).toMatch(/^End A: /);
  });
});
