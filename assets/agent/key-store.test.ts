// The OpenRouter key store as a trust boundary: memory unless the visitor opts
// in, a stored value used only when it has the key's shape (anything else is
// removed), Forget clears both, and blocked storage degrades to memory only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getKey, setKey, forgetKey, isRemembered, isKeyShape } from './key-store.js';

const KEY = 'sk-or-v1-' + 'a1'.repeat(32);
const STORE_KEY = 'tm-openrouter-key';

let store: Map<string, string>;
const fakeStorage = () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

beforeEach(() => { store = new Map(); vi.stubGlobal('localStorage', fakeStorage()); forgetKey(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('key store', () => {
  it('checks the shape', () => {
    expect(isKeyShape(KEY)).toBe(true);
    for (const bad of ['', 'sk-or-v1-short', KEY.toUpperCase(), `${KEY}0`, ` ${KEY}`, 'sk-ant-xyz', null, 42]) {
      expect(isKeyShape(bad)).toBe(false);
    }
  });

  it('keeps a key in memory only by default', () => {
    expect(setKey(KEY, false)).toBe(true);
    expect(getKey()).toBe(KEY);
    expect(store.size).toBe(0);
    expect(isRemembered()).toBe(false);
  });

  it('refuses a value that is not a key, keeping nothing', () => {
    expect(setKey('not a key', true)).toBe(false);
    expect(getKey()).toBeNull();
    expect(store.size).toBe(0);
  });

  it('trims a pasted key', () => {
    expect(setKey(`  ${KEY}\n`, false)).toBe(true);
    expect(getKey()).toBe(KEY);
  });

  it('remembers on this device only when asked, and Forget clears both', () => {
    setKey(KEY, true);
    expect(store.get(STORE_KEY)).toBe(KEY);
    expect(isRemembered()).toBe(true);
    forgetKey();
    expect(getKey()).toBeNull();
    expect(store.size).toBe(0);
  });

  it('turning remember off removes the stored copy', () => {
    setKey(KEY, true);
    setKey(KEY, false);
    expect(store.size).toBe(0);
    expect(getKey()).toBe(KEY);
  });

  it('loads a remembered key, and removes a stored value of the wrong shape', () => {
    store.set(STORE_KEY, KEY);
    expect(getKey()).toBe(KEY);
    forgetKey();
    store.set(STORE_KEY, '<img src=x onerror=alert(1)>');
    expect(getKey()).toBeNull();
    expect(store.has(STORE_KEY)).toBe(false);
  });

  it('works in memory when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(setKey(KEY, true)).toBe(true);
    expect(getKey()).toBe(KEY);
    expect(isRemembered()).toBe(false);
    expect(() => forgetKey()).not.toThrow();
    expect(getKey()).toBeNull();
  });
});
