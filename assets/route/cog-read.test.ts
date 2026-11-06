import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLimiter, openTiff, readTile, readWindow, type Fetcher } from './cog-read.js';

const fsFetcher = (name: string): Fetcher => {
  const buf = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return async (start, end) => new Uint8Array(buf.subarray(start, Math.min(end, buf.length)));
};
const fromBytes = (b: Uint8Array): Fetcher => async (s, e) => b.slice(s, Math.min(e, b.length));
const raw = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// band index b (0-based) holds (x*7 + y*13 + (b+1)*31) % 256; tile (1,1) of tiny.tif is zero
const expected = (b: number, x: number, y: number) =>
  x >= 512 && y >= 512 ? 0 : (x * 7 + y * 13 + (b + 1) * 31) % 256;

describe('openTiff', () => {
  it('reads the layout of tiny.tif', async () => {
    const info = await openTiff(fsFetcher('tiny.tif'));
    expect(info).toMatchObject({ width: 1000, height: 700, tileWidth: 512, tileHeight: 512, bands: 3, compression: 8 });
    expect(info.tileOffsets).toHaveLength(4);
    expect(info.tileByteCounts[3]).toBe(0);
    expect(info.pixelScale?.slice(0, 2)).toEqual([250, 250]);
    expect(info.tiepoint?.slice(3, 5)).toEqual([-2000000, 3000000]);
  });
  it('reads an uncompressed file', async () => {
    const info = await openTiff(fsFetcher('none.tif'));
    expect(info.compression).toBe(1);
    expect(info.width).toBe(64);
    expect((await readTile(info, fsFetcher('none.tif'), 0, 0)).length).toBe(128 * 128 * 3);
  });
  it('fetches beyond the first range when the IFD lives past it', async () => {
    const real = raw('tiny.tif');
    const pad = new Uint8Array(70000);
    // header pointing at an IFD placed after 70 KB of padding, tag arrays offset accordingly
    const shifted = new Uint8Array(pad.length + real.length);
    shifted.set(real.subarray(0, 8));
    shifted.set(real.subarray(8), 8 + pad.length);
    const dv = new DataView(shifted.buffer);
    const ifd = dv.getUint32(4, true);
    dv.setUint32(4, ifd + pad.length, true);
    const n = dv.getUint16(ifd + pad.length, true);
    for (let i = 0; i < n; i++) {
      const o = ifd + pad.length + 2 + i * 12;
      const type = dv.getUint16(o + 2, true);
      const size = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 }[type] ?? 1;
      if (size * dv.getUint32(o + 4, true) > 4) dv.setUint32(o + 8, dv.getUint32(o + 8, true) + pad.length, true);
    }
    const info = await openTiff(fromBytes(shifted));
    expect(info.width).toBe(1000);
    expect(info.tileOffsets).toHaveLength(4);
  });
});

describe('readTile', () => {
  it('returns zeros for a sparse tile', async () => {
    const f = fsFetcher('tiny.tif');
    const t = await readTile(await openTiff(f), f, 1, 1);
    expect(t.length).toBe(512 * 512 * 3);
    expect(t.every((v) => v === 0)).toBe(true);
  });
  it('rejects a tile outside the image', async () => {
    const f = fsFetcher('tiny.tif');
    await expect(readTile(await openTiff(f), f, 2, 0)).rejects.toThrow(/out of range/);
  });
});

describe('readWindow', () => {
  const windows: [number, number, number, number][] = [
    [0, 0, 1, 1],
    [0, 0, 10, 10],
    [500, 500, 24, 24], // spans all four tiles
    [510, 0, 5, 700], // vertical strip across the tile boundary
    [0, 510, 1000, 4], // horizontal strip across the boundary
    [990, 690, 10, 10], // clipped corner, in the sparse tile
    [0, 0, 1000, 700], // everything
  ];
  it.each(windows)('window %i,%i %ix%i equals the formula', async (c, r, w, h) => {
    const f = fsFetcher('tiny.tif');
    const info = await openTiff(f);
    const bands = await readWindow(info, f, c, r, w, h);
    expect(bands).toHaveLength(3);
    for (let b = 0; b < 3; b++) {
      expect(bands[b].length).toBe(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (bands[b][y * w + x] !== expected(b, c + x, r + y)) throw new Error(`band ${b} (${c + x},${r + y})`);
      }
    }
  });
  it('clips a window that hangs off the image', async () => {
    const f = fsFetcher('tiny.tif');
    const info = await openTiff(f);
    const bands = await readWindow(info, f, 995, 695, 20, 20);
    expect(bands[0].length).toBe(5 * 5);
    expect(bands[2][0]).toBe(expected(2, 995, 695));
    expect(bands[1][4 * 5 + 4]).toBe(expected(1, 999, 699));
  });
  it('returns empty bands for a window outside the image', async () => {
    const f = fsFetcher('tiny.tif');
    const bands = await readWindow(await openTiff(f), f, 2000, 0, 5, 5);
    expect(bands.map((b) => b.length)).toEqual([0, 0, 0]);
  });
});

describe('readWindow into caller arrays', () => {
  const windows: [number, number, number, number][] = [
    [0, 0, 10, 10],
    [500, 500, 24, 24],
    [510, 0, 5, 700],
    [990, 690, 10, 10],
    [995, 695, 20, 20], // hangs off the image
    [-3, -2, 8, 6],     // starts before it
    [0, 0, 1000, 700],
  ];
  it.each(windows)('window %i,%i %ix%i copies exactly the old per-band output', async (c, r, w, h) => {
    const f = fsFetcher('tiny.tif');
    const info = await openTiff(f);
    const old = await readWindow(info, f, c, r, w, h);
    const cw = Math.max(0, Math.min(1000, c + w) - Math.max(0, c)), ch = Math.max(0, Math.min(700, r + h) - Math.max(0, r));
    // Destination raster wider and taller than the window, filled with a sentinel.
    const W = w + 7, H = h + 5, dc = 4, dr = 3, SENT = 0xee;
    const dest = [new Uint8Array(W * H).fill(SENT), null, new Uint8Array(W * H).fill(SENT)];
    const ret = await readWindow(info, f, c, r, w, h, { into: { bands: dest, width: W, col: dc, row: dr } });
    expect(ret).toBeUndefined();
    const x0 = dc + Math.max(0, c) - c, y0 = dr + Math.max(0, r) - r;  // where the clipped window lands
    for (const b of [0, 2]) {
      const d = dest[b]!;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const inside = x >= x0 && x < x0 + cw && y >= y0 && y < y0 + ch;
        const want = inside ? old[b][(y - y0) * cw + (x - x0)] : SENT;
        if (d[y * W + x] !== want) throw new Error(`band ${b} dest (${x},${y}) = ${d[y * W + x]}, want ${want}`);
      }
    }
  });
  it('fetches no tile when every band is skipped', async () => {
    let calls = 0;
    const base = fsFetcher('tiny.tif');
    const info = await openTiff(base);
    const f: Fetcher = (s, e) => { calls++; return base(s, e); };
    await readWindow(info, f, 0, 0, 1000, 700, { into: { bands: [null, null, null], width: 1000, col: 0, row: 0 } });
    expect(calls).toBe(0);
  });
  it('refuses a destination with the wrong band count', async () => {
    const f = fsFetcher('tiny.tif');
    const info = await openTiff(f);
    await expect(readWindow(info, f, 0, 0, 4, 4, { into: { bands: [new Uint8Array(16)], width: 4, col: 0, row: 0 } }))
      .rejects.toThrow(/destination has 1 bands, file has 3/);
  });
});

describe('createLimiter', () => {
  it('runs at most n jobs at once, all of them, in order of arrival', async () => {
    const limit = createLimiter(3);
    let live = 0, peak = 0;
    const started: number[] = [];
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => limit(async () => {
      started.push(i);
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 1 + (i % 3)));
      live--;
      return i * 2;
    })));
    expect(peak).toBe(3);
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
    expect(started).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
  it('frees the slot when a job throws', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await limit(async () => 7)).toBe(7);
  });
});

describe('openTiff rejections', () => {
  const patched = (edit: (b: Uint8Array, dv: DataView) => void) => {
    const b = raw('tiny.tif');
    edit(b, new DataView(b.buffer));
    return fromBytes(b);
  };
  const setTag = (dv: DataView, tag: number, value: number) => {
    const ifd = dv.getUint32(4, true);
    const n = dv.getUint16(ifd, true);
    for (let i = 0; i < n; i++) {
      const o = ifd + 2 + i * 12;
      if (dv.getUint16(o, true) === tag) return dv.setUint16(o + 8, value, true);
    }
    throw new Error('tag not in fixture');
  };
  const renameTag = (dv: DataView, from: number, to: number) => {
    const ifd = dv.getUint32(4, true);
    for (let i = 0; i < dv.getUint16(ifd, true); i++) {
      const o = ifd + 2 + i * 12;
      if (dv.getUint16(o, true) === from) return dv.setUint16(o, to, true);
    }
  };

  it('BigTIFF', async () => {
    await expect(openTiff(patched((_b, dv) => dv.setUint16(2, 43, true)))).rejects.toThrow(/BigTIFF/);
  });
  it('big-endian', async () => {
    await expect(openTiff(patched((b) => { b[0] = 0x4d; b[1] = 0x4d; }))).rejects.toThrow(/big-endian/);
  });
  it('strips', async () => {
    await expect(openTiff(patched((_b, dv) => renameTag(dv, 322, 60001)))).rejects.toThrow(/strips/);
  });
  it('predictor 2', async () => {
    await expect(openTiff(fsFetcher('predictor2.tif'))).rejects.toThrow(/Predictor/);
  });
  it('BitsPerSample other than 8', async () => {
    await expect(openTiff(patched((b, dv) => dv.setUint16(414, 16, true)))).rejects.toThrow(/BitsPerSample/);
  });
  it('planar configuration 2', async () => {
    await expect(openTiff(patched((_b, dv) => setTag(dv, 284, 2)))).rejects.toThrow(/PlanarConfiguration/);
  });
  it('unsupported compression', async () => {
    await expect(openTiff(patched((_b, dv) => setTag(dv, 259, 5)))).rejects.toThrow(/compression 5/);
  });
});
