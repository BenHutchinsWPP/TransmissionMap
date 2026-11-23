// ─── Route panel: Crossings sub-tab ──────────────────────────────────────────
// Role: what the routed line crosses and runs through, from result.profile.crossings:
//       a Feature | Crossings | Miles | Note table (zero rows hidden),
//       land-manager and designation miles, crossing pills, sources, "Show on
//       map" toggles (ctx.showCrossings; their state is session.crossingKinds, which the
//       shell's markers follow on every tab, so leaving the tab changes nothing) and a CSV export. A row with crossing points is
//       clickable / Enter and fits the map to them (ctx.fitPoints).
//       "List crossings by name" (ctx.listExactCrossings; busy while session.exactBusy) reads the exact
//       crossings into session.exact; while they belong to the shown result (`shownExact`), each kind they
//       cover takes their count, points and the note "exact" (the others note "approximate"), and a names
//       list sits below the table with one line per family not read. The CSV gains one formula-guarded
//       line per exact point and an ODbL source line. The aviation rows (only with miles) are followed by
//       one note, `aviationNote`. A failure is one line (session.exactError). All text goes in through
//       textContent. `crossingRows`, `crossingsCsv`, `pathKey` and `shownExact` are pure and live in ../route-format.ts. Optional
//       aviation observations share their renderer and export rows with the printable report.
// Deps: ui/route/tabs/widgets.ts, route-format.ts, ui/route/tabs/types.ts (types), route/profile.ts (types),
//       route-observations.ts, utils/utils-dom.ts (h), i18n (t), ./crossings.css.

import './crossings.css';
import { t } from '../../../../src/i18n/index.js';
import { h } from '../../../utils/utils-dom.js';
import type { CrossingPoint, RouteCrossings } from '../../../route/profile.js';
import { aviationNote, routeObservations } from '../route-observations.js';
import { crossingPills } from './widgets.js';
import { approxCount, crossingRows, crossingsCsv, exactPoints, shownExact, type ExactView } from '../route-format.js';
import type { RouteTab, RouteTabContext } from './types.js';

type Kind = CrossingPoint['kind'];
const FAMILY_LABEL: Record<string, string> = {
  river: 'route.cross.row.river', road: 'route.cross.row.road', rail: 'route.cross.row.rail',
  pipeline: 'route.cross.row.pipeline', line: 'route.cross.show.lines',
};

function cell(tr: HTMLElement, text: string | null, cls = 'rx-num'): void {
  const td = h('td', text === null ? `${cls} rx-na` : cls, text ?? t('route.cross.na'));
  tr.append(td);
}

function table(c: RouteCrossings, ctx: RouteTabContext, ex: ExactView | null): HTMLElement {
  const tbl = h('table', 'rx-table');
  tbl.setAttribute('aria-label', t('route.cross.table'));
  const hr = h('tr');
  [['route.cross.head.feature', ''], ['route.cross.head.crossings', ' rx-num'], ['route.cross.head.miles', ' rx-num'], ['route.cross.head.note', '']].forEach(([k, x]) => {
    const th = h('th', x.trim(), t(k));
    th.scope = 'col';
    hr.append(th);
  });
  const thead = h('thead');
  thead.append(hr);
  const body = h('tbody');
  let active: HTMLElement | null = null;
  for (const r of crossingRows(c, ex)) {
    const tr = h('tr', 'rx-row');
    tr.dataset.row = r.id;
    cell(tr, r.label, '');
    cell(tr, r.count === null ? null : approxCount(r.count));
    cell(tr, r.miles === null ? null : r.miles.toFixed(1));
    tr.append(h('td', 'rx-note', r.note));
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
  const box = h('div', 'rx-box rx-show');
  box.append(h('h4', undefined, t('route.cross.show')));
  for (const tg of TOGGLES) {
    const label = h('label');
    const cb = h('input');
    cb.type = 'checkbox';
    cb.checked = tg.kinds.every((k) => ctx.session.crossingKinds.includes(k));
    cb.dataset.kinds = tg.kinds.join(',');
    cb.addEventListener('change', () => ctx.showCrossings(tg.kinds, cb.checked));
    label.append(cb, h('span', 'rx-glyph', tg.glyph), h('span', undefined, t(tg.key)));
    box.append(label);
  }
  return box;
}

/** The button, the busy state, the failure line, or (with a result) the names list and the families not read. */
function exactBox(ctx: RouteTabContext, ex: ExactView | null): HTMLElement {
  const s = ctx.session, box = h('div', 'rx-exact');
  if (!ex) {
    const btn = h('button', 'rx-csv rx-exact-btn', t(s.exactBusy ? 'route.obs.busy' : 'route.obs.read'));
    btn.type = 'button';
    btn.disabled = !!s.exactBusy;
    btn.setAttribute('aria-busy', String(!!s.exactBusy));
    btn.addEventListener('click', () => ctx.listExactCrossings());
    box.append(btn);
    if (s.exactError && !s.exactBusy) box.append(h('p', 'rx-note', t('route.cross.exact.error', { reason: s.exactError })));
    return box;
  }
  for (const f of ex.failed) box.append(h('p', 'rx-note', t('route.cross.exact.failed', { kind: t(FAMILY_LABEL[f.family] ?? f.family), reason: f.note })));
  const pts = exactPoints(ex);
  if (!pts.length) return box;
  const tbl = h('table', 'rx-table rx-names');
  tbl.setAttribute('aria-label', t('route.cross.names'));
  const hr = h('tr');
  for (const [k, x] of [['route.cross.csv.kind', ''], ['route.cross.csv.name', ''], ['route.cross.csv.detail', ''], ['route.cross.csv.mile', 'rx-num']]) {
    const th = h('th', x, t(k));
    th.scope = 'col';
    hr.append(th);
  }
  const thead = h('thead'), body = h('tbody');
  thead.append(hr);
  for (const p of pts) {
    const tr = h('tr', 'rx-row rx-row--go');
    tr.tabIndex = 0;
    tr.title = t('route.cross.names.hint');
    tr.append(h('td', undefined, t(`route.cross.row.${p.kind}`)), h('td', p.name ? undefined : 'rx-na', p.name ?? t('route.cross.names.unnamed')),
      h('td', 'rx-note', p.detail ?? ''), h('td', 'rx-num', p.mi.toFixed(1)));
    const go = () => ctx.fitPoints([p.lngLat]);
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    body.append(tr);
  }
  tbl.append(thead, body);
  box.append(h('h4', 'rx-names-head', t('route.cross.names')), tbl);
  return box;
}

function download(c: RouteCrossings, ex: ExactView | null): void {
  const url = URL.createObjectURL(new Blob([crossingsCsv(c, ex)], { type: 'text/csv;charset=utf-8' }));
  const a = h('a');
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
    const left = h('div', 'rx-left');
    const csv = h('button', 'rx-csv', t('route.cross.csv'));
    csv.type = 'button';
    csv.addEventListener('click', () => download(c, ex));
    const bar = h('div', 'rx-bar');
    bar.append(csv);
    const exact = exactBox(ctx, ex);
    if (!ex) bar.append(exact);
    left.append(bar, table(c, ctx, ex));
    const av = aviationNote(c);
    if (av) left.append(h('p', 'rx-note rx-av-note', av));
    if (ex) left.append(exact, routeObservations(ex.screening));

    const sources = h('div', 'rx-box');
    sources.append(h('h4', undefined, t('route.cross.sources.heading')));
    if (ex) sources.append(h('p', undefined, t('route.cross.sources.exact')));
    sources.append(h('p', undefined, t('route.cross.sources')));
    const counts = { ...c.counts };
    for (const k of ex?.exact ?? []) counts[k] = ex!.result.counts[k];
    const right = h('div', 'rx-right');
    right.append(crossingPills(c, counts), showBox(ctx), sources);

    const grid = h('div', 'rx');
    grid.append(left, right);
    root.append(grid);
  },
};

export default tab;
