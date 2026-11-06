// @vitest-environment jsdom
// Session snapshots: restore only on a reload / back-forward / discard of the
// same hash, never on a fresh navigation; versioned envelope; quota → shrink or
// give up silently; the page-lifecycle marker.
// Deps: session-snapshot.ts, imported fresh per test (it memoises the boot hash
// and the navigation type at load).

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Mod = typeof import('./session-snapshot.js');

async function load(nav: string, hash = '#3/40/-100?l=a', discarded = false): Promise<Mod> {
  vi.resetModules();
  history.replaceState(null, '', hash);
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(nav ? [{ type: nav } as unknown as PerformanceEntry] : []);
  Object.defineProperty(document, 'wasDiscarded', { value: discarded, configurable: true });
  return import('./session-snapshot.js');
}

const put = (key: string, v: unknown) => sessionStorage.setItem(key, JSON.stringify(v));
const ok = (d: unknown) => d as { n: number };

beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

describe('readSnapshot gate', () => {
  it('restores on a reload of the same hash', async () => {
    put('k', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: { n: 1 } });
    const m = await load('reload');
    expect(m.hasSnapshot('k')).toBe(true);
    expect(m.readSnapshot('k', ok)).toEqual({ n: 1 });
  });

  it('restores on back/forward and on a discard reload', async () => {
    put('k', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: { n: 2 } });
    expect((await load('back_forward')).readSnapshot('k', ok)).toEqual({ n: 2 });
    expect((await load('navigate', '#3/40/-100?l=a', true)).readSnapshot('k', ok)).toEqual({ n: 2 });
  });

  it('never restores on a fresh navigation (a pasted link in the same tab)', async () => {
    put('k', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: { n: 1 } });
    const m = await load('navigate');
    expect(m.hasSnapshot('k')).toBe(false);
    expect(m.readSnapshot('k', ok)).toBeNull();
  });

  it('never restores onto a different hash', async () => {
    put('k', { v: 1, hash: '#3/40/-100?l=b', at: 1, data: { n: 1 } });
    expect((await load('reload')).readSnapshot('k', ok)).toBeNull();
  });

  it('drops a wrong version, junk, or what validate refuses', async () => {
    put('a', { v: 2, hash: '#3/40/-100?l=a', at: 1, data: {} });
    sessionStorage.setItem('b', '{not json');
    put('c', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: { n: 'x' } });
    const m = await load('reload');
    expect(m.readSnapshot('a', ok)).toBeNull();
    expect(m.readSnapshot('b', ok)).toBeNull();
    expect(m.readSnapshot('c', d => (typeof (d as { n: unknown }).n === 'number' ? d : null))).toBeNull();
    expect(m.readSnapshot('c', () => { throw new Error('bad'); })).toBeNull();
  });

  it('keeps its boot decision after restampSnapshot moves the hash on', async () => {
    put('k', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: { n: 1 } });
    const m = await load('reload');
    expect(m.hasSnapshot('k')).toBe(true);
    history.replaceState(null, '', '#4/41/-101?l=c');
    m.restampSnapshot('k');
    expect(JSON.parse(sessionStorage.getItem('k')!).hash).toBe('#4/41/-101?l=c');
    expect(m.readSnapshot('k', ok)).toEqual({ n: 1 });
  });

  it('restamps nothing that failed the gate', async () => {
    put('k', { v: 1, hash: '#old', at: 1, data: { n: 1 } });
    const m = await load('reload');
    m.restampSnapshot('k');
    expect(JSON.parse(sessionStorage.getItem('k')!).hash).toBe('#old');
  });
});

describe('a failed save', () => {
  it('removes the older snapshot instead of leaving it to restamp and restore stale', async () => {
    put('k', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: [1, 2, 3] });
    const m = await load('reload');
    expect(m.saveSnapshot('k', [1, 2, 3], { shrink: () => null, maxChars: 5 })).toBe(false);
    expect(sessionStorage.getItem('k')).toBeNull();
    put('j', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: 1 });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(m.saveSnapshot('j', 2)).toBe(false);
    expect(sessionStorage.getItem('j')).toBeNull();
  });

  it('a claimed key is no longer restamped', async () => {
    put('k', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: { n: 1 } });
    const m = await load('reload');
    expect(m.hasSnapshot('k')).toBe(true);
    m.claimSnapshot('k');
    history.replaceState(null, '', '#4/41/-101?l=c');
    m.restampSnapshot('k');
    expect(JSON.parse(sessionStorage.getItem('k')!).hash).toBe('#3/40/-100?l=a');
  });
});

describe('saveSnapshot', () => {
  it('writes a versioned envelope with the current hash', async () => {
    const m = await load('navigate');
    expect(m.saveSnapshot('k', { n: 3 })).toBe(true);
    const e = JSON.parse(sessionStorage.getItem('k')!);
    expect(e).toMatchObject({ v: 1, hash: '#3/40/-100?l=a', data: { n: 3 } });
    expect(typeof e.at).toBe('number');
  });

  it('shrinks until it fits maxChars, or gives up writing nothing', async () => {
    const m = await load('navigate');
    const shrink = (d: number[]) => (d.length ? d.slice(1) : null);
    expect(m.saveSnapshot('k', [1, 2, 3, 4, 5], { shrink, maxChars: 60 })).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('k')!).data.length).toBeLessThan(5);
    expect(m.saveSnapshot('z', [1, 2, 3], { shrink, maxChars: 5 })).toBe(false);
    expect(sessionStorage.getItem('z')).toBeNull();
  });

  it('on QuotaExceededError shrinks, and never throws', async () => {
    const m = await load('navigate');
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (v.length > 70) throw new DOMException('full', 'QuotaExceededError');
      real.call(this, k, v);
    });
    expect(m.saveSnapshot('k', [1, 2, 3, 4, 5, 6, 7, 8], { shrink: d => (d.length ? d.slice(1) : null) })).toBe(true);
    expect(m.saveSnapshot('q', 'x'.repeat(200))).toBe(false);
    spy.mockImplementation(() => { throw new Error('blocked'); });
    expect(m.saveSnapshot('b', 1)).toBe(false);
    expect(() => m.clearSnapshot('k')).not.toThrow();
  });
});

describe('endSnapshots', () => {
  it('removes every snapshot the page touched, and nothing saves or restamps after', async () => {
    put('k', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: { n: 1 } });
    put('other', { v: 1, hash: '#3/40/-100?l=a', at: 1, data: { n: 2 } });
    const m = await load('reload');
    expect(m.hasSnapshot('k')).toBe(true);
    m.saveSnapshot('s', { n: 3 });
    m.endSnapshots();
    expect(sessionStorage.getItem('k')).toBeNull();
    expect(sessionStorage.getItem('s')).toBeNull();
    expect(sessionStorage.getItem('other')).not.toBeNull();     // never touched by this page
    history.replaceState(null, '', '#4/1/1?l=b');
    expect(m.saveSnapshot('k', { n: 4 })).toBe(false);
    m.restampSnapshot('other');
    expect(sessionStorage.getItem('k')).toBeNull();
  });
});

describe('onHidden', () => {
  it('runs on hidden and on pagehide, and swallows a throw', async () => {
    const m = await load('navigate');
    const fn = vi.fn(() => { throw new Error('x'); });
    m.onHidden(fn);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    expect(fn).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
});

describe('page lifecycle', () => {
  it('reports what the previous page left, clears it, then marks this one', async () => {
    put('tm-lifecycle', { hidden: true, at: 1 });
    let m = await load('reload', '#a', true);
    expect(m.initPageLifecycle()).toMatchObject({ navigation: 'reload', wasDiscarded: true, previous: 'no-pagehide' });
    expect(sessionStorage.getItem('tm-lifecycle')).toBeNull();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(JSON.parse(sessionStorage.getItem('tm-lifecycle')!)).toMatchObject({ hidden: true, pagehide: true });
    m = await load('reload');
    expect(m.pageLifecycle().previous).toBe('pagehide');
    m = await load('navigate');
    expect(m.pageLifecycle()).toMatchObject({ navigation: 'navigate', wasDiscarded: false, previous: 'none' });
  });
});
