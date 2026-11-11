// ─── Route panel: Alternatives sub-tab ────────────────────────────────────────────────
// Role: Alternatives tab. Before a search: an explainer and "Find alternatives"; then the
//       routes as a list (lowest routing score first; selecting one fits the map to it, "Make this the
//       result" promotes it), the similar-cost-areas threshold and toggle, a compare table
//       (lowest routing score vs each Alt, rows that differ by default) with a plain-language note, and
//       a GeoJSON export of all routes. Renders from ctx.session; changes the map only
//       through the context's calls. disabled() is final. The selected row and the "only rows
//       that differ" box are kept per session (WeakMap) and reset when a different route is shown;
//       the "none found" text names the stretch the search used (session.altStretch).
//       While an alternative is the shown result (session.fromAlt), the lowest-score route is
//       listed as "Lowest routing score" with its own make button (makeAltResult(-1));
//       otherRoutes() is that list, also drawn and exported by ui-route.ts.
// Deps: route/route.ts (types), route-tabs/types.ts (types), route-tabs/colours.ts, i18n (t), ./alternatives.css.

import './alternatives.css';
import { t } from '../../../src/i18n/index.js';
import type { RouteAlternative, RouteResult } from '../../route/route.js';
import type { RouteSession, RouteTab, RouteTabContext, SurfaceThreshold } from './types.js';
import { ALT_COLOURS, OPTIMAL_OTHER, PLAIN } from './colours.js';

const THRESHOLDS: SurfaceThreshold[] = [0.02, 0.05, 0.10, 0.20];
const MIN_DIFF_MI = 0.1;

/** View state per pane (a reopened pane starts clean); reset when a new result is shown. */
interface View { path: unknown; selected: number; onlyDiffer: boolean }   // selected: 0 = optimal, n = Alt n
const views = new WeakMap<RouteSession, View>();
function viewFor(s: RouteSession): View {
  const path = s.result?.path;
  let v = views.get(s);
  // Find alternatives merges into a copy with the same path: the view stays; another route resets it.
  if (!v || v.path !== path) { v = { path, selected: 0, onlyDiffer: true }; views.set(s, v); }
  return v;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, key?: string, params?: Record<string, string | number>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (key) { e.dataset.i18n = key; e.textContent = t(key, params); }
  return e;
}

const mi1 = (v: number) => v.toFixed(1);
const altColour = (i: number) => ALT_COLOURS[i % ALT_COLOURS.length];

/** A route listed beside the shown one: Alt n (`alt` = n − 1, numbered as found) or, while an
 *  alternative is shown, the least-cost route (`alt` = −1). */
export interface OtherRoute {
  alt: number; name: string; colour: string; path: GeoJSON.LineString; lengthMi: number;
  cost: RouteResult['cost']; crossings?: RouteAlternative['crossings']; pctRoute: number; sharedWithRoute: number | null;
}

/** The routes beside the shown result, in list order: the least-cost route first while an
 *  alternative is shown, then every alternative except the shown one. */
export function otherRoutes(s: RouteSession): OtherRoute[] {
  const opt = s.optimal ?? s.result;
  if (!opt) return [];
  const out: OtherRoute[] = [];
  if (s.fromAlt && s.optimal) {
    out.push({ alt: -1, name: t('route.alt.optimalOther'), colour: OPTIMAL_OTHER, path: opt.path, lengthMi: opt.lengthMi,
      cost: opt.cost, crossings: opt.profile?.crossings, pctRoute: 0, sharedWithRoute: null });
  }
  (opt.alternatives ?? []).forEach((a, i) => {
    if (s.fromAlt === i + 1) return;
    out.push({ alt: i, name: t('route.alt.name', { n: i + 1 }), colour: altColour(i), path: a.path, lengthMi: a.lengthMi,
      cost: a.cost, crossings: a.crossings, pctRoute: a.pctRoute, sharedWithRoute: a.sharedWithRoute });
  });
  return out;
}

/** One route as the compare table and note read it (`alt`: −2 the shown route, else as OtherRoute). */
interface Col {
  alt: number; colour: string;
  name: string; lengthMi: number; tribal: number; prot: number | null; crossings: number | null;
  angles: number; pctRoute: number | null; shared: number | null; total: number; low: number; high: number;
  path: GeoJSON.LineString;
}

function protectedMi(c?: { miles: { gap12: number; gap3: number } }): number | null {
  return c ? c.miles.gap12 + c.miles.gap3 : null;
}
function crossingTotal(c?: { counts: Record<string, number> }): number | null {
  return c ? (c.counts.river ?? 0) + (c.counts.road ?? 0) + (c.counts.rail ?? 0) : null;
}

function columns(ctx: RouteTabContext): Col[] {
  const s = ctx.session, r = s.result!, n = s.fromAlt;
  const cols: Col[] = [{
    alt: -2, colour: PLAIN,
    name: n ? t('route.alt.name', { n }) : t('route.alt.optimalName'), lengthMi: r.lengthMi, tribal: r.tribalMiles, prot: protectedMi(r.profile?.crossings),
    crossings: crossingTotal(r.profile?.crossings), angles: r.path.coordinates.length - 2,
    pctRoute: n ? s.optimal?.alternatives?.[n - 1]?.pctRoute ?? null : 0, shared: n ? s.optimal?.alternatives?.[n - 1]?.sharedWithRoute ?? null : null,
    total: r.cost.total2025, low: r.cost.band.low, high: r.cost.band.high, path: r.path,
  }];
  for (const a of otherRoutes(s)) cols.push({
    alt: a.alt, colour: a.colour, name: a.name, lengthMi: a.lengthMi, tribal: a.cost.tribalMiles, prot: protectedMi(a.crossings),
    crossings: crossingTotal(a.crossings), angles: a.path.coordinates.length - 2, pctRoute: a.pctRoute, shared: a.sharedWithRoute,
    total: a.cost.total2025, low: a.cost.band.low, high: a.cost.band.high, path: a.path,
  });
  return cols;
}
/** The least-cost route's column: the first unless an alternative is shown. */
const isOptimal = (c: Col, ctx: RouteTabContext) => c.alt === -1 || (c.alt === -2 && !ctx.session.fromAlt);

function note(cols: Col[]): string {
  const [opt, ...alts] = cols;
  const out: string[] = [];
  for (const a of alts) {
    const parts: string[] = [];
    const dl = a.lengthMi - opt.lengthMi;
    if (Math.abs(dl) >= MIN_DIFF_MI) parts.push(t(dl > 0 ? 'route.alt.d.longer' : 'route.alt.d.shorter', { mi: mi1(Math.abs(dl)) }));
    const dt = a.tribal - opt.tribal;
    if (dt >= MIN_DIFF_MI) parts.push(t('route.alt.d.tribalMore', { mi: mi1(dt) }));
    else if (dt <= -MIN_DIFF_MI) parts.push(t('route.alt.d.tribalLess', { mi: mi1(-dt) }));
    if (a.prot != null && opt.prot != null) {
      const dp = a.prot - opt.prot;
      if (dp >= MIN_DIFF_MI) parts.push(t('route.alt.d.protMore', { mi: mi1(dp) }));
      else if (dp <= -MIN_DIFF_MI) parts.push(t('route.alt.d.protLess', { mi: mi1(-dp) }));
    }
    out.push(parts.length
      ? t('route.alt.d.sentence', { name: a.name, parts: parts.join(t('route.alt.d.and')) })
      : t('route.alt.d.same', { name: a.name }));
  }
  return out.join(' ');
}

function exportGeojson(ctx: RouteTabContext, cols: Col[]): void {
  const r = ctx.session.result!;
  const fc: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: cols.map((c, i) => ({
      type: 'Feature', geometry: c.path, properties: {
        name: c.name, kind: i === 0 ? 'route' : 'alternative', preset: r.preset.id, lengthMi: +c.lengthMi.toFixed(2),
        total2025Usd: Math.round(c.total), low2025Usd: Math.round(c.low), high2025Usd: Math.round(c.high),
        tribalMiles: +c.tribal.toFixed(2), protectedGap123Miles: c.prot == null ? null : +c.prot.toFixed(2),
        crossings: c.crossings, anglePoints: c.angles,
        routingScoreAboveLowestPct: c.pctRoute == null ? null : +c.pctRoute.toFixed(2),
        sharedWithLowest: c.shared == null ? null : +c.shared.toFixed(3),
      },
    })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'route-alternatives.geojson';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function list(ctx: RouteTabContext, view: View, cols: Col[], redraw: () => void): HTMLElement {
  const ul = el('ul', 'ra-list');
  ul.setAttribute('aria-label', t('route.alt.listLabel'));
  cols.forEach((c, i) => {
    const li = el('li', 'ra-item');
    const b = el('button', 'ra-row');
    b.type = 'button';
    b.dataset.idx = String(i);
    b.setAttribute('aria-pressed', String(i === view.selected));
    const sw = el('span', 'ra-sw');
    sw.style.background = c.colour;
    const money = ctx.money(c.total, c.total);
    const text = el('span');
    const n = c.alt === -2 ? ctx.session.fromAlt ?? 0 : c.alt + 1;
    if (c.alt === -1) text.textContent = t('route.alt.optimalRow', { mi: mi1(c.lengthMi), usd: money });
    else if (isOptimal(c, ctx)) text.textContent = t('route.alt.optimal', { mi: mi1(c.lengthMi), usd: money });
    else text.textContent = t('route.alt.row', { n, pct: (c.pctRoute ?? 0).toFixed(1), mi: mi1(c.lengthMi), usd: money });
    b.append(sw, text);
    if (i > 0 && c.tribal > 0) {
      const tr = el('span', 'ra-tribal');
      tr.textContent = ` · ${t('route.alt.rowTribal', { mi: mi1(c.tribal) })}`;
      text.append(tr);
    }
    b.addEventListener('click', () => {
      view.selected = i;
      ctx.fitPoints(c.path.coordinates as [number, number][]);
      redraw();
    });
    li.append(b);
    if (i > 0) {
      const mk = el('button', 'ra-btn', 'route.alt.make');
      mk.type = 'button';
      mk.dataset.make = String(c.alt);
      mk.setAttribute('aria-label', c.alt === -1 ? t('route.alt.makeOptimal') : t('route.alt.makeN', { n }));
      mk.addEventListener('click', () => ctx.makeAltResult(c.alt));
      li.append(mk);
    }
    ul.append(li);
  });
  return ul;
}

function thresholdControl(ctx: RouteTabContext): HTMLElement {
  const wrap = el('div', 'ra-thr');
  const lab = el('span', undefined, 'route.alt.thresholdLabel');
  lab.id = 'ra-thr-lab';
  const group = el('div', 'ra-seg');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', lab.id);
  const mark = () => {
    for (const b of group.querySelectorAll<HTMLButtonElement>('button')) {
      const on = Number(b.dataset.thr) === ctx.session.threshold;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  for (const th of THRESHOLDS) {
    const b = el('button', 'ra-seg-btn');
    b.type = 'button';
    b.dataset.thr = String(th);
    b.setAttribute('role', 'radio');
    b.textContent = t('route.alt.thr', { pct: Math.round(th * 100) });
    b.addEventListener('click', () => { ctx.setThreshold(th); ctx.session.threshold = th; mark(); });
    group.append(b);
  }
  group.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = THRESHOLDS[(THRESHOLDS.indexOf(ctx.session.threshold) + step + THRESHOLDS.length) % THRESHOLDS.length];
    group.querySelector<HTMLElement>(`[data-thr="${next}"]`)?.click();
    group.querySelector<HTMLElement>(`[data-thr="${next}"]`)?.focus();
  });
  mark();
  wrap.append(lab, group);
  return wrap;
}

function surfaceControl(ctx: RouteTabContext): HTMLElement {
  const wrap = el('div', 'ra-surface');
  const s = ctx.session.result!.surface;
  const skipped = s && 'skipped' in s ? s.skipped : null;
  const label = el('label', 'ra-check');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = ctx.session.showSurface && !skipped;
  cb.disabled = !!skipped;
  cb.addEventListener('change', () => ctx.showSurface(cb.checked));
  const span = el('span', undefined, 'route.alt.showSurface');
  label.append(cb, span);
  wrap.append(label);
  if (skipped) wrap.append(el('p', 'ra-note', 'route.alt.surfaceSkipped', { reason: skipped }));
  return wrap;
}

interface Row { key: string; cells: string[]; hi?: boolean[]; bar?: (number | null)[] }

function rows(ctx: RouteTabContext, cols: Col[]): Row[] {
  const num = (v: number | null, f: (x: number) => string) => (v == null ? '—' : f(v));
  const mi = (v: number | null) => num(v, (x) => t('route.alt.mi', { mi: mi1(x) }));
  return [
    { key: 'above', cells: cols.map((c) => (isOptimal(c, ctx) ? t('route.alt.leastCost') : num(c.pctRoute, (x) => t('route.alt.pct', { pct: `+${x.toFixed(1)}` })))) },
    { key: 'total', cells: cols.map((c) => ctx.money(c.total, c.total)) },
    { key: 'range', cells: cols.map((c) => `${ctx.money(c.low, c.low)} – ${ctx.money(c.high, c.high)}`) },
    { key: 'length', cells: cols.map((c) => mi(c.lengthMi)) },
    { key: 'tribal', cells: cols.map((c) => mi(c.tribal)), hi: cols.map((c) => c.tribal > 0) },
    { key: 'protected', cells: cols.map((c) => mi(c.prot)) },
    { key: 'crossings', cells: cols.map((c) => num(c.crossings, String)) },
    { key: 'shared', cells: cols.map((c) => num(c.shared, (x) => t('route.alt.pct', { pct: Math.round(x * 100) }))), bar: cols.map((c) => c.shared) },
    { key: 'angles', cells: cols.map((c) => String(c.angles)) },
  ];
}

function compareTable(ctx: RouteTabContext, cols: Col[], onlyDiffer: boolean): HTMLElement {
  const table = el('table', 'ra-table');
  const head = document.createElement('tr');
  head.append(document.createElement('th'));
  for (const c of cols) { const th = el('th'); th.scope = 'col'; th.textContent = c.name; head.append(th); }
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  for (const r of rows(ctx, cols)) {
    if (onlyDiffer && r.cells.every((c) => c === r.cells[0])) continue;
    const tr = document.createElement('tr');
    tr.dataset.row = r.key;
    const th = el('th', undefined, `route.alt.row.${r.key}`);
    th.scope = 'row';
    tr.append(th);
    r.cells.forEach((text, i) => {
      const td = el('td', r.hi?.[i] ? 'ra-hi' : undefined);
      td.textContent = text;
      const share = r.bar?.[i];
      if (share != null) {
        const bar = el('span', 'ra-bar');
        const fill = document.createElement('i');
        fill.style.width = `${Math.round((1 - share) * 100)}%`;
        bar.append(fill);
        td.append(bar);
      }
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

const tab: RouteTab = {
  id: 'alternatives',
  labelKey: 'route.sub.alternatives',
  disabled: (s) => (s.result?.optimality === 'not-solved' ? t('route.sub.why.noAlts') : null),
  render(root, ctx) {
    const s = ctx.session;
    const r = s.result;
    root.replaceChildren();
    if (!r) return;
    const redraw = () => tab.render(root, ctx);
    const left = el('div', 'ra-left');
    const right = el('div', 'ra-right');
    const requested = r.alternatives !== undefined || r.altFound !== undefined || r.altSkipped !== undefined;
    const found = r.alternatives ?? [];

    if (s.altsSolving) {
      const p = el('p', 'ra-note');
      p.setAttribute('role', 'status');
      p.append(el('span', 'ra-spin'), el('span', undefined, 'route.alt.solving'));
      left.append(p);
    } else if (s.altsError) {
      const p = el('p', 'ra-note ra-err');
      p.setAttribute('role', 'alert');
      p.textContent = t('route.alt.error', { reason: s.altsError });
      const retry = el('button', 'ra-btn', 'route.alt.retry');
      retry.type = 'button';
      retry.addEventListener('click', () => ctx.findAlternatives());
      left.append(p, retry);
    } else if (!requested) {
      const btn = el('button', 'ra-btn ra-btn--primary', 'route.alt.find');
      btn.type = 'button';
      btn.addEventListener('click', () => ctx.findAlternatives());
      left.append(el('p', 'ra-note', 'route.alt.intro'), btn);
    } else if (found.length === 0) {
      const p = el('p', 'ra-note');
      p.dataset.none = '1';
      p.textContent = r.altSkipped ?? t('route.alt.none', { stretch: Math.round(s.altStretch * 100) });
      left.append(p);
    } else {
      const cols = columns(ctx);
      const view = viewFor(s);
      if (view.selected >= cols.length) view.selected = 0;
      left.append(list(ctx, view, cols, redraw), el('p', 'ra-note', 'route.alt.distinct'));
      const only = el('label', 'ra-check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = view.onlyDiffer;
      cb.addEventListener('change', () => { view.onlyDiffer = cb.checked; redraw(); });
      only.append(cb, el('span', undefined, 'route.alt.onlyDiffer'));
      const exp = el('button', 'ra-btn', 'route.alt.export');
      exp.type = 'button';
      exp.addEventListener('click', () => exportGeojson(ctx, cols));
      const nt = el('p', 'ra-note');
      nt.dataset.note = '1';
      nt.textContent = note(cols);
      right.append(el('h4', 'ra-h', 'route.alt.compare'), compareTable(ctx, cols, view.onlyDiffer), only, nt, exp);
    }
    left.append(thresholdControl(ctx), surfaceControl(ctx));
    const grid = el('div', 'ra');
    grid.append(left);
    if (right.childElementCount) grid.append(right);
    root.append(grid);
  },
};

export default tab;
