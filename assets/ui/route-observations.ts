// Route building and aviation observations shared by the Crossings tab and print.
// Role: text-only tables, source/coverage notes and CSV rows for the shown path. The pure row, head, source, survey
//       and unavailable-reason builders are exported: the batch PDF (route-batch-pdf.ts) lays out the same cells, so the
//       wording lives here once. Building counts are national footprint pieces (a building across a tile seam counts
//       as more than one), said in the building notes; aviation is FAA NTAD (facilities incl. closed, with status),
//       worded as screening only: Part 77 surface heights, obstruction standard, "FAA Form 7460-1 / OE/AAA decides".
//       `aviationMiles` (the aviation miles rows both the Crossings tab and the report list: codes with miles above zero)
//       and `aviationNote` (the one note under them: the height the method screens at, or none) live here once.
// Deps: route/screening.ts (types), route/profile.ts (type), i18n. Fetches nothing and changes no route state.

import type { RouteCrossings } from '../route/profile.js';
import type { RouteScreening } from '../route/screening.js';
import { t } from '../../src/i18n/index.js';

export type CsvRow = (string | number)[];
const classes = ['all', 'residential', 'nonresidential', 'unknown'] as const;
const metres = (n: number): string => n.toFixed(1);
const unknown = (): string => t('route.cross.na');
export const surveys = (dates: (string | null)[]): string => dates.map(d => d || unknown()).join(' / ');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

function table(head: string[], rows: CsvRow[]): HTMLTableElement {
  const tbl = el('table');
  tbl.className = 'rx-table';
  const thead = el('thead'), tr = el('tr');
  for (const text of head) { const th = el('th', text); th.scope = 'col'; tr.append(th); }
  thead.append(tr); tbl.append(thead);
  const body = el('tbody');
  for (const row of rows) {
    const r = el('tr');
    for (const v of row) r.append(el('td', String(v)));
    body.append(r);
  }
  tbl.append(body);
  return tbl;
}

/** The fetch date as shown: national building data carries the literal "unknown". */
export const fetched = (fetchedAt: string): string =>
  fetchedAt === 'unknown' ? t('route.obs.fetchUnknown') : t('route.obs.fetched', { date: fetchedAt });

export function source(p: { credit: string; fetchedAt: string; license: string }): string {
  return `${p.credit} · ${fetched(p.fetchedAt)} · ${p.license}`;
}

/** Why a family is unavailable, in the visitor's language: the reason's key when it has one, else its text. */
export function unavailableText(o: { reason: string; reasonKey?: string }): string {
  return t('route.obs.unavailable', { reason: o.reasonKey ? t(o.reasonKey) : o.reason });
}

/** Aviation codes with a miles row (0 nodata and 1 no surface have none). */
export const AVIATION_CODES = [2, 3, 4, 5, 6] as const;

/** The aviation codes the route has miles in, in code order; empty when the band was not read or the route meets no surface. */
export const aviationMiles = (c: Pick<RouteCrossings, 'miles'>): { code: number; miles: number }[] =>
  AVIATION_CODES.flatMap((code) => (c.miles.aviation[code] > 0 ? [{ code, miles: c.miles.aviation[code] }] : []));

/** The one note under the aviation miles rows: the height the method screens at (feet rounded from metres here), or that it weighs no class. null without aviation rows. */
export function aviationNote(c: Pick<RouteCrossings, 'miles' | 'aviationHeightM'>): string | null {
  if (!aviationMiles(c).length) return null;
  const m = c.aviationHeightM;
  return m === null ? t('route.obs.av.noteNone') : t('route.obs.av.note', { m, ft: Math.round(m / 0.3048) });
}

/** The values shared by the displayed and exported building table. */
export function buildingRows(b: Extract<RouteScreening['buildings'], { status: 'ok' }>): CsvRow[] {
  return classes.map(k => [t(`route.obs.${k}`), b.counts[k], metres(b.metres[k])]);
}

export function runwayRows(a: Extract<RouteScreening['aviation'], { status: 'ok' }>): CsvRow[] {
  return a.runways.map(r => [`${r.airport} ${r.runway}`, metres(r.centrelineM), metres(r.endM), metres(r.airportPointM)]);
}

export function facilityRows(a: Extract<RouteScreening['aviation'], { status: 'ok' }>): CsvRow[] {
  const type = (v: string): string => ['A', 'AD', 'H', 'G'].includes(v) ? t(`route.obs.type.${v === 'AD' ? 'A' : v}`) : v;
  const use = (v: string): string => ['PU', 'PR'].includes(v) ? t(`route.obs.use.${v}`) : v;
  return a.facilities.map(f => [
    `${f.id} ${f.name}`,
    `${type(f.type)} / ${use(f.use)} / ${f.operationalStatus}`,
    metres(f.distanceM), t(`route.obs.runways.${f.runwayCoverage}`),
  ]);
}

export const buildingHead = (): string[] => ['class', 'count', 'metres'].map(k => t(`route.obs.${k}`));
export const runwayHead = (): string[] => ['runway', 'centreline', 'end', 'airportPoint'].map(k => t(`route.obs.${k}`));
export const facilityHead = (): string[] => ['facility', 'attributes', 'distance', 'runways'].map(k => t(`route.obs.${k}`));

/** Observations only: the caller ensures these belong to the current full path. */
export function routeObservations(observations?: RouteScreening): HTMLElement {
  const box = el('section');
  box.className = 'rx-box route-observations';
  box.append(el('h3', t('route.obs.heading')));
  if (!observations) { box.append(el('p', t('route.obs.notRead'))); return box; }
  const b = observations.buildings;
  box.append(el('h4', t('route.obs.buildings')));
  if (b.status === 'unavailable') box.append(el('p', unavailableText(b)));
  else {
    box.append(el('p', t('route.obs.coverage', { observed: metres(b.observedM), total: metres(b.totalM) })));
    box.append(table(buildingHead(), buildingRows(b)));
    box.append(el('p', t('route.obs.imagery', { years: b.imageryYears.join(', ') || unknown() })));
    box.append(el('p', source(b.provenance)));
  }
  box.append(el('p', t('route.obs.buildingLimit')));
  const a = observations.aviation;
  box.append(el('h4', t('route.obs.aviation')));
  if (a.status === 'unavailable') box.append(el('p', unavailableText(a)));
  else {
    box.append(el('p', a.scope));
    box.append(el('p', t('route.obs.inventory', { facilities: a.facilities.length, runways: a.runways.length })));
    box.append(el('p', t('route.obs.cycle', { cycle: a.cycle })));
    box.append(table(runwayHead(), runwayRows(a)));
    for (const r of a.runways) box.append(el('p', `${r.airport} ${r.runway} · ${t('route.obs.surveys', { dates: surveys(r.surveyDates) })}`));
    box.append(el('h4', t('route.obs.facilities')));
    box.append(table(facilityHead(), facilityRows(a)));
    box.append(el('p', source(a.provenance)));
  }
  box.append(el('p', t('route.obs.aviationLimit')));
  return box;
}

/** CSV cells remain unescaped here; crossingsCsv applies its formula guard to every cell. */
export function observationCsvRows(observations?: RouteScreening): CsvRow[] {
  const rows: CsvRow[] = [[], [t('route.obs.heading')]];
  if (!observations) return [...rows, [t('route.obs.notRead')]];
  const provenance = (p: { source: string; sha256: string; credit: string; fetchedAt: string; license: string }): CsvRow[] =>
    [[p.credit, p.source, p.fetchedAt === 'unknown' ? t('route.obs.fetchUnknown') : p.fetchedAt, p.license], ['SHA256', p.sha256]];
  const b = observations.buildings;
  rows.push([t('route.obs.buildings')]);
  if (b.status === 'unavailable') rows.push([unavailableText(b)]);
  else {
    rows.push([t('route.obs.coverage', { observed: metres(b.observedM), total: metres(b.totalM) })],
      buildingHead(), ...buildingRows(b), [t('route.obs.imagery', { years: b.imageryYears.join(', ') || unknown() })], ...provenance(b.provenance));
  }
  rows.push([t('route.obs.buildingLimit')], [], [t('route.obs.aviation')]);
  const a = observations.aviation;
  if (a.status === 'unavailable') rows.push([unavailableText(a)]);
  else {
    rows.push([a.scope], [t('route.obs.inventory', { facilities: a.facilities.length, runways: a.runways.length })],
      [t('route.obs.cycle', { cycle: a.cycle })], runwayHead(), ...runwayRows(a));
    for (const r of a.runways) rows.push([`${r.airport} ${r.runway}`, t('route.obs.surveys', { dates: surveys(r.surveyDates) })]);
    rows.push([t('route.obs.facilities')], facilityHead(), ...facilityRows(a), ...provenance(a.provenance));
  }
  rows.push([t('route.obs.aviationLimit')]);
  return rows;
}
