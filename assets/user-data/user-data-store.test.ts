import { describe, it, expect, vi, afterEach } from 'vitest';
import { parsePayload, serializePayload, createUserDataStore, STORAGE_KEY } from './user-data-store.js';

const fc = (n = 1): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, i) => ({
    type: 'Feature', id: `f${i}`, geometry: { type: 'Point', coordinates: [i, i] }, properties: {},
  })),
});

afterEach(() => vi.restoreAllMocks());

describe('parsePayload', () => {
  it('returns an empty payload for null or empty input', () => {
    expect(parsePayload(null)).toEqual({ layers: [], drawn: { type: 'FeatureCollection', features: [] } });
    expect(parsePayload('')).toEqual({ layers: [], drawn: { type: 'FeatureCollection', features: [] } });
  });

  it('returns an empty payload and warns on bad JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = parsePayload('{not json');
    expect(out.layers).toEqual([]);
    expect(out.drawn.features).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('returns an empty payload and warns on a non-object payload', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePayload('42').layers).toEqual([]);
    expect(parsePayload('[1,2]').layers).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('skips a malformed layer with a warning and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify({
      userLayers: [
        { filename: 'good.geojson', geojson: fc(2), color: '#ff0000', visible: false },
        { filename: 'bad.geojson', geojson: { type: 'Feature' } },
        null,
        { geojson: fc(1) },
        { filename: 'also-good.kml', geojson: fc(1) },
      ],
      drawnFeatures: fc(3),
    });
    const out = parsePayload(raw);
    expect(out.layers.map(l => l.filename)).toEqual(['good.geojson', 'also-good.kml']);
    expect(out.layers[0]).toMatchObject({ color: '#ff0000', visible: false });
    expect(out.layers[1]).toMatchObject({ color: undefined, visible: true });
    expect(out.drawn.features).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('ignores a malformed drawnFeatures value with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = parsePayload(JSON.stringify({ userLayers: [], drawnFeatures: { features: 'x' } }));
    expect(out.drawn).toEqual({ type: 'FeatureCollection', features: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/drawnFeatures/);
  });
});

describe('serializePayload', () => {
  it('writes the stored shape and drops UI-only fields', () => {
    const layer = { id: 'user-0', filename: 'a.geojson', geojson: fc(1), color: '#123456', visible: true, expanded: true };
    const s = serializePayload([layer], fc(1));
    expect(s).toBe(JSON.stringify({
      userLayers: [{ filename: 'a.geojson', geojson: fc(1), color: '#123456', visible: true }],
      drawnFeatures: fc(1),
    }));
  });

  it('round-trips through parsePayload', () => {
    const layers = [{ filename: 'a.geojson', geojson: fc(2), color: '#123456', visible: false }];
    expect(parsePayload(serializePayload(layers, fc(1)))).toEqual({ layers, drawn: fc(1) });
  });
});

describe('createUserDataStore', () => {
  const memory = (init?: string) => {
    const m = new Map<string, string>(init ? [[STORAGE_KEY, init]] : []);
    return {
      m,
      getItem: vi.fn((k: string) => m.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => { m.set(k, v); }),
    };
  };
  const layer = (name: string) => ({ filename: name, geojson: fc(1), visible: true });
  const ids = (s: string) => (JSON.parse(s).drawnFeatures.features as GeoJSON.Feature[]).map(f => f.id);
  const names = (s: string) => (JSON.parse(s).userLayers as { filename: string }[]).map(l => l.filename);

  it('holds saves back until load, then writes once after the restore', () => {
    const storage = memory(serializePayload([layer('stored.geojson')], fc(2)));
    const snap = { layers: [layer('early.geojson')], drawn: null as GeoJSON.FeatureCollection | null };
    const store = createUserDataStore(storage, () => snap);

    store.save();
    store.save();
    expect(storage.setItem).not.toHaveBeenCalled();

    // The restore merges the stored layers into the live snapshot.
    store.load(p => { snap.layers.push(...p.layers); });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const saved = storage.m.get(STORAGE_KEY)!;
    expect(names(saved)).toEqual(['early.geojson', 'stored.geojson']);
    expect(ids(saved)).toEqual(['f0', 'f1']); // drawings not loaded: the stored ones are kept
  });

  it('load with nothing held back hands over the payload and writes nothing', () => {
    const storage = memory(serializePayload([layer('a')], fc(1)));
    const restore = vi.fn();
    createUserDataStore(storage, () => ({ layers: [], drawn: null })).load(restore);
    expect(restore).toHaveBeenCalledWith({ layers: [layer('a')], drawn: fc(1) });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('saves write straight through once loaded', () => {
    const storage = memory();
    const store = createUserDataStore(storage, () => ({ layers: [layer('x')], drawn: fc(1) }));
    store.load(() => {});
    store.save();
    expect(names(storage.m.get(STORAGE_KEY)!)).toEqual(['x']);
  });

  it('keeps the last-known drawings when a snapshot has none', () => {
    const storage = memory(serializePayload([], fc(2)));
    let drawn: GeoJSON.FeatureCollection | null = null;
    const store = createUserDataStore(storage, () => ({ layers: [], drawn }));
    store.load(() => {});
    expect(store.drawn()).toEqual(fc(2));
    store.save();
    expect(ids(storage.m.get(STORAGE_KEY)!)).toEqual(['f0', 'f1']);
    drawn = fc(3);
    store.save();
    drawn = null;
    store.save();
    expect(ids(storage.m.get(STORAGE_KEY)!)).toEqual(['f0', 'f1', 'f2']);
    expect(store.drawn()).toEqual(fc(3));
  });

  it('a failed read skips the restore and still flushes the held-back save', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = new Map<string, string>();
    const storage = {
      getItem: (): string | null => { throw new Error('denied'); },
      setItem: (k: string, v: string) => { m.set(k, v); },
    };
    const store = createUserDataStore(storage, () => ({ layers: [], drawn: fc(1) }));
    store.save();
    const restore = vi.fn();
    store.load(restore);
    expect(restore).not.toHaveBeenCalled();
    expect(ids(m.get(STORAGE_KEY)!)).toEqual(['f0']);
  });

  it('a failed write goes to onError and the store keeps working', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = vi.fn();
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    const store = createUserDataStore(storage, () => ({ layers: [], drawn: fc(1) }), onError);
    store.load(() => {});
    store.save();
    store.save();
    expect(onError).toHaveBeenCalledTimes(2);
    expect((onError.mock.calls[0][0] as Error).message).toBe('QuotaExceededError');
  });
});
