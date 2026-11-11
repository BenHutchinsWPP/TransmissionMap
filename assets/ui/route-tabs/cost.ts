// ─── Route panel: Cost sub-tab ───────────────────────────────────────────────
// Role: "From base $/mi to total" — a dollar-year toggle (2025$ | preset year), the full waterfall
//       (left), headline KPIs, the rough-early-estimate range bar and a line-item table (right) whose 2025$ column (and the
//       method-year column, behind a checkbox) sum to the totals. Renders from ctx.session; the toggle sets
//       session.dollars and calls ctx.rerender(). Source text is set through textContent. Terminals are one
//       row per kind (stations, line positions: `terminalSplit`, "n × each"), and a figure the visitor entered
//       reads "entered by you" (`costSrc`). The rows read the preset as the solve used it (`solvedPresetOf`:
//       the method with its patch), so an all-in estimate shows no markup rows.
// Deps: route-tabs/widgets.ts, route-tabs/method.ts (solvedPresetOf), route-tabs/types.ts (types), route/cost.ts (types),
//       registry/route-presets.ts, i18n (t), ./cost.css.

import './cost.css';
import { t } from '../../../src/i18n/index.js';
import { ROUTE_PRESETS, routePreset, type RoutePreset } from '../../../src/registry/route-presets.js';
import type { CostResult } from '../../route/cost.js';
import { costSrc, kpis, rangeBar, sourceInfo, terminalSplit, waterfall, waterfallLines } from './widgets.js';
import { solvedPresetOf } from './method.js';
import type { DollarYear, RouteSession, RouteTab, RouteTabContext } from './types.js';

/** Method-year dollars and the mitigation range are shown on request; per session, off by default. */
const showMethod = new WeakMap<RouteSession, boolean>();

const M_PER_MI = 1609.344;
const DOLLARS: DollarYear[] = ['y2025', 'preset'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface CostItem { key: string; label: string; basis: string; nominal: number; src: string }

const m1 = (usd: number) => (usd / 1e6).toFixed(1);

/** The table rows, in preset dollars; they sum to cost.totalNominal. */
export function costItems(cost: CostResult, preset: RoutePreset): CostItem[] {
  const line = preset.line_types[cost.lineType];
  const mi = cost.lengthM / M_PER_MI;
  const lf = cost.lengthFactor || 1;
  const raw = cost.lineUsdNominal / lf;
  const items: CostItem[] = [];
  const add = (key: string, label: string, basis: string, nominal: number, src = '') => items.push({ key, label, basis, nominal, src });

  add('base', t('route.cost.base'), t('route.cost.base.basis', { perMi: m1(mi ? cost.baseUsd / mi : 0), year: cost.dollarYear, mi: mi.toFixed(1) }), cost.baseUsd, costSrc(line?.base_per_mi.src, cost));
  add('mult', t('route.cost.mult'), t('route.cost.mult.basis', { x: cost.meanCostX.toFixed(2) }), raw - cost.baseUsd, t('route.cost.mult.src'));
  if (lf !== 1) add('short', t('route.cost.shortLine'), t('route.cost.shortLine.basis', { x: lf.toFixed(2) }), cost.lineUsdNominal - raw, preset.length_factor?.src);
  const split = terminalSplit(cost);
  if (!split) {
    if (cost.terminalsUsd) add('terminals', t('route.cost.terminals'), t('route.cost.terminals.basis', { n: cost.terminalCount, each: m1(cost.terminalsUsd / (cost.terminalCount || 1)) }), cost.terminalsUsd, costSrc(line?.terminals.src, cost, true));
  } else {
    const { stations: st, positions: po } = split;
    if (st?.usd) add('terminals', t('route.cost.terminals'), t('route.cost.terminals.basis', { n: st.n, each: m1(st.each) }), st.usd, costSrc(line?.terminals.src, cost, true));
    if (po?.usd) add('positions', t('route.cost.positions'), t('route.cost.terminals.basis', { n: po.n, each: m1(po.each) }), po.usd, costSrc(line?.terminals.position?.src, cost, true));
  }
  if (cost.mitigationUsd.mid) {
    add('mitigation', t('route.cost.mitigation'), t('route.cost.mitigation.basis', { lo: m1(cost.mitigationUsd.low), hi: m1(cost.mitigationUsd.high) }), cost.mitigationUsd.mid, preset.mitigation?.src);
  }
  if (cost.rowLand && cost.rowLand.usd) add('rowLand', t('route.cost.rowLand'), cost.rowLand.note, cost.rowLand.usd, preset.row_land?.note);
  // Markups compound on line + ROW land; each gets its share of markupsUsd.
  const markupBase = cost.lineUsdNominal + (cost.rowLand?.usd ?? 0);
  let x = 1;
  (cost.markupsUsd ? preset.markups : []).forEach((m, i) => {
    const usd = markupBase * x * (m.x - 1);
    x *= m.x;
    add(`markup${i}`, m.label, t('route.cost.markup.basis', { x: m.x }), usd, m.src);
  });
  if (cost.contingency) {
    add('contingency', t('route.cost.contingency'), t('route.cost.contingency.basis', { pct: Math.round(cost.contingency.pct * 1000) / 10 }), cost.contingency.usd, preset.contingency?.src);
  }
  return items;
}

function segmented(ctx: RouteTabContext, year: number): HTMLElement {
  const wrap = el('div', 'rc-head');
  const lab = el('span', 'rc-head-lab', t('route.cost.dollarYear'));
  lab.id = 'rc-dollars-lab';
  const group = el('div', 'rc-seg');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', lab.id);
  const label = (d: DollarYear) => (d === 'y2025' ? t('route.kpi.dollars.y2025') : t('route.kpi.dollars.preset', { year }));
  const pick = (d: DollarYear) => {
    if (d === ctx.session.dollars) return;
    ctx.session.dollars = d;
    ctx.rerender();
  };
  for (const d of DOLLARS) {
    const b = el('button', 'rc-seg-btn', label(d));
    b.type = 'button';
    b.dataset.dollars = d;
    b.setAttribute('role', 'radio');
    const on = d === ctx.session.dollars;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
    b.addEventListener('click', () => pick(d));
    group.append(b);
  }
  group.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    pick(DOLLARS[(DOLLARS.indexOf(ctx.session.dollars) + step + DOLLARS.length) % DOLLARS.length]);
  });
  wrap.append(lab, group);
  return wrap;
}

function methodToggle(ctx: RouteTabContext): HTMLElement {
  const lab = el('label', 'rc-method');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = showMethod.get(ctx.session) === true;
  box.addEventListener('change', () => {
    showMethod.set(ctx.session, box.checked);
    ctx.rerender();
  });
  const text = el('span', undefined, t('route.cost.showMethod'));
  text.dataset.i18n = 'route.cost.showMethod';
  lab.append(box, text);
  return lab;
}

function table(cost: CostResult, preset: RoutePreset, method: boolean): HTMLElement {
  const k = cost.totalNominal ? cost.total2025 / cost.totalNominal : 1;
  const n = preset.escalation.to_year - preset.dollar_year;
  const pct = n > 0 ? Math.round((k ** (1 / n) - 1) * 1000) / 10 : 0;
  const esc = t('route.cost.escalation', { f: k.toFixed(3), pct });
  const tbl = el('table', 'rc-table');
  const head = el('tr');
  const cols: [string, boolean][] = [
    [t('route.cost.col.item'), false], [t('route.cost.col.basis'), false],
    [t('route.cost.col.nominal', { year: cost.dollarYear }), true], [t('route.cost.col.y2025'), true], [t('route.cost.col.source'), false],
  ];
  cols.forEach(([text, num], i) => {
    const th = el('th', num ? 'rc-num' : undefined, text);
    if (i === 2) th.hidden = !method;
    head.append(th);
  });
  const thead = el('thead');
  thead.append(head);
  tbl.append(thead);
  const body = el('tbody');
  const row = (key: string, label: string, basis: string, nominal: number, src: string, cls?: string) => {
    const tr = el('tr', cls);
    tr.dataset.item = key;
    tr.dataset.nominal = String(nominal);
    tr.dataset.usd2025 = String(nominal * k);
    const source = el('td');
    if (src) {
      source.append(el('span', 'rc-src', src), ' ', sourceInfo(src));
    }
    const nom = el('td', 'rc-num', m1(nominal));
    nom.hidden = !method;
    tr.append(el('td', undefined, label), el('td', undefined, key === 'mitigation' && !method ? '' : basis), nom, el('td', 'rc-num', m1(nominal * k)), source);
    body.append(tr);
  };
  for (const it of costItems(cost, preset)) row(it.key, it.label, it.basis, it.nominal, it.src);
  row('total', t('route.cost.total'), '', cost.totalNominal, `${preset.escalation.src} · ${esc}`, 'rc-total');
  tbl.append(body);
  const wrap = el('div', 'rc-scroll');
  wrap.append(tbl);
  return wrap;
}

const tab: RouteTab = {
  id: 'cost',
  labelKey: 'route.sub.cost',
  disabled: () => null,
  render(root, ctx) {
    const r = ctx.session.result;
    root.replaceChildren();
    if (!r) return;
    const dollars = ctx.session.dollars;
    const money = (v: number) => ctx.money(v, v);
    const preset = (ctx.session.resultInputs ? solvedPresetOf(ctx.session.resultInputs) : null) ?? routePreset(r.preset.id) ?? routePreset(r.cost.preset) ?? ROUTE_PRESETS[0];
    const yearLabel = dollars === 'y2025' ? t('route.kpi.dollars.y2025') : t('route.kpi.dollars.preset', { year: r.cost.dollarYear });

    const left = el('div', 'rc-left');
    left.append(
      el('h4', 'rc-h', t('route.cost.heading', { dollars: yearLabel })),
      waterfall(waterfallLines(r.cost, preset, { dollars }), { money }),
    );
    const right = el('div', 'rc-right');
    right.append(kpis(r, dollars), rangeBar(r.cost, dollars), el('h4', 'rc-h', t('route.cost.items')), table(r.cost, preset, showMethod.get(ctx.session) === true));
    const grid = el('div', 'rc-grid');
    grid.append(left, right);
    const wrap = el('div', 'rc');
    wrap.append(segmented(ctx, r.cost.dollarYear), methodToggle(ctx), grid);
    root.append(wrap);
  },
};

export default tab;
