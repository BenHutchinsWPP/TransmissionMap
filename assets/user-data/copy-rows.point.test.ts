// copy-rows.ts 'point' mode over a mocked max-zoom archive (real MVT tiles): a columns-file row copies
// its own point, a tile row below the max zoom takes the z13 tile's point of the same id, a tile row at
// the max zoom copies as is, and what cannot be read keeps the tile point marked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PbfWriter } from 'pbf';

const added: { features: GeoJSON.Feature[]; layerName?: string }[] = [];
vi.mock('./user-data.js', () => ({
  addCopiedFeatures: (features: GeoJSON.Feature[], layerName?: string) => { added.push({ features, layerName }); return { saved: true }; },
  storedUserDataChars: () => 0,
}));
vi.mock('./user-data-export.js', () => ({ downloadFile: vi.fn() }));

const zz = (v: number) => (v << 1) ^ (v >> 31);
const EXTENT = 4096;
/** One MVT layer "substations" of point features {id, px, py} (tile coordinates). */
function mvt(features: { id: number; px: number; py: number }[]): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_: unknown, p: PbfWriter) => {
    p.writeVarintField(15, 2);
    p.writeStringField(1, 'substations');
    for (const f of features) p.writeMessage(2, (_: unknown, q: PbfWriter) => {
      q.writeVarintField(1, f.id);
      q.writeVarintField(3, 1);
      q.writePackedVarint(4, [9, zz(f.px), zz(f.py)]);
    }, null);
    p.writeVarintField(5, EXTENT);
  }, null);
  return pbf.finish();
}

const tiles = new Map<string, Uint8Array>();
const asked: string[] = [];
let archiveDown = false;
vi.mock('pmtiles', () => ({
  PMTiles: class {
    async getHeader() { return { maxZoom: 13 }; }
    async getZxy(z: number, x: number, y: number) {
      asked.push(`${z}/${x}/${y}`);
      if (archiveDown) throw new Error('offline');
      const t = tiles.get(`${z}/${x}/${y}`);
      return t ? { data: t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength) } : undefined;
    }
  },
}));

const { copyRows, copyMode, resetCopyManifest } = await import('./copy-rows.js');
const { tileForLngLat } = await import('../elevation/terrarium.js');

const LAYER = 'osm-substations-points';
const lngLatOf = (x: number, y: number, px: number, py: number) => {
  const n = 2 ** 13;
  const lng = ((x + px / EXTENT) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / EXTENT)) / n))) * 180) / Math.PI;
  return [lng, lat];
};
/** A tile row: the z6-rounded point (a tile's middle) of the substation whose true place is (px, py) in z13 tile x/y. */
const rowIn = (id: number, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id, props: {},
  feature: { type: 'Feature', geometry: { type: 'Point', coordinates: lngLatOf(x, y, 2048, 2048) }, properties: { name: 'S' + id } } as GeoJSON.Feature,
  ...extra,
});

const t0 = tileForLngLat(-105.2, 39.7, 13);
beforeEach(() => {
  added.length = 0; asked.length = 0; tiles.clear(); archiveDown = false;
  resetCopyManifest();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
});

describe('copyRows (point)', () => {
  it('is the point mode of the substation points layer', () => { expect(copyMode(LAYER)).toBe('point'); });

  it('a z6 copy reads the z13 tiles around the tile point and returns the z13 coordinate', async () => {
    tiles.set(`13/${t0.x}/${t0.y}`, mvt([{ id: 5, px: 100, py: 4000 }, { id: 123456789013, px: 1000, py: 3000 }]));
    const res = await copyRows(LAYER, [rowIn(123456789013, t0.x, t0.y)], 'P', 6);
    expect(res).toEqual({ kind: 'copied', n: 1, simplified: 0 });
    const g = added[0].features[0].geometry as GeoJSON.Point;
    const [lng, lat] = lngLatOf(t0.x, t0.y, 1000, 3000);
    expect(g.coordinates[0]).toBeCloseTo(lng, 9);
    expect(g.coordinates[1]).toBeCloseTo(lat, 9);
    expect(added[0].features[0].properties).not.toHaveProperty('geometry_source');
    expect(added[0].features[0].properties?.osm).toBe('https://www.openstreetmap.org/relation/12345678901');
    expect(asked.every(a => a.startsWith('13/'))).toBe(true);
  });

  it('a tile point is never trusted as max-zoom from the map zoom: at zoom 13.4 the z13 tile is still read', async () => {
    tiles.set(`13/${t0.x}/${t0.y}`, mvt([{ id: 7, px: 1000, py: 3000 }]));
    const res = await copyRows(LAYER, [rowIn(7, t0.x, t0.y)], 'P', 13.4);
    expect(res).toMatchObject({ kind: 'copied', n: 1, simplified: 0 });
    const [lng, lat] = lngLatOf(t0.x, t0.y, 1000, 3000);
    expect(added[0].features[0].geometry).toEqual({ type: 'Point', coordinates: [expect.closeTo(lng, 9), expect.closeTo(lat, 9)] });
    expect(asked.length).toBeGreaterThan(0);
  });

  it('pads the search by one grid unit of the drawn zoom: a point drawn just across a tile edge is found in the next tile', async () => {
    // Drawn 1.6 grid units (~1.5 m) before tile A's east edge; the true point is in tile B. Pad at z12 (2.4 m) reaches
    // B, no pad or the z13 pad (1.2 m) does not.
    const r = rowIn(9, t0.x, t0.y);
    (r.feature.geometry as GeoJSON.Point).coordinates = lngLatOf(t0.x, t0.y, 4094.4, 2048);
    tiles.set(`13/${t0.x + 1}/${t0.y}`, mvt([{ id: 9, px: 300, py: 2048 }]));
    expect(await copyRows(LAYER, [r], 'P', 12.5)).toMatchObject({ kind: 'copied', n: 1, simplified: 0 });
    const [lng] = lngLatOf(t0.x + 1, t0.y, 300, 2048);
    expect((added[0].features[0].geometry as GeoJSON.Point).coordinates[0]).toBeCloseTo(lng, 9);
  });

  it('reads nothing when every row is a columns-file row', async () => {
    const r = rowIn(8, t0.x, t0.y, { pointOnly: true as const });
    await copyRows(LAYER, [r], 'P', 6);
    expect(asked).toEqual([]);
  });

  it('a columns-file row copies its own point exactly and reads nothing', async () => {
    const r = rowIn(8, t0.x, t0.y, { pointOnly: true as const });
    (r.feature.geometry as GeoJSON.Point).coordinates = [-105.123457, 39.700001];
    expect(await copyRows(LAYER, [r], 'P', 4)).toMatchObject({ kind: 'copied', n: 1, simplified: 0 });
    expect(added[0].features[0].geometry).toEqual({ type: 'Point', coordinates: [-105.123457, 39.700001] });
    expect(added[0].features[0].properties).not.toHaveProperty('geometry_source');
    expect(asked).toEqual([]);
  });

  it('a fid the z13 tiles lack keeps its tile point, marked', async () => {
    tiles.set(`13/${t0.x}/${t0.y}`, mvt([{ id: 1, px: 1, py: 1 }]));
    const r = rowIn(2, t0.x, t0.y);
    expect(await copyRows(LAYER, [r], 'P', 6)).toMatchObject({ kind: 'copied', n: 1, simplified: 1 });
    expect(added[0].features[0].geometry).toEqual(r.feature.geometry);
    expect(added[0].features[0].properties?.geometry_source).toBe('simplified from map tiles');
  });

  it('an archive that cannot be read keeps every tile point, marked', async () => {
    archiveDown = true;
    expect(await copyRows(LAYER, [rowIn(2, t0.x, t0.y)], 'P', 6)).toMatchObject({ kind: 'copied', n: 1, simplified: 1 });
  });

  it('reads at most 20 distinct tiles per copy; the rest keep their tile point, marked', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => rowIn(100 + i, t0.x + i, t0.y));
    rows.forEach((r, i) => tiles.set(`13/${t0.x + i}/${t0.y}`, mvt([{ id: 100 + i, px: 500, py: 500 }])));
    const res = await copyRows(LAYER, rows, 'P', 6);
    expect(res).toMatchObject({ kind: 'copied', n: 25, simplified: 5 });
    expect(new Set(asked).size).toBeLessThanOrEqual(20);
    expect(added[0].features.filter(f => f.properties?.geometry_source).length).toBe(5);
  });

  it('an unknown zoom keeps the tile point, marked', async () => {
    expect(await copyRows(LAYER, [rowIn(2, t0.x, t0.y)], 'P')).toMatchObject({ simplified: 1 });
    expect(asked).toEqual([]);
  });
});
