// The data paths scripts/validate_build.py sees. Its expected_layers() regexes
// every double-quoted "data/layers/…" literal out of this file's source text,
// and that list decides what `make validate` checks and what
// scripts/publish_data.sh publishes (via --list-expected). A DATA path written
// any other way (a template literal, a .map()) is invisible to both, so this
// test holds the regex's view equal to DATA itself.
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DATA } from './constants.js';

// Same pattern as expected_layers() in scripts/validate_build.py.
const PATH_LITERAL = /"(data\/layers\/[^"]+)"/g;

// DATA entries that are deliberately not data/layers/ paths: the moratorium
// layer is served from its own branch (MORATORIUM_ORIGIN), which
// validate_build.py and publish_data.sh leave alone; the Routing constraints
// rasters are dev-only files beside the route cube (data/route/constraints/).
const NOT_SCRAPED = new Set<keyof typeof DATA>(['dc_moratoriums', 'route_constraints', 'line_index']);

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

  it('serves the Routing constraints rasters relative, beside the route cube', () => {
    expect(DATA.route_constraints).toBe('data/route/constraints/what-constrains.pmtiles');
  });

  it('serves the line geometry index relative, from data/analysis/', () => {
    expect(DATA.line_index).toBe('data/analysis/index.json');
  });
});

// Download packs sit on the data host under data/releases/, the keys
// publish_r2.sh uploads them to. RELEASES_ORIGIN is resolved at module load, so
// the prod branch takes a fresh import.
describe('RELEASES_ORIGIN — download pack host', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('is data/releases/ on the data host in prod, and empty in dev', async () => {
    vi.resetModules();
    vi.stubEnv('PROD', true);
    const { RELEASES_ORIGIN } = await import('./constants.js');
    expect(RELEASES_ORIGIN).toBe('https://data.wpptx.org/data/releases/');
    vi.resetModules();
    vi.stubEnv('PROD', false);
    expect((await import('./constants.js')).RELEASES_ORIGIN).toBe('');
  });
});
