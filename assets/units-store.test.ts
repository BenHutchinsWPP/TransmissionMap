// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadUnits, saveUnits } from './units-store.js';
import { getUnits, setUnits, DEFAULT_UNITS } from '../src/units.js';

const KEY = 'tm-units';
const store = (v: unknown) => localStorage.setItem(KEY, typeof v === 'string' ? v : JSON.stringify(v));

beforeEach(() => {
  localStorage.clear();
  setUnits(DEFAULT_UNITS);
});
afterEach(() => {
  vi.restoreAllMocks();
  setUnits(DEFAULT_UNITS);
});

describe('loadUnits', () => {
  it('leaves defaults in place when nothing is stored', () => {
    loadUnits();
    expect(getUnits()).toEqual(DEFAULT_UNITS);
  });

  it('applies a fully-specified stored preference', () => {
    const metric = { temp: 'C', speed: 'kph', distance: 'km', area: 'km2', elevation: 'm', pressure: 'inHg' };
    store(metric);
    loadUnits();
    expect(getUnits()).toEqual(metric);
  });

  it('applies a partial preference and leaves the rest at their current value', () => {
    store({ temp: 'C' });
    loadUnits();
    expect(getUnits()).toEqual({ ...DEFAULT_UNITS, temp: 'C' });
  });

  // Everything below is the trust boundary: localStorage is user-writable and
  // survives across deploys, so a stored blob can be anything at all.
  it('drops an unknown dimension but keeps its valid siblings', () => {
    store({ temp: 'C', luminance: 'lux' });
    loadUnits();
    expect(getUnits()).toEqual({ ...DEFAULT_UNITS, temp: 'C' });
  });

  it('drops an unrecognized value for a known dimension', () => {
    store({ temp: 'kelvin', speed: 'kph' });
    loadUnits();
    expect(getUnits()).toEqual({ ...DEFAULT_UNITS, speed: 'kph' });
  });

  // A key inherited from Object.prototype would index UNIT_OPTIONS to a
  // function, whose .options is undefined — the hasOwn guard is what keeps
  // .find() from throwing and discarding the valid keys alongside it.
  it('ignores keys that collide with Object.prototype members', () => {
    store({ toString: 'F', constructor: 'C', temp: 'C' });
    expect(() => loadUnits()).not.toThrow();
    expect(getUnits()).toEqual({ ...DEFAULT_UNITS, temp: 'C' });
  });

  it('survives malformed JSON', () => {
    store('{not json');
    expect(() => loadUnits()).not.toThrow();
    expect(getUnits()).toEqual(DEFAULT_UNITS);
  });

  it('survives JSON that is not an object', () => {
    for (const raw of ['null', '42', '"F"', '[]']) {
      setUnits(DEFAULT_UNITS);
      store(raw);
      expect(() => loadUnits()).not.toThrow();
      expect(getUnits()).toEqual(DEFAULT_UNITS);
    }
  });

  it('survives a localStorage that refuses to be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => loadUnits()).not.toThrow();
    expect(getUnits()).toEqual(DEFAULT_UNITS);
  });
});

describe('saveUnits', () => {
  it('round-trips the current preference through loadUnits', () => {
    setUnits({ temp: 'C', area: 'ha' });
    const saved = getUnits();
    saveUnits();
    setUnits(DEFAULT_UNITS);
    loadUnits();
    expect(getUnits()).toEqual(saved);
  });

  it('survives a write that is refused', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => saveUnits()).not.toThrow();
  });
});
