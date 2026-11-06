// ─── Terrarium elevation sampler ──────────────────────────────────────────────
// Role: elevation at points from the Terrarium tiles the 3D terrain already uses (AWS Open Data
//   Terrain Tiles, worldwide); one fetch per tile, a pixel per point. Used by the route profile
//   (route-tabs/profile.ts) and, where USGS 3DEP has no value, the line profile
//   (lines/profile.ts). Main thread (createImageBitmap + canvas).
// Deps: constants.js (TERRAIN_TILE_URL). Failed tiles give null samples, never 0.
import { TERRAIN_TILE_URL } from '../constants.js';

export const TERRAIN_CREDIT = 'Terrain Tiles (Mapzen/AWS, CC BY 4.0)';

const MAX_IN_FLIGHT = 6;

/** Terrarium RGB to metres. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Slippy tile and integer pixel (0..255) holding a point. */
export function tileForLngLat(lng: number, lat: number, z: number): { x: number; y: number; px: number; py: number } {
  const n = 2 ** z;
  const latR = (lat * Math.PI) / 180;
  const fx = ((lng + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  const x = clamp(Math.floor(fx), n - 1);
  const y = clamp(Math.floor(fy), n - 1);
  return {
    x, y,
    px: clamp(Math.floor((fx - x) * 256), 255),
    py: clamp(Math.floor((fy - y) * 256), 255),
  };
}

export type FetchTile = (url: string, signal?: AbortSignal) => Promise<ImageData | null>;

const abortError = () => new DOMException('Aborted', 'AbortError');

async function defaultFetchTile(url: string, signal?: AbortSignal): Promise<ImageData | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bmp.width, bmp.height)
      : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height);
  } catch {
    if (signal?.aborted) throw abortError();
    return null;
  }
}

/** Elevation in metres at each [lng, lat], in order; null where the tile could not be read. */
export async function sampleElevation(
  points: [number, number][],
  opts: { z?: number; signal?: AbortSignal; fetchTile?: FetchTile } = {},
): Promise<(number | null)[]> {
  const { z = 12, signal, fetchTile = defaultFetchTile } = opts;
  if (signal?.aborted) throw abortError();
  const out: (number | null)[] = new Array(points.length).fill(null);
  const byTile = new Map<string, { x: number; y: number; hits: { i: number; px: number; py: number }[] }>();
  points.forEach(([lng, lat], i) => {
    const { x, y, px, py } = tileForLngLat(lng, lat, z);
    const key = `${x}/${y}`;
    let t = byTile.get(key);
    if (!t) byTile.set(key, (t = { x, y, hits: [] }));
    t.hits.push({ i, px, py });
  });
  const queue = [...byTile.values()];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      if (signal?.aborted) throw abortError();
      const url = TERRAIN_TILE_URL.replace('{z}', String(z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
      let img: ImageData | null = null;
      try {
        img = await fetchTile(url, signal);
      } catch {
        if (signal?.aborted) throw abortError();
      }
      if (signal?.aborted) throw abortError();
      if (!img || img.width !== 256) continue;
      for (const { i, px, py } of t.hits) {
        const o = (py * img.width + px) * 4;
        out[i] = decodeTerrarium(img.data[o], img.data[o + 1], img.data[o + 2]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, queue.length) }, worker));
  return out;
}
