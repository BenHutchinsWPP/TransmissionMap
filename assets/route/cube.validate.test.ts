// Real-cube check (excluded from `npm test`, like every *.validate.test.ts): decodes three blocks of
// data/route/250m/ with cog-read.ts and compares them with the raw values scripts/build_route_cube.py
// dumped to data/build/route/fixtures/. Skips when the cube or the fixtures are absent.
// Run: npx vitest run --config vitest.route.config.ts assets/route/cube.validate.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PD_BANDS, OSM_BANDS } from './route.js';
import { openTiff, readWindow, type Fetcher } from './cog-read.js';

const CUBE = process.env.ROUTE_CUBE ?? 'data/route/250m/';
const FIX = process.env.ROUTE_CUBE_FIXTURES ?? 'data/build/route/fixtures/';
const BLOCK = 512;
const names = ['pd_rockies', 'osm_flags', 'pd_edge'];
const have = existsSync(CUBE + 'grid.json') && names.every((n) => existsSync(`${FIX}${n}.json`));

const fds: number[] = [];
if (!have) console.warn('route cube or fixtures absent: cube.validate suite skipped');
afterAll(() => fds.forEach((fd) => closeSync(fd)));

function fileFetcher(path: string): Fetcher {
  const fd = openSync(path, 'r');
  fds.push(fd);
  return async (start, end) => {
    const buf = Buffer.alloc(end - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  };
}

describe.skipIf(!have)('route cube vs fixtures', () => {
  it('grid.json lists the super-tiles and passes the reader band order', () => {
    const g = JSON.parse(readFileSync(CUBE + 'grid.json', 'utf8'));
    expect(g.crs).toBe('EPSG:5070');
    expect(g.version).toBe(8);
    expect(Object.values(g.pd_bands)).toEqual([...PD_BANDS]);
    expect(Object.values(g.osm_bands)).toEqual(OSM_BANDS.map((n) => n.replace(/^osm_/, '')));
    expect(PD_BANDS.length).toBe(19);
    expect(OSM_BANDS.length).toBe(3);
    expect(g.building_footprints.rounding).toBe('ceil');
    expect(g.building_provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(g.building_provenance.feature_count ?? g.building_provenance.object_id_count).toBeGreaterThan(0);
    expect(g.building_provenance).not.toHaveProperty('object_ids');
    for (const [c, r] of g.super_tiles_present) {
      expect(existsSync(`${CUBE}pd_${c}_${r}.tif`)).toBe(true);
      expect(existsSync(`${CUBE}osm_${c}_${r}.tif`)).toBe(true);
    }
  });

  for (const name of names) {
    it(`${name} decodes to the dumped values`, async () => {
      const fx = JSON.parse(readFileSync(`${FIX}${name}.json`, 'utf8'));
      const f = fileFetcher(CUBE + fx.file);
      const info = await openTiff(f);
      expect([info.tileWidth, info.tileHeight, info.compression, info.bands]).toEqual([BLOCK, BLOCK, 8, fx.bands]);
      const bands = await readWindow(info, f, fx.block[0] * BLOCK, fx.block[1] * BLOCK, BLOCK, BLOCK);
      const n = fx.width * fx.height;
      expect(bands[0].length).toBe(n);
      const raw = new Uint8Array(n * fx.bands); // pixel-interleaved, like the dump
      for (let b = 0; b < fx.bands; b++) for (let i = 0; i < n; i++) raw[i * fx.bands + b] = bands[b][i];
      expect(createHash('sha256').update(raw).digest('hex')).toBe(fx.sha256);
      expect(Buffer.from(raw).equals(Buffer.from(fx.b64, 'base64'))).toBe(true);
      expect(raw.reduce((k, v) => k + (v ? 1 : 0), 0)).toBe(fx.nonzero);
      const perBand = bands.map((b) => b.reduce((k, v) => k + (v ? 1 : 0), 0));
      expect(perBand).toEqual(fx.band_nonzero);
      if (name !== 'osm_flags') expect(perBand.filter((k) => k > 0).length).toBeGreaterThanOrEqual(6);
    });
  }
});
