// Tests for custom-presets.ts: round trip, revalidation on load, storage safety, caps.
import { describe, expect, it } from 'vitest';
import { ROUTE_PRESETS } from '../../src/registry/route-presets.js';
import { CUSTOM_PRESETS_KEY, MAX_METHOD_FILE_CHARS, buildMethodFile, createCustomPresetStore, methodFileName, readMethodFile } from './custom-presets.js';

const mem = (init?: string) => {
  const m = new Map<string, string>();
  if (init !== undefined) m.set(CUSTOM_PRESETS_KEY, init);
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const C = ROUTE_PRESETS.find((p) => p.contingency)!;
const good = { contingency: 0.1 };
const stored = (items: unknown[]) => JSON.stringify({ v: 1, items });

describe('custom preset store', () => {
  it('saves and lists a round trip', () => {
    const s = createCustomPresetStore(mem());
    const r = s.save('  Mine\u0007 ', C.id, good);
    expect(r.ok).toBe(true);
    const [p] = s.list();
    expect(p.name).toBe('Mine');
    expect(p.status).toBe('ok');
    expect(p.preset?.contingency?.pct).toBe(0.1);
  });

  it('refuses an invalid patch, bad name, unknown base', () => {
    const st = mem(), s = createCustomPresetStore(st);
    expect(s.save('x', C.id, { contingency: 5 }).ok).toBe(false);
    expect(s.save('x', 'nope', {}).ok).toBe(false);
    expect(s.save('   ', C.id, good).ok).toBe(false);
    expect(s.save('a'.repeat(61), C.id, good).ok).toBe(false);
    expect(st.m.size).toBe(0);
  });

  it('keeps a no-longer-valid item as needs-review', () => {
    const item = { id: 'a', name: 'Old', base: C.id, patch: { contingency: 5 }, savedAt: 't' };
    const st = mem(stored([item])), s = createCustomPresetStore(st);
    const [p] = s.list();
    expect(p.status).toBe('needs-review');
    expect(p.problem).toBeTruthy();
    expect(p.preset).toBeUndefined();
    expect(JSON.parse(st.m.get(CUSTOM_PRESETS_KEY)!).items).toHaveLength(1);
  });

  it('marks an unknown base needs-review', () => {
    const s = createCustomPresetStore(mem(stored([{ id: 'a', name: 'X', base: 'gone', patch: {}, savedAt: 't' }])));
    expect(s.list()[0].status).toBe('needs-review');
  });

  it('reads malformed storage as empty and leaves it until a save', () => {
    const st = mem('{not json'), s = createCustomPresetStore(st);
    expect(s.list()).toEqual([]);
    expect(st.m.get(CUSTOM_PRESETS_KEY)).toBe('{not json');
    expect(s.save('N', C.id, good).ok).toBe(true);
    expect(s.list()).toHaveLength(1);
    const wrong = mem(stored([{ id: 1 }, 'x']));
    expect(createCustomPresetStore(wrong).list()).toEqual([]);
  });

  it('renames and removes', () => {
    const s = createCustomPresetStore(mem());
    const r = s.save('A', C.id, good);
    if (!r.ok) throw new Error(r.reason);
    const id = r.result.id;
    expect(s.rename(id, ' B ')).toBe(true);
    expect(s.rename(id, '')).toBe(false);
    expect(s.rename('zzz', 'C')).toBe(false);
    expect(s.list()[0].name).toBe('B');
    expect(s.remove('zzz')).toBe(false);
    expect(s.remove(id)).toBe(true);
    expect(s.list()).toEqual([]);
  });

  it('caps at 20 items', () => {
    const s = createCustomPresetStore(mem());
    for (let i = 0; i < 20; i++) expect(s.save(`p${i}`, C.id, good).ok).toBe(true);
    const r = s.save('p20', C.id, good);
    expect(r.ok).toBe(false);
    expect(s.list()).toHaveLength(20);
  });

  it('update replaces the patch only when valid', () => {
    const st = mem(), s = createCustomPresetStore(st);
    const r = s.save('Mine', C.id, good);
    if (!r.ok) throw new Error(r.reason);
    expect(s.update(r.result.id, { contingency: 5 }).ok).toBe(false);
    expect(s.update('nope', good).ok).toBe(false);
    const u = s.update(r.result.id, { contingency: 0.2 });
    expect(u.ok && u.result.preset?.contingency?.pct).toBe(0.2);
    expect(s.list()[0].name).toBe('Mine');
    expect(s.list()[0].id).toBe(r.result.id);
  });
});

describe('method files', () => {
  it('round-trips a method through a file', () => {
    const r = readMethodFile(buildMethodFile('Tribal ×1', C.id, good));
    expect(r).toEqual({ ok: true, result: { name: 'Tribal ×1', base: C.id, patch: good } });
    expect(methodFileName('Tribal ×1 / WestTEC')).toBe('Tribal-1-WestTEC.tmroute.json');
    expect(methodFileName('///')).toBe('route-method.tmroute.json');
  });

  it('refuses what a stored method would refuse, and anything that is not a method file', () => {
    const bad = (o: unknown) => readMethodFile(typeof o === 'string' ? o : JSON.stringify(o)).ok;
    expect(bad('{nope')).toBe(false);
    expect(bad({ format: 'tmview', v: 1, hash: '' })).toBe(false);
    expect(bad({ format: 'tmroute', v: 2, name: 'x', base: C.id, patch: {} })).toBe(false);
    expect(bad({ format: 'tmroute', v: 1, name: 'x', base: 'nope', patch: {} })).toBe(false);
    expect(bad({ format: 'tmroute', v: 1, name: 'x', base: C.id, patch: { contingency: 5 } })).toBe(false);
    expect(bad({ format: 'tmroute', v: 1, name: '\u0007 ', base: C.id, patch: {} })).toBe(false);
    expect(bad(' '.repeat(MAX_METHOD_FILE_CHARS + 1))).toBe(false);
    expect(bad({ format: 'tmroute', v: 1, name: 'x', base: C.id })).toBe(true);   // no patch = the base as is
  });
});

describe('uploaded-layer rows', () => {
  const H = 'ab12cd34ef56ab78';
  const row = { layer: H, label: 'Corridor', route_w: 3, cost_x: 1.2, barrier: false };

  it('stores hash, label and weights only: no geometry, no coordinates', () => {
    const st = mem(), s = createCustomPresetStore(st);
    const r = s.save('With layer', C.id, { add_rows: [row] });
    expect(r.ok).toBe(true);
    const raw = st.m.get(CUSTOM_PRESETS_KEY)!;
    expect(raw).not.toMatch(/geometry|coordinates/);
    expect(raw).not.toMatch(/\[\s*-?\d+(\.\d+)?\s*,\s*-?\d/);   // no coordinate pair anywhere
  });

  it('refuses geometry or any other field smuggled into an add_rows entry', () => {
    const st = mem(), s = createCustomPresetStore(st);
    for (const extra of [{ geometry: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }, { coordinates: [1, 2] }, { band: 'slope' }]) {
      expect(s.save('x', C.id, { add_rows: [{ ...row, ...extra }] }).ok).toBe(false);
    }
    expect(s.save('x', C.id, { add_rows: [{ ...row, remove: true }] }).ok).toBe(false);
    expect(st.m.size).toBe(0);
  });

  it('update replaces the entry: the edited route_w is what is stored, a removed entry is gone', () => {
    const st = mem(), s = createCustomPresetStore(st);
    const id = (s.save('x', C.id, { add_rows: [row] }) as { result: { id: string } }).result.id;
    expect(s.update(id, { add_rows: [{ ...row, route_w: 7 }] }).ok).toBe(true);
    expect(JSON.parse(st.m.get(CUSTOM_PRESETS_KEY)!).items[0].patch.add_rows[0].route_w).toBe(7);
    expect(s.update(id, {}).ok).toBe(true);
    expect(JSON.parse(st.m.get(CUSTOM_PRESETS_KEY)!).items[0].patch.add_rows).toBeUndefined();
  });

  it('a method file carries the rows and reads back through the validator', () => {
    const f = readMethodFile(buildMethodFile('M', C.id, { add_rows: [row] }));
    expect(f.ok && (f.result.patch as { add_rows: unknown[] }).add_rows).toEqual([row]);
  });
});
