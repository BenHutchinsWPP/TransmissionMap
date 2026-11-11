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
// rasters and the route cube are served from data/route/ (versioned by ROUTE_ID on the data host).
const NOT_SCRAPED = new Set<keyof typeof DATA>(['dc_moratoriums', 'route_cube', 'route_constraints', 'line_index']);

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

  it('serves the route cube and Routing constraints relative under Vitest', () => {
    expect(DATA.route_cube).toBe('data/route/250m/');
    expect(DATA.route_constraints).toBe('data/route/constraints/what-constrains.pmtiles');
  });

  it('serves the line geometry index relative, from data/analysis/', () => {
    expect(DATA.line_index).toBe('data/analysis/index.json');
  });
});

// On the data host the route data sits under the immutable data/route/<ROUTE_ID>/ prefix.
describe('route data in prod', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('names the data host and the ROUTE_ID prefix', async () => {
    vi.resetModules();
    vi.stubEnv('PROD', true);
    vi.stubEnv('DEV', false);
    const m = await import('./constants.js');
    const base = `https://data.wpptx.org/data/route/${m.ROUTE_ID}/`;
    expect(m.ROUTE_ID).toMatch(/^[0-9a-f]{12}$/);
    expect(m.DATA.route_cube).toBe(base + '250m/');
    expect(m.DATA.route_constraints).toBe(base + 'constraints/what-constrains.pmtiles');
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
