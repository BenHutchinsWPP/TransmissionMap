// Tests for route-request.ts: requests equal hand-written RouteRequest literals; mergePatch cases, add_rows by hash.
// Deps: route-request.ts; preset-patch.ts (validatePresetPatch, uploadHashes); route-presets.ts; custom-presets.ts (CustomPreset, type only).
import { describe, it, expect } from 'vitest';
import { makeRequestBuilder, mergePatch } from './route-request.js';
import type { CustomPreset } from '../route/custom-presets.js';
import type { RouteInputs, SolveSpec } from './route-tabs/types.js';
import { uploadHashes, validatePresetPatch, type AddRow, type PresetPatch } from '../route/preset-patch.js';
import { routePreset } from '../../src/registry/route-presets.js';

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
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500',
      profile: true, surface: false, alternatives: 0,
    });
  });

  it('session patch rides as presetPatch', () => {
    const patch = { contingency: 0.3 } as PresetPatch;
    expect(none.requestFor(inputs('tm-default'), spec({ patch, alternatives: 2, surface: true }))).toEqual({
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500',
      presetPatch: { contingency: 0.3 }, profile: false, surface: true, alternatives: 2,
    });
  });

  it('weight overlay: weightImage + mode, rows paints as route', () => {
    const base = { from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500', profile: false, surface: false, alternatives: 0 };
    expect(none.requestFor(inputs('tm-default'), spec(), 'cost')).toEqual({ ...base, weightImage: true, weightMode: 'cost' });
    expect(none.requestFor(inputs('tm-default'), spec(), 'rows')).toEqual({ ...base, weightImage: true, weightMode: 'route' });
  });

  it('custom method: base preset, saved patch under the session patch', () => {
    const b = makeRequestBuilder(() => [custom({ rows: [{ row: 1, band: 'x', route_w: 2 }], contingency: 0.1 })]);
    const session = { rows: [{ row: 1, band: 'x', cost_x: 3 }], contingency: 0.3 } as PresetPatch;
    expect(b.requestFor(inputs('custom:c1'), spec({ patch: session }))).toEqual({
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500',
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
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500',
      presetPatch: { add_rows: [r(B), r(C)] }, uploads: [B, C],
      profile: false, surface: false, alternatives: 0,
    });
    expect(none().requestFor(inputs('tm-default'), spec({ patch: { add_rows: [r(A)] } as PresetPatch }))).toEqual({
      from: [-119.8, 39.5], to: [-119.2, 39.9], preset: 'tm-default', lineType: 'ac-500',
      presetPatch: { add_rows: [r(A)] }, uploads: [A], profile: false, surface: false, alternatives: 0,
    });
  });
});
const none = () => makeRequestBuilder(() => []);
