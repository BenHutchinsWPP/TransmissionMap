// ─── Columns-file column decode (pure; worker and main thread) ───────────────
// Role: one column of one row group of a columns Parquet, decoded whole from the
//       bytes of that row group's chunks, as a dictionary and codes. Fetches
//       nothing, touches no DOM, keeps no module state, so a worker and the main
//       thread run the same code.
//   groupRange(md, g, columns)  the one contiguous byte range [start, end) that
//                         holds the chunks of `columns` in row group g (one fetch
//                         per group; chunks in between come along)
//   decodeColumn({schema, rowGroup, column, bytes, start})  async: `bytes` are the
//                         file's bytes from `start`; reads exactly as range-io
//                         `readRows` does (object rows, ZSTD by fzstd, no offset
//                         index), so values convert the same (int64 stays bigint)
//   expand(col, i)        row i's value: null for a null, else the dictionary entry
//   estimateBytes(col)    rough heap size: 4 per code + per entry 16 (+ 2 per
//                         string character)
// Col: {dict, codes, bytes}: dict holds each distinct value once (-0 apart from
//   +0, one NaN), codes[i] its index for row i or -1 for null. Columns files hold
//   primitives only (build_columns_parquet.py refuses lists and objects), so any
//   other value is a decode error, thrown.
// Errors: a read outside the piece throws 'columns decode: read outside piece';
//   hyparquet's own errors pass through.
// Deps: hyparquet, fzstd. No range-io.ts or constants.ts (no fetch state).

import { parquetReadObjects, type AsyncBuffer, type FileMetaData, type RowGroup,
  type SchemaElement, type Compressors } from 'hyparquet';
import { decompress } from 'fzstd';

export interface Col { dict: unknown[]; codes: Int32Array; bytes: number }
export interface DecodeInput { schema: SchemaElement[]; rowGroup: RowGroup; column: string; bytes: ArrayBuffer; start: number }

const COMPRESSORS: Compressors = { ZSTD: (input: Uint8Array) => decompress(input) };

/** The byte range holding the chunks of `columns` in row group `g`, as one span. */
export function groupRange(md: Pick<FileMetaData, 'row_groups'>, g: number, columns: readonly string[]): { start: number; end: number } {
  let start = Infinity, end = -Infinity, found = 0;
  for (const c of md.row_groups[g].columns) {
    const m = c.meta_data;
    if (!m || !columns.includes(m.path_in_schema.join('.'))) continue;
    const s = Number(m.dictionary_page_offset || m.data_page_offset);   // a 0n or absent dictionary offset: the data page
    start = Math.min(start, s);
    end = Math.max(end, s + Number(m.total_compressed_size));
    found++;
  }
  if (found !== new Set(columns).size) throw new Error('columns decode: column not in row group');
  return { start, end };
}

export async function decodeColumn({ schema, rowGroup, column, bytes, start }: DecodeInput): Promise<Col> {
  const end = start + bytes.byteLength;
  const file: AsyncBuffer = {
    byteLength: end,
    slice(a: number, b = end) {
      if (a < start || b > end) throw new Error('columns decode: read outside piece');
      return bytes.slice(a - start, b - start);
    },
  };
  const metadata: FileMetaData = { version: 2, schema, row_groups: [rowGroup], num_rows: rowGroup.num_rows, metadata_length: 0 };
  const rows = await parquetReadObjects({ file, metadata, rowStart: 0, rowEnd: Number(rowGroup.num_rows), columns: [column],
    compressors: COMPRESSORS, useOffsetIndex: false, rowFormat: 'object' }) as Record<string, unknown>[];
  const dict: unknown[] = [];
  const codes = new Int32Array(rows.length);
  const index = new Map<unknown, number>();   // SameValueZero: -0 would land on +0, so it has its own slot
  let negZero = -1;
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i][column];
    if (v === null || v === undefined) { codes[i] = -1; continue; }
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'bigint' && t !== 'boolean') throw new Error('columns decode: not a primitive');
    if (Object.is(v, -0)) {
      if (negZero < 0) { negZero = dict.length; dict.push(-0); }
      codes[i] = negZero;
      continue;
    }
    let k = index.get(v);
    if (k === undefined) { k = dict.length; dict.push(v); index.set(v, k); }
    codes[i] = k;
  }
  const col: Col = { dict, codes, bytes: 0 };
  col.bytes = estimateBytes(col);
  return col;
}

export function expand(col: Col, i: number): unknown {
  const k = col.codes[i];
  return k < 0 ? null : col.dict[k];
}

export function estimateBytes(col: Pick<Col, 'dict' | 'codes'>): number {
  let n = 4 * col.codes.length;
  for (const v of col.dict) n += typeof v === 'string' ? 16 + 2 * v.length : 16;
  return n;
}
