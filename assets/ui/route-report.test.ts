// @vitest-environment jsdom
// ─── Route report tests ──────────────────────────────────────────────────────
// Role: every report part is present, the body class brackets print, the camera is restored,
//       a tainted canvas shows the placeholder, and our own wording avoids banned words.
//       English comes from src/i18n/route/en.ts and locales/en.ts (the shipped text).
// Deps: ./route-report.ts, ./route-tabs/fixture.ts, state.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../src/i18n/route/en.js')).default,
  };
  return { t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

import routeEn from '../../src/i18n/route/en.js';
import { openRouteReport } from './route-report.js';
import { FIXTURE_SESSION, fakeTabContext } from './route-tabs/fixture.js';
import { observationFixture } from './route-observations.fixture.js';
import { pathKey } from './route-tabs/crossings.js';
import { state } from '../state.js';
import { createCustomPresetStore } from '../route/custom-presets.js';

let calls: string[];
function stubMap(toDataURL: () => string, layers: Record<string, number> = {}) {
  const map = {
    opacity: { ...layers } as Record<string, unknown>,
    atSnap: {} as Record<string, unknown>,
    getLayer: (id: string) => (id in layers ? { id } : undefined),
    getPaintProperty: (id: string, k: string) => (k === 'raster-opacity' ? map.opacity[id] : undefined),
    setPaintProperty: (id: string, k: string, v: unknown) => { if (k === 'raster-opacity') map.opacity[id] = v; },
    getCanvas: () => ({ toDataURL: () => { map.atSnap = { ...map.opacity }; return toDataURL(); } }),
    once: vi.fn((_e: string, cb: () => void) => cb()),
    triggerRepaint: vi.fn(),
    fitBounds: vi.fn(() => calls.push('fit')),
    getCenter: () => ({ lng: 1, lat: 2 }), getZoom: () => 7, getBearing: () => 10, getPitch: () => 20,
    jumpTo: vi.fn(() => calls.push('jump')),
  };
  (state as unknown as { map: unknown }).map = map;
  return map;
}

let atPrint: { cls: boolean; section: boolean } | null;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  document.body.className = '';
  calls = [];
  atPrint = null;
  window.print = vi.fn(() => { atPrint = { cls: document.body.classList.contains('printing-route-report'), section: !!document.getElementById('route-report') }; });
});

describe('openRouteReport', () => {
  it('prints observations for the shown full path with the same source and coverage notes', () => {
    stubMap(() => 'data:image/png;base64,AAA');
    const s = FIXTURE_SESSION(), r = s.result!;
    s.exact = { routes: [{ points: [], counts: r.profile!.crossings.counts, dupDropped: 0 }], status: {} as never, exact: [],
      forPath: pathKey(r.path, r.lengthMi), screening: [observationFixture()] };
    openRouteReport(fakeTabContext(s));
    const obs = document.querySelector('.route-observations');
    expect(obs?.textContent).toContain('600.0 of 1000.0');
    expect(obs?.textContent).toContain('RNO 08/26');
    expect(obs?.textContent).toContain('2014/10/08');
    expect(obs?.textContent).toContain('Example source');
    expect(obs?.querySelector('img')).toBeNull();
    expect(window.print).toHaveBeenCalledOnce();
  });
  it('builds every part', () => {
    stubMap(() => 'data:image/png;base64,AAA');
    const ctx = fakeTabContext(FIXTURE_SESSION());
    openRouteReport(ctx);
    const r = document.getElementById('route-report')!;
    const text = r.textContent!;
    expect(r.querySelector('h1')!.textContent).toMatch(/^Route: .* → /);
    expect(r.querySelector('.rp-badge')).toBeTruthy();
    expect(r.querySelector<HTMLImageElement>('img.rr-snap')!.src).toContain('data:image/png');
    expect(r.querySelector('.rp-kpis')).toBeTruthy();
    expect(r.querySelector('.rp-range')).toBeTruthy();
    expect(r.querySelector('.rp-wf')).toBeTruthy();
    expect(r.querySelector('svg.rr-strip')).toBeTruthy();
    expect(r.querySelectorAll('table tr').length).toBe(21);   // + the park and NWI wetland mile rows and the five aviation code rows
    expect(r.querySelector('.rp-tribal')).toBeTruthy();
    expect(text).toContain('AACE International Class 5 (concept screening)');
    expect(text).toContain(ctx.session.result!.preset.attribution);
    expect(text).toContain(ctx.session.result!.preset.caveat);
    for (const s of ['NLCD', '3DEP', 'PAD-US', 'USFWS', 'BLM', 'OpenStreetMap (ODbL)', 'HIFLD', 'WorldPop (CC BY', 'PoPWest (CC BY', '© OpenStreetMap contributors']) expect(text).toContain(s);
    expect(text).toContain('cheapest path found inside the search area');
  });

  it('replaces a previous report', () => {
    stubMap(() => 'data:,');
    const ctx = fakeTabContext(FIXTURE_SESSION());
    openRouteReport(ctx);
    openRouteReport(ctx);
    expect(document.querySelectorAll('#route-report')).toHaveLength(1);
  });

  it('sets the body class before print and clears it, and the section, on afterprint', () => {
    stubMap(() => 'data:,');
    openRouteReport(fakeTabContext(FIXTURE_SESSION()));
    expect(atPrint).toEqual({ cls: true, section: true });
    expect(document.body.classList.contains('printing-route-report')).toBe(true);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.body.classList.contains('printing-route-report')).toBe(false);
    expect(document.getElementById('route-report')).toBeNull();
  });

  it('refits without drawer padding and restores the camera', () => {
    const map = stubMap(() => 'data:,');
    openRouteReport(fakeTabContext(FIXTURE_SESSION()));
    expect(map.fitBounds).toHaveBeenCalledOnce();
    const opts = (map.fitBounds.mock.calls[0] as unknown as [unknown, { padding: unknown; duration: number }])[1];
    expect(opts.padding).toBe(24);
    expect(opts.duration).toBe(0);
    expect(map.jumpTo).toHaveBeenCalledWith({ center: { lng: 1, lat: 2 }, zoom: 7, bearing: 10, pitch: 20 });
    expect(calls).toEqual(['fit', 'jump']);
  });

  it('takes the snapshot with the cell weights and similar-cost areas hidden, then restores them', () => {
    const map = stubMap(() => 'data:,', { 'rp-weight': 0.8, 'rp-surface': 0.7 });
    openRouteReport(fakeTabContext(FIXTURE_SESSION()));
    expect(map.atSnap).toEqual({ 'rp-weight': 0, 'rp-surface': 0 });
    expect(map.opacity).toEqual({ 'rp-weight': 0.8, 'rp-surface': 0.7 });
  });

  it('shows a placeholder when the canvas is tainted, and still restores the camera', () => {
    const map = stubMap(() => { throw new Error('tainted'); });
    openRouteReport(fakeTabContext(FIXTURE_SESSION()));
    const r = document.getElementById('route-report')!;
    expect(r.querySelector<HTMLElement>('.rr-snap-na')!.hidden).toBe(false);
    expect(r.textContent).toContain('Map snapshot unavailable');
    expect(r.querySelector<HTMLElement>('img.rr-snap')!.hidden).toBe(true);
    expect(map.jumpTo).toHaveBeenCalled();
    expect(window.print).toHaveBeenCalled();
  });

  it('omits the strip and crossings without a profile', () => {
    stubMap(() => 'data:,');
    const s = FIXTURE_SESSION();
    s.result = { ...s.result!, profile: null };
    openRouteReport(fakeTabContext(s));
    const r = document.getElementById('route-report')!;
    expect(r.querySelector('svg.rr-strip')).toBeNull();
    expect(r.querySelector('table')).toBeNull();
  });

  it('keeps data out of the markup', () => {
    stubMap(() => 'data:,');
    const s = FIXTURE_SESSION();
    s.resultInputs!.a = { lngLat: [-119.3, 45.93], hit: { name: '<img src=x onerror=alert(1)>', maxKv: 500 } as never };
    openRouteReport(fakeTabContext(s));
    const r = document.getElementById('route-report')!;
    expect(r.querySelector('img[src="x"]')).toBeNull();
    expect(r.querySelector('h1')!.textContent).toContain('<img src=x');
  });

  it('names the solved ends (resultInputs), not ends picked since', () => {
    stubMap(() => 'data:,');
    const s = FIXTURE_SESSION();
    s.resultInputs!.a = { lngLat: [-119.3, 45.93], hit: { name: 'Solved A', maxKv: 500 } as never };
    s.inputs.a = { lngLat: [-100, 40], hit: { name: 'Picked later', maxKv: 230 } as never };
    openRouteReport(fakeTabContext(s));
    const text = document.getElementById('route-report')!.textContent!;
    expect(text).toContain('Solved A');
    expect(text).not.toContain('Picked later');
  });

  it('a custom method reads "{name} (based on {base})" and lists the session edits row by row', () => {
    stubMap(() => 'data:,');
    const saved = createCustomPresetStore(localStorage).save('Steep', 'tm-default', { rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', cost_x: 2 }] });
    if (!saved.ok) throw new Error(saved.reason);
    const s = FIXTURE_SESSION();
    s.resultInputs = { ...s.resultInputs!, presetId: `custom:${saved.result.id}`, patch: {
      rows: [{ row: 9, band: 'slope', note: 'mountain, ≥ 4°', cost_x: 3 }, { row: 15, band: 'protect', note: 'GAP 2', route_w: 25 }],
      contingency: 0.2,
    } };
    openRouteReport(fakeTabContext(s));
    const r = document.getElementById('route-report')!;
    const base = s.result!.preset.label;
    expect(r.querySelector('.rr-sub')!.textContent).toContain(`Steep (based on ${base})`);
    expect(r.textContent).toContain(`Costing method: Steep (based on ${base}).`);
    expect(r.textContent).toContain('3 edits for this route:');
    expect([...r.querySelectorAll('.rr-edits li')].map((li) => li.textContent)).toEqual([
      'Slope — mountain, ≥ 4°: cost ×2→3',
      'Protected areas — GAP 2: routing ×10→25',
      'Contingency: 30 % → 20 %',
    ]);
    localStorage.clear();
  });

  it('lists each uploaded layer of the method with its weights', () => {
    stubMap(() => 'data:,');
    const s = FIXTURE_SESSION();
    s.resultInputs = { ...s.resultInputs!, patch: { add_rows: [
      { layer: 'a'.repeat(16), label: 'Alpha Layer', route_w: 3, cost_x: 1.5 },
      { layer: 'b'.repeat(16), label: 'Beta \u2265 Zone', route_w: 100, cost_x: 1, barrier: true },
    ] } };
    openRouteReport(fakeTabContext(s));
    const items = [...document.getElementById('route-report')!.querySelectorAll('.rr-edits li')].map((li) => li.textContent);
    expect(items).toEqual([
      'uploaded layer: Alpha Layer \u2014 routing weight 3, cost \u00d7 1.5',
      'uploaded layer: Beta \u2265 Zone \u2014 routing weight 100, cost \u00d7 1, barrier',
    ]);
  });

  it('scopes Letter page size to the report (a named @page)', () => {
    const css = readFileSync('assets/ui/route-report.css', 'utf8');
    expect(css).not.toMatch(/@page\s*\{/);
    expect(css).toMatch(/@page route-report \{/);
    expect(css).toMatch(/#route-report \{ display: block; page: route-report; \}/);
  });

  it('uses no banned words in its own text', () => {
    const own = Object.entries(routeEn).filter(([k]) => k.startsWith('route.report.'));
    expect(own.length).toBeGreaterThan(0);
    for (const [, v] of own) expect(v).not.toMatch(/corridor|exploratory/i);
  });
});
