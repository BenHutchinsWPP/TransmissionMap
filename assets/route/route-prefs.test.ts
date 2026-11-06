// Tests for route-prefs.ts: validation, defaults, custom-method fallback.
import { describe, expect, it } from 'vitest';
import { ROUTE_PRESETS } from '../../src/registry/route-presets.js';
import { createCustomPresetStore } from './custom-presets.js';
import { DEFAULT_ALT_STRETCH } from './preset-patch.js';
import { ROUTE_PREFS_KEY, defaultRoutePrefs, loadRoutePrefs, saveRoutePrefs } from './route-prefs.js';

const mem = (prefs?: unknown) => {
  const m = new Map<string, string>();
  if (prefs !== undefined) m.set(ROUTE_PREFS_KEY, typeof prefs === 'string' ? prefs : JSON.stringify(prefs));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const D = defaultRoutePrefs();

describe('route prefs', () => {
  it('defaults', () => {
    expect(D).toMatchObject({ presetId: 'tm-default', autoAlternatives: false, altCount: 3, altStretch: DEFAULT_ALT_STRETCH, showSurface: true, snapKm: 3, colour: 'cost' });
    expect(D.lineType).toBe(Object.keys(ROUTE_PRESETS[0].line_types)[0]);
    expect(loadRoutePrefs(mem())).toEqual(D);
  });
  it('round trips', () => {
    const st = mem();
    const p = { ...D, autoAlternatives: true, altCount: 2, altStretch: 0.3, showSurface: false, snapKm: 5 as const, colour: 'plain' as const };
    expect(saveRoutePrefs(st, p)).toBe(true);
    expect(loadRoutePrefs(st)).toEqual(p);
  });
  it('malformed storage or wrong version gives defaults', () => {
    for (const bad of ['{nope', '[]', '"x"', { v: 2, snapKm: 5 }]) expect(loadRoutePrefs(mem(bad))).toEqual(D);
  });
  it('bad values fall back one by one and unknown keys drop', () => {
    const l = loadRoutePrefs(mem({ v: 1, presetId: 'zz', lineType: 'nope', autoAlternatives: 'yes', altCount: 9, altStretch: 0.9, showSurface: 0, snapKm: 4, colour: 'red', extra: 1, snapkm: 5 }));
    expect(l).toEqual(D);
    expect(loadRoutePrefs(mem({ v: 1, altCount: 1.5, altStretch: 0, snapKm: 1 }))).toEqual({ ...D, snapKm: 1 });
  });
  it('line type must belong to the method', () => {
    const lt = Object.keys(ROUTE_PRESETS[0].line_types)[1];
    const lacking = ROUTE_PRESETS.find((p) => !(lt in p.line_types));
    expect(loadRoutePrefs(mem({ v: 1, presetId: ROUTE_PRESETS[0].id, lineType: lt })).lineType).toBe(lt);
    if (lacking) expect(loadRoutePrefs(mem({ v: 1, presetId: lacking.id, lineType: lt })).lineType).toBe(Object.keys(lacking.line_types)[0]);
  });
  it('a saved 138 kV choice stays; a method without it falls back', () => {
    expect(loadRoutePrefs(mem({ v: 1, presetId: 'tm-default', lineType: 'ac138' })).lineType).toBe('ac138');
    expect(loadRoutePrefs(mem({ v: 1, presetId: 'pnas-wu2023', lineType: 'ac138' })).lineType).toBe('ac500');
  });
  it('custom method only while it exists and is ok', () => {
    const st = mem({ v: 1 });
    const r = createCustomPresetStore(st).save('Mine', 'tm-default', {});
    if (!r.ok) throw new Error(r.reason);
    const id = `custom:${r.result.id}`;
    st.setItem(ROUTE_PREFS_KEY, JSON.stringify({ v: 1, presetId: id }));
    expect(loadRoutePrefs(st).presetId).toBe(id);
    createCustomPresetStore(st).remove(r.result.id);
    expect(loadRoutePrefs(st).presetId).toBe('tm-default');
    st.setItem('tm-route-presets', JSON.stringify({ v: 1, items: [{ id: 'bad', name: 'B', base: 'tm-default', patch: { contingency: 99 }, savedAt: 't' }] }));
    st.setItem(ROUTE_PREFS_KEY, JSON.stringify({ v: 1, presetId: 'custom:bad' }));
    expect(loadRoutePrefs(st).presetId).toBe('tm-default');
  });
});
