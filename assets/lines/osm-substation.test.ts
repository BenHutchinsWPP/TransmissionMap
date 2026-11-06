// osm-substation.ts: the tiles around a chain end, and a name read by fid out of a real
// MVT tile (encoded here with pbf) served by a mocked PMTiles archive.
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

const tiles = new Map<string, Uint8Array>();
const asked: string[] = [];
vi.mock('pmtiles', () => ({
  PMTiles: class {
    async getHeader() { return { maxZoom: 13 }; }
    async getZxy(z: number, x: number, y: number) {
      asked.push(`${z}/${x}/${y}`);
      const t = tiles.get(`${z}/${x}/${y}`);
      return t ? { data: t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength) } : undefined;
    }
  },
}));

const { tilesAround, nameIn, osmSubstationName } = await import('./osm-substation.js');
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
