import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { state as StateSingleton } from './state.js';
import type { ZoneAlertEntry } from './nws-zone-join.js';

// The shared county source is layer-init.ts's; this suite's map double has it already.
vi.mock('./layers/layer-init.js', () => ({ ensureCountyBoundaries: vi.fn() }));


const ZONE = { source: 'nws_zones', sourceLayer: 'nws_zones' };
const COUNTY = { source: 'county_boundaries', sourceLayer: 'county_boundaries' };
const NWS_KEYS = ['nws_group', 'nws_sev', 'nws_multi'];

type Target = { source: string; sourceLayer: string; id: string };
const fid = (t: Target) => `${t.source}/${t.id}`;

// A map double holding a real per-feature state bag, merged by setFeatureState
// and cleared key by key by removeFeatureState, as MapLibre does.
async function setup() {
  const { state } = await import('./state.js');
  const bags = new Map<string, Record<string, unknown>>();
  const map = {
    on: vi.fn(),
    getSource: vi.fn(() => ({})),
    getLayer: vi.fn(() => undefined),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    setLayoutProperty: vi.fn(),
    setFeatureState: vi.fn((t: Target, s: Record<string, unknown>) => {
      bags.set(fid(t), { ...bags.get(fid(t)), ...s });
    }),
    removeFeatureState: vi.fn((t: Target, key?: string) => {
      const bag = bags.get(fid(t));
      if (!bag) return;
      if (key === undefined) bags.delete(fid(t)); else delete bag[key];
    }),
  };
  state.map = map as unknown as typeof StateSingleton.map;
  state.layerVisibility = { 'nws-alerts': true };
  const mod = await import('./nws-zone-join.js');
  const bus = await import('./state-bus.js');
  mod.initNwsZoneJoin();
  const bag = (src: typeof ZONE, id: string) => bags.get(`${src.source}/${id}`) ?? {};
  return { map, mod, bus, bag };
}

let snapshot: ZoneAlertEntry[] = [];
async function deliver(bus: typeof import('./state-bus.js'), entries: ZoneAlertEntry[]) {
  snapshot = entries;
  bus.emit('layer:data', { id: 'nws-alerts' } as never);
  await vi.advanceTimersByTimeAsync(0);
}

const alert = (over: Partial<ZoneAlertEntry>): ZoneAlertEntry => ({
  zones: [], fips: [], event: 'Test', id: 'a', _group: 'other', ...over,
});

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ zone_alerts: snapshot }) })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('nws-zone-join', () => {
  it('keys zones by a one-char type prefix + ugc (contract with extract_nws_zones.py / fetch_nws_alerts.py)', async () => {
    const { map, bus } = await setup();
    await deliver(bus, [alert({
      zones: [['forecast', 'CAZ041'], ['fire', 'CAZ241'], ['marine', 'PZZ530']],
    })]);
    const ids = map.setFeatureState.mock.calls
      .filter(([t]) => t.source === 'nws_zones').map(([t]) => t.id).sort();
    expect(ids).toEqual(['fCAZ241', 'mPZZ530', 'zCAZ041']);
  });

  it('paints each alerted zone and county with the winning alert', async () => {
    const { bag, bus } = await setup();
    await deliver(bus, [
      alert({ id: 'w', zones: [['forecast', 'CAZ041']], fips: ['06037'], severity: 'Moderate', _group: 'winter' }),
      alert({ id: 'f', fips: ['06037'], severity: 'Severe', _group: 'fire' }),
    ]);
    expect(bag(ZONE, 'zCAZ041')).toEqual({ nws_group: 'winter', nws_sev: 'Moderate', nws_multi: false });
    expect(bag(COUNTY, '06037')).toEqual({ nws_group: 'fire', nws_sev: 'Severe', nws_multi: true });
  });

  it('breaks a severity tie by the earliest `ends`', async () => {
    const { bag, bus } = await setup();
    await deliver(bus, [
      alert({ id: 'late', zones: [['forecast', 'CAZ041']], fips: ['06037'], severity: 'Severe',
              ends: '2026-07-16T20:00:00Z', _group: 'winter' }),
      alert({ id: 'early', zones: [['forecast', 'CAZ041']], fips: ['06037'], severity: 'Severe',
              ends: '2026-07-16T14:00:00Z', _group: 'fire' }),
    ]);
    expect(bag(ZONE, 'zCAZ041')).toEqual({ nws_group: 'fire', nws_sev: 'Severe', nws_multi: true });
    expect(bag(COUNTY, '06037')).toEqual({ nws_group: 'fire', nws_sev: 'Severe', nws_multi: true });
  });

  it('unpaints a zone and county that drop out of the next snapshot', async () => {
    const { bag, bus, mod } = await setup();
    await deliver(bus, [
      alert({ id: 'a', zones: [['forecast', 'CAZ041']], fips: ['06037'], severity: 'Minor' }),
      alert({ id: 'b', zones: [['fire', 'ORZ601']], fips: ['41051'], severity: 'Minor' }),
    ]);
    await deliver(bus, [alert({ id: 'b', zones: [['fire', 'ORZ601']], fips: ['41051'], severity: 'Minor' })]);
    expect(bag(ZONE, 'zCAZ041')).toEqual({});
    expect(bag(COUNTY, '06037')).toEqual({});
    expect(bag(ZONE, 'fORZ601').nws_group).toBe('other');
    expect(bag(COUNTY, '41051').nws_group).toBe('other');
    expect(mod.lookupByZone('forecast', 'CAZ041')).toEqual([]);
    expect(mod.lookupByFips('06037')).toEqual([]);
  });

  it('unpaints an alert on the prune path once its expiry passes', async () => {
    const { bag, bus, mod } = await setup();
    await deliver(bus, [
      alert({ id: 'soon', zones: [['forecast', 'CAZ041']], fips: ['06037'], ends: '2026-07-16T12:30:00Z' }),
      alert({ id: 'later', fips: ['41051'], expires: '2026-07-16T18:00:00Z' }),
    ]);
    mod.pruneExpiredZoneAlerts();
    expect(bag(ZONE, 'zCAZ041').nws_group).toBe('other');

    vi.setSystemTime(new Date('2026-07-16T13:00:00Z'));
    mod.pruneExpiredZoneAlerts();
    expect(bag(ZONE, 'zCAZ041')).toEqual({});
    expect(bag(COUNTY, '06037')).toEqual({});
    expect(bag(COUNTY, '41051').nws_group).toBe('other');
  });

  it("never removes ODIN's keys from a shared county feature", async () => {
    const { map, bag, bus, mod } = await setup();
    map.setFeatureState({ ...COUNTY, id: '06037' }, { odin_out: 1200, odin_n: 3 });
    await deliver(bus, [alert({ fips: ['06037'], ends: '2026-07-16T12:30:00Z' })]);
    expect(bag(COUNTY, '06037')).toMatchObject({ odin_out: 1200, nws_group: 'other' });

    vi.setSystemTime(new Date('2026-07-16T13:00:00Z'));
    mod.pruneExpiredZoneAlerts();
    expect(bag(COUNTY, '06037')).toEqual({ odin_out: 1200, odin_n: 3 });

    map.setFeatureState({ ...COUNTY, id: '41051' }, { odin_out: 5 });
    await deliver(bus, [alert({ fips: ['41051'] })]);
    await deliver(bus, []);
    expect(bag(COUNTY, '41051')).toEqual({ odin_out: 5 });

    for (const [, key] of map.removeFeatureState.mock.calls) expect(NWS_KEYS).toContain(key);
  });
});
