// ─── Route panel: Crossings sub-tab ──────────────────────────────────────────
// Role: what the routed line crosses and runs through, from result.profile.crossings:
//       a Feature | Crossings | Miles | Note table (zero rows hidden, except tribal land),
//       land-manager and designation miles, crossing pills, tribal note, sources, "Show on
//       map" toggles (ctx.showCrossings; their state is session.crossingKinds, which the
//       shell's markers follow on every tab, so leaving the tab changes nothing) and a CSV export. A row with crossing points is
//       clickable / Enter and fits the map to them (ctx.fitPoints).
//       "List crossings by name" (ctx.listExactCrossings; busy while session.exactBusy) reads the exact
//       crossings into session.exact; while they belong to the shown result (`shownExact`), each kind they
//       cover takes their count, points and the note "exact" (the others note "approximate"), and a names
//       list sits below the table with one line per family not read. The CSV gains one formula-guarded
//       line per exact point and an ODbL source line. The aviation rows (only with miles) are followed by
//       one note, `aviationNote`. A failure is one line (session.exactError). All text goes in through
//       textContent. `crossingRows`, `crossingsCsv`, `pathKey` and `shownExact` are pure. Optional
//       building/aviation observations share their renderer and export rows with the printable report.
// Deps: route-tabs/widgets.ts, route-tabs/types.ts (types), route/profile.ts, route/crossings-exact.ts (types),
//       route-observations.ts, route/screening.ts (types), utils/utils.ts (csvCell), i18n (t), ./crossings.css.

import './crossings.css';
import { t } from '../../../src/i18n/index.js';
import type { CrossingPoint, RouteCrossings } from '../../route/profile.js';
import type { ExactResult } from '../../route/crossings-exact.js';
import type { RouteScreening } from '../../route/screening.js';
import { aviationMiles, aviationNote, observationCsvRows, routeObservations } from '../route-observations.js';
import { approxCount, crossingPills, tribalNote } from './widgets.js';
import { csvCell } from '../../utils/utils.js';
import type { RouteSession, RouteTab, RouteTabContext } from './types.js';

type Kind = CrossingPoint['kind'];
/** Exact crossings of the shown result: its points and counts, the kinds they cover, families not read. */
export interface ExactView { result: ExactResult; exact: Kind[]; failed: { family: string; note: string }[]; screening?: RouteScreening }

/** Identity includes every vertex so a changed interior cannot inherit old observations. */
export function pathKey(path: GeoJSON.LineString, lengthMi: number): string {
  return JSON.stringify([path.coordinates, lengthMi]);
}

const FAMILY_LABEL: Record<string, string> = {
  river: 'route.cross.row.river', road: 'route.cross.row.road', rail: 'route.cross.row.rail',
  pipeline: 'route.cross.row.pipeline', line: 'route.cross.show.lines',
};

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

/** The table's rows in display order; zero rows dropped (tribal land always stays; an exact kind stays
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
    if (mi > 0 || m === 'tribal') {
      const follows = ex?.exact.includes('line230') ? t('route.cross.note.followsExact') : t('route.cross.note.follows');
      rows.push({ id: m, label: t(`route.cross.row.${m}`), count: null, miles: mi, note: m === 'follows' ? follows : m === 'tribal' ? t('route.cross.note.tribal') : '', kind: null });
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
const exactPoints = (ex: ExactView): CrossingPoint[] =>
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function cell(tr: HTMLElement, text: string | null, cls = 'rx-num'): void {
  const td = el('td', text === null ? `${cls} rx-na` : cls, text ?? t('route.cross.na'));
  tr.append(td);
}

function table(c: RouteCrossings, ctx: RouteTabContext, ex: ExactView | null): HTMLElement {
  const tbl = el('table', 'rx-table');
  tbl.setAttribute('aria-label', t('route.cross.table'));
  const hr = el('tr');
  [['route.cross.head.feature', ''], ['route.cross.head.crossings', ' rx-num'], ['route.cross.head.miles', ' rx-num'], ['route.cross.head.note', '']].forEach(([k, x]) => {
    const th = el('th', x.trim(), t(k));
    th.scope = 'col';
    hr.append(th);
  });
  const thead = el('thead');
  thead.append(hr);
  const body = el('tbody');
  let active: HTMLElement | null = null;
  for (const r of crossingRows(c, ex)) {
    const tr = el('tr', 'rx-row');
    tr.dataset.row = r.id;
    cell(tr, r.label, '');
    cell(tr, r.count === null ? null : approxCount(r.count));
    cell(tr, r.miles === null ? null : r.miles.toFixed(1));
    tr.append(el('td', 'rx-note', r.note));
    const kind = r.kind;
    const pts = kind ? (ex?.exact.includes(kind) ? ex.result.points : c.points).filter((p) => p.kind === kind) : [];
    if (kind && pts.length) {
      const go = () => {
        active?.classList.remove('rx-row--on');
        active = tr;
        tr.classList.add('rx-row--on');
        ctx.fitPoints(pts.map((p) => p.lngLat));
      };
      tr.classList.add('rx-row--go');
      tr.tabIndex = 0;
      tr.title = t('route.cross.rowHint');
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    body.append(tr);
  }
  tbl.append(thead, body);
  return tbl;
}

const TOGGLES: { key: string; glyph: string; kinds: Kind[] }[] = [
  { key: 'route.cross.show.river', glyph: '●', kinds: ['river'] },
  { key: 'route.cross.show.roadrail', glyph: '■', kinds: ['road', 'rail'] },
  { key: 'route.cross.show.pipeline', glyph: '◆', kinds: ['pipeline'] },
  { key: 'route.cross.show.lines', glyph: '▲', kinds: ['line230', 'line100'] },
];

function showBox(ctx: RouteTabContext): HTMLElement {
  const box = el('div', 'rx-box rx-show');
  box.append(el('h4', undefined, t('route.cross.show')));
  for (const tg of TOGGLES) {
    const label = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = tg.kinds.every((k) => ctx.session.crossingKinds.includes(k));
    cb.dataset.kinds = tg.kinds.join(',');
    cb.addEventListener('change', () => ctx.showCrossings(tg.kinds, cb.checked));
    label.append(cb, el('span', 'rx-glyph', tg.glyph), el('span', undefined, t(tg.key)));
    box.append(label);
  }
  return box;
}

/** The button, the busy state, the failure line, or (with a result) the names list and the families not read. */
function exactBox(ctx: RouteTabContext, ex: ExactView | null): HTMLElement {
  const s = ctx.session, box = el('div', 'rx-exact');
  if (!ex) {
    const btn = el('button', 'rx-csv rx-exact-btn', t(s.exactBusy ? 'route.obs.busy' : 'route.obs.read'));
    btn.type = 'button';
    btn.disabled = !!s.exactBusy;
    btn.setAttribute('aria-busy', String(!!s.exactBusy));
    btn.addEventListener('click', () => ctx.listExactCrossings());
    box.append(btn);
    if (s.exactError && !s.exactBusy) box.append(el('p', 'rx-note', t('route.cross.exact.error', { reason: s.exactError })));
    return box;
  }
  for (const f of ex.failed) box.append(el('p', 'rx-note', t('route.cross.exact.failed', { kind: t(FAMILY_LABEL[f.family] ?? f.family), reason: f.note })));
  const pts = exactPoints(ex);
  if (!pts.length) return box;
  const tbl = el('table', 'rx-table rx-names');
  tbl.setAttribute('aria-label', t('route.cross.names'));
  const hr = el('tr');
  for (const [k, x] of [['route.cross.csv.kind', ''], ['route.cross.csv.name', ''], ['route.cross.csv.detail', ''], ['route.cross.csv.mile', 'rx-num']]) {
    const th = el('th', x, t(k));
    th.scope = 'col';
    hr.append(th);
  }
  const thead = el('thead'), body = el('tbody');
  thead.append(hr);
  for (const p of pts) {
    const tr = el('tr', 'rx-row rx-row--go');
    tr.tabIndex = 0;
    tr.title = t('route.cross.names.hint');
    tr.append(el('td', undefined, t(`route.cross.row.${p.kind}`)), el('td', p.name ? undefined : 'rx-na', p.name ?? t('route.cross.names.unnamed')),
      el('td', 'rx-note', p.detail ?? ''), el('td', 'rx-num', p.mi.toFixed(1)));
    const go = () => ctx.fitPoints([p.lngLat]);
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    body.append(tr);
  }
  tbl.append(thead, body);
  box.append(el('h4', 'rx-names-head', t('route.cross.names')), tbl);
  return box;
}

function download(c: RouteCrossings, ex: ExactView | null): void {
  const url = URL.createObjectURL(new Blob([crossingsCsv(c, ex)], { type: 'text/csv;charset=utf-8' }));
  const a = el('a');
  a.href = url;
  a.download = t('route.cross.csv.file');
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const tab: RouteTab = {
  id: 'crossings',
  labelKey: 'route.sub.crossings',
  disabled: (s) => {
    const p = s.result?.profile;
    if (p === null) return t('route.sub.why.straight');
    return p ? null : t('route.sub.why.reprofile');
  },
  render(root, ctx) {
    root.replaceChildren();
    const r = ctx.session.result;
    const c = r?.profile?.crossings;
    if (!r || !c) return;
    const ex = shownExact(ctx.session);
    const left = el('div', 'rx-left');
    const csv = el('button', 'rx-csv', t('route.cross.csv'));
    csv.type = 'button';
    csv.addEventListener('click', () => download(c, ex));
    const bar = el('div', 'rx-bar');
    bar.append(csv);
    const exact = exactBox(ctx, ex);
    if (!ex) bar.append(exact);
    left.append(bar, table(c, ctx, ex));
    const av = aviationNote(c);
    if (av) left.append(el('p', 'rx-note rx-av-note', av));
    if (ex) left.append(exact, routeObservations(ex.screening));

    const sources = el('div', 'rx-box');
    sources.append(el('h4', undefined, t('route.cross.sources.heading')));
    if (ex) sources.append(el('p', undefined, t('route.cross.sources.exact')));
    sources.append(el('p', undefined, t('route.cross.sources')));
    const counts = { ...c.counts };
    for (const k of ex?.exact ?? []) counts[k] = ex!.result.counts[k];
    const right = el('div', 'rx-right');
    right.append(crossingPills(c, counts), tribalNote(r), showBox(ctx), sources);

    const grid = el('div', 'rx');
    grid.append(left, right);
    root.append(grid);
  },
};

export default tab;
