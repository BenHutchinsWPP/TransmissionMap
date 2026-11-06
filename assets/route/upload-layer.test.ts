// upload-layer.ts against an independent reference: fixtures/upload-ref.json, burned by
// rasterio (GDAL, all_touched=False, one shape per part) from pyproj-projected coordinates by
// fixtures/make-upload-ref.py. Regenerate with `venv/bin/python -I assets/route/fixtures/make-upload-ref.py`.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gridFromJson, GRID_250, lngLatOf, type Grid } from './grid.js';
import {
  insideCell, layerFromProjected, rasterize, uploadLayer, validateUpload,
  UPLOAD_MAX_BYTES, type UploadLayer,
} from './upload-layer.js';
import type { CellWindow } from './surface-image.js';

interface RefGrid { crs: string; origin: [number, number]; cell: number; cols: number; rows: number }
interface Fixture { name: string; crs: 'lnglat' | '5070'; grid?: RefGrid; polygons: number[][][][]; box: CellWindow; rows: string[] }
const REF = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/upload-ref.json', import.meta.url)), 'utf8')) as { grid: RefGrid; fixtures: Fixture[] };
const gridOf = (g: RefGrid): Grid => gridFromJson({ ...g, super: 4096, block: 512 });

async function layerOf(f: Fixture): Promise<UploadLayer> {
  if (f.crs === '5070') return layerFromProjected(f.polygons, gridOf(f.grid!));
  const r = await uploadLayer(f.polygons, gridOf(REF.grid));
  if (!r.ok) throw new Error(r.reason);
  return r.result;
}
const asRows = (a: Uint8Array, box: CellWindow) =>
  Array.from({ length: box.rows }, (_, r) => Array.from(a.subarray(r * box.cols, (r + 1) * box.cols)).join(''));

describe('rasterize matches rasterio', () => {
  it('the reference grid is GRID_250', () => {
    expect(gridOf(REF.grid)).toEqual(GRID_250);
    expect(REF.fixtures.length).toBeGreaterThan(50);
  });
  for (const f of REF.fixtures) {
    it(f.name, async () => {
      const layer = await layerOf(f);
      const got = rasterize(layer, f.box);
      expect(asRows(got, f.box)).toEqual(f.rows);
      // insideCell agrees on every cell of the box and a ring around it.
      for (let r = -2; r < f.box.rows + 2; r++) for (let c = -2; c < f.box.cols + 2; c++) {
        const inBox = r >= 0 && c >= 0 && r < f.box.rows && c < f.box.cols;
        const want = inBox ? got[r * f.box.cols + c] === 1 : rasterize(layer, { col0: f.box.col0 + c, row0: f.box.row0 + r, cols: 1, rows: 1 })[0] === 1;
        if (insideCell(layer, f.box.col0 + c, f.box.row0 + r) !== want) throw new Error(`${f.name}: insideCell(${c}, ${r}) != rasterize`);
      }
    });
  }
  it('a box past every part is empty and insideCell is false far away', async () => {
    const layer = await layerOf(REF.fixtures.find(f => f.name === 'square')!);
    expect(rasterize(layer, { col0: 0, row0: 0, cols: 8, rows: 8 }).some(v => v)).toBe(false);
    expect(insideCell(layer, 0, 0)).toBe(false);
  });
});

describe('uploadLayer / validateUpload', () => {
  const [lng, lat] = lngLatOf(GRID_250, 9000, 6000);
  const sq = (d = 0.05, dx = 0) => [[lng - d + dx, lat - d], [lng + d + dx, lat - d], [lng + d + dx, lat + d], [lng - d + dx, lat + d], [lng - d + dx, lat - d]];
  const fc = (geoms: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features: geoms.map(g => ({ type: 'Feature', properties: { name: 'x' }, geometry: g })) });
  const refused = async (p: Promise<{ ok: boolean; reason?: string }>, re: RegExp) => {
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(re);
  };

  it('takes a Polygon, a Feature and a FeatureCollection; one hash for one geometry', async () => {
    const poly = { type: 'Polygon', coordinates: [sq()] };
    const a = await validateUpload(JSON.stringify(poly));
    const b = await validateUpload(new TextEncoder().encode(`\uFEFF${JSON.stringify({ type: 'Feature', properties: {}, geometry: poly })}`));
    const c = await validateUpload(fc([{ type: 'MultiPolygon', coordinates: [[sq()]] }]));
    for (const r of [a, b, c]) expect(r.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.result.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(b.result.hash).toBe(a.result.hash);
    expect(c.result.hash).toBe(a.result.hash);
    expect(a.result.geometry).toEqual([[sq()]]);
    const again = await uploadLayer(a.result.geometry);
    expect(again.ok && again.result.hash).toBe(a.result.hash);
    const other = await uploadLayer([[sq(0.04)]]);
    expect(other.ok && other.result.hash).not.toBe(a.result.hash);
    expect(insideCell(a.result, 9000, 6000)).toBe(true);
  });

  it('drops a third coordinate and keeps [lng, lat] order', async () => {
    const r = await uploadLayer([[sq().map(p => [...p, 1234])]]);
    expect(r.ok && r.result.geometry).toEqual([[sq()]]);
    // Swapped axes put the shape at lat -105: outside the grid.
    await refused(uploadLayer([[sq().map(([x, y]) => [y, x])]]), /lng|outside/);
  });

  it('refuses what the preset-patch validator refuses', async () => {
    const parts = Array.from({ length: 5001 }, (_, i) => [sq(0.001, i * 0.003)]);
    await refused(validateUpload(JSON.stringify({ type: 'MultiPolygon', coordinates: parts })), /5000 polygon parts/);
    await refused(validateUpload(fc(parts.map(p => ({ type: 'Polygon', coordinates: p })))), /5000 polygon parts/);
    await refused(uploadLayer(parts), /5000 polygon parts/);
    await refused(validateUpload(JSON.stringify({ type: 'Point', coordinates: [lng, lat] })), /only Polygon and MultiPolygon.*Point/);
    await refused(validateUpload(fc([{ type: 'Polygon', coordinates: [sq()] }, { type: 'LineString', coordinates: [[lng, lat], [lng + 1, lat]] }])), /LineString/);
    await refused(validateUpload(fc([{ type: 'GeometryCollection', geometries: [] }])), /GeometryCollection/);
    await refused(validateUpload(fc([null])), /no geometry/);
    await refused(validateUpload(fc([])), /no polygons/);
    await refused(uploadLayer([[sq().slice(0, 4)]]), /not closed/);
    await refused(uploadLayer([[[[lng, lat], [lng + 0.1, lat], [lng, lat]]]]), /fewer than 4/);
    const nan = sq(); nan[2] = [NaN, lat];
    await refused(uploadLayer([[nan]]), /finite/);
    await refused(validateUpload('{"type":"Polygon","coordinates":[[[1e400,40],[-100,41],[-101,41],[1e400,40]]]}'), /finite/);
    const str = sq(); str[1] = [String(lng), lat] as unknown as number[];
    await refused(uploadLayer([[str]]), /finite/);
    await refused(uploadLayer([[sq().map(([x, y]) => [x + 300, y])]]), /outside lng/);
    await refused(uploadLayer([[sq(0.05, 60)]]), /outside the routing grid/);
    await refused(uploadLayer([[]]), /no rings/);
    await refused(uploadLayer([]), /no polygons/);
    await refused(uploadLayer({ type: 'Polygon' }), /no polygons/);
    const many = Array.from({ length: 250_004 }, (_, i) => [lng + Math.cos(i) * 0.01, lat + Math.sin(i) * 0.01]);
    many.push(many[0]);
    await refused(uploadLayer([[many]]), /250000 positions/);
    await refused(validateUpload('not json'), /did not parse/);
    await refused(validateUpload(new Uint8Array([0x7b, 0xff, 0x7d])), /UTF-8/);
    await refused(validateUpload(JSON.stringify([1, 2])), /not a GeoJSON object/);
  });

  it('refuses a file of 10 MiB + 1 byte and takes one of exactly 10 MiB', async () => {
    const body = JSON.stringify({ type: 'Polygon', coordinates: [sq()] });
    const pad = (n: number) => body + ' '.repeat(n - body.length);
    await refused(validateUpload(pad(UPLOAD_MAX_BYTES + 1)), /over 10 MiB/);
    await refused(validateUpload(new TextEncoder().encode(pad(UPLOAD_MAX_BYTES + 1))), /over 10 MiB/);
    // Multi-byte characters count as their UTF-8 bytes.
    await refused(validateUpload(body + ' '.repeat(UPLOAD_MAX_BYTES - body.length - 1) + 'é'), /over 10 MiB/);
    expect((await validateUpload(pad(UPLOAD_MAX_BYTES))).ok).toBe(true);
  });

  it('a 5,000-part, 250,000-position layer is indexed and answers quickly', async () => {
    const parts = Array.from({ length: 5000 }, (_, i) => {
      const cx = lng + (i % 100) * 0.02, cy = lat + Math.floor(i / 100) * 0.02;
      const ring = Array.from({ length: 49 }, (_, k) => [cx + 0.008 * Math.cos(k / 49 * 2 * Math.PI), cy + 0.008 * Math.sin(k / 49 * 2 * Math.PI)]);
      ring.push(ring[0]);
      return [ring];
    });
    const t0 = performance.now();
    const r = await uploadLayer(parts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const box = { col0: 8990, row0: 5400, cols: 800, rows: 700 };
    const a = rasterize(r.result, box);
    let n = 0;
    for (let i = 0; i < 20_000; i++) {
      const c = box.col0 + ((i * 7919) % box.cols), rr = box.row0 + ((i * 104729) % box.rows);
      if (insideCell(r.result, c, rr) !== (a[(rr - box.row0) * box.cols + c - box.col0] === 1)) n++;
    }
    expect(n).toBe(0);
    expect(a.some(v => v)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});
