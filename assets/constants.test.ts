// The data paths scripts/validate_build.py sees. Its expected_layers() regexes
// every double-quoted "data/layers/…" literal out of this file's source text,
// and that list decides what `make validate` checks and what
// scripts/publish_data.sh publishes (via --list-expected). A DATA path written
// any other way (a template literal, a .map()) is invisible to both, so this
// test holds the regex's view equal to DATA itself.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { DATA } from './constants.js';

// Same pattern as expected_layers() in scripts/validate_build.py.
const PATH_LITERAL = /"(data\/layers\/[^"]+)"/g;

// DATA entries that are deliberately not data/layers/ paths: the moratorium
// layer is served from its own branch (MORATORIUM_ORIGIN), which
// validate_build.py and publish_data.sh leave alone.
const NOT_SCRAPED = new Set<keyof typeof DATA>(['dc_moratoriums']);

describe('constants.ts data paths', () => {
  const source = readFileSync(new URL('./constants.ts', import.meta.url), 'utf8');
  const scraped = [...source.matchAll(PATH_LITERAL)].map(m => m[1]).sort();

  it('runs with empty origins under Vitest, so DATA holds relative paths', () => {
    expect(import.meta.env.PROD).toBe(false);
    expect(DATA.osm_generators).toBe('data/layers/osm_generators.pmtiles');
  });

  it('every DATA path is a literal validate_build.py scrapes, and nothing else is', () => {
    const paths = Object.entries(DATA)
      .filter(([key]) => !NOT_SCRAPED.has(key as keyof typeof DATA))
      .map(([, url]) => url)
      .sort();
    expect(scraped).toEqual(paths);
  });

  it('the allow-listed entries are not data/layers/ paths', () => {
    for (const key of NOT_SCRAPED) expect(DATA[key]).not.toMatch(/data\/layers\//);
  });
});
