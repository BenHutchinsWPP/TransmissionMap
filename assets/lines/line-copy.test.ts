// line-copy.ts: full geometry merged with the tile properties, the fallback to tile
// geometry, and the caps (line count, copy size, projected My Data payload) checked
// before anything is committed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const added: { features: GeoJSON.Feature[]; layerName?: string }[] = [];
let stored = 0;
vi.mock('../user-data/user-data.js', () => ({
  addCopiedFeatures: (features: GeoJSON.Feature[], layerName?: string) => added.push({ features, layerName }),
  storedUserDataChars: () => stored,
}));
vi.mock('../user-data/user-data-export.js', () => ({ downloadFile: vi.fn() }));

const full: GeoJSON.LineString = { type: 'LineString', coordinates: [[0, 0], [0.5, 0.5], [1, 1]] };
let reply: 'ok' | 'offline' | 'unavailable' | 'timeout' = 'ok';
let geometryKind: 'line' | 'polygon' = 'line';
let bigGeometry = false;
vi.mock('./line-read.js', () => ({
  MAX_SELECTION: 1000,
  lineGeometry: async () => (reply === 'ok' ? { ok: true, result: full } : { ok: false, reason: reply }),
  selectionGeometry: async (_l: string, fids: (string | number)[]) => {
    if (reply !== 'ok') return { ok: false, reason: reply };
    const g: GeoJSON.LineString = bigGeometry
      ? { type: 'LineString', coordinates: Array.from({ length: 2000 }, (_, i) => [i * 1e-6, 1.123456]) }
      : full;
    return { ok: true, result: { geometries: new Map(fids.slice(1).map(f => [String(f), g])), missing: [fids[0]] } };
  },
  lineDataset: async () => ({ ok: true, result: { dataset: 'osm_transmission_lines', geometry: geometryKind, label: 'OSM Transmission Lines',
    attribution: '© OpenStreetMap contributors', licence: 'ODbL 1.0', url: 'https://www.openstreetmap.org/copyright' } }),
}));

const { copyLines, itemsBbox, MAX_COPY_CHARS, SIMPLIFIED } = await import('./line-copy.js');

const tile: GeoJSON.LineString = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
const item = (fid: number) => ({ fid, properties: { name: `L${fid}`, nominal_kv: 500 }, tileGeometry: tile,
  mapLayerId: 'osm-transmission-lines-hv' });

beforeEach(() => { added.length = 0; stored = 0; reply = 'ok'; bigGeometry = false; geometryKind = 'line'; });

describe('copyLines', () => {
  it('copies one line with its full geometry, the tile properties and the credit', async () => {
    const r = await copyLines('osm-transmission-lines', [item(1234562)]);
    expect(r).toEqual({ kind: 'copied', n: 1, simplified: 0 });
    const f = added[0].features[0];
    expect(f.geometry).toEqual(full);
    expect(f.properties).toMatchObject({ name: 'L1234562', nominal_kv: 500, fid: 1234562,
      source: 'OSM Transmission Lines', licence: 'ODbL 1.0', osm: 'https://www.openstreetmap.org/way/123456',
      __src: 'osm-transmission-lines-hv' });
    expect(added[0].layerName).toBeUndefined();
  });

  it('gives a non-OSM layer with a native tile id (PAD-US) no OSM link', async () => {
    geometryKind = 'polygon';
    await copyLines('padus', [{ ...item(1234562), tileGeometry: null, mapLayerId: 'padus-fill' }, { ...item(22), tileGeometry: null, mapLayerId: 'padus-fill' }]);
    expect(added[0].features[0].properties).toMatchObject({ fid: 22 });
    expect(added[0].features[0].properties).not.toHaveProperty('osm');
  });

  it('keeps the tile geometry, marked, when the files cannot answer', async () => {
    reply = 'offline';
    const r = await copyLines('osm-transmission-lines', [item(12)]);
    expect(r).toEqual({ kind: 'copied', n: 1, simplified: 1 });
    expect(added[0].features[0].geometry).toEqual(tile);
    expect(added[0].features[0].properties?.geometry_source).toBe(SIMPLIFIED);
  });

  it('refuses when there are no line files here, and commits nothing', async () => {
    reply = 'unavailable';
    expect(await copyLines('osm-transmission-lines', [item(12)])).toEqual({ kind: 'refused', reason: 'unavailable' });
    expect(added).toEqual([]);
  });

  it('puts a selection in its own layer; a line the files lack keeps its tile geometry', async () => {
    const r = await copyLines('osm-transmission-lines', [item(12), item(22), item(32)], 'OSM Lines: 3 lines');
    expect(r).toEqual({ kind: 'copied', n: 3, simplified: 1 });
    expect(added[0].layerName).toBe('OSM Lines: 3 lines');
  });

  it('reports a read that timed out, not not-found, when nothing was found', async () => {
    reply = 'timeout';
    const hint = (fid: number) => ({ ...item(fid), tileGeometry: null, searchHint: { type: 'Point', coordinates: [0, 0] } as GeoJSON.Geometry });
    expect(await copyLines('osm-transmission-lines', [hint(1), hint(2)])).toEqual({ kind: 'refused', reason: 'timeout' });
    expect(await copyLines('osm-transmission-lines', [hint(1)])).toEqual({ kind: 'refused', reason: 'timeout' });
    expect(added).toEqual([]);
  });

  it('counts a point-only line the files lack in missing, and never copies it as a Point', async () => {
    const hint = { ...item(1), tileGeometry: null, searchHint: { type: 'Point', coordinates: [0, 0] } as GeoJSON.Geometry };
    const r = await copyLines('osm-transmission-lines', [hint, item(22), item(32)]);
    expect(r).toEqual({ kind: 'copied', n: 2, simplified: 0, missing: 1 });
    expect(added[0].features.every(f => f.geometry.type !== 'Point')).toBe(true);
  });

  it('counts what a timed-out partial read left unread under unread, not missing', async () => {
    reply = 'timeout';
    const hint = (fid: number) => ({ ...item(fid), tileGeometry: null, searchHint: { type: 'Point', coordinates: [0, 0] } as GeoJSON.Geometry });
    const r = await copyLines('osm-transmission-lines', [hint(1), hint(2), item(3)]);
    expect(r).toEqual({ kind: 'copied', n: 1, simplified: 1, unread: 2 });
    expect(r).not.toHaveProperty('missing');
  });

  it('never copies a polygon from its tile piece, whatever the read said', async () => {
    const piece: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const poly = (fid: number) => ({ ...item(fid), tileGeometry: piece as GeoJSON.Geometry });
    geometryKind = 'polygon';
    expect(await copyLines('osm-substations-polygons', [poly(12), poly(22), poly(32)])).toEqual({ kind: 'copied', n: 2, simplified: 0, missing: 1 });
    expect(added[0].features.every(f => f.geometry !== piece && !f.properties?.geometry_source)).toBe(true);
    added.length = 0; reply = 'offline';
    expect(await copyLines('osm-substations-polygons', [poly(12)])).toEqual({ kind: 'refused', reason: 'offline' });
    geometryKind = 'line';   // an index that did not answer for the dataset: the tile's own shape still decides
    expect(await copyLines('osm-substations-polygons', [poly(12), poly(22)])).toEqual({ kind: 'refused', reason: 'offline' });
    expect(added).toEqual([]);
  });

  it('refuses more than 1,000 lines', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => item(i));
    expect(await copyLines('osm-transmission-lines', items)).toEqual({ kind: 'refused', reason: 'too-many' });
    expect(added).toEqual([]);
  });

  it('offers a download over the copy size cap, with the attribution as a foreign member', async () => {
    bigGeometry = true;
    const items = Array.from({ length: 60 }, (_, i) => item(i));
    const r = await copyLines('osm-transmission-lines', items);
    expect(r.kind).toBe('download');
    if (r.kind !== 'download') return;
    expect(r.chars).toBeGreaterThan(MAX_COPY_CHARS);
    expect(r.fc).toMatchObject({ attribution: '© OpenStreetMap contributors', licence: 'ODbL 1.0' });
    expect(r.fc.features[0].properties).not.toHaveProperty('__src');
    expect(added).toEqual([]);
  });

  it('offers a download when My Data would pass its storage budget', async () => {
    stored = 3_999_900;
    const r = await copyLines('osm-transmission-lines', [item(12)]);
    expect(r.kind).toBe('download');
    expect(added).toEqual([]);
  });
});

const padded = ([a, b, c, d]: number[]) => [a - 1e-6, b - 1e-6, c + 1e-6, d + 1e-6];
describe('itemsBbox', () => {
  it('spans every tile geometry', () => {
    const a = { ...item(1), tileGeometry: { type: 'MultiLineString', coordinates: [[[-3, 2], [1, 5]], [[4, -1], [0, 0]]] } as GeoJSON.Geometry };
    expect(itemsBbox([a, item(2)])).toEqual(padded([-3, -1, 4, 5]));
  });
  it('spans a point-only item\'s search hint beside tile geometry, and nothing more', () => {
    const a = { ...item(1), tileGeometry: { type: 'LineString', coordinates: [[0, 0], [2, 3]] } as GeoJSON.Geometry };
    const b = { ...item(2), tileGeometry: null, searchHint: { type: 'Point', coordinates: [7, -4] } as GeoJSON.Geometry };
    expect(itemsBbox([a, b])).toEqual(padded([0, -4, 7, 3]));
  });
  it('pads a vertical line by 1e-6° each side and leaves an empty box infinite', () => {
    const v = { ...item(1), tileGeometry: { type: 'LineString', coordinates: [[5, 1], [5, 2]] } as GeoJSON.Geometry };
    const [w, , e] = itemsBbox([v]);
    expect(e - w).toBeCloseTo(2e-6, 12);
    expect(w).toBeLessThan(5 - 5e-7);
    expect(itemsBbox([{ ...item(2), tileGeometry: null }])).toEqual([Infinity, Infinity, -Infinity, -Infinity]);
  });
});
