// ─── Route report ────────────────────────────────────────────────────────────
// Role: the printable Letter-size report of the shown route, opened by the route
//       pane's Report button through a dynamic import. Builds `#route-report` on demand
//       (title, badge, map snapshot, KPIs + estimate range, endpoints, optimality sentence,
//       waterfall, long-section strip, crossings table, tribal note, method, sources),
//       the crossings table taking the exact counts of the kinds session.exact covers while it belongs to
//       the shown result (crossings.ts shownExact); while some counted kinds are exact and some not, the exact rows
//       end in " (exact)" and the "approximate" sentence stands for the rest; all exact, one sentence saying the counts come from vector data and the miles from cells,
//       takes the map snapshot inside a `render` event after an unpadded refit (cell weights and
//       similar-cost areas at opacity 0 for it), restores the camera and those overlays, then prints with `body.printing-route-report` set (cleared, and the
//       section removed, on `afterprint`). Endpoints and method come from
//       `session.resultInputs` (what the shown result was solved with): a custom method
//       reads "{name} (based on {base})", and the session's edits are listed row by row
//       (category — note: routing ×a→b, cost ×c→d). All text goes in through textContent.
//       The wording and figures come from `route-report-model.ts` (`buildReportModel`); this file only
//       lays them out, so the PDF and the print show the same text (including the method's uploaded-layer lines).
// Deps: route-report-model.ts (the model), route-tabs/widgets.ts (builders), route-tabs/types.ts (types),
//       route-observations.ts (shared building/aviation tables), state.ts (map), i18n, ./route-report.css.

import './route-report.css';
import { state } from '../state.js';
import type { RouteTabContext } from './route-tabs/types.js';
import { routeObservations } from './route-observations.js';
import { buildReportModel, fillTpl, type RouteReportModel } from './route-report-model.js';
import { badge, kpis, rangeBar, tribalNote, waterfall } from './route-tabs/widgets.js';
import { t } from '../../src/i18n/index.js';

const SVG = 'http://www.w3.org/2000/svg';
const OVERLAYS = ['rp-weight', 'rp-surface'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Cost × track and land-manager track as small SVG bars over the profile's runs. */
function strip(m: NonNullable<RouteReportModel['strip']>): SVGSVGElement {
  const W = 700, H = 46;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'rr-strip');
  const x = (mi: number) => (mi / (m.lengthMi || 1)) * W;
  const rect = (mi0: number, mi1: number, y: number, fill: string) => {
    const r = document.createElementNS(SVG, 'rect');
    r.setAttribute('x', String(x(mi0)));
    r.setAttribute('y', String(y));
    r.setAttribute('width', String(Math.max(0.5, x(mi1) - x(mi0))));
    r.setAttribute('height', '16');
    r.setAttribute('fill', fill);
    svg.append(r);
  };
  for (const run of m.runs) {
    rect(run.mi0, run.mi1, 0, run.costFill);
    rect(run.mi0, run.mi1, 24, run.agencyFill);
  }
  const title = document.createElementNS(SVG, 'title');
  title.textContent = m.title;
  svg.append(title);
  const label = (mi: number, anchor: string, text: string) => {
    const tx = document.createElementNS(SVG, 'text');
    tx.setAttribute('x', String(x(mi)));
    tx.setAttribute('y', String(H - 2));
    tx.setAttribute('font-size', '9');
    tx.setAttribute('text-anchor', anchor);
    tx.textContent = text;
    svg.append(tx);
  };
  label(0, 'start', m.startLabel);
  label(m.lengthMi, 'end', m.endLabel);
  return svg;
}

function crossingsTable(c: NonNullable<RouteReportModel['crossings']>): HTMLElement {
  const wrap = el('div');
  const table = el('table');
  table.setAttribute('aria-label', t('route.cross.table'));
  const head = el('tr');
  c.head.forEach((h, i) => head.append(el('th', i > 0 ? 'rr-n' : undefined, h)));
  table.append(head);
  for (const r of c.rows) {
    const tr = el('tr');
    tr.append(el('td', undefined, r.label), el('td', 'rr-n', r.count), el('td', 'rr-n', r.miles));
    table.append(tr);
  }
  wrap.append(table);
  if (c.aviationNote) wrap.append(el('p', 'rr-small', c.aviationNote));
  wrap.append(el('p', 'rr-small', c.note));
  return wrap;
}

function section(h: string, ...kids: (Node | string)[]): HTMLElement {
  const s = el('section');
  s.append(el('h2', undefined, h), ...kids);
  return s;
}

/** Refit the route without drawer padding, capture the canvas in a render event, restore the camera, then call done. */
function snapshot(coords: number[][], img: HTMLImageElement, na: HTMLElement, done: () => void): void {
  const map = state.map;
  if (!map || coords.length < 1) { na.hidden = false; img.hidden = true; done(); return; }
  const cam = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    restore();
    map.jumpTo(cam);
    done();
  };
  // The cell-weight and similar-cost rasters stay out of the snapshot: hidden by opacity for the one frame, then restored.
  const overlays = OVERLAYS.filter((id) => map.getLayer(id)).map((id) => [id, map.getPaintProperty(id, 'raster-opacity')] as const);
  for (const [id] of overlays) {
    map.setPaintProperty(id, 'raster-opacity-transition', { duration: 0, delay: 0 });
    map.setPaintProperty(id, 'raster-opacity', 0);
  }
  const restore = () => { for (const [id, v] of overlays) if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', v); };
  const timer = setTimeout(() => { na.hidden = false; img.hidden = true; finish(); }, 2000);
  const lngs = coords.map((p) => p[0]), lats = coords.map((p) => p[1]);
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 24, duration: 0, animate: false });
  map.once('render', () => {
    try {
      img.src = map.getCanvas().toDataURL('image/png');
      img.hidden = false;
      na.hidden = true;
    } catch {
      na.hidden = false;
      img.hidden = true;
    }
    finish();
  });
  map.triggerRepaint();
}

export function openRouteReport(ctx: RouteTabContext): void {
  const { session } = ctx;
  const result = session.result;
  if (!result) return;
  document.getElementById('route-report')?.remove();
  const money = (v: number) => ctx.money(v, v);
  const m = buildReportModel(session, money);
  if (!m) return;

  const root = el('section');
  root.id = 'route-report';
  const head = el('header');
  head.append(el('h1', undefined, m.title), el('p', 'rr-sub', m.subtitle), badge(result.optimality));

  const img = el('img', 'rr-snap');
  img.alt = m.snapshot.alt;
  img.hidden = true;
  const na = el('div', 'rr-snap-na', m.snapshot.unavailable);
  na.hidden = true;

  const wf = waterfall(m.waterfall.lines, { money });

  root.append(head, img, na);
  root.append(section(m.cost.heading, kpis(result, money, session.dollars), rangeBar(result.cost, money, session.dollars), el('p', 'rr-small', m.cost.note)));
  root.append(section(m.endpoints.heading, el('div', undefined, m.endpoints.a), el('div', undefined, m.endpoints.b), el('p', undefined, m.endpoints.optimality)));
  root.append(section(m.waterfall.heading, wf));
  if (m.strip) {
    const along = section(m.strip.heading, el('div', 'rr-legend', m.strip.legend), strip(m.strip));
    along.className = 'rr-keep';   // prints whole: its heading never ends a page without its tracks
    root.append(along);
  }
  if (m.crossings) root.append(section(m.crossings.heading, crossingsTable(m.crossings)));
  if (m.observations) root.append(routeObservations(m.observations.screening));
  root.append(tribalNote(result));
  const me = m.method;
  const edits: Node[] = [];
  if (me.editsSummary !== null) {
    edits.push(el('p', undefined, me.editsSummary));
    const ul = el('ul', 'rr-edits');
    for (const line of me.edits) ul.append(el('li', undefined, line));
    edits.push(ul);
  }
  if (me.uploads.length) {
    const ul = el('ul', 'rr-edits');
    for (const u of me.uploads) ul.append(el('li', undefined, fillTpl(u)));
    edits.push(ul);
  }
  root.append(section(
    me.heading,
    el('p', undefined, me.preset),
    ...edits,
    el('p', undefined, me.attribution),
    el('p', undefined, me.caveat),
    el('p', undefined, me.class5),
    el('p', undefined, me.grid),
    el('h2', undefined, me.sourcesHeading), el('p', undefined, me.sources),
  ));
  root.append(section(m.caveats.heading, el('p', undefined, m.caveats.screening), el('p', 'rr-small', m.caveats.credit)));
  document.body.append(root);

  snapshot(result.path.coordinates, img, na, () => {
    const cleanup = () => {
      document.body.classList.remove('printing-route-report');
      root.remove();
    };
    window.addEventListener('afterprint', cleanup, { once: true });
    document.body.classList.add('printing-route-report');
    window.print();
  });
}
