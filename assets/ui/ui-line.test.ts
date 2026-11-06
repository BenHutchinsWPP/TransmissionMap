// @vitest-environment jsdom
// The Line tab's fault locator over a stubbed reader and map: the chain's ends
// and notes, a pin from each end, the refusals, and the lt- layers added and removed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDrawerEnv, resetDrawerEnv } from './test-drawer-env.js';
import { state } from '../state.js';
import { setUnits, DEFAULT_UNITS } from '../../src/units.js';
import type { Chain, LineOutcome, IdxRow } from '../lines/line-read.js';

const reader = vi.hoisted(() => ({
  chain: null as unknown as LineOutcome<Chain>,
  idx: null as unknown as LineOutcome<IdxRow>,
}));
vi.mock('../lines/line-read.js', () => ({
  chainGeometry: vi.fn(async () => reader.chain),
  lookup: vi.fn(async () => reader.idx),
}));

const subs = vi.hoisted(() => ({ features: [] as GeoJSON.Feature[] }));
vi.mock('../layers/layer-data.js', async () => {
  const { state } = await import('../state.js');
  return { loadSource: vi.fn(async (id: string) => { state.sourcesData[id] = subs.features; state.sourcesLoaded[id] = true; }) };
});

const { openLineTools } = await import('./ui-line.js');
const { closeLine, linePanel } = await import('./ui-table.js');

// Two ways on the equator, the second drawn backwards: 0.1° each.
const DEG_M = 6371.0088e3 * Math.PI / 180;
const CHAIN: Chain = {
  chain: 7, startSub: 12342, endSub: null,
  ways: [
    { fid: 102, rev: false, length_km: 0.1 * DEG_M / 1000, geometry: { type: 'LineString', coordinates: [[0, 0], [0.1, 0]] } },
    { fid: 202, rev: true, length_km: 0.1 * DEG_M / 1000, geometry: { type: 'LineString', coordinates: [[0.2, 0], [0.1, 0]] } },
  ],
};

let sources: Map<string, unknown>, layers: Map<string, unknown>;
function stubMap() {
  sources = new Map(); layers = new Map();
  Object.assign(state.map!, {
    getSource: (id: string) => sources.has(id) ? { setData: (d: unknown) => sources.set(id, d) } : undefined,
    addSource: (id: string, spec: { data: unknown }) => sources.set(id, spec.data),
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => layers.get(id),
    addLayer: (spec: { id: string }) => layers.set(spec.id, spec),
    removeLayer: (id: string) => layers.delete(id),
    querySourceFeatures: () => [],
  });
}

const panel = () => linePanel().textContent ?? '';
const flush = () => new Promise(r => setTimeout(r, 0));
async function locate(a: string, b: string) {
  (linePanel().querySelector('#lt-da') as HTMLInputElement).value = a;
  (linePanel().querySelector('#lt-db') as HTMLInputElement).value = b;
  linePanel().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}

beforeEach(() => {
  installDrawerEnv();
  stubMap();
  setUnits({ ...DEFAULT_UNITS, distance: 'km' });
  reader.chain = { ok: true, result: CHAIN };
  reader.idx = { ok: true, result: { row: 1, length_km: 0.1, chain: 7, circuits: 2 } };
});
afterEach(() => { closeLine(); resetDrawerEnv(); setUnits(DEFAULT_UNITS); });

const osm = { layerId: 'osm-transmission-lines', fid: 102, properties: { name: 'Test 500', nominal_kv: 500 } };

describe('the Line tab', () => {
  it('shows the chain, its ends and the notes', async () => {
    await openLineTools(osm);
    await flush();
    const txt = panel();
    expect(txt).toContain('Test 500');
    expect(txt).toContain('The whole chain: 2 ways');
    expect(txt).toContain('substation (OSM way 1234)');
    expect(txt).toMatch(/End B: the chain ends at a branch/);
    expect(txt).toContain('This line carries 2 circuits');
    expect([...layers.keys()].every(id => id.startsWith('lt-'))).toBe(true);
    expect([...sources.keys()].sort()).toEqual(['lt-line', 'lt-pts', 'lt-span']);
  });

  it('places a pin from each end on the true geometry, consistent with the length', async () => {
    await openLineTools(osm);
    await flush();
    await locate('5', '5');
    const pins = (sources.get('lt-pts') as GeoJSON.FeatureCollection).features.filter(f => f.properties!.kind === 'pin');
    expect(pins).toHaveLength(2);
    const [a, b] = pins.map(f => (f.geometry as GeoJSON.Point).coordinates);
    expect(a[0]).toBeCloseTo(5000 / DEG_M, 9);
    expect(b[0]).toBeCloseTo(0.2 - 5000 / DEG_M, 9);
    expect(panel()).toContain(`Gap between the pins: ${((0.2 * DEG_M - 10_000) / 1000).toFixed(2)} km`);
    expect((sources.get('lt-span') as GeoJSON.FeatureCollection).features).toHaveLength(2);
  });

  it('refuses a distance longer than the line', async () => {
    await openLineTools(osm);
    await flush();
    await locate('50', '');
    expect(panel()).toMatch(/50\.00 km from end A is longer than the line \(22\.24 km\)/);
  });

  it('refuses when the full geometry cannot be read, and draws nothing', async () => {
    reader.chain = { ok: false, reason: 'offline' };
    await openLineTools(osm);
    await flush();
    expect(panel()).toMatch(/needs the line's full geometry/);
    expect(sources.size).toBe(0);
  });

  it('refuses ways that do not meet, and draws the pieces', async () => {
    reader.chain = { ok: true, result: { ...CHAIN, ways: [CHAIN.ways[0], { ...CHAIN.ways[1], geometry: { type: 'LineString', coordinates: [[0.3, 0], [0.2, 0]] } }] } };
    await openLineTools(osm);
    await flush();
    expect(panel()).toContain('2 pieces that do not meet');
    const line = (sources.get('lt-line') as GeoJSON.FeatureCollection).features[0].geometry as GeoJSON.MultiLineString;
    expect(line.coordinates).toHaveLength(2);
  });

  const hifld = { layerId: 'hifld-transmission-lines', fid: 102, properties: { SUB_1: 'NORTH', SUB_2: 'TAP123', VOLTAGE: 345 } };
  const sub = (name: string, x: number): GeoJSON.Feature => ({ type: 'Feature', properties: { name }, geometry: { type: 'Point', coordinates: [x, 0.001] } });

  it('names HIFLD ends from SUB_1 / SUB_2, placed by the substations of those names, and removes its layers on close', async () => {
    reader.chain = { ok: true, result: { chain: -1, startSub: null, endSub: null, ways: [CHAIN.ways[0]] } };
    reader.idx = { ok: true, result: { row: 1, length_km: 0.1, chain: -1, circuits: -1 } };
    subs.features = [sub('North', 0.1), sub('Tap123', 0)];   // the substations file is title case   // SUB_1 at the geometry's far end
    await openLineTools(hifld);
    await flush();
    expect(panel()).toContain('Distance from A (NORTH)');
    expect(panel()).toContain('Distance from B (TAP123)');
    expect(panel()).toContain('matched to HIFLD substations by name');
    expect(panel()).not.toContain('Measure along');
    await locate('1', '');
    const pin = (sources.get('lt-pts') as GeoJSON.FeatureCollection).features.find(f => f.properties!.kind === 'pin')!;
    expect((pin.geometry as GeoJSON.Point).coordinates[0]).toBeCloseTo(0.1 - 1000 / DEG_M, 9);
    closeLine();
    expect(layers.size + sources.size).toBe(0);
  });

  it('says when HIFLD ends cannot be placed, and Swap turns the line round', async () => {
    reader.chain = { ok: true, result: { chain: -1, startSub: null, endSub: null, ways: [CHAIN.ways[0]] } };
    reader.idx = { ok: true, result: { row: 1, length_km: 0.1, chain: -1, circuits: -1 } };
    subs.features = [];
    await openLineTools(hifld);
    await flush();
    expect(panel()).toContain('A and B may be swapped');
    const a0 = (sources.get('lt-pts') as GeoJSON.FeatureCollection).features.find(f => f.properties!.label === 'A')!;
    expect((a0.geometry as GeoJSON.Point).coordinates).toEqual([0, 0]);
    (linePanel().querySelector('.lt-swap') as HTMLButtonElement).click();
    const a1 = (sources.get('lt-pts') as GeoJSON.FeatureCollection).features.find(f => f.properties!.label === 'A')!;
    expect((a1.geometry as GeoJSON.Point).coordinates).toEqual([0.1, 0]);
  });
});
