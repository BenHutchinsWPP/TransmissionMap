// The pairs CSV builder: the same text as toCsv, chunks of ≤ 10,000 rows, the formula guard, the
// truncation note, and the size limit counted in UTF-8 bytes (a non-Latin file passes a character count).
// Deps: pairs-csv.ts, csv-worker.ts, user-data/user-data-export.ts (toCsv, the reference).

import { describe, it, expect } from 'vitest';
import { buildPairsCsv, CSV_CHUNK, type PairsCsvInput } from './pairs-csv.js';
import { handleCsv } from './csv-worker.js';
import { toCsv } from '../user-data/user-data-export.js';

function input(n: number, name = (i: number) => `P${i}`): PairsCsvInput {
  const pts = n + 1;
  return {
    fields: ['group', 'a_row', 'b_row', 'a_id', 'b_id', 'a_name', 'b_name', 'distance_km', 'a_latitude', 'a_longitude', 'b_latitude', 'b_longitude', 'a_Note', 'b_Note'],
    unitKm: 1,
    a: Int32Array.from({ length: n }, (_, k) => k), b: Int32Array.from({ length: n }, (_, k) => k + 1),
    km: Float64Array.from({ length: n }, () => 0.12345),
    group: new Int32Array(pts).fill(1), rowNo: Int32Array.from({ length: pts }, (_, i) => i),
    lat: Float64Array.from({ length: pts }, () => 30.5), lon: Float64Array.from({ length: pts }, () => -97.25),
    names: Array.from({ length: pts }, (_, i) => name(i)), idText: Array.from({ length: pts }, (_, i) => `id${i}`),
    cols: [Array.from({ length: pts }, (_, i) => (i % 2 ? '=1+1' : 'a,"b"'))],
    notes: [],
  };
}

const join = (o: ReturnType<typeof buildPairsCsv>) => { if (!o.ok) throw new Error('refused'); return o.parts.join(''); };

describe('buildPairsCsv', () => {
  it('writes what toCsv writes for the same rows, formula-guarded and quoted', () => {
    const d = { ...input(3), notes: ['stops, here'] };
    const rows = Array.from({ length: 3 }, (_, k) => {
      const a = d.a[k], b = d.b[k];
      const r: Record<string, unknown> = {};
      const v = [d.group[a], d.rowNo[a] + 1, d.rowNo[b] + 1, d.idText![a], d.idText![b], d.names[a], d.names[b], 0.123, d.lat[a], d.lon[a], d.lat[b], d.lon[b], d.cols[0][a], d.cols[0][b]];
      d.fields.forEach((f, i) => { r[f] = v[i]; });
      return r;
    });
    expect(join(buildPairsCsv(d))).toBe(toCsv(rows, d.fields, undefined, d.notes));
  });

  it('cuts chunks of at most 10,000 rows, the header once, notes last, and reports progress', () => {
    const d = { ...input(25_000), notes: ['note'] };
    const seen: number[] = [];
    const o = buildPairsCsv(d, undefined, n => seen.push(n));
    if (!o.ok) throw new Error('refused');
    expect(o.parts).toHaveLength(3);
    expect(seen).toEqual([10_000, 20_000, 25_000]);
    expect(o.parts.map(p => p.split('\r\n').length - 1)).toEqual([CSV_CHUNK + 1, CSV_CHUNK, 5_000 + 1]);
    const all = o.parts.join('').split('\r\n');
    expect(all.filter(l => l.startsWith('group,'))).toHaveLength(1);
    expect(all.at(-2)).toBe('note');
  });

  it('writes the header and notes for an empty list', () => {
    expect(join(buildPairsCsv({ ...input(0), notes: ['n'] }))).toMatch(/^group,.*\r\nn\r\n$/);
  });

  it('counts the 200 MB limit in UTF-8 bytes, not characters', () => {
    const d = input(500, i => `東京の変電所${i}`);
    const full = join(buildPairsCsv(d));
    const chars = full.length, bytes = new TextEncoder().encode(full).length;
    expect(bytes).toBeGreaterThan(chars + 1_000);
    const limit = Math.floor((chars + bytes) / 2);   // above the character count, below the byte count
    const o = buildPairsCsv(d, limit);
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.bytes).toBeGreaterThan(limit);
    expect(buildPairsCsv(d, bytes + 1_000).ok).toBe(true);
  });
});

describe('handleCsv', () => {
  it('posts progress, then a text/csv Blob', async () => {
    const out: { id: number; progress?: number; outcome?: { ok: boolean; blob?: Blob } }[] = [];
    handleCsv({ id: 7, input: input(12_000) }, m => out.push(m as never));
    expect(out.map(m => m.progress)).toEqual([10_000, 12_000, undefined]);
    const o = out.at(-1)!.outcome!;
    expect(o.ok).toBe(true);
    expect(o.blob!.type).toBe('text/csv;charset=utf-8');
    expect(await o.blob!.text()).toBe(join(buildPairsCsv(input(12_000))));
  });
  it('relays the size refusal and turns an error into a fixed failure', () => {
    const out: { outcome?: unknown }[] = [];
    handleCsv({ id: 1, input: input(500), limit: 100 }, m => out.push(m as never));
    expect(out.at(-1)!.outcome).toMatchObject({ ok: false, bytes: expect.any(Number) });
    handleCsv({ id: 2, input: { ...input(2), cols: null as never } }, m => out.push(m as never));
    expect(out.at(-1)!.outcome).toEqual({ ok: false, failed: true });
  });
});
