// ─── Route formatting ────────────────────────────────────────────────────────
// Role: the route panel's pure text and number logic, shared by the tabs, the printable report and the batch
//       export, with no DOM: waterfall lines (`waterfallLines`, with the terminal grouping `terminalSplit` /
//       `terminalLabel` / `endsText`), headline dollars (`fmtMoneyHead`), the estimate class (`bandLabel`), the
//       headline KPI tiles (`kpiTiles`), crossing counts (`approxCount`), a weights row's label and factor text
//       (`rowLabel`, `fmtFactor`), and the Crossings tab's data: `pathKey`, `shownExact`, `crossingRows`,
//       `crossingsCsv` (the CSV text, every cell formula-guarded).
// Deps: route/cost.ts (greatCircleM, types), route/categories.ts, route/route.ts, route/profile.ts, route/crossings-exact.ts and
//       route/screening.ts (types only), registry/route-presets.ts (types), ui/route/tabs/types.ts (types), route-observations.ts,
//       utils/utils.ts (csvCell), i18n/index.ts.

import { t } from '../../../src/i18n/index.js';
import { greatCircleM, type CostResult } from '../../route/cost.js';
import { categoryLabelKey, routeCategory } from '../../route/categories.js';
import type { RouteResult } from '../../route/route.js';
import type { CrossingPoint, RouteCrossings } from '../../route/profile.js';
import type { ExactResult } from '../../route/crossings-exact.js';
import type { RouteScreening } from '../../route/screening.js';
import type { CostRow, Factor, RoutePreset } from '../../../src/registry/route-presets.js';
import { aviationMiles, aviationNote, observationCsvRows } from './route-observations.js';
import { csvCell } from '../../utils/utils.js';
import type { DollarYear, RouteSession } from './tabs/types.js';

type Kind = CrossingPoint['kind'];
type Val = number | [number, number];

export type WaterfallGroup = 'base' | 'multipliers' | 'terminals' | 'markups' | 'contingency' | 'subtotal' | 'total' | 'other';
export interface WaterfallLine { label: string; value: number; group: WaterfallGroup; src?: string }
export interface WaterfallOpts { money: (v: number) => string; compact?: boolean; maxLines?: number }


const M_PER_MI = 1609.344;

export interface TerminalGroup { n: number; each: number; usd: number; ends: ('A' | 'B')[]; mid: number }
/** "A, B" or "A, 2 mid-line": the ends of a terminal group and its mid-line stations. */
export function endsText(ends: ('A' | 'B')[], mid: number): string {
  return [...ends, ...(mid ? [t('route.term.midLine', { n: mid })] : [])].join(t('route.term.sep'));
}
/** The label of a terminal group: new stations (a study method's read as the method prices them) or line positions. */
export function terminalLabel(kind: 'stations' | 'positions', g: TerminalGroup, preset: RoutePreset): string {
  const key = kind === 'positions' ? 'route.term.positions' : preset.study_terminals ? 'route.term.study' : 'route.term.stations';
  return t(key, { ends: endsText(g.ends, g.mid) });
}
/** The terminals of a cost as stations (new and mid-line) and line positions; a `none` end is in neither group, in method-year dollars. `usd` of a group
 *  is its items' sum, except that with both kinds the stations take what `terminalsUsd` leaves, so the two sum to
 *  `terminalsUsd` exactly. Null without `terminalItems` (a result from before kinds). */
export function terminalSplit(cost: CostResult): { stations: TerminalGroup | null; positions: TerminalGroup | null } | null {
  const items = cost.terminalItems;
  if (!items) return null;
  const total = cost.terminalsUsd ?? 0;
  const st = items.filter((i) => i.kind !== 'position'), po = items.filter((i) => i.kind === 'position');
  const group = (xs: typeof items, usd: number): TerminalGroup | null => (xs.length ? {
    n: xs.length, each: xs[0].usd, usd,
    ends: xs.flatMap((i) => (i.end ? [i.end] : [])), mid: xs.filter((i) => i.kind === 'mid').length,
  } : null);
  const posUsd = po.reduce((s, i) => s + i.usd, 0);
  return {
    stations: group(st, po.length ? total - posUsd : total),
    positions: group(po, st.length ? posUsd : total),
  };
}


/** The waterfall lines of a cost: base, one per category (largest first), adjustments, subtotal,
 *  contingency, total. In preset dollars they sum to totalNominal; for 2025$ each is scaled by
 *  total2025 / totalNominal (the one escalation factor), so they sum to total2025. */
export function waterfallLines(cost: CostResult, preset: RoutePreset, opts: { dollars: DollarYear }): WaterfallLine[] {
  const k = opts.dollars === 'y2025' && cost.totalNominal ? cost.total2025 / cost.totalNominal : 1;
  const line = preset.line_types[cost.lineType];
  const out: WaterfallLine[] = [];
  const add = (label: string, usd: number, group: WaterfallGroup, src?: string) => out.push({ label, value: usd * k, group, src });

  add(t('route.wf.base'), cost.baseUsd, 'base', line?.base_per_mi.src);
  const cats = new Map<string, { usd: number; src: string }>();
  for (const r of cost.perRow) {
    const row = preset.rows[r.row];
    const key = row ? routeCategory(row) : 'other';
    const c = cats.get(key) ?? { usd: 0, src: row?.src ?? '' };
    c.usd += r.usd;
    cats.set(key, c);
  }
  [...cats].sort((a, b) => b[1].usd - a[1].usd).forEach(([key, c]) => {
    if (Math.abs(c.usd * k) >= 0.5) add(t(categoryLabelKey(key)), c.usd, 'multipliers', c.src);
  });
  if (Math.abs(cost.otherUsd * k) >= 1) add(t('route.wf.other'), cost.otherUsd, 'other');
  const lf = cost.lengthFactor || 1;
  if (lf !== 1) add(t('route.wf.shortLine'), cost.lineUsdNominal * (1 - 1 / lf), 'multipliers');
  const split = terminalSplit(cost);
  if (!split) { if (cost.terminalsUsd) add(t('route.cost.terminals'), cost.terminalsUsd, 'terminals', line?.terminals.src); }
  else {
    if (split.stations?.usd) add(terminalLabel('stations', split.stations, preset), split.stations.usd, 'terminals', line?.terminals.src);
    if (split.positions?.usd) add(terminalLabel('positions', split.positions, preset), split.positions.usd, 'terminals', line?.terminals.position?.src);
  }
  if (cost.mitigationUsd.mid) add(t('route.wf.mitigation'), cost.mitigationUsd.mid, 'terminals', preset.mitigation?.src);
  if (cost.rowLand && cost.rowLand.usd) add(t('route.wf.rowLand'), cost.rowLand.usd, 'other', cost.rowLand.note);
  if (cost.markupsUsd) add(t('route.wf.markups'), cost.markupsUsd, 'markups', preset.markups.map((m) => m.label).join(', '));
  const sub = cost.totalNominal - (cost.contingency?.usd ?? 0);
  out.push({ label: t('route.wf.subtotal'), value: sub * k, group: 'subtotal' });
  if (cost.contingency) {
    add(t('route.wf.contingency', { pct: Math.round(cost.contingency.pct * 1000) / 10 }), cost.contingency.usd, 'contingency', cost.contingency.label);
  }
  out.push({ label: t('route.wf.total'), value: cost.totalNominal * k, group: 'total' });
  return out;
}

/** Headline dollars to two significant figures (`$3.1 B`, `$720 M`, `$9.5 M`, `$12 k`); the unit is chosen after
 *  rounding, so 999.6 M reads "$1.0 B". A no-break space precedes the unit; negatives use U+2212. */
export function fmtMoneyHead(v: number): string {
  const s = v < 0 ? '\u2212' : '';
  const r = Number(Math.abs(v).toPrecision(2));
  if (!r) return '$0';
  const [div, unit] = r >= 1e9 ? [1e9, '\u00a0B'] : r >= 1e6 ? [1e6, '\u00a0M'] : r >= 1e3 ? [1e3, '\u00a0k'] : [1, ''];
  const u = r / div;
  return `${s}$${u >= 10 ? u.toFixed(0) : u.toFixed(1)}${unit}`;
}


/** A crossing count as shown: "≈" + the number (counts come from 250 m cells or the drawn path, so they are estimates). */
export const approxCount = (n: number) => `≈${n}`;

/** The estimate class in the reader's language: the presets' rough-early-estimate band has a key; any other label shows as given. */
export const bandLabel = (label: string): string => (/^Rough early estimate\b/.test(label) ? t('route.range.class5') : label);


/** The five headline tiles: range, point estimate, miles, $/mi all-in, $/mi line only (terminals, with their
 *  contingency, taken out of the total; both in the shown dollars). */
export function kpiTiles(result: RouteResult, dollars: DollarYear = 'y2025'): { value: string; label: string }[] {
  const c = result.cost, coords = result.path.coordinates;
  const total = dollars === 'y2025' ? c.total2025 : c.totalNominal;
  const k = dollars === 'preset' && c.total2025 ? c.totalNominal / c.total2025 : 1;
  const low = c.band.low * k, high = c.band.high * k;
  const terminals = (c.terminalsUsd ?? 0) * (dollars === 'y2025' && c.totalNominal ? c.total2025 / c.totalNominal : 1) * (1 + (c.contingency?.pct ?? 0));
  const straightMi = coords.length > 1 ? greatCircleM(coords[0] as [number, number], coords[coords.length - 1] as [number, number]) / M_PER_MI : 0;
  const yearLabel = dollars === 'y2025' ? t('route.kpi.dollars.y2025') : t('route.kpi.dollars.preset', { year: c.dollarYear });
  const perMi = (usd: number) => t('route.kpi.perMi', { amount: fmtMoneyHead(result.lengthMi ? usd / result.lengthMi : 0) });
  return [
    { value: `${fmtMoneyHead(low)} \u2013 ${fmtMoneyHead(high)}`, label: `${bandLabel(c.band.label)} \u00b7 ${yearLabel}` },
    { value: fmtMoneyHead(total), label: t('route.kpi.total', { dollars: yearLabel }) },
    { value: t('route.kpi.miles', { mi: result.lengthMi.toFixed(1) }), label: straightMi > 0 ? t('route.kpi.straight', { x: (result.lengthMi / straightMi).toFixed(2) }) : '' },
    { value: perMi(total), label: t('route.kpi.allIn') },
    { value: perMi(total - terminals), label: t('route.kpi.lineOnly') },
  ];
}


export const fmtFactor = (f: Factor | Val): string =>
  typeof f === 'number' ? String(f) : Array.isArray(f) ? `${f[0]}, ${f[1]}` : `${f.ramp[0]}, ${f.ramp[1]}`;


export const rowLabel = (row: CostRow): string => `${t(categoryLabelKey(routeCategory(row)))} — ${row.note ?? row.band}`;


/** Exact crossings of the shown result: its points and counts, the kinds they cover, families not read. */
export interface ExactView { result: ExactResult; exact: Kind[]; failed: { family: string; note: string }[]; screening?: RouteScreening }

/** Identity includes every vertex so a changed interior cannot inherit old observations. */
export function pathKey(path: GeoJSON.LineString, lengthMi: number): string {
  return JSON.stringify([path.coordinates, lengthMi]);
}


/** session.exact when it belongs to the shown result, else null. */
export function shownExact(s: Pick<RouteSession, 'exact' | 'result'>): ExactView | null {
  const ex = s.exact, r = s.result;
  if (!ex || !r || !ex.routes[0] || ex.forPath !== pathKey(r.path, r.lengthMi)) return null;
  const failed = Object.entries(ex.status).filter(([, st]) => !st.ok).map(([family, st]) => ({ family, note: st.note ?? '' }));
  return { result: ex.routes[0], exact: ex.exact, failed, ...(ex.screening?.[0] ? { screening: ex.screening[0] } : {}) };
}

export interface CrossingRow {
  id: string;
  label: string;
  count: number | null;       // null = not applicable
  miles: number | null;
  note: string;
  kind: Kind | null;          // the crossing points a click fits to
}

const COUNTED: Kind[] = ['river', 'road', 'rail', 'pipeline', 'line230', 'line100'];
const MILES: ('follows' | 's368' | 'gap12' | 'gap3' | 'critHab' | 'phma' | 'tribal' | 'park' | 'wetland')[] = ['follows', 's368', 'gap12', 'gap3', 'critHab', 'phma', 'tribal', 'park', 'wetland'];

/** The table's rows in display order; zero rows dropped (an exact kind stays
 *  while either count is above zero; the aviation rows appear only with miles, and `aviationNote` follows the table). With `ex`, its kinds take the exact counts. */
export function crossingRows(c: RouteCrossings, ex?: ExactView | null): CrossingRow[] {
  const rows: CrossingRow[] = [];
  for (const k of COUNTED) {
    const exact = !!ex && ex.exact.includes(k);
    const count = exact ? ex!.result.counts[k] : c.counts[k];
    if (count > 0 || (exact && c.counts[k] > 0)) {
      rows.push({ id: k, label: t(`route.cross.row.${k}`), count, miles: null, note: exact ? t('route.cross.note.exact') : ex ? t('route.cross.note.approx') : '', kind: k });
    }
  }
  for (const m of MILES) {
    const mi = c.miles[m];
    if (mi > 0) {
      const follows = ex?.exact.includes('line230') ? t('route.cross.note.followsExact') : t('route.cross.note.follows');
      rows.push({ id: m, label: t(`route.cross.row.${m}`), count: null, miles: mi, note: m === 'follows' ? follows : '', kind: null });
    }
  }
  for (const { code, miles } of aviationMiles(c)) {
    rows.push({ id: `av${code}`, label: t(`route.cross.row.av${code}`), count: null, miles, note: '', kind: null });
  }
  for (const [code, mi] of Object.entries(c.miles.byAgency)) {
    if (Number(code) >= 1 && mi > 0) rows.push({ id: `agency-${code}`, label: `${t('route.cross.agency.heading')}: ${t(`route.lbl.agency.${code}`)}`, count: null, miles: mi, note: '', kind: null });
  }
  for (const [bit, mi] of Object.entries(c.miles.desig)) {
    if (mi > 0 && Number(bit) >= 0 && Number(bit) <= 7) rows.push({ id: `desig-${bit}`, label: `${t('route.cross.desig.heading')}: ${t(`route.cross.desig.${bit}`)}`, count: null, miles: mi, note: '', kind: null });
  }
  return rows;
}

const SOURCE_LINE = 'Source: OpenStreetMap contributors (ODbL 1.0, https://opendatacommons.org/licenses/odbl/), HIFLD, BTS NARN';

/** The exact points of the kinds `ex` covers, by mile. */
export const exactPoints = (ex: ExactView): CrossingPoint[] =>
  ex.result.points.filter((p) => ex.exact.includes(p.kind)).sort((a, b) => a.mi - b.mi);

/** The table as CSV text: header row, then one line per row; "not applicable" cells are empty. With `ex`: a
 *  blank line, a Kind | Name | Detail | Mile | Longitude | Latitude header, one line per exact point, a source line. */
export function crossingsCsv(c: RouteCrossings, ex?: ExactView | null): string {
  const head = ['route.cross.head.feature', 'route.cross.head.crossings', 'route.cross.head.miles', 'route.cross.head.note'].map((k) => csvCell(t(k)));
  const lines = [head.join(',')];
  for (const r of crossingRows(c, ex)) {
    lines.push([csvCell(r.label), r.count === null ? '' : String(r.count), r.miles === null ? '' : r.miles.toFixed(1), csvCell(r.note)].join(','));
  }
  const av = aviationNote(c);
  if (av) lines.push(csvCell(av));
  if (ex) {
    lines.push('', ['route.cross.csv.kind', 'route.cross.csv.name', 'route.cross.csv.detail', 'route.cross.csv.mile', 'route.cross.csv.lng', 'route.cross.csv.lat']
      .map((k) => csvCell(t(k))).join(','));
    for (const p of exactPoints(ex)) {
      lines.push([t(`route.cross.row.${p.kind}`), p.name ?? '', p.detail ?? '', +p.mi.toFixed(2), +p.lngLat[0].toFixed(6), +p.lngLat[1].toFixed(6)].map(csvCell).join(','));
    }
    lines.push(csvCell(SOURCE_LINE));
    lines.push(...observationCsvRows(ex.screening).map(row => row.map(csvCell).join(',')));
  }
  return lines.join('\r\n') + '\r\n';
}

