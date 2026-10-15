// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderDataCredits } from './ui-credits.js';
import { LAYER_SOURCES } from '../../src/registry/index.js';

// Mirrors the shapes index.html ships: top-level anchored entries, an
// umbrella entry whose anchors sit on nested <span>s, an entry carrying a
// display note, and an anchorless entry.
const FALLBACK_HTML = `
  <li data-source-credit="osm"><a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a></li>
  <li><a href="https://www.eia.gov/">EIA</a> — public domain: <span data-source-credit="eia"><a href="https://www.eia.gov/electricity/data/eia860/">Form 860</a></span>; <span data-source-credit="eia-ba">Balancing Authorities</span>.</li>
  <li data-source-credit="hifld-tribal">Census TIGER/Line — <strong>Display note:</strong> Administrative boundaries only.</li>
  <li>Tooling: <a href="https://maplibre.org/">MapLibre GL JS</a> / <a href="https://www.arcgis.com/">Esri World Imagery</a></li>
`;
const FALLBACK_TEXTS = [
  'OpenStreetMap contributors',
  'EIA — public domain: Form 860; Balancing Authorities.',
  'Display note: Administrative boundaries only.',
  'Tooling: MapLibre GL JS / Esri World Imagery',
];

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

// LAYER_SOURCES keys ("eia", "osm", "hifld-tribal") — see src/registry/sources.ts.
// Only source_id and data_as_of are read; the rest mirrors the real manifest.
function layer(source_id: unknown, data_as_of: unknown = '2026-10-09') {
  return { label: 'L', source: 'S', url: 'UNKNOWN', licence: 'UNKNOWN', source_id, source_rows: null, data_as_of, bytes: null };
}

function manifest(layers: Record<string, unknown>) {
  return { generated_utc: '2026-10-15T00:00:00Z', note: 'test manifest', layers };
}

function text(sourceId: string): string {
  return document.querySelector(`[data-source-credit="${sourceId}"]`)!.textContent!;
}

beforeEach(() => {
  setupDialog();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('renderDataCredits', () => {
  it('writes one date per source, however many layers share it', async () => {
    stubFetchOk(manifest({ a: layer('osm'), b: layer('osm'), c: layer('osm') }));

    await renderDataCredits();

    expect(text('osm')).toBe('OpenStreetMap contributors — data as of 2026-10-09');
    expect(document.querySelectorAll('#creditsDialog ul > li').length).toBe(4);
  });

  it('dates a source by its oldest layer', async () => {
    stubFetchOk(manifest({ a: layer('osm', '2026-10-09'), b: layer('osm', '2026-09-01'), c: layer('osm', null) }));

    await renderDataCredits();

    expect(text('osm')).toContain('data as of 2026-09-01');
    expect(text('osm')).not.toContain('2026-10-09');
  });

  it('gives an umbrella entry one date, the oldest of the sources it credits', async () => {
    stubFetchOk(manifest({ a: layer('eia', '2026-10-11'), b: layer('eia-ba', '2026-08-20') }));

    await renderDataCredits();

    const umbrella = document.querySelector('[data-source-credit="eia"]')!.closest('li')!.textContent!;
    expect(umbrella).toBe('EIA — public domain: Form 860; Balancing Authorities. — data as of 2026-08-20');
  });

  it('puts the date before an entry\'s display note', async () => {
    stubFetchOk(manifest({ a: layer('hifld-tribal') }));

    await renderDataCredits();

    expect(text('hifld-tribal')).toContain('Census TIGER/Line — Data as of 2026-10-09. Display note:');
  });

  it('leaves an anchored entry as shipped when none of its layers is dated', async () => {
    stubFetchOk(manifest({ a: layer('osm', null), b: layer('eia', 'yesterday') }));

    await renderDataCredits();

    expect(text('osm')).toBe('OpenStreetMap contributors');
    expect(text('eia')).toBe('Form 860');
  });

  it('adds a new anchored <li> for a group with no hand-written entry', async () => {
    stubFetchOk(manifest({ pop: layer('worldpop') }));

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    const added = ul.querySelector(':scope > li[data-source-credit="worldpop"]')!;
    expect(added.querySelector('strong')?.textContent).toBe(LAYER_SOURCES.worldpop.label);
    expect(added.textContent).toContain('data as of 2026-10-09');
    for (const t of FALLBACK_TEXTS) expect(ul.textContent).toContain(t);
  });

  it('keeps every hand-written credit, nested-span umbrella, display note and anchorless entry', async () => {
    stubFetchOk(manifest({ a: layer('osm'), b: layer('eia'), c: layer('eia-ba'), d: layer('hifld-tribal') }));

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    for (const t of ['OpenStreetMap contributors', 'EIA — public domain: Form 860', 'Display note: Administrative boundaries only.',
      'Tooling: MapLibre GL JS / Esri World Imagery']) expect(ul.textContent).toContain(t);
  });

  it('skips a malformed entry without dropping the rest', async () => {
    stubFetchOk(manifest({ broken: 'not an object', odd: { source_id: 42 }, good: layer('osm') }));

    await renderDataCredits();

    expect(text('osm')).toContain('data as of 2026-10-09');
  });

  it('leaves the fallback markup intact when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await renderDataCredits();

    expect(text('osm')).toBe('OpenStreetMap contributors');
  });

  it('leaves the fallback markup intact when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));

    await renderDataCredits();

    expect(text('osm')).toBe('OpenStreetMap contributors');
  });

  it('leaves the fallback markup intact when the payload is not valid JSON or has no layers map', async () => {
    for (const json of [async () => { throw new SyntaxError('Unexpected token'); }, async () => ({ layers: [] }), async () => null]) {
      setupDialog();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json })));

      await renderDataCredits();

      expect(document.querySelectorAll('#creditsDialog li[data-source-credit]').length).toBe(2);
      expect(text('osm')).toBe('OpenStreetMap contributors');
    }
  });

  it('never adds an anchor for a source_id that is UNKNOWN, missing, unrecognized or inherited', async () => {
    stubFetchOk(manifest({
      a: layer('UNKNOWN'), b: layer(undefined), c: layer('not-a-real-layer-source'),
      d: layer('__proto__'), e: layer('constructor'),
    }));

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelectorAll('li[data-source-credit]').length).toBe(2);
    for (const id of ['UNKNOWN', 'not-a-real-layer-source', '__proto__', 'constructor']) {
      expect(ul.querySelector(`[data-source-credit="${id}"]`)).toBeNull();
    }
  });

  it('ignores a date that is not YYYY-MM-DD instead of injecting it', async () => {
    stubFetchOk(manifest({ a: layer('osm', '<img src=x onerror=alert(1)>'), b: layer('worldpop', '2026-10-09<script>') }));

    await renderDataCredits();

    const ul = document.querySelector('#creditsDialog ul')!;
    expect(ul.querySelector('img')).toBeNull();
    expect(ul.querySelector('script')).toBeNull();
    expect(text('osm')).toBe('OpenStreetMap contributors');
    expect(text('worldpop')).toBe(LAYER_SOURCES.worldpop.label);
  });

  // Runs the render over the real index.html credits list and the real
  // LAYER_SOURCES registry, with a manifest layer for every anchor it carries:
  // every hand-written entry's text (notes, disclaimers, anchorless entries)
  // must survive, and every anchor the per-layer "source" button
  // (ui-layer-rows.ts -> openSourceCredit() in ui.ts) scrolls to must resolve.
  it('keeps every index.html credit and anchor after a manifest render', async () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const dialogMatch = html.match(/<dialog[^>]*id="creditsDialog"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>\s*<p class="credits-support">/);
    expect(dialogMatch).not.toBeNull();
    const list = document.querySelector('#creditsDialog ul')!;
    list.innerHTML = dialogMatch![1];

    const fallbackTexts = Array.from(list.querySelectorAll(':scope > li'), li => li.textContent!.trim());
    const anchoredSourceIds = Array.from(list.querySelectorAll<HTMLElement>('[data-source-credit]'),
      el => el.dataset.sourceCredit!).filter(id => Object.hasOwn(LAYER_SOURCES, id));
    expect(anchoredSourceIds.length).toBeGreaterThan(0);

    const layers: Record<string, unknown> = {};
    anchoredSourceIds.forEach((sourceId, i) => {
      layers[`layer_${i}`] = { source_id: sourceId, data_as_of: '2026-10-09' };
    });
    stubFetchOk({ generated_utc: '2026-09-19T00:00:00Z', note: 'test manifest', layers });

    await renderDataCredits();

    const hosts = new Set(anchoredSourceIds.map(id => list.querySelector(`[data-source-credit="${id}"]`)!.closest('li')));
    expect((list.textContent!.match(/data as of 2026-10-09/gi) ?? []).length).toBe(hosts.size);
    const after = list.textContent!.replace(/ — data as of 2026-10-09|Data as of 2026-10-09\. /g, '');
    for (const text of fallbackTexts) expect(after).toContain(text);
    expect(after).toContain('ZCTAs approximate ZIP code service areas');
    expect(after).toContain('Esri World Imagery');
    const renderedIds = new Set(
      Array.from(list.querySelectorAll('[data-source-credit]')).map(el => el.getAttribute('data-source-credit')),
    );
    for (const sourceId of anchoredSourceIds) {
      expect(renderedIds.has(sourceId), `missing data-source-credit for "${sourceId}" after manifest render`).toBe(true);
    }
  });
});
