// ─── Route batch ZIP tests ───────────────────────────────────────────────────
// Role: the ZIP layout through createZipSink: paths, BOM'd formula-guarded CSVs, byte total, sanitised and
//       case-insensitively unique names, slugs that keep hostile keys harmless.
// Deps: ./route-batch-zip.ts, jszip.

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { createZipSink, csvFile, rowSlug, safePath } from './route-batch-zip.js';

describe('rowSlug', () => {
  it('is NNN-ascii, at most 40 slug characters, and harmless for hostile keys', () => {
    expect(rowSlug(1, 'Reno to Boise')).toBe('001-reno-to-boise');
    expect(rowSlug(12, '../../x')).toBe('012-x');
    expect(rowSlug(3, 'CON')).toBe('003-con');
    expect(rowSlug(4, '東京 القاهرة')).toBe('004');
    expect(rowSlug(5, 'Ünïcødé')).toBe('005-unic-de');
    expect(rowSlug(6, 'a'.repeat(100))).toMatch(/^006-a{40}$/);
    for (const k of ['..', 'a/b\\c', 'NUL.txt', ' ']) expect(rowSlug(7, k)).toMatch(/^007(-[a-z0-9-]+)?$/);
  });
  it('keys that differ only in case stay distinct through the index', () => {
    expect(rowSlug(1, 'Reno').toLowerCase()).not.toBe(rowSlug(2, 'reno').toLowerCase());
  });
});

describe('safePath', () => {
  it('drops dot segments and separators inside names', () => {
    expect(safePath('../../etc/passwd')).toBe('etc/passwd');
    expect(safePath('rows/001-x/a\\b.csv')).toBe('rows/001-x/a_b.csv');
    expect(safePath('/abs/.hidden')).toBe('abs/_hidden');
    expect(safePath('..')).toBe('file');
  });
});

describe('createZipSink', () => {
  const FIELDS = ['key', 'note'];
  it('lays out paths, BOM + formula-guarded CSVs, and counts bytes', async () => {
    const sink = createZipSink();
    const slug = rowSlug(1, 'Reno');
    const csv = csvFile([{ key: '=cmd()', note: 'a,b' }, { key: '+1', note: 'é' }], FIELDS);
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 1, 2, 3]);
    sink.add('routes.geojson', '{"type":"FeatureCollection","features":[]}');
    sink.add('summary.csv', csv);
    sink.add(`rows/${slug}/cost.csv`, csvFile([], FIELDS));
    sink.add(`rows/${slug}/crossings.csv`, csvFile([], FIELDS));
    sink.add(`rows/${slug}/report.pdf`, pdf);
    sink.add('batch.json', '{}');
    expect(sink.paths()).toEqual(['routes.geojson', 'summary.csv', 'rows/001-reno/cost.csv', 'rows/001-reno/crossings.csv', 'rows/001-reno/report.pdf', 'batch.json']);
    const enc = new TextEncoder();
    const expected = [csv, csvFile([], FIELDS), csvFile([], FIELDS), '{"type":"FeatureCollection","features":[]}', '{}'].reduce((n, s) => n + enc.encode(s).length, 0) + pdf.length;
    expect(sink.bytes()).toBe(expected);

    const zip = await JSZip.loadAsync(await sink.generate());
    expect(Object.keys(zip.files).filter(n => !n.endsWith('/')).sort()).toEqual([...sink.paths()].sort());
    const text = await zip.file('summary.csv')!.async('string');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("'=cmd()");
    expect(text).toContain("'+1");
    expect(await zip.file('rows/001-reno/report.pdf')!.async('uint8array')).toEqual(pdf);
    for (const p of sink.paths().filter(n => n.endsWith('.csv'))) expect((await zip.file(p)!.async('string')).charCodeAt(0)).toBe(0xfeff);
  });

  it('keeps names unique case-insensitively and inside the archive', async () => {
    const sink = createZipSink();
    sink.add('rows/001-a/report.pdf', 'x');
    sink.add('rows/001-A/REPORT.pdf', 'y');
    sink.add('../../evil.txt', 'z');
    const p = sink.paths();
    expect(new Set(p.map(s => s.toLowerCase())).size).toBe(3);
    expect(p[2]).toBe('evil.txt');
    expect(p.some(s => s.includes('..'))).toBe(false);
  });
});
