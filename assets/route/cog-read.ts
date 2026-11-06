// Role: minimal reader for this project's Cloud-Optimised GeoTIFFs (route-optimizer band files):
//   classic little-endian TIFF, tiled, pixel-interleaved, uint8 bands, DEFLATE (zlib) or none, no predictor.
// Reads the first IFD only; every other layout throws. No dependencies; runs in workers and Node
// (the Fetcher is the only I/O seam: a Range request in the browser, an fs read in tests).
// readWindow returns one array per band, or decodes straight into the caller's band arrays
// (`into`, a null band is skipped); `createLimiter` caps tiles in flight across many windows
// (route.ts readBands shares one per read).
// Layout is pinned by fixtures/make-tiny.py (GDAL COG driver options); swap in `geotiff` if a
// third-party COG ever has to be read.

/** Bytes [start, end) of the file; end is exclusive. */
export type Fetcher = (start: number, end: number) => Promise<Uint8Array>;

export interface TiffInfo {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  bands: number;
  tileOffsets: number[];
  tileByteCounts: number[];
  /** 1 = none, 8 = zlib DEFLATE */
  compression: number;
  /** GeoTIFF ModelPixelScale (33550): [sx, sy, sz] */
  pixelScale?: number[];
  /** GeoTIFF ModelTiepoint (33922): [i, j, k, x, y, z] */
  tiepoint?: number[];
}

const HEAD = 65536;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8 };

export async function openTiff(fetch: Fetcher): Promise<TiffInfo> {
  const head = await fetch(0, HEAD);
  if (head.length < 8) throw new Error("TIFF: file too short");
  const bytes = async (start: number, end: number): Promise<DataView> => {
    if (end <= head.length) return new DataView(head.buffer, head.byteOffset + start, end - start);
    const b = await fetch(start, end);
    if (b.length < end - start) throw new Error("TIFF: read past end of file");
    return new DataView(b.buffer, b.byteOffset, b.length);
  };
  const h = new DataView(head.buffer, head.byteOffset, head.length);
  const order = String.fromCharCode(head[0], head[1]);
  if (order === "MM") throw new Error("TIFF: big-endian files are not supported");
  if (order !== "II") throw new Error("TIFF: bad byte-order mark");
  const magic = h.getUint16(2, true);
  if (magic === 43) throw new Error("TIFF: BigTIFF is not supported");
  if (magic !== 42) throw new Error("TIFF: bad magic number");

  const ifd = h.getUint32(4, true);
  const count = (await bytes(ifd, ifd + 2)).getUint16(0, true);
  const dir = await bytes(ifd + 2, ifd + 2 + count * 12);

  const tags = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const o = i * 12;
    const tag = dir.getUint16(o, true);
    const type = dir.getUint16(o + 2, true);
    const n = dir.getUint32(o + 4, true);
    const size = TYPE_SIZE[type];
    if (!size) continue;
    const total = size * n;
    let v: DataView;
    let at: number;
    if (total <= 4) {
      v = dir;
      at = o + 8;
    } else {
      const off = dir.getUint32(o + 8, true);
      v = await bytes(off, off + total);
      at = 0;
    }
    if (type === 2) continue;
    const out: number[] = new Array(n);
    for (let j = 0; j < n; j++) {
      if (type === 1) out[j] = v.getUint8(at + j);
      else if (type === 3) out[j] = v.getUint16(at + 2 * j, true);
      else if (type === 4) out[j] = v.getUint32(at + 4 * j, true);
      else if (type === 12) out[j] = v.getFloat64(at + 8 * j, true);
      else out[j] = v.getUint32(at + 8 * j, true) / v.getUint32(at + 8 * j + 4, true);
    }
    tags.set(tag, out);
  }

  const one = (t: number, d?: number): number => {
    const v = tags.get(t);
    if (v) return v[0];
    if (d === undefined) throw new Error(`TIFF: missing tag ${t}`);
    return d;
  };
  const width = one(256);
  const height = one(257);
  if (!tags.has(322) || !tags.has(323)) throw new Error("TIFF: strips are not supported (no TileWidth)");
  const bands = one(277, 1);
  const bits = tags.get(258) ?? [1];
  if (bits.length < 1 || bits.some((b) => b !== 8)) throw new Error("TIFF: only BitsPerSample 8 is supported");
  if ((tags.get(339) ?? [1]).some((f) => f !== 1)) throw new Error("TIFF: only unsigned integer samples are supported");
  if (one(284, 1) !== 1) throw new Error("TIFF: only PlanarConfiguration 1 (pixel-interleaved) is supported");
  if (one(317, 1) !== 1) throw new Error("TIFF: Predictor must be 1 (none)");
  const compression = one(259, 1);
  if (compression !== 1 && compression !== 8) throw new Error(`TIFF: unsupported compression ${compression}`);

  return {
    width,
    height,
    tileWidth: one(322),
    tileHeight: one(323),
    bands,
    tileOffsets: tags.get(324) ?? [],
    tileByteCounts: tags.get(325) ?? [],
    compression,
    pixelScale: tags.get(33550),
    tiepoint: tags.get(33922),
  };
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decoded pixel-interleaved bytes of one full tile (edge tiles are full-size on disk). */
export async function readTile(info: TiffInfo, fetch: Fetcher, tx: number, ty: number): Promise<Uint8Array> {
  const across = Math.ceil(info.width / info.tileWidth);
  const down = Math.ceil(info.height / info.tileHeight);
  if (tx < 0 || ty < 0 || tx >= across || ty >= down) throw new Error(`TIFF: tile (${tx},${ty}) out of range`);
  const idx = ty * across + tx;
  const want = info.tileWidth * info.tileHeight * info.bands;
  const off = info.tileOffsets[idx];
  const len = info.tileByteCounts[idx];
  if (off === undefined || len === undefined) throw new Error(`TIFF: no offset for tile (${tx},${ty})`);
  if (len === 0) return new Uint8Array(want);
  const raw = await fetch(off, off + len);
  if (raw.length < len) throw new Error(`TIFF: short read for tile (${tx},${ty})`);
  const out = info.compression === 8 ? await inflate(raw) : raw;
  if (out.length !== want) throw new Error(`TIFF: tile (${tx},${ty}) decoded to ${out.length} bytes, expected ${want}`);
  return out;
}

/** Runs `job` once a slot is free; at most `n` jobs run at a time (FIFO). */
export type Limiter = <T>(job: () => Promise<T>) => Promise<T>;

export function createLimiter(n: number): Limiter {
  let running = 0;
  const queue: (() => void)[] = [];
  return async (job) => {
    if (running >= n) await new Promise<void>((go) => queue.push(go));
    else running++;
    try {
      return await job();
    } finally {
      const next = queue.shift();
      if (next) next();
      else running--;
    }
  };
}

/**
 * Where readWindow writes: one array per band (`null` = band skipped, never decoded into),
 * each a raster `width` cells wide; image pixel (col0, row0) lands at (`col`, `row`).
 * Pixels outside the image are not written.
 */
export interface WindowDest {
  bands: (Uint8Array | null)[];
  width: number;
  col: number;
  row: number;
}

export interface WindowOptions {
  /** Decode straight into these arrays instead of allocating a window per band. */
  into?: WindowDest;
  /** Tile jobs (fetch + decode + copy) run through this; shared across windows to cap tiles in flight. */
  limit?: Limiter;
}

/**
 * One Uint8Array per band for the pixel window, clipped to the image; the output is
 * (clipped width) x (clipped height) row-major. Tiles are fetched in parallel (through
 * `opts.limit` when given). With `opts.into`, tiles are written into the caller's arrays
 * and nothing is returned.
 */
export async function readWindow(info: TiffInfo, fetch: Fetcher, col0: number, row0: number, w: number, h: number): Promise<Uint8Array[]>;
export async function readWindow(
  info: TiffInfo, fetch: Fetcher, col0: number, row0: number, w: number, h: number,
  opts: WindowOptions & { into: WindowDest },
): Promise<void>;
export async function readWindow(
  info: TiffInfo, fetch: Fetcher, col0: number, row0: number, w: number, h: number, opts?: WindowOptions,
): Promise<Uint8Array[] | void>;
export async function readWindow(
  info: TiffInfo,
  fetch: Fetcher,
  col0: number,
  row0: number,
  w: number,
  h: number,
  opts: WindowOptions = {},
): Promise<Uint8Array[] | void> {
  const c0 = Math.max(0, col0);
  const r0 = Math.max(0, row0);
  const c1 = Math.min(info.width, col0 + w);
  const r1 = Math.min(info.height, row0 + h);
  const cw = Math.max(0, c1 - c0);
  const ch = Math.max(0, r1 - r0);
  let out: Uint8Array[] | undefined;
  let dest = opts.into;
  if (!dest) {
    out = Array.from({ length: info.bands }, () => new Uint8Array(cw * ch));
    dest = { bands: out, width: cw, col: col0 - c0, row: row0 - r0 };
  } else if (dest.bands.length !== info.bands) {
    throw new Error(`TIFF: destination has ${dest.bands.length} bands, file has ${info.bands}`);
  }
  if (!cw || !ch) return out;
  const { tileWidth: tw, tileHeight: th, bands } = info;
  const { width: dw, col: dc, row: dr } = dest;
  const wanted = dest.bands.flatMap((arr, b) => (arr ? [[b, arr] as const] : []));
  if (!wanted.length) return out;
  const limit: Limiter = opts.limit ?? ((job) => job());
  const jobs: Promise<void>[] = [];
  for (let ty = Math.floor(r0 / th); ty <= Math.floor((r1 - 1) / th); ty++) {
    for (let tx = Math.floor(c0 / tw); tx <= Math.floor((c1 - 1) / tw); tx++) {
      jobs.push(
        limit(async () => {
          const tile = await readTile(info, fetch, tx, ty);
          const xa = Math.max(c0, tx * tw);
          const xb = Math.min(c1, (tx + 1) * tw);
          const ya = Math.max(r0, ty * th);
          const yb = Math.min(r1, (ty + 1) * th);
          for (let y = ya; y < yb; y++) {
            const srcRow = ((y - ty * th) * tw - tx * tw) * bands;
            const dstRow = (y - row0 + dr) * dw - col0 + dc;
            for (const [b, arr] of wanted) {
              for (let x = xa; x < xb; x++) arr[dstRow + x] = tile[srcRow + x * bands + b];
            }
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  return out;
}
