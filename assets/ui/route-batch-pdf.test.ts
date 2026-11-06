// @vitest-environment jsdom
// ─── Route batch PDF tests ───────────────────────────────────────────────────
// Role: the WinAnsi byte measurement behind the core-font branch, glyph coverage generated from the en locale and
//       ROUTE_PRESETS, the PDF's text streams (compress: false, parentheses escaped), zero canvas blocks for
//       app wording, and the canvas path for non-Latin visitor text. Canvas is a recording fake.
// Deps: ./route-batch-pdf.ts, ./route-report-model.ts, ./route-tabs/fixture.ts, ./route-tabs/weights-table.ts,
//       registry/route-presets.ts, i18n/locales/en.ts, jspdf.

import { describe, it, expect, beforeAll } from 'vitest';
import { jsPDF } from 'jspdf';
import baseEn from '../../src/i18n/locales/en.js';
import routeEn from '../../src/i18n/route/en.js';
import { ROUTE_PRESETS } from '../../src/registry/route-presets.js';
import { causeLegend, classLegend, similarLegend, isCoreText, isRtl, makeRenderPdf, pdfGlyphs, type CanvasLike } from './route-batch-pdf.js';
import { buildReportModel, fmtMoney, type RouteReportModel } from './route-report-model.js';
import { FIXTURE_SESSION } from './route-tabs/fixture.js';
import { rowLabel } from './route-tabs/weights-table.js';
import { loadRouteStrings } from '../../src/i18n/index.js';

const en: Record<string, string> = { ...baseEn, ...routeEn };
beforeAll(() => loadRouteStrings());

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR4nGNgQAcAABIAAXfx+gAAAAAASUVORK5CYII=';
const JPEG = Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCOiiivmj7A/9k=', 'base64'));

function fakeCanvas() {
  const seen = { images: 0, texts: [] as string[], rtl: false };
  const make = (): CanvasLike => {
    const ctx = {
      font: '', direction: 'ltr', textAlign: 'left', textBaseline: 'top', fillStyle: '',
      measureText: (s: string) => ({ width: Array.from(s).length * 0.55 * parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? '10') }),
      fillText: (s: string) => { seen.texts.push(s); if (ctx.direction === 'rtl') seen.rtl = true; },
    };
    return { width: 0, height: 0, getContext: () => ctx, toDataURL: () => { seen.images++; return PNG; } };
  };
  return { seen, make };
}

const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');
const count = (s: string, needle: string): number => s.split(needle).length - 1;

function model(over: (m: RouteReportModel) => void = () => {}): RouteReportModel {
  const m = buildReportModel(FIXTURE_SESSION(), fmtMoney, '1/2/2026')!;
  over(m);
  return m;
}

describe('WinAnsi punctuation', () => {
  it('jsPDF standard-font text() writes the eight characters as bytes 96 97 85 91 92 93 94 95', () => {
    const d = new jsPDF({ compress: false });
    d.text('A – — … ‘ ’ “ ” •', 10, 10);
    const s = Buffer.from(d.output('arraybuffer')).toString('hex');
    expect(s).toContain('41' + ['96', '97', '85', '91', '92', '93', '94', '95'].map(b => '20' + b).join('') + '29');
  });

  it('the predicate admits exactly those eight and not the C1 code points', () => {
    expect(isCoreText('– — … ‘ ’ “ ” •')).toBe(true);
    expect(isCoreText('\u0096')).toBe(false);
    expect(isCoreText('−')).toBe(false);
    expect(isCoreText('a→b')).toBe(false);
  });
});

describe('glyph coverage (generated from en.ts and ROUTE_PRESETS)', () => {
  const strings: [string, string][] = [];
  for (const [k, v] of Object.entries(en)) if (k.startsWith('route.') && typeof v === 'string') strings.push([k, v]);
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') return;
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (['note', 'label', 'src', 'notes'].includes(k)) {
          for (const s of Array.isArray(v) ? v : [v]) if (typeof s === 'string') strings.push([`${path}.${k}`, s]);
        } else walk(v, `${path}.${k}`);
      }
    }
  };
  walk(ROUTE_PRESETS, 'ROUTE_PRESETS');

  it('walks a real number of strings', () => {
    expect(strings.length).toBeGreaterThan(500);
  });

  it('every one is core text after pdfGlyphs', () => {
    const bad: string[] = [];
    for (const [k, s] of strings) {
      for (const ch of Array.from(pdfGlyphs(s).normalize('NFC'))) if (!isCoreText(ch)) bad.push(`${k}: U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} ${ch}`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  it('the fixed table maps the symbols it names', () => {
    expect(pdfGlyphs('−1 → ≤ ≥ ≈ ✓ ＋ ⓘ x∈y ∪ Π')).toBe('-1 -> <= >= ~ yes +  x in y  or  product of');
    expect(pdfGlyphs('a b c')).toBe('a b c');
  });
});

describe('renderPdf', () => {
  it('writes a PDF whose streams hold the KPI text and the escaped range wording; no canvas blocks', async () => {
    const c = fakeCanvas();
    const m = model();
    const out = await makeRenderPdf({ canvas: c.make, compress: false })(m, []);
    const s = latin1(out);
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s).toContain(`(${pdfGlyphs(m.cost.kpis[0].value)})`);
    expect(s).toContain('Rough early estimate \\(-30 % / +50 %\\)');
    expect(c.seen.images).toBe(0);
    expect(count(s, '/Subtype /Image')).toBe(0);
  });

  it('every route.report.* key and the real tm-default row labels draw as text (0 canvas blocks)', async () => {
    const c = fakeCanvas();
    const reportKeys = Object.entries(en).filter(([k, v]) => k.startsWith('route.report.') && typeof v === 'string')
      .map(([, v]) => (v as string).replace(/\{\w+\}/g, '1'));
    const labels = ROUTE_PRESETS.find(p => p.id === 'tm-default')!.rows.map(rowLabel);
    expect(reportKeys.length).toBeGreaterThan(30);
    expect(labels.length).toBeGreaterThan(20);
    const m = model(x => { x.method.editsSummary = reportKeys.join(' | '); x.method.edits = [...reportKeys, ...labels]; });
    const out = await makeRenderPdf({ canvas: c.make, compress: false })(m, []);
    expect(c.seen.images).toBe(0);
    expect(count(latin1(out), '/Subtype /Image')).toBe(0);
    expect(count(latin1(out), '/Type /Page\n')).toBeGreaterThan(1);
  });

  const titled = (key: string) => model(m => { m.parts.title = { template: m.parts.title.template, params: { a: key, b: 'B' }, visitor: ['a', 'b'] }; });

  it('a key with Latin-1 letters stays text; the same with CJK and Arabic goes to the canvas', async () => {
    const plain = fakeCanvas();
    const a = await makeRenderPdf({ canvas: plain.make, compress: false })(titled('Ünïcødé'), []);
    expect(plain.seen.images).toBe(0);
    expect(latin1(a)).toContain('Route: Ünïcødé -> B');

    const c = fakeCanvas();
    const key = 'Ünïcødé 東京 القاهرة';
    const b = await makeRenderPdf({ canvas: c.make, compress: false })(titled(key), []);
    expect(c.seen.images).toBeGreaterThan(0);
    expect(count(latin1(b), '/Subtype /Image')).toBeGreaterThan(0);
    expect(c.seen.texts.join('')).toContain(key);
    expect(c.seen.texts.join('')).toContain('\u2192');
    expect(c.seen.rtl).toBe(false);
  });

  it('visitor text is never glyph-mapped: a key with >= and a method with ~ go to the canvas exactly as typed', async () => {
    const c = fakeCanvas();
    const m = model(x => {
      x.parts.title = { template: x.parts.title.template, params: { a: '\u2265 345 kV tie', b: 'B' }, visitor: ['a', 'b'] };
      x.parts.methodPreset = { template: '{label}', params: { label: { template: 'Method {name}', params: { name: 'Cost \u2248 PNAS' }, visitor: ['name'] } } };
    });
    const out = latin1(await makeRenderPdf({ canvas: c.make, compress: false })(m, []));
    expect(c.seen.texts.join('|')).toContain('\u2265 345 kV tie');
    expect(c.seen.texts.join('|')).toContain('Cost \u2248 PNAS');
    expect(out).not.toContain('>= 345');
    expect(out).not.toContain('Cost ~ PNAS');
  });

  it('draws each uploaded layer with its weights; the label is exact visitor text', async () => {
    const c = fakeCanvas();
    const m = model(x => {
      x.method.uploads = [
        { template: 'uploaded layer: {label} \u2014 routing weight {w}, cost \u00d7 {x}', params: { label: 'Alpha Layer', w: '3', x: '1.5' }, visitor: ['label'] },
        { template: 'uploaded layer: {label} \u2014 routing weight {w}, cost \u00d7 {x}', params: { label: 'Beta \u2265 Zone', w: '100', x: '1' }, visitor: ['label'] },
      ];
    });
    const out = latin1(await makeRenderPdf({ canvas: c.make, compress: false })(m, []));
    expect(out).toContain('routing weight 3, cost');
    expect(out).toContain('Alpha Layer');
    expect(c.seen.texts.join('|')).toContain('Beta \u2265 Zone');
    expect(out).not.toContain('Beta >= Zone');
  });

  it('the app\u2019s own arrow in the title template becomes -> text for an ASCII key', async () => {
    const c = fakeCanvas();
    const out = latin1(await makeRenderPdf({ canvas: c.make, compress: false })(titled('North'), []));
    expect(out).toContain('Route: North -> B');
    expect(c.seen.images).toBe(0);
  });

  it('base direction is the first strong letter: English title with an Arabic key stays ltr; Arabic first is rtl', async () => {
    expect(isRtl('Route: \u0627\u0644\u0642\u0627\u0647\u0631\u0629 \u2192 B')).toBe(false);
    expect(isRtl('1) \u0627\u0644\u0642\u0627\u0647\u0631\u0629 to B')).toBe(true);
    expect(isRtl('\u05e9\u05dc\u05d5\u05dd')).toBe(true);
    expect(isRtl('123')).toBe(false);
    const c = fakeCanvas();
    await makeRenderPdf({ canvas: c.make, compress: false })(titled('\u0627\u0644\u0642\u0627\u0647\u0631\u0629'), []);
    expect(c.seen.images).toBeGreaterThan(0);
    expect(c.seen.rtl).toBe(false);
  });

  it('pictures: a JPEG becomes an image object, a note becomes text, no pictures shows the unavailable line', async () => {
    const c = fakeCanvas();
    const out = latin1(await makeRenderPdf({ canvas: c.make, compress: false })(model(), [
      { picture: 'route', jpeg: JPEG }, { picture: 'cause', note: 'not available (area too large)' },
    ]));
    expect(count(out, '/Filter /DCTDecode')).toBe(1);
    expect(out).toContain('(not available \\(area too large\\))');
    expect(c.seen.images).toBe(0);
    const none = latin1(await makeRenderPdf({ canvas: c.make, compress: false })(model(), []));
    expect(none).toContain(model().snapshot.unavailable.slice(0, 20));
  });

  it('a caption and a colour legend are drawn with the picture; none without them', async () => {
    const c = fakeCanvas();
    const legend = causeLegend({ cause: { barrier: false, present: [{ key: 'upload', colour: '#22d3ee', labelKey: 'route.cat.wildfire', share: 0.6 }, { key: 'other', colour: '#8b919c', labelKey: 'route.wf.other', share: 0.4 }] } });
    expect(legend).toEqual([{ colour: '#22d3ee', label: expect.any(String) }, { colour: '#8b919c', label: expect.any(String) }]);
    expect(legend[1].label).not.toBe('route.wf.other');
    const out = latin1(await makeRenderPdf({ canvas: c.make, compress: false })(model(), [
      { picture: 'cause', jpeg: JPEG, caption: 'CAPTION-ONE', legend },
      { picture: 'route', jpeg: JPEG },
    ]));
    expect(out).toContain('(CAPTION-ONE)');
    expect(out).toContain(`(${legend[0].label})`);
    expect(out).toContain(`(${legend[1].label})`);
    expect(out).toMatch(/0\.13 0\.83 0\.93 rg/);
    expect(count(out, '(CAPTION-ONE)')).toBe(1);
  });

  it('the cost and weight class legends follow the overlay breaks, with the barrier class last', () => {
    expect(classLegend('cost').map((l) => l.label)).toEqual(['\u00d71\u20131.5', '\u00d71.5\u20132', '\u00d72\u20133', '\u00d73+', en['route.insp.legend.blocked']]);
    expect(classLegend('route')).toHaveLength(8);
    expect(classLegend('cost')[0].colour).toBe('#c7e9c0');
    expect(similarLegend([0.02, 0.05])).toEqual([{ colour: '#08519c', label: '\u2264 2 %' }, { colour: '#3182bd', label: '\u2264 5 %' }]);
  });

  it('keeps each caption and legend on its picture\'s page', async () => {
    const legend = Array.from({ length: 10 }, (_, i) => ({ colour: '#22d3ee', label: `LEG-${i}` }));
    const pics = [1, 2, 3].map((n) => ({ picture: 'cause' as const, jpeg: JPEG, caption: `CAP-${n}`, legend: legend.map((l) => ({ ...l, label: `${l.label}-${n}` })) }));
    const out = latin1(await makeRenderPdf({ canvas: fakeCanvas().make, compress: false })(model(), pics));
    // page content streams in order: the one holding a caption also holds its image and its whole legend
    const pages = out.split('endstream').filter((x) => x.includes(' Tf'));
    expect(pages.length).toBeGreaterThan(1);
    for (const n of [1, 2, 3]) {
      const page = pages.find((x) => x.includes(`(CAP-${n})`))!;
      expect(page, `CAP-${n}`).toBeDefined();
      expect(page).toContain(`(LEG-0-${n})`);
      expect(page).toContain(`(LEG-9-${n})`);
      const at = page.indexOf(`(CAP-${n})`);
      expect(page.slice(at, page.indexOf(`(LEG-0-${n})`))).toMatch(/ Do\b/);
    }
  });

  it('prints the aviation note under the crossings table', async () => {
    const c = fakeCanvas();
    const out = latin1(await makeRenderPdf({ canvas: c.make, compress: false })(model(), []));
    expect(out).toContain('This method screens structures at 61 m');
  });

  it('renders the observations tables from raw data', async () => {
    const c = fakeCanvas();
    const m = model(x => {
      x.observations = { screening: {
        buildings: { status: 'unavailable', reason: 'no cache' },
        aviation: { status: 'unavailable', reason: 'no cycle' },
      } as never };
    });
    const out = latin1(await makeRenderPdf({ canvas: c.make, compress: false })(m, []));
    expect(out).toContain('no cache');
    expect(out).toContain('no cycle');
  });

  it('renders the ok observations: class rows, runway metres and the aviation limit', async () => {
    const prov = { source: 'src', sha256: 'x', credit: 'Credit Co', fetchedAt: '2026-01-02', license: 'CC-BY' };
    const zero = { all: 0, residential: 0, nonresidential: 0, unknown: 0 };
    const m = model(x => {
      x.observations = { screening: {
        buildings: { status: 'ok', observedM: 100, totalM: 200, counts: { ...zero, all: 7, residential: 3 }, metres: { ...zero, all: 123.456, residential: 40 }, imageryYears: [2021], provenance: prov },
        aviation: { status: 'ok', scope: 'SCOPE-TEXT', cycle: '2026-03', facilities: [{ id: 'KRNO', name: 'Reno Tahoe', type: 'A', use: 'PU', operationalStatus: 'O', distanceM: 4321.09, runwayCoverage: 'all' }],
          runways: [{ airport: 'KRNO', runway: '16R/34L', centrelineM: 1234.56, endM: 2345.67, airportPointM: 3456.78, surveyDates: ['2020-01-01', null] }], provenance: prov },
      } as never };
    });
    const out = latin1(await makeRenderPdf({ canvas: fakeCanvas().make, compress: false })(m, []));
    expect(out).toContain('(123.5)');
    expect(out).toContain('(KRNO 16R/34L)');
    expect(out).toContain('(1234.6)');
    expect(out).toContain('(KRNO Reno Tahoe)');
    expect(out).toContain('(4321.1)');
    expect(out).toContain('SCOPE-TEXT');
    expect(out).toContain(en['route.obs.aviationLimit'].replace(/[()\\]/g, '\\$&').slice(0, 30));
  });

  it('compressed output is a PDF too', async () => {
    const out = await makeRenderPdf({ canvas: fakeCanvas().make })(model(), []);
    expect(latin1(out.slice(0, 5))).toBe('%PDF-');
  });
});
