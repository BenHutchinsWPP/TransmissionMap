// @vitest-environment jsdom
// Tests for the Crossings sub-tab: counts and miles from the fixture, zero rows hidden,
// row click fits that kind's points, the "Show on map" toggles, the CSV text and wording.
// Exact crossings (session.exact): counts, notes, the names list and the CSV point lines.
// English comes from src/i18n/route/en.ts and locales/en.ts (the shipped text).
// Deps: crossings.ts, fixture.ts.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/i18n/index.js', async () => {
  const en: Record<string, string> = {
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/locales/en.js')).default,
    ...(await vi.importActual<{ default: Record<string, string> }>('../../../src/i18n/route/en.js')).default,
  };
  return { t: (k: string, p?: Record<string, string | number>) => (en[k] ?? k).replace(/\{(\w+)\}/g, (m, n) => (p && n in p ? String(p[n]) : m)) };
});

import tab, { crossingsCsv, crossingRows, pathKey, shownExact } from './crossings.js';
import { FIXTURE_SESSION, fakeTabContext } from './fixture.js';
import type { CrossingPoint } from '../../route/profile.js';
import type { RouteSession } from './types.js';

function render(mut?: (c: NonNullable<NonNullable<ReturnType<typeof FIXTURE_SESSION>['result']>['profile']>['crossings']) => void) {
  const s = FIXTURE_SESSION();
  if (mut) mut(s.result!.profile!.crossings);
  const ctx = fakeTabContext(s);
  const el = document.createElement('div');
  document.body.append(el);
  tab.render(el, ctx);
  return { el, ctx, c: s.result!.profile!.crossings };
}
const row = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-row="${id}"]`);

describe('Crossings tab', () => {
  it('renders counts and miles from the fixture', () => {
    const { el } = render();
    expect(row(el, 'river')!.textContent).toContain('Rivers');
    expect(row(el, 'river')!.children[1].textContent).toBe('≈6');
    expect(row(el, 'river')!.children[2].textContent).toBe('—');
    expect(row(el, 'follows')!.children[2].textContent).toBe('38.2');
    expect(row(el, 'follows')!.children[1].textContent).toBe('—');
    expect(row(el, 'agency-2')!.textContent).toContain('BLM');
    expect(row(el, 'agency-1')!.textContent).toContain('Private / not in PAD-US');
    expect(row(el, 'desig-4')!.textContent).toContain('Wild & Scenic River corridor');
    expect(el.querySelectorAll('.rp-pill').length).toBeGreaterThan(3);
    expect(el.textContent).toContain('approximate');
  });

  it('hides zero rows except tribal land', () => {
    const { el } = render((c) => { c.counts.rail = 0; c.miles.phma = 0; c.miles.tribal = 0; c.miles.byAgency = {}; c.miles.desig = {}; });
    expect(row(el, 'rail')).toBeNull();
    expect(row(el, 'phma')).toBeNull();
    expect(row(el, 'agency-2')).toBeNull();
    expect(row(el, 'tribal')!.children[2].textContent).toBe('0.0');
  });

  it('a row click fits that kind and highlights the row; Enter works too', () => {
    const { el, ctx, c } = render();
    row(el, 'pipeline')!.click();
    const pts = c.points.filter((p) => p.kind === 'pipeline').map((p) => p.lngLat);
    expect(pts.length).toBe(5);
    expect(ctx.calls).toEqual([`fitPoints(${JSON.stringify(pts)})`]);
    expect(row(el, 'pipeline')!.classList.contains('rx-row--on')).toBe(true);
    row(el, 'river')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(ctx.calls.length).toBe(2);
    expect(row(el, 'pipeline')!.classList.contains('rx-row--on')).toBe(false);
    row(el, 'follows')!.click();
    expect(ctx.calls.length).toBe(2);
  });

  it('toggles call showCrossings with defaults river and road/rail on', () => {
    const { el, ctx } = render();
    const boxes = [...el.querySelectorAll<HTMLInputElement>('.rx-show input')];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false, false]);
    boxes[2].click();
    boxes[1].click();
    expect(ctx.calls).toEqual(['showCrossings(["pipeline"],true)', 'showCrossings(["road","rail"],false)']);
  });

  it('writes the CSV with a header, quoting, and empty cells for n/a', () => {
    const { c } = render();
    const lines = crossingsCsv(c).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Feature,Crossings,Miles,Note');
    expect(lines).toContain('Rivers,6,,');
    expect(lines).toContain('Follows existing ≥ 230 kV line,,38.2,Runs along the line for 2 km or more');
    expect(lines.some((l) => l.startsWith('"Major roads (motorway/trunk/primary)"') || l.startsWith('Major roads'))).toBe(true);
    c.miles.tribal = 1;
    const tribal = crossingsCsv(c).split('\r\n').find((l) => l.startsWith('Tribal land'))!;
    expect(tribal).toBe('Tribal land,,1.0,"Tribal land is a planning flag, not a permit finding"');
  });

  it('CSV carries the aviation rows with miles and, after the rows, the one aviation note', () => {
    const { c } = render();
    const lines = crossingsCsv(c).split('\r\n');
    const i = lines.findIndex((l) => l.startsWith('"Aviation: notice zone (14 CFR 77.9), no lower Part 77 surface"'));
    expect(lines.slice(i, i + 5).map((l) => l.split(',').length > 2)).toEqual([true, true, true, true, true]);
    expect(lines[i + 1]).toContain('1.1');
    expect(lines.filter((l) => l.startsWith('This method screens structures at 61 m (200 ft)'))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('Assumed structure height'))).toBe(false);
    c.aviationHeightM = null;
    expect(crossingsCsv(c)).toContain('This method weighs no Part 77 class.');
    c.aviationHeightM = 61;   // the fixture's crossings are shared between tests
  });

  it('aviation rows follow the zero-row rule: none, and no note, when no aviation miles', () => {
    const { c, el } = render();
    expect(el.querySelector('.rx-av-note')?.textContent).toContain('61 m (200 ft)');
    c.miles.aviation = { 3: 0.5 };
    expect(crossingRows(c).filter((r) => r.id.startsWith('av')).map((r) => r.id)).toEqual(['av3']);
    const kept = c.miles.aviation;
    c.miles.aviation = {};
    expect(crossingRows(c).filter((r) => r.id.startsWith('av'))).toHaveLength(0);
    const csv = crossingsCsv(c);
    expect(csv).not.toContain('Aviation:');
    expect(csv).not.toContain('Part 77');
    expect(render((x) => { x.miles.aviation = {}; }).el.querySelector('.rx-av-note')).toBeNull();
    c.miles.aviation = kept;
  });

  it('escapes quotes and commas', () => {
    const { c } = render();
    const csv = crossingsCsv(c);
    expect(csv).toContain('"Tribal land is a planning flag, not a permit finding"');
    expect(crossingRows(c).length).toBeGreaterThan(10);
  });

  it('uses no forbidden wording', () => {
    const { el } = render();
    const text = el.textContent!.toLowerCase();
    expect(text).not.toContain('exploratory');
    const stripped = text.replace(/section 368 corridor|wild & scenic river corridor|national historic\/scenic trail corridor/g, '');
    expect(stripped).not.toContain('corridor');
  });

  it('is disabled without a profile', () => {
    const s = FIXTURE_SESSION();
    expect(tab.disabled(s)).toBeNull();
    s.result = { ...s.result!, profile: undefined };
    expect(tab.disabled(s)).not.toBeNull();
  });

  it('checkboxes start from session.crossingKinds and leaving the tab keeps the markers', () => {
    const s = FIXTURE_SESSION();
    s.crossingKinds = ['pipeline', 'river'];
    const ctx = fakeTabContext(s);
    const el = document.createElement('div');
    document.body.append(el);
    tab.render(el, ctx);
    expect([...el.querySelectorAll<HTMLInputElement>('.rx-show input')].map((b) => b.checked)).toEqual([true, false, true, false]);
    el.querySelectorAll<HTMLInputElement>('.rx-show input')[3].click();
    expect(s.crossingKinds).toEqual(['pipeline', 'river', 'line230', 'line100']);
    tab.dispose?.();
    expect(ctx.calls).toEqual(['showCrossings(["line230","line100"],true)']);
    const el2 = document.createElement('div');
    tab.render(el2, ctx);
    expect(el2.querySelectorAll<HTMLInputElement>('.rx-show input')[3].checked).toBe(true);
  });
});

describe('exact crossings', () => {
  const pt = (kind: CrossingPoint['kind'], mi: number, name?: string, detail?: string): CrossingPoint =>
    ({ kind, mi, lngLat: [-107.8 + mi / 100, 40.4], ...(name ? { name } : {}), ...(detail ? { detail } : {}) });
  const points = [pt('road', 3.25, '=HYPERLINK("http://x","y")', 'motorway'), pt('river', 1.5, 'Cube Creek'), pt('road', 0.4), pt('line230', 2, undefined, '345 kV')];
  const counts = { river: 1, road: 2, rail: 0, pipeline: 0, line230: 1, line100: 0 };
  const ok = { ok: true, bytes: 1, groups: 1, rowsDecoded: 1, rowsKept: 1, ms: 1 };
  function withExact(s: RouteSession, exact: CrossingPoint['kind'][] = ['river', 'road', 'rail', 'line230', 'line100'],
    status = { road: ok, river: ok, rail: ok, pipeline: { ...ok, ok: false, note: 'pipelines_osm.parquet: HTTP 404' }, line: ok }): RouteSession {
    s.exact = { forPath: pathKey(s.result!.path, s.result!.lengthMi), routes: [{ points, counts, dupDropped: 0 }], status, exact };
    return s;
  }
  const view = (s: RouteSession) => shownExact(s)!;

  it('shownExact only for the shown path', () => {
    const s = withExact(FIXTURE_SESSION());
    expect(view(s).exact).toContain('road');
    expect(view(s).failed).toEqual([{ family: 'pipeline', note: 'pipelines_osm.parquet: HTTP 404' }]);
    s.exact!.forPath = 'other';
    expect(shownExact(s)).toBeNull();
    expect(shownExact({ ...s, exact: null })).toBeNull();
  });

  it('crossingRows takes exact counts and notes for exact kinds only', () => {
    const s = withExact(FIXTURE_SESSION());
    const c = s.result!.profile!.crossings, rows = crossingRows(c, view(s));
    const r = (id: string) => rows.find((x) => x.id === id);
    expect(r('river')).toMatchObject({ count: 1, note: 'exact' });
    expect(r('road')).toMatchObject({ count: 2, note: 'exact' });
    expect(r('pipeline')).toMatchObject({ count: c.counts.pipeline, note: 'approximate (250 m cells)' });
    expect(r('follows')!.note).toContain('not counted');
    if (c.counts.rail > 0) expect(r('rail')).toMatchObject({ count: 0, note: 'exact' });
    // without exact data the rows are as before
    expect(crossingRows(c).find((x) => x.id === 'river')).toMatchObject({ count: c.counts.river, note: '' });
    // the line family not read: the follows note makes no claim about line crossings
    const noLines = withExact(FIXTURE_SESSION(), ['river', 'road', 'rail']);
    expect(crossingRows(c, view(noLines)).find((x) => x.id === 'follows')!.note).not.toContain('not counted');
  });

  it('crossingsCsv adds formula-guarded point lines by mile and the source line', () => {
    const s = withExact(FIXTURE_SESSION());
    const lines = crossingsCsv(s.result!.profile!.crossings, view(s)).trimEnd().split('\r\n');
    const at = lines.indexOf('Kind,Name,Detail,Mile,Longitude,Latitude');
    expect(at).toBeGreaterThan(1);
    expect(lines[at - 1]).toBe('');
    expect(lines.slice(at + 1, at + 5)).toEqual([
      'Major roads (motorway/trunk/primary),,,0.4,-107.796,40.4',
      'Rivers,Cube Creek,,1.5,-107.785,40.4',
      'Existing lines ≥ 230 kV,,345 kV,2,-107.78,40.4',
      `Major roads (motorway/trunk/primary),"'=HYPERLINK(""http://x"",""y"")",motorway,3.25,-107.7675,40.4`,
    ]);
    expect(lines).toContain('"Source: OpenStreetMap contributors (ODbL 1.0, https://opendatacommons.org/licenses/odbl/), HIFLD, BTS NARN"');
    expect(crossingsCsv(s.result!.profile!.crossings)).not.toContain('Source:');
  });

  it('the tab shows the button, then the names list (text only) and the families not read', () => {
    const s = FIXTURE_SESSION(), ctx = fakeTabContext(s), el = document.createElement('div');
    tab.render(el, ctx);
    const btn = el.querySelector<HTMLButtonElement>('.rx-exact-btn')!;
    expect(btn.textContent).toBe('Read crossings and observations');
    btn.click();
    expect(ctx.calls).toEqual(['listExactCrossings()']);
    s.exactBusy = true;
    tab.render(el, ctx);
    expect(el.querySelector<HTMLButtonElement>('.rx-exact-btn')!.disabled).toBe(true);
    expect(el.querySelector('.rx-exact-btn')!.textContent).toBe('Reading crossings and observations…');
    s.exactBusy = false;
    s.exactError = 'no report data';
    tab.render(el, ctx);
    expect(el.textContent).toContain('no report data');

    withExact(s);
    s.exactError = null;
    tab.render(el, ctx);
    expect(el.querySelector('.rx-exact-btn')).toBeNull();
    const names = [...el.querySelectorAll<HTMLElement>('.rx-names tbody tr')];
    expect(names.map((tr) => tr.children[3].textContent)).toEqual(['0.4', '1.5', '2.0', '3.3']);
    expect(names[0].children[1].textContent).toBe('unnamed');
    expect(names[3].children[1].textContent).toBe('=HYPERLINK("http://x","y")');
    expect(el.querySelector('.rx-names a')).toBeNull();
    names[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(ctx.calls.at(-1)).toBe(`fitPoints(${JSON.stringify([[-107.785, 40.4]])})`);
    expect(el.textContent).toContain('Pipelines: not read (pipelines_osm.parquet: HTTP 404)');
    expect(row(el, 'river')!.children[1].textContent).toBe('≈1');
    expect(row(el, 'river')!.children[3].textContent).toBe('exact');
    // the pills take the exact counts; Sources says what exact means
    const pills = [...el.querySelectorAll('.rp-pill')].map((p) => p.textContent);
    expect(pills).toContain('≈1 river');
    expect(pills.some((p) => /^≈2 major roads?$/.test(p!))).toBe(true);
    expect(el.querySelector('.rx-right')!.textContent).toContain('Counts marked exact');
    // a river row click fits the exact points
    row(el, 'river')!.click();
    expect(ctx.calls.at(-1)).toBe(`fitPoints(${JSON.stringify([[-107.785, 40.4]])})`);
  });
});
