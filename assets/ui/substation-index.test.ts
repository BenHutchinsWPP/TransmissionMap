// Tests for substation-index.ts: one shared load, a failed or empty load is forgotten and retried;
// snapEnd's order (HIFLD known kV → OSM known kV → HIFLD unknown kV → null) and its OSM failure path.
// Deps: substation-index.ts, route/snap.ts; layer-data.js and lines/osm-substation.js are mocked;
//       state.sourcesData is filled by hand.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../layers/layer-data.js', () => ({ loadSource: vi.fn() }));
vi.mock('../lines/osm-substation.js', () => ({ substationPointsNear: vi.fn() }));

import { loadSource } from '../layers/layer-data.js';
import { state } from '../state.js';
import { layerSourceId } from '../layers/layer-source.js';
import { ensureSubstationIndex, cachedSubstationIndex, _resetSubstationIndex, snapEnd } from './substation-index.js';
import { substationPointsNear } from '../lines/osm-substation.js';
import { buildSubstationIndex, type OsmPoint } from '../route/snap.js';

const sub = (id: string, name: string, lng: number, lat: number) => ({
  type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lng, lat] },
  properties: { hifld_id: id, name, max_kv: 345, states: '|NV|', ba: '|NEVP|' },
});
const key = () => layerSourceId('hifld-substations');

beforeEach(() => {
  _resetSubstationIndex();
  vi.mocked(loadSource).mockReset();
  delete (state.sourcesData as Record<string, unknown>)[key()];
});

describe('ensureSubstationIndex', () => {
  it('builds the index from the loaded features and shares one load', async () => {
    vi.mocked(loadSource).mockImplementation(async () => {
      (state.sourcesData as Record<string, unknown>)[key()] = [sub('1', 'ALPHA', -119.8, 39.5), sub('2', 'BETA', -119.9, 39.6)];
    });
    const [a, b] = await Promise.all([ensureSubstationIndex(), ensureSubstationIndex()]);
    expect(vi.mocked(loadSource)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadSource)).toHaveBeenCalledWith('hifld-substations');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) { expect(a.result).toBe(b.result); expect(a.result.subs.map((s) => s.id)).toEqual(['1', '2']); }
    expect(cachedSubstationIndex()).not.toBeNull();
    await ensureSubstationIndex();
    expect(vi.mocked(loadSource)).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty list and retries on the next call', async () => {
    vi.mocked(loadSource).mockResolvedValue(undefined as never);
    const o = await ensureSubstationIndex();
    expect(o).toEqual({ ok: false, reason: 'the substation list could not be loaded; try again' });
    expect(cachedSubstationIndex()).toBeNull();
    vi.mocked(loadSource).mockImplementation(async () => {
      (state.sourcesData as Record<string, unknown>)[key()] = [sub('1', 'ALPHA', -119.8, 39.5)];
    });
    expect((await ensureSubstationIndex()).ok).toBe(true);
    expect(vi.mocked(loadSource)).toHaveBeenCalledTimes(2);
  });

  it('refuses a failed load and retries', async () => {
    vi.mocked(loadSource).mockRejectedValueOnce(new Error('net'));
    expect((await ensureSubstationIndex()).ok).toBe(false);
    vi.mocked(loadSource).mockImplementation(async () => {
      (state.sourcesData as Record<string, unknown>)[key()] = [sub('1', 'ALPHA', -119.8, 39.5)];
    });
    expect((await ensureSubstationIndex()).ok).toBe(true);
  });
});

describe('snapEnd', () => {
  const at: [number, number] = [-119.8, 39.5];
  const hifld = (id: string, kv: number | null, dLng: number) => ({
    type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [at[0] + dLng, at[1]] },
    properties: { hifld_id: id, name: `H${id}`, max_kv: kv, states: '|NV|', ba: '|NEVP|' },
  });
  const idx = (...fs: ReturnType<typeof hifld>[]) => buildSubstationIndex({ type: 'FeatureCollection', features: fs });
  const osmPt = (fid: number, kv: number | null, dLng: number): OsmPoint =>
    ({ fid, lngLat: [at[0] + dLng, at[1]], name: `O${fid}`, kv, subType: 'transmission', countries: '|USA|' });
  const reader = (pts: OsmPoint[]) => vi.fn(async () => pts);

  it('a HIFLD hit of known kV wins without reading OSM', async () => {
    const read = reader([osmPt(1, 500, 0.0001)]);
    const h = await snapEnd(idx(hifld('1', 345, 0.01)), at, 345, 3, { osm: true, read });
    expect(h).toMatchObject({ id: '1', source: 'hifld' });
    expect(read).not.toHaveBeenCalled();
  });

  it('no HIFLD hit: the OSM hit, read over the radius box in metres', async () => {
    const read = reader([osmPt(7, 345, 0.002)]);
    const h = await snapEnd(idx(hifld('1', 345, 0.5)), at, 345, 3, { osm: true, read });
    expect(h).toMatchObject({ id: 'osm:7', source: 'osm', maxKv: 345 });
    expect(read).toHaveBeenCalledWith(at, 3000);
    expect(await snapEnd(null, at, 345, 5, { osm: true, read })).toMatchObject({ id: 'osm:7' });
  });

  it('an OSM hit of known kV beats a HIFLD hit of unknown kV; that HIFLD hit is next', async () => {
    const unknown = idx(hifld('U', null, 0.001));
    expect(await snapEnd(unknown, at, 345, 3, { osm: true, read: reader([osmPt(7, 500, 0.02)]) }))
      .toMatchObject({ id: 'osm:7' });
    expect(await snapEnd(unknown, at, 345, 3, { osm: true, read: reader([osmPt(7, null, 0.001)]) }))
      .toMatchObject({ id: 'U', kvUnknown: true, source: 'hifld' });
    expect(await snapEnd(idx(), at, 345, 3, { osm: true, read: reader([]) })).toBeNull();
  });

  it('osm: false never reads OSM (the chat)', async () => {
    const read = reader([osmPt(7, 500, 0.001)]);
    expect(await snapEnd(idx(hifld('U', null, 0.001)), at, 345, 3, { osm: false, read })).toMatchObject({ id: 'U' });
    expect(await snapEnd(idx(), at, 345, 3, { osm: false, read })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('a rejecting reader is no OSM hit', async () => {
    const read = vi.fn(async () => { throw new Error('net'); });
    expect(await snapEnd(idx(), at, 345, 3, { osm: true, read })).toBeNull();
    expect(await snapEnd(idx(hifld('U', null, 0.001)), at, 345, 3, { osm: true, read })).toMatchObject({ id: 'U' });
  });

  it('the default reader is osm-substation.ts substationPointsNear', async () => {
    vi.mocked(substationPointsNear).mockResolvedValue([osmPt(9, 345, 0.001)]);
    expect(await snapEnd(idx(), at, 345, 1, { osm: true })).toMatchObject({ id: 'osm:9' });
    expect(vi.mocked(substationPointsNear)).toHaveBeenCalledWith(at, 1000);
  });
});
