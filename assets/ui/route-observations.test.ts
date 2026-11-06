// @vitest-environment jsdom
// Role: observations preserve partial scope, source dates and inert display/export text.
// Deps: route-observations.ts, route-observations.fixture.ts, route-tabs/crossings.ts.
import { describe, expect, it, beforeAll } from 'vitest';
import { routeObservations, observationCsvRows, source, aviationNote, aviationMiles } from './route-observations.js';
import baseEn from '../../src/i18n/locales/en.js';
import routeEn from '../../src/i18n/route/en.js';
import { observationFixture } from './route-observations.fixture.js';
import { crossingsCsv, pathKey, shownExact } from './route-tabs/crossings.js';
import { FIXTURE_SESSION } from './route-tabs/fixture.js';
import { loadRouteStrings } from '../../src/i18n/index.js';

const en: Record<string, string> = { ...baseEn, ...routeEn };
beforeAll(() => loadRouteStrings());

describe('building and aviation observations', () => {
  it('keeps partial queried coverage, unknown class, dates and omitted runway inventories visible', () => {
    const box = routeObservations(observationFixture());
    expect(box.textContent).toContain('600.0 of 1000.0');
    expect(box.textContent).toContain('Unknown class');
    expect(box.textContent).toContain('2014, 2024');
    expect(box.textContent).toContain('2026/10/01');
    expect(box.textContent).toContain('2014/10/08');
    expect(box.textContent).toContain('Not read');
    expect(box.textContent).toContain('<img src=x');
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelectorAll('table')).toHaveLength(3);
    expect(box.textContent).toContain('Example source');
  });
  it('distinguishes missing and unavailable observations from a queried zero', () => {
    expect(routeObservations().textContent).toContain('have not been read');
    const obs = observationFixture();
    obs.buildings = { status: 'unavailable', reason: 'outside regional query' };
    expect(routeObservations(obs).textContent).toContain('outside regional query');
    expect(routeObservations(obs).querySelectorAll('table')).toHaveLength(2);
    const zero = observationFixture();
    if (zero.buildings.status === 'ok') {
      zero.buildings.counts = { all: 0, residential: 0, nonresidential: 0, unknown: 0 };
      zero.buildings.metres = { all: 0, residential: 0, nonresidential: 0, unknown: 0 };
    }
    expect(routeObservations(zero).querySelectorAll('table')).toHaveLength(3);
    expect(routeObservations(zero).textContent).toContain('do not establish');
  });
  it('formula-guards exported source text and shares the displayed distance values', () => {
    const obs = observationFixture();
    if (obs.buildings.status === 'ok') obs.buildings.provenance.credit = '=SUM(1,2)';
    const s = FIXTURE_SESSION();
    const csv = crossingsCsv(s.result!.profile!.crossings, { result: { counts: { road: 0, river: 0, rail: 0, pipeline: 0, line230: 0, line100: 0 }, points: [], dupDropped: 0 }, exact: [], failed: [], screening: obs });
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('RNO 08/26,50.0,75.0,200.0');
    expect(csv).toContain('600.0 of 1000.0');
    expect(observationCsvRows(obs).flat().join(' ')).toContain('2014/10/08');
  });
  it('binds observations to every interior vertex, even with identical ends and length', () => {
    const s = FIXTURE_SESSION();
    const a: GeoJSON.LineString = { type: 'LineString', coordinates: [[-120, 40], [-119, 41], [-118, 40]] };
    const b: GeoJSON.LineString = { type: 'LineString', coordinates: [[-120, 40], [-119, 39], [-118, 40]] };
    expect(pathKey(a, 100)).not.toBe(pathKey(b, 100));
    s.result = { ...s.result!, path: a, lengthMi: 100 };
    s.exact = { routes: [{ points: [], counts: s.result.profile!.crossings.counts, dupDropped: 0 }], exact: [], status: {} as never, forPath: pathKey(a, 100), screening: [observationFixture()] };
    expect(shownExact(s)?.screening).toBeDefined();
    s.result = { ...s.result, path: b };
    expect(shownExact(s)).toBeNull();
  });
  it('words the national scope: no pilot-area text, pieces note, FAA decision line', () => {
    const box = routeObservations(observationFixture());
    expect(box.textContent).not.toMatch(/Reno|Sparks|pilot|serving/i);
    expect(box.textContent).toContain('footprint pieces');
    expect(box.textContent).toContain('notice zone (14 CFR 77.9)');
    expect(box.textContent).toContain('FAA Form 7460-1 / OE/AAA decides');
    expect(observationCsvRows(observationFixture()).flat().join(' ')).toContain('footprint pieces');
  });
  it('words the one aviation note: height in m with ft rounded from m, or no class weighed; none without aviation miles', () => {
    const miles = FIXTURE_SESSION().result!.profile!.crossings.miles;
    const note = (m: number | null, mi = miles) => aviationNote({ miles: mi, aviationHeightM: m });
    expect(note(61)).toBe("This method screens structures at 61 m (200 ft): classes below that height exceed an obstruction standard (screening).");
    expect(note(46)).toContain('46 m (151 ft)');
    expect(note(30)).toContain('30 m (98 ft)');
    expect(note(null)).toBe('This method weighs no Part 77 class.');
    expect(note(61, { ...miles, aviation: {} })).toBeNull();
    expect(aviationMiles({ miles: { ...miles, aviation: { 2: 0, 3: 1.5, 6: 0 } } })).toEqual([{ code: 3, miles: 1.5 }]);
  });
  it('says "exceeds an obstruction standard" only in the screening limit of the observations', () => {
    expect(Object.entries(en).filter(([, v]) => /exceeds an obstruction standard/i.test(v)).map(([k]) => k)).toEqual(['route.obs.aviationLimit']);
  });
  it('keeps the English aviation text free of conclusive words', () => {
    const keys = Object.keys(en).filter((k) => /^route\.obs\.(aviation|inventory|av\.|runways|facilit|runway|cycle|surveys)/.test(k));
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect(en[k as keyof typeof en], k).not.toMatch(/hazard|clearance|approved|safe|compliant/i);
  });
  it('shows an unavailable reason by key, falling back to its text, and a literal unknown fetch date as words', () => {
    const obs = observationFixture();
    obs.buildings = { status: 'unavailable', reason: 'engine text', reasonKey: 'route.obs.overBudget' };
    obs.aviation = { status: 'unavailable', reason: 'plain text reason' };
    const txt = routeObservations(obs).textContent;
    expect(txt).toContain(`Not available: ${en['route.obs.overBudget']}`);
    expect(txt).not.toContain('engine text');
    expect(txt).toContain('Not available: plain text reason');
    expect(source({ credit: 'C', fetchedAt: 'unknown', license: 'L' })).toBe('C · Fetch date unknown · L');
    expect(source({ credit: 'C', fetchedAt: '2026-10-31', license: 'L' })).toContain('Fetched 2026-10-31');
  });
});
