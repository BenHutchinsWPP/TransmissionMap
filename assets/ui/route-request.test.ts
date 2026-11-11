// Tests for route-request.ts: requests equal hand-written RouteRequest literals; mergePatch cases, add_rows by hash.
// Deps: route-request.ts; preset-patch.ts (validatePresetPatch, uploadHashes); route-presets.ts; custom-presets.ts (CustomPreset, type only).
import { describe, it, expect } from 'vitest';
import { makeRequestBuilder, mergePatch } from './route-request.js';
import type { CustomPreset } from '../route/custom-presets.js';
import type { RouteInputs, SolveSpec } from './route-tabs/types.js';
import { uploadHashes, validatePresetPatch, type AddRow, type PresetPatch } from '../route/preset-patch.js';
import { routePreset } from '../../src/registry/route-presets.js';
import type { SnapHit } from '../route/snap.js';

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
  const hit = (maxKv: number | null): SnapHit => ({ id: 'S', name: 'S', lngLat: [-119.8, 39.5], maxKv, kvUnknown: maxKv === null, distanceKm: 0.2, states: [], ba: [] });
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
  it('a study method with no position figure is new, and a figure the visitor enters makes auto a position', () => {
    expect(kinds(at('ac500', 500, 500, 'pnas-wu2023'))).toEqual(['new', 'new']);
    const entered: PresetPatch = { cost_inputs: { basis: 'bare', year: 2025, line_types: { ac500: { position_usd: 5e6 } } } };
    expect(kinds(at('ac500', 500, 500, 'pnas-wu2023', entered))).toEqual(['position', 'position']);
  });
  it('an explicit choice goes through as given, per end', () => {
    const ends: PresetPatch = { cost_inputs: { basis: 'bare', year: 2025, ends: ['none', 'new'] } };
    expect(kinds(at('ac345', 500, 500, 'tm-default', ends))).toEqual(['none', 'new']);
    const pos: PresetPatch = { cost_inputs: { basis: 'bare', year: 2025, ends: ['auto', 'position'] } };
    expect(kinds(at('ac345', 'raw', 'raw', 'tm-default', pos))).toEqual(['new', 'position']);
  });
  it('a saved method\'s ends apply until the session patch replaces its cost inputs', () => {
    const saved = custom({ cost_inputs: { basis: 'bare', year: 2025, ends: ['none', 'none'] } });
    const b = makeRequestBuilder(() => [saved]);
    const r = b.requestFor(at('ac345', 500, 500, 'custom:c1'), spec());
    expect(typeof r === 'string' ? r : r.terminals).toEqual(['none', 'none']);
    const over = b.requestFor(at('ac345', 500, 500, 'custom:c1'), spec({ patch: { cost_inputs: { basis: 'bare', year: 2025 } } }));
    expect(typeof over === 'string' ? over : over.terminals).toEqual(['position', 'position']);
  });
  it('the request carries the patch with its cost inputs, which route() validates', () => {
    const patch: PresetPatch = { cost_inputs: { basis: 'all-in', year: 2024, line_types: { ac345: { usd_per_mi: 4e6 } } } };
    const r = none.requestFor(at('ac345', 500, 500, 'tm-default', patch), spec({ patch }));
    expect(typeof r === 'string' ? r : r.presetPatch).toEqual(patch);
  });
});
