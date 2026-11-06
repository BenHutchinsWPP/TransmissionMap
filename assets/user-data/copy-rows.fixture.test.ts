// copy-rows.ts → line-copy.ts → line-read.ts over the mini GeoParquet in
// lines/fixtures/analysis/: a table copy of 21 columns-file (point-only) line rows,
// and a copy of substation polygons (IDX + GEO only), which never fall back to tile geometry.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const added: { features: GeoJSON.Feature[]; layerName?: string }[] = [];
vi.mock('./user-data.js', () => ({
  addCopiedFeatures: (features: GeoJSON.Feature[], layerName?: string) => {
    added.push({ features, layerName });
    return { saved: true };
  },
  storedUserDataChars: () => 0,
}));
vi.mock('./user-data-export.js', () => ({ downloadFile: vi.fn() }));

const { copyRows, copyAvailable } = await import('./copy-rows.js');
const { resetLineRead } = await import('../lines/line-read.js');

const FIX = fileURLToPath(new URL('../lines/fixtures/analysis/', import.meta.url));
const OSM = 'osm-transmission-lines';

function serve(url: string, init?: RequestInit): Response {
  const range = new Headers(init?.headers).get('range');
  if (!url.startsWith('data/analysis/')) return new Response('', { status: 404 });
  let bytes: Buffer;
  try { bytes = readFileSync(FIX + url.slice('data/analysis/'.length)); } catch { return new Response('', { status: 404 }); }
  const m = range?.match(/^bytes=(\d+)-(\d+)$/);
  if (!m) return new Response(new Uint8Array(bytes), { status: 200 });
  return new Response(new Uint8Array(bytes.subarray(Number(m[1]), Number(m[2]) + 1)), { status: 206 });
}

// Grid line fid 1000 + i starts at (20 + (i % 30) × 0.1, 10 + ⌊i / 30⌋ × 0.1).
const pointRow = (i: number) => ({
  id: 1000 + i, props: {},
  feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [20 + (i % 30) * 0.1, 10 + Math.floor(i / 30) * 0.1] },
    properties: { nominal_kv: 115 } } as GeoJSON.Feature,
  pointOnly: true as const,
});

beforeEach(() => {
  added.length = 0;
  resetLineRead();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'data/analysis/index.json') return new Response(readFileSync(FIX + 'index.json', 'utf8'), { status: 200 });
    return serve(url, init);
  }));
});

describe('copyRows of point-only line rows over the fixture files', () => {
  it('copies 21 lines with full geometry and no geometry_source, skipping an unfound fid', async () => {
    const rows = [...Array.from({ length: 21 }, (_, i) => pointRow(i)), { ...pointRow(0), id: 9999 }];
    const res = await copyRows(OSM, rows, 'N');
    expect(res).toEqual({ kind: 'copied', n: 21, simplified: 0, missing: 1 });
    expect(added[0].features).toHaveLength(21);
    for (const f of added[0].features) {
      expect(f.geometry.type).toBe('LineString');
      expect(f.properties).not.toHaveProperty('geometry_source');
    }
  });
});

const POLY = 'osm-substations-polygons';
const piece: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[1, 1], [1.1, 1], [1.1, 1.1], [1, 1]]] };   // a clipped tile piece
const tileRow = (id: number) => ({ id, props: {}, feature: { type: 'Feature', geometry: piece, properties: { name: 'P' + id } } as GeoJSON.Feature });

describe('copyRows of substation polygons over the fixture files', () => {
  it('copies the file geometry, counts a polygon the files lack and never copies its tile piece', async () => {
    const res = await copyRows(POLY, [tileRow(101), tileRow(102), tileRow(777)], 'P');
    expect(res).toEqual({ kind: 'copied', n: 2, simplified: 0, missing: 1 });
    const fs = added[0].features;
    expect(fs.map(f => f.geometry.type).sort()).toEqual(['MultiPolygon', 'Polygon']);
    for (const f of fs) {
      expect(f.geometry).not.toEqual(piece);
      expect(f.properties).not.toHaveProperty('geometry_source');
      expect(f.properties?.attribution).toBe('© OpenStreetMap contributors');
    }
    expect(fs.map(f => f.properties?.osm).sort()).toEqual(['https://www.openstreetmap.org/node/10', 'https://www.openstreetmap.org/way/10']);
  });
  it('a polygon missing from the files alone is refused as not-found, never copied from the tile', async () => {
    expect(await copyRows(POLY, [tileRow(777)], 'P')).toEqual({ kind: 'refused', reason: 'not-found' });
    expect(added).toHaveLength(0);
  });
  it('a columns-file polygon row (no tile geometry) the files lack is counted', async () => {
    const pointOnly = { ...tileRow(888), pointOnly: true as const };
    expect(await copyRows(POLY, [tileRow(103), pointOnly], 'P')).toEqual({ kind: 'copied', n: 1, simplified: 0, missing: 1 });
  });
  it('copyAvailable follows the files: yes with index.json, false without it', async () => {
    expect(await copyAvailable(POLY)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    resetLineRead();
    expect(await copyAvailable(POLY)).toBe(false);
  });
  it('without index.json no polygon is copied from tiles (unavailable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    resetLineRead();
    expect(await copyRows(POLY, [tileRow(101)], 'P')).toEqual({ kind: 'refused', reason: 'unavailable' });
  });
});
