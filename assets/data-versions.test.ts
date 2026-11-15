// src/registry/data-versions.json — the ?v= table publish_r2.sh writes: its shape, and
// that every data-host URL the app builds (DATA values and every registry layer's
// download packs, prod origins, minus data/route/) has an entry, so no fixed-name
// object is read without a version. The coverage test is red until the data is published.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import TABLE from '../src/registry/data-versions.json';
import { LAYERS } from '../src/registry/index.js';
import { packLinks } from './download-packs.js';

const HOST = 'https://data.wpptx.org/';
const PRIVATE_OR_IMMUTABLE = /^data\/route\//;

/** Repo paths the app reads from the data host as fixed names. */
export function expectedPaths(): string[] {
  const out = new Set<string>();
  const src = readFileSync(new URL('./constants.ts', import.meta.url), 'utf8');
  for (const m of src.matchAll(/DATA_ORIGIN \+ "(data\/[^"]+)"/g)) out.add(m[1]);
  for (const l of LAYERS) {
    for (const f of packLinks(l.downloads ?? {}, HOST + 'data/releases/')) {
      for (const link of f.links) out.add(link.url.slice(HOST.length).split('?')[0]);
    }
  }
  return [...out].filter(p => !PRIVATE_OR_IMMUTABLE.test(p)).sort();
}

/** The paths of `expected` the table does not name. */
export const missingFrom = (table: Record<string, string>, expected: string[]) =>
  expected.filter(p => !(p in table));

describe('data-versions.json', () => {
  it('holds sorted data/ keys with a token each', () => {
    const keys = Object.keys(TABLE);
    for (const k of keys) expect(k).toMatch(/^data\/(layers|analysis|releases)\//);
    for (const v of Object.values(TABLE)) expect(v).toMatch(/^([0-9a-f]{10}|r\d{8}T\d{6}Z)$/);
    expect(keys).toEqual([...keys].sort());
  });

  it('names every data-host URL the app builds', () => {
    expect(missingFrom(TABLE, expectedPaths())).toEqual([]);
  });

  it('the listing returns exactly the key removed from a full table', () => {
    const expected = ['data/layers/a.pmtiles', 'data/layers/b.json'];
    const full = Object.fromEntries(expected.map(p => [p, '0123456789']));
    expect(missingFrom(full, expected)).toEqual([]);
    const { 'data/layers/b.json': _gone, ...rest } = full;
    void _gone;
    expect(missingFrom(rest, expected)).toEqual(['data/layers/b.json']);
  });
});
