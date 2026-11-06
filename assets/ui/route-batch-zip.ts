// ─── Route batch ZIP ─────────────────────────────────────────────────────────
// Role: the batch export's archive: `createZipSink()` is a `ZipSink` (add, bytes) that also
//       lists its paths and generates the ZIP (jszip, in memory; text deflated, PDFs and JPEGs stored). Every
//       path is sanitised per segment (no `..`, no separators inside a name, no leading dot, no Windows-reserved
//       characters) and kept unique case-insensitively (`-2`, `-3`… before the extension). `rowSlug` names a
//       row's folder (`NNN-<ascii slug ≤ 40>`, the index prefix keeps CON/NUL/`../x` harmless and keys that
//       differ only in case apart); `csvFile` is a CSV through `toCsv` (formula-guarded) with a U+FEFF BOM.
//       `bytes()` is the sum of the uncompressed sizes added (strings as UTF-8): the runner's size gate reads it after row 1.
// Deps: route-batch-types.ts (ZipSink, type only), user-data/user-data-export.ts (toCsv), jszip.
//       The caller imports this module dynamically with the rest of the batch chunk.

import JSZip from 'jszip';
import { toCsv } from '../user-data/user-data-export.js';
import type { ZipSink } from './route-batch-types.js';

export const BOM = '﻿';

/** The folder name of row `index` (1-based) for the visitor's `key`: `001-reno-boise`. ASCII only. */
export function rowSlug(index: number, key: string): string {
  const base = key.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  const n = String(Math.max(0, Math.floor(index))).padStart(3, '0');
  return base ? `${n}-${base}` : n;
}

/** A CSV file body: BOM, then RFC 4180 rows with spreadsheet-formula cells neutralised. */
export function csvFile(rows: readonly Record<string, unknown>[], fields: readonly string[]): string {
  return BOM + toCsv(rows, fields);
}

function safeSegment(s: string): string {
  let out = s.normalize('NFC').replace(/[\\:*?"<>|\p{Cc}]/gu, '_').replace(/^\.+/, m => '_'.repeat(m.length));
  out = out.replace(/[. ]+$/, '');
  return out || '_';
}

/** `a/../b\c.csv` → `a/b_c.csv`-style: only forward-slash structure survives, empty and dot segments are dropped. */
export function safePath(path: string): string {
  const segs = path.split('/').filter(s => s !== '' && s !== '.' && s !== '..').map(safeSegment);
  return segs.length ? segs.join('/') : 'file';
}

export interface ZipBuilder extends ZipSink {
  /** The sanitised paths added so far, in order. */
  paths(): string[];
  generate(): Promise<Uint8Array>;
}

export function createZipSink(): ZipBuilder {
  const zip = new JSZip();
  const taken = new Set<string>();
  const order: string[] = [];
  let total = 0;
  const unique = (p: string): string => {
    if (!taken.has(p.toLowerCase())) return p;
    const slash = p.lastIndexOf('/'), dot = p.lastIndexOf('.');
    const stem = dot > slash + 1 ? p.slice(0, dot) : p, ext = dot > slash + 1 ? p.slice(dot) : '';
    for (let i = 2; ; i++) {
      const c = `${stem}-${i}${ext}`;
      if (!taken.has(c.toLowerCase())) return c;
    }
  };
  return {
    add(path, data) {
      const p = unique(safePath(path));
      taken.add(p.toLowerCase());
      order.push(p);
      total += typeof data === 'string' ? new TextEncoder().encode(data).length : data.length;
      const stored = /\.(pdf|jpe?g|png)$/i.test(p);
      zip.file(p, data, { binary: typeof data !== 'string', compression: stored ? 'STORE' : 'DEFLATE' });
    },
    bytes: () => total,
    paths: () => [...order],
    generate: () => zip.generateAsync({ type: 'uint8array' }),
  };
}
