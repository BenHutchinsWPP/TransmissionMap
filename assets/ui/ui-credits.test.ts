// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderDataCredits } from './ui-credits.js';
import { LAYER_SOURCES } from '../../src/registry/index.js';

const FALLBACK_HTML = `
  <li data-source-credit="osm"><a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a></li>
  <li data-source-credit="eia"><a href="https://www.eia.gov/">EIA</a></li>
`;

function setupDialog() {
  document.body.innerHTML = `
    <dialog id="creditsDialog">
      <div class="credits-content">
        <ul>${FALLBACK_HTML}</ul>
      </div>
    </dialog>
  `;
}

function stubFetchOk(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  })));
}

// LAYER_SOURCES keys ("eia", "osm") — see src/registry/sources.ts.
const VALID_MANIFEST = {
  generated_utc: '2026-09-19T00:00:00Z',
  note: 'test manifest',
  layers: {
    eia_generators: {
      label: 'EIA Generators',
      source: 'U.S. Energy Information Administration',
      url: 'https://www.eia.gov/electricity/data/eia860/',
      licence: 'Public domain',
      source_id: 'eia',
      source_rows: 14806,
      coverage: null,
      retrieved: '2026-09-01',
      bytes: 12345,
    },
    osm_plants_polygons: {
      label: 'OSM Plants (Polygons)',
      source: 'OpenStreetMap contributors',
      url: 'UNKNOWN',
      licence: 'ODbL 1.0',
      source_id: 'osm',
      source_rows: null,
      coverage: null,
      retrieved: null,
      bytes: null,
    },
  },
};

beforeEach(() => {
  setupDialog();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('renderDataCredits', () => {
  it('renders one <li> per source_id group, replacing the fallback list', async () => {
    stubFetchOk(VALID_MANIFEST);

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    const groups = ul.querySelectorAll('li[data-source-credit]');
    expect(groups.length).toBe(2);

    const eiaGroup = ul.querySelector('[data-source-credit="eia"]')!;
    expect(eiaGroup.querySelector('strong')?.textContent).toBe(LAYER_SOURCES.eia.label);
    expect(eiaGroup.innerHTML).toContain('EIA Generators');
    expect(eiaGroup.innerHTML).toContain('14,806 rows');
    expect(eiaGroup.querySelector('a')?.getAttribute('href')).toBe('https://www.eia.gov/electricity/data/eia860/');

    // url is UNKNOWN — rendered as plain text, no link, and the word
    // "UNKNOWN" itself never reaches the DOM.
    const osmGroup = ul.querySelector('[data-source-credit="osm"]')!;
    expect(osmGroup.querySelector('strong')?.textContent).toBe(LAYER_SOURCES.osm.label);
    expect(osmGroup.querySelector('a')).toBeNull();
    expect(osmGroup.innerHTML).not.toContain('UNKNOWN');
    expect(osmGroup.innerHTML).toContain('OSM Plants (Polygons)');
  });

  it('keeps a shipped entry whose source has no manifest layer (live feeds, joined tables)', async () => {
    document.querySelector('#creditsDialog ul')!.insertAdjacentHTML('beforeend',
      '<li data-source-credit="fema-nri">FEMA National Risk Index — not endorsed by FEMA.</li>');
    stubFetchOk(VALID_MANIFEST);

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelectorAll('li[data-source-credit]').length).toBe(3);
    expect(ul.querySelector('[data-source-credit="fema-nri"]')?.textContent).toContain('not endorsed by FEMA');
    expect(ul.querySelector('[data-source-credit="eia"]')?.innerHTML).toContain('14,806 rows');
  });

  it('groups several layers under one shared source_id anchor', async () => {
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: {
        osm_plants_points: {
          label: 'OSM Plants (Points)', source: 'OpenStreetMap contributors',
          url: 'https://www.openstreetmap.org/copyright', licence: 'ODbL 1.0', source_id: 'osm',
          source_rows: 100, coverage: null, retrieved: null, bytes: null,
        },
        osm_generators: {
          label: 'OSM Generators', source: 'OpenStreetMap contributors',
          url: 'https://www.openstreetmap.org/copyright', licence: 'ODbL 1.0', source_id: 'osm',
          source_rows: 200, coverage: null, retrieved: null, bytes: null,
        },
      },
    });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    // One osm group, plus the shipped eia entry this manifest has no layer for.
    expect(Array.from(ul.querySelectorAll('li[data-source-credit]'), li => li.getAttribute('data-source-credit')))
      .toEqual(['eia', 'osm']);
    const osmGroup = ul.querySelector('[data-source-credit="osm"]')!;
    expect(osmGroup.querySelectorAll('.credits-group-layers > li').length).toBe(2);
    expect(osmGroup.innerHTML).toContain('OSM Plants (Points)');
    expect(osmGroup.innerHTML).toContain('OSM Generators');
  });

  it('leaves the fallback markup intact when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelector('[data-source-credit="osm"]')).not.toBeNull();
    expect(ul.querySelector('[data-source-credit="eia"]')).not.toBeNull();
  });

  it('leaves the fallback markup intact when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelector('[data-source-credit="osm"]')).not.toBeNull();
    expect(ul.querySelector('[data-source-credit="eia"]')).not.toBeNull();
  });

  it('leaves the fallback markup intact when the payload has the wrong shape', async () => {
    // Missing required fields on the layer entry (no url/licence), and
    // layers is present but every entry fails the type check.
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: { broken: { label: 'Broken' } },
    });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelectorAll('li[data-source-credit]').length).toBe(2);
    expect(ul.querySelector('[data-source-credit="eia"]')).not.toBeNull();
  });

  it('leaves the fallback markup intact when the payload is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    })));

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelectorAll('li[data-source-credit]').length).toBe(2);
  });

  it('leaves the fallback markup intact when layers is empty', async () => {
    stubFetchOk({ generated_utc: '2026-09-19T00:00:00Z', note: 'test manifest', layers: {} });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelectorAll('li[data-source-credit]').length).toBe(2);
  });

  it('leaves the fallback markup intact when every entry\'s source_id is UNKNOWN, missing, or unrecognized — never a bogus anchor', async () => {
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: {
        admin_lines: {
          label: 'Natural Earth Admin Lines', source: 'Natural Earth',
          url: 'https://www.naturalearthdata.com/about/terms-of-use/', licence: 'Public domain',
          source_id: 'UNKNOWN', source_rows: null, coverage: null, retrieved: null, bytes: null,
        },
        no_source_id_field: {
          label: 'No Source Id', source: 'Someone', url: 'https://example.com', licence: 'UNKNOWN',
          source_rows: null, coverage: null, retrieved: null, bytes: null,
        },
        fabricated_source_id: {
          label: 'Fabricated', source: 'Someone', url: 'https://example.com', licence: 'UNKNOWN',
          source_id: 'not-a-real-layer-source', source_rows: null, coverage: null, retrieved: null, bytes: null,
        },
      },
    });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelectorAll('li[data-source-credit]').length).toBe(2);
    expect(ul.querySelector('[data-source-credit="osm"]')).not.toBeNull();
    expect(ul.querySelector('[data-source-credit="eia"]')).not.toBeNull();
    expect(ul.querySelector('[data-source-credit="not-a-real-layer-source"]')).toBeNull();
  });

  it('leaves the fallback markup intact when a source_id names an inherited Object property', async () => {
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: {
        proto: {
          label: 'Proto', source: 'Someone', url: 'https://example.com', licence: 'UNKNOWN',
          source_id: '__proto__', source_rows: null, coverage: null, retrieved: null, bytes: null,
        },
        ctor: {
          label: 'Ctor', source: 'Someone', url: 'https://example.com', licence: 'UNKNOWN',
          source_id: 'constructor', source_rows: null, coverage: null, retrieved: null, bytes: null,
        },
      },
    });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelector('[data-source-credit="__proto__"]')).toBeNull();
    expect(ul.querySelector('[data-source-credit="constructor"]')).toBeNull();
    expect(ul.querySelector('[data-source-credit="osm"]')).not.toBeNull();
  });

  it('escapes HTML in manifest-derived strings instead of injecting it', async () => {
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: {
        hostile: {
          label: '<img src=x onerror=alert(1)>',
          source: '<script>alert(2)</script>',
          url: 'https://example.com/"><script>alert(3)</script>',
          licence: 'CC BY 4.0',
          source_id: 'osm',
          source_rows: 5,
          coverage: null,
          retrieved: null,
          bytes: null,
        },
      },
    });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelector('img')).toBeNull();
    expect(ul.querySelector('script')).toBeNull();
    expect(ul.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');

    const osmGroup = ul.querySelector('[data-source-credit="osm"]')!;
    const link = osmGroup.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/"><script>alert(3)</script>');
    // The href value is attacker-controlled but was written through
    // escapeHtml, so it cannot break out of the attribute or open a new tag.
    expect(ul.innerHTML).not.toContain('"><script>alert(3)</script></a>');
  });

  it('renders per-field coverage, sorted by count, dropping full-coverage fields', async () => {
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: {
        eia_generators: {
          label: 'EIA Generators', source: 'EIA', url: 'UNKNOWN', licence: 'Public domain',
          source_id: 'eia', source_rows: 14806,
          coverage: { state: 14806, county: 13427, capacity_factor: 11452 },
          retrieved: null, bytes: null,
        },
      },
    });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    const eiaGroup = ul.querySelector('[data-source-credit="eia"]')!;
    // `state` has full coverage (14,806 === source_rows) and is dropped;
    // the rest are sorted by count descending.
    expect(eiaGroup.innerHTML).not.toContain('with state');
    expect(eiaGroup.innerHTML).toContain('13,427 with county');
    expect(eiaGroup.innerHTML).toContain('11,452 with capacity_factor');
    const countyIdx = eiaGroup.innerHTML.indexOf('13,427 with county');
    const cfIdx = eiaGroup.innerHTML.indexOf('11,452 with capacity_factor');
    expect(countyIdx).toBeLessThan(cfIdx);
  });

  it('omits the coverage line entirely when coverage is null or every field has full coverage', async () => {
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: {
        null_coverage: {
          label: 'Null Coverage', source: 'EIA', url: 'UNKNOWN', licence: 'Public domain',
          source_id: 'eia', source_rows: 100, coverage: null, retrieved: null, bytes: null,
        },
        full_coverage: {
          label: 'Full Coverage', source: 'OSM', url: 'UNKNOWN', licence: 'ODbL 1.0',
          source_id: 'osm', source_rows: 50, coverage: { name: 50 }, retrieved: null, bytes: null,
        },
      },
    });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.innerHTML).not.toContain('with');
  });

  it('caps the coverage list and says how many more', async () => {
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: {
        wide_select: {
          label: 'Wide Select', source: 'EIA', url: 'UNKNOWN', licence: 'Public domain',
          source_id: 'eia', source_rows: 1000,
          coverage: { a: 900, b: 800, c: 700, d: 600, e: 500, f: 400 },
          retrieved: null, bytes: null,
        },
      },
    });

    await renderDataCredits();

    const eiaGroup = document.querySelector('[data-source-credit="eia"]')!;
    expect(eiaGroup.innerHTML).toContain('900 with a');
    expect(eiaGroup.innerHTML).toContain('500 with e');
    expect(eiaGroup.innerHTML).not.toContain('with f');
    expect(eiaGroup.innerHTML).toContain('+1 more');
  });

  it('escapes coverage field names instead of trusting them', async () => {
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: {
        hostile_field: {
          label: 'Hostile Field', source: 'EIA', url: 'UNKNOWN', licence: 'Public domain',
          source_id: 'eia', source_rows: 100,
          coverage: { '<img src=x onerror=alert(1)>': 50 },
          retrieved: null, bytes: null,
        },
      },
    });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelector('img')).toBeNull();
    expect(ul.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders the built artifact size alongside the row count', async () => {
    stubFetchOk({
      generated_utc: '2026-09-19T00:00:00Z',
      note: 'test manifest',
      layers: {
        sized: {
          label: 'Sized Layer', source: 'EIA', url: 'UNKNOWN', licence: 'Public domain',
          source_id: 'eia', source_rows: 2048, coverage: null, retrieved: null, bytes: 2_400_000,
        },
      },
    });

    await renderDataCredits();

    const eiaGroup = document.querySelector('[data-source-credit="eia"]')!;
    expect(eiaGroup.innerHTML).toContain('2,048 rows');
    expect(eiaGroup.innerHTML).toContain('2.3 MB');
  });

  // Pins the fix for a real regression: replacing the credits list from the
  // manifest must not orphan the per-layer "source" button (ui-layer-rows.ts
  // -> openSourceCredit() in ui.ts), which scrolls to a data-source-credit
  // anchor by its LAYER_SOURCES key. Reads the real index.html fallback and
  // the real LAYER_SOURCES registry, so it fails if a future change makes
  // rendering drop or rename an anchor those callers depend on.
  it('every fallback data-source-credit anchor still resolves after a manifest render', async () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const dialogMatch = html.match(/<dialog[^>]*id="creditsDialog"[^>]*>([\s\S]*?)<\/dialog>/);
    expect(dialogMatch).not.toBeNull();

    const fallbackIds = new Set(
      Array.from(dialogMatch![1].matchAll(/data-source-credit="([^"]+)"/g)).map(m => m[1]),
    );
    // Anchors that are real LAYER_SOURCES keys — the only ones openSourceCredit()
    // and the per-layer "source" button can navigate to (the fallback also
    // carries a couple of fixed extras, e.g. "im3", that aren't LAYER_SOURCES
    // keys and have no source button pointed at them).
    const anchoredSourceIds = Array.from(fallbackIds).filter(id => id in LAYER_SOURCES);
    expect(anchoredSourceIds.length).toBeGreaterThan(0);

    const layers: Record<string, unknown> = {};
    anchoredSourceIds.forEach((sourceId, i) => {
      layers[`layer_${i}`] = {
        label: `Layer ${i}`, source: 'Some Source', url: 'https://example.com', licence: 'Public domain',
        source_id: sourceId, source_rows: null, coverage: null, retrieved: null, bytes: null,
      };
    });
    stubFetchOk({ generated_utc: '2026-09-19T00:00:00Z', note: 'test manifest', layers });

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    const renderedIds = new Set(
      Array.from(ul.querySelectorAll('[data-source-credit]')).map(el => el.getAttribute('data-source-credit')),
    );
    for (const sourceId of anchoredSourceIds) {
      expect(renderedIds.has(sourceId), `missing data-source-credit for "${sourceId}" after manifest render`).toBe(true);
    }
  });
});
