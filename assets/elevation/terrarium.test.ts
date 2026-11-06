import { describe, expect, it } from 'vitest';
import { decodeTerrarium, sampleElevation, tileForLngLat } from './terrarium.js';

const tile = (r: number, g: number, b: number) => {
  const data = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { width: 256, height: 256, data } as unknown as ImageData;
};

describe('decodeTerrarium', () => {
  it('decodes vectors', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(0, 0, 0)).toBe(-32768);
    expect(decodeTerrarium(128, 1, 128)).toBe(1.5);
    expect(decodeTerrarium(127, 255, 0)).toBe(-1);
  });
});

describe('tileForLngLat', () => {
  it('origin at z1 is the corner of tile 1/1', () => {
    expect(tileForLngLat(0, 0, 1)).toEqual({ x: 1, y: 1, px: 0, py: 0 });
  });
  it('western US point (Denver) at z12', () => {
    // n = 2^12 = 4096. fx = (-104.99 + 180) / 360 * 4096 = 853.44711 → x 853, px = floor(0.44711 * 256) = floor(114.46) = 114.
    // fy = (1 - asinh(tan(39.74°)) / π) / 2 * 4096 = 1554.51459 (asinh form, independent of the code's ln form)
    //   → y 1554, py = floor(0.51459 * 256) = floor(131.74) = 131.
    const t = tileForLngLat(-104.99, 39.74, 12);
    expect(t).toEqual({ x: 853, y: 1554, px: 114, py: 131 });
  });
  it('antimeridian and pole clamp into range', () => {
    expect(tileForLngLat(180, 0, 2).x).toBe(3);
    expect(tileForLngLat(0, 89.9, 2).y).toBe(0);
  });
});

describe('sampleElevation', () => {
  it('dedupes tile fetches and preserves order', async () => {
    const urls: string[] = [];
    const fetchTile = async (url: string) => { urls.push(url); return tile(128, url.includes('/12/') ? 10 : 0, 0); };
    const pts: [number, number][] = [[-105, 39.7], [-105.0001, 39.7001], [10, 10]];
    const out = await sampleElevation(pts, { fetchTile });
    expect(urls.length).toBe(2);
    expect(out).toEqual([10, 10, 10]);
  });
  it('failures give null, not 0', async () => {
    const out = await sampleElevation([[0, 0], [100, 40]], {
      fetchTile: async (url) => (url.includes('/12/2048/') ? tile(128, 5, 0) : null),
    });
    expect(out[0]).toBe(5);
    expect(out[1]).toBeNull();
    const thrown = await sampleElevation([[0, 0]], { fetchTile: async () => { throw new Error('x'); } });
    expect(thrown).toEqual([null]);
  });
  it('rejects with AbortError when aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(sampleElevation([[0, 0]], { signal: c.signal, fetchTile: async () => tile(0, 0, 0) }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
