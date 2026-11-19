// osm-substation.ts: the tiles around a chain end, a name read by fid out of a real
// MVT tile (encoded here with pbf) served by a mocked PMTiles archive, and the
// substation points around a place (zoom choice, decode, tile cache, a failed read).
import { describe, expect, it, vi } from 'vitest';
import { PbfWriter } from 'pbf';

/** One MVT layer "substations" with point features {id, name}. */
function mvt(features: { id: number; name: string }[]): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_: unknown, p: PbfWriter) => {
    p.writeVarintField(15, 2);
    p.writeStringField(1, 'substations');
    features.forEach((f, i) => p.writeMessage(2, (_: unknown, q: PbfWriter) => {
      q.writeVarintField(1, f.id);
      q.writePackedVarint(2, [0, i]);
      q.writeVarintField(3, 1);
      q.writePackedVarint(4, [9, 50, 50]);
    }, null));
    p.writeStringField(3, 'name');
    for (const f of features) p.writeMessage(4, (_: unknown, q: PbfWriter) => q.writeStringField(1, f.name), null);
    p.writeVarintField(5, 4096);
  }, null);
  return pbf.finish();
}

/** One MVT layer "substations" with point features at tile coordinates (px, py) and string tags. */
function mvtProps(features: { id: number; px: number; py: number; props: Record<string, string> }[]): Uint8Array {
  const keys: string[] = [], vals: string[] = [];
  const idx = (list: string[], v: string) => { let i = list.indexOf(v); if (i < 0) { i = list.length; list.push(v); } return i; };
  const tagged = features.map((f) => Object.entries(f.props).flatMap(([k, v]) => [idx(keys, k), idx(vals, v)]));
  const zz = (n: number) => (n << 1) ^ (n >> 31);
  const pbf = new PbfWriter();
  pbf.writeMessage(3, (_: unknown, p: PbfWriter) => {
    p.writeVarintField(15, 2);
    p.writeStringField(1, 'substations');
    features.forEach((f, i) => p.writeMessage(2, (_: unknown, q: PbfWriter) => {
      q.writeVarintField(1, f.id);
      q.writePackedVarint(2, tagged[i]);
      q.writeVarintField(3, 1);
      q.writePackedVarint(4, [9, zz(f.px), zz(f.py)]);
    }, null));
    for (const k of keys) p.writeStringField(3, k);
    for (const v of vals) p.writeMessage(4, (_: unknown, q: PbfWriter) => q.writeStringField(1, v), null);
    p.writeVarintField(5, 4096);
  }, null);
  return pbf.finish();
}

const tiles = new Map<string, Uint8Array>();
const asked: string[] = [];
let headerFails = false;
vi.mock('pmtiles', () => ({
  PMTiles: class {
    async getHeader() { if (headerFails) throw new Error('unreachable'); return { minZoom: 4, maxZoom: 13 }; }
    async getZxy(z: number, x: number, y: number) {
      asked.push(`${z}/${x}/${y}`);
      const t = tiles.get(`${z}/${x}/${y}`);
      return t ? { data: t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength) } : undefined;
    }
  },
}));

const { tilesAround, nameIn, osmSubstationName, substationPointsIn, substationPointsNear, _resetSnapTiles, NEAR_TILES, SNAP_CACHE } =
  await import('./osm-substation.js');
const { tileForLngLat } = await import('../elevation/terrarium.js');

describe('tilesAround', () => {
  it('is one tile in a tile middle and up to four near a corner', () => {
    const t = tileForLngLat(-105, 40, 13);
    expect(tilesAround([-105, 40], 13, 10).length).toBeLessThanOrEqual(2);
    const all = tilesAround([-105, 40], 13, 1500);
    expect(all.length).toBeLessThanOrEqual(4);
    expect(all).toContainEqual([13, t.x, t.y]);
  });
});

describe('osmSubstationName', () => {
  it('reads the name of the fid from the tile at the chain end', async () => {
    const at = [-105.2, 39.7];
    const t = tileForLngLat(at[0], at[1], 13);
    tiles.set(`13/${t.x}/${t.y}`, mvt([{ id: 42, name: 'Other' }, { id: 123456789012, name: 'Valmont' }]));
    expect(await osmSubstationName(123456789012, at)).toBe('Valmont');
    const n = asked.length;
    expect(await osmSubstationName(123456789012, at)).toBe('Valmont');   // cached
    expect(asked.length).toBe(n);
    expect(await osmSubstationName(7, at)).toBeNull();
  });

  it('nameIn skips features without a name', () => {
    const layer = { length: 1, feature: () => ({ id: 5, properties: { name: ' ' } }) };
    expect(nameIn({ layers: { s: layer } }, 5)).toBeNull();
  });
});

describe('substationPointsIn', () => {
  it('reads each point feature with an id; kV through osmKv; other geometry and id-less features skipped', () => {
    const feat = (id: number | undefined, type: number, props: Record<string, unknown>, gtype = 'Point') => ({
      id, type, properties: props,
      toGeoJSON: (x: number, y: number, z: number) => ({ geometry: { type: gtype, coordinates: [x + z, y] } }),
    });
    const fs = [
      feat(11, 1, { name: 'Valmont', nominal_kv: '230', sub_type: 'transmission', countries: '|USA|' }),
      feat(12, 1, { name: '', nominal_kv: '' }),
      feat(undefined, 1, { name: 'No id', nominal_kv: '345' }),
      feat(13, 3, { name: 'Polygon', nominal_kv: '345' }),
      feat(14, 1, { name: 'Multi', nominal_kv: '345' }, 'MultiPoint'),
    ];
    const tile = { layers: { s: { length: fs.length, feature: (i: number) => fs[i] } } };
    expect(substationPointsIn(tile, 2, 3, 10)).toEqual([
      { fid: 11, lngLat: [12, 3], name: 'Valmont', kv: 230, subType: 'transmission', countries: '|USA|' },
      { fid: 12, lngLat: [12, 3], name: '', kv: null, subType: null, countries: null },
    ]);
  });
});

describe('substationPointsNear', () => {
  const at: [number, number] = [-104.9, 39.75];

  it('reads the highest zoom whose box needs at most NEAR_TILES tiles, decodes, and caches tiles', async () => {
    _resetSnapTiles();
    tiles.clear();
    // 5 km box: z13 needs more than 4 tiles there, so a lower zoom is read.
    expect(tilesAround(at, 13, 5000).length).toBeGreaterThan(NEAR_TILES);
    let z = 13;
    while (tilesAround(at, z, 5000).length > NEAR_TILES) z--;
    const t = tileForLngLat(at[0], at[1], z);
    tiles.set(`${z}/${t.x}/${t.y}`, mvtProps([
      { id: 501, px: 2048, py: 2048, props: { name: 'Big', nominal_kv: '345', sub_type: 'transmission', countries: '|USA|' } },
      { id: 502, px: 100, py: 100, props: { name: 'Small', nominal_kv: '', countries: '|USA|' } },
    ]));
    asked.length = 0;
    const pts = await substationPointsNear(at, 5000);
    expect(asked.length).toBeLessThanOrEqual(NEAR_TILES);
    expect(asked.every((k) => k.startsWith(`${z}/`))).toBe(true);
    expect(pts.map((p) => [p.fid, p.name, p.kv, p.subType, p.countries])).toEqual([
      [501, 'Big', 345, 'transmission', '|USA|'], [502, 'Small', null, null, '|USA|'],
    ]);
    // Tile t's centre; Small sits at pixel (100, 100), the north-west part of the tile.
    const n = 2 ** z;
    const cLng = ((t.x + 0.5) / n) * 360 - 180;
    const cLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (t.y + 0.5)) / n))) * 180) / Math.PI;
    const [big, small] = [pts[0].lngLat, pts[1].lngLat];
    expect(big[0]).toBeCloseTo(cLng, 4);
    expect(big[1]).toBeCloseTo(cLat, 4);
    expect(tileForLngLat(small[0], small[1], z)).toMatchObject({ x: t.x, y: t.y });
    expect(small[0]).toBeLessThan(cLng);
    expect(small[1]).toBeGreaterThan(cLat);
    const held = asked.length;
    await substationPointsNear(at, 5000);
    expect(asked.length).toBe(held);   // decoded tiles held
  });

  it('holds at most SNAP_CACHE tiles, oldest out; a hit moves a tile to the newest', async () => {
    _resetSnapTiles();
    // Tile centres at z13 along one row: a 1 m box reads exactly that tile.
    const n = 2 ** 13, y = 3000;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
    const centre = (x: number): [number, number] => [((x + 0.5) / n) * 360 - 180, lat];
    const read = async (x: number) => { asked.length = 0; await substationPointsNear(centre(x), 1); return [...asked]; };
    for (let x = 0; x < SNAP_CACHE; x++) expect(await read(x)).toEqual([`13/${x}/${y}`]);
    expect(await read(0)).toEqual([]);                       // held; now the newest
    expect(await read(SNAP_CACHE)).toEqual([`13/${SNAP_CACHE}/${y}`]);   // evicts tile 1, the oldest
    expect(await read(0)).toEqual([]);
    expect(await read(1)).toEqual([`13/1/${y}`]);
  });

  it('a small box stays at the max zoom', async () => {
    _resetSnapTiles();
    asked.length = 0;
    await substationPointsNear(at, 1000);
    expect(asked.every((k) => k.startsWith('13/'))).toBe(true);
    expect(asked.length).toBeLessThanOrEqual(NEAR_TILES);
  });

  it('rejects when the archive cannot be read', async () => {
    _resetSnapTiles();
    headerFails = true;
    try { await expect(substationPointsNear(at, 3000)).rejects.toThrow(); }
    finally { headerFails = false; }
  });
});
