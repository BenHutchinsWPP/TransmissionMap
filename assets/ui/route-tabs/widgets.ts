// ─── Route panel widgets ─────────────────────────────────────────────────────
// Role: pure DOM builders the route tabs share — cost waterfall (drawn from `waterfallLines` in ../route-format.ts), rough-early-estimate range bar, crossing pills,
//       optimality badge, source ⓘ button, headline KPI tiles as elements (`kpis`, from `kpiTiles` in ../route-format.ts). Each returns an element; all text goes in through
//       textContent, so data is never parsed as HTML. Styling: widgets.css (rp-* classes,
//       app tokens only).
// Deps: ../route-format.ts (waterfall types, fmtMoneyHead, bandLabel, approxCount, kpiTiles), route/cost.ts (types), route/route.ts and
//       route/profile.ts (types only), i18n/index.ts, utils/utils-dom.ts (h), ./widgets.css.

import './widgets.css';
import { t } from '../../../src/i18n/index.js';
import { h } from '../../utils/utils-dom.js';
import type { CostResult } from '../../route/cost.js';
import type { RouteResult } from '../../route/route.js';
import type { RouteCrossings } from '../../route/profile.js';
import type { DollarYear } from './types.js';
import { approxCount, bandLabel, fmtMoneyHead, kpiTiles, type WaterfallGroup, type WaterfallLine, type WaterfallOpts } from '../route-format.js';

// ─── waterfall ───────────────────────────────────────────────────────────────

/** Keeps the `max − 1` largest |value| lines before the first subtotal and folds the rest into
 *  one "Other (n items)" line, so the sum is unchanged. */
function fold(lines: WaterfallLine[], max: number): WaterfallLine[] {
  const cut = lines.findIndex((l) => l.group === 'subtotal' || l.group === 'total');
  const head = cut < 0 ? lines : lines.slice(0, cut);
  const tail = cut < 0 ? [] : lines.slice(cut);
  if (head.length <= max) return lines;
  const keep = new Set([...head].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, Math.max(0, max - 1)));
  const rest = head.filter((l) => !keep.has(l));
  const other: WaterfallLine = {
    label: t('route.wf.otherItems', { n: rest.length }), group: 'other', value: rest.reduce((s, l) => s + l.value, 0),
  };
  return [...head.filter((l) => keep.has(l)), other, ...tail];
}

const signed = (v: number, money: (v: number) => string) => (v < 0 ? '−' : '+') + money(Math.abs(v));

export function waterfall(lines: WaterfallLine[], opts: WaterfallOpts): HTMLElement {
  const shown = opts.compact && opts.maxLines ? fold(lines, opts.maxLines) : lines;
  // Geometry: floating bars start where the previous ended; subtotal/total start at 0.
  let cursor = 0, max = 0;
  const spans = shown.map((l) => {
    const full = l.group === 'subtotal' || l.group === 'total';
    const from = full ? 0 : cursor, to = full ? l.value : cursor + l.value;
    cursor = to;
    max = Math.max(max, from, to);
    return { lo: Math.min(from, to), hi: Math.max(from, to) };
  });
  const scale = max > 0 ? max : 1;
  const root = h('div', `rp-wf${opts.compact ? ' rp-wf--compact' : ''}`);
  shown.forEach((l, i) => {
    const row = h('div', `rp-wf-row rp-wf-row--${l.group}`);
    const lab = h('span', 'rp-wf-lab', l.label);
    lab.title = l.src ? `${l.label}\n${l.src}` : l.label;
    const track = h('span', 'rp-wf-track');
    track.setAttribute('aria-hidden', 'true');
    const bar = h('span', 'rp-wf-bar');
    const { lo, hi } = spans[i];
    bar.style.left = `${(Math.max(lo, 0) / scale) * 100}%`;
    bar.style.width = `${Math.max(((hi - lo) / scale) * 100, 0.35)}%`;
    track.append(bar);
    const full = l.group === 'subtotal' || l.group === 'total';
    row.append(lab, track, h('span', 'rp-wf-val', full ? opts.money(l.value) : signed(l.value, opts.money)));
    root.append(row);
  });
  const legend = h('div', 'rp-wf-legend');
  const groups: WaterfallGroup[] = ['base', 'multipliers', 'terminals', 'markups', 'contingency', 'other'];
  for (const g of groups) {
    if (!shown.some((l) => l.group === g)) continue;
    const item = h('span', `rp-wf-row--${g}`);
    item.append(h('i'), document.createTextNode(t(`route.wf.legend.${g}`)));
    legend.append(item);
  }
  const wrap = h('div', 'rp-wf-wrap');
  wrap.append(root, legend);
  return wrap;
}

// ─── range bar ───────────────────────────────────────────────────────────────

/** Estimate low / point / high. The band is stored in 2025$; `dollars: 'preset'` rescales it. */
export function rangeBar(cost: CostResult, dollars: DollarYear = 'y2025'): HTMLElement {
  const k = dollars === 'preset' && cost.total2025 ? cost.totalNominal / cost.total2025 : 1;
  const low = cost.band.low * k, high = cost.band.high * k, pt = cost.total2025 * k;
  const pad = (high - low) * 0.1 || 1;
  const a = low - pad, span = high + pad - a;
  const pos = (v: number) => `${((v - a) / span) * 100}%`;
  const pct = (v: number) => `${v < pt ? '−' : '+'}${Math.round((Math.abs(v - pt) / (pt || 1)) * 100)}`;

  const root = h('div', 'rp-range');
  const lab = h('div', 'rp-range-lab');
  lab.append(h('b', undefined, bandLabel(cost.band.label)), ' ', h('span', undefined, t('route.range.pct', { lo: pct(low), hi: pct(high) })));
  const track = h('div', 'rp-range-track');
  const band = h('span', 'rp-range-band');
  band.style.left = pos(low);
  band.style.width = `${((high - low) / span) * 100}%`;
  const mark = h('span', 'rp-range-pt');
  mark.style.left = pos(pt);
  mark.title = t('route.range.point');
  track.append(band, mark);
  const ticks = h('div', 'rp-range-ticks');
  for (const [v, bold] of [[low, false], [pt, true], [high, false]] as const) {
    const s = h('span');
    s.style.left = pos(v);
    s.append(bold ? h('b', undefined, fmtMoneyHead(v)) : document.createTextNode(fmtMoneyHead(v)));
    ticks.append(s);
  }
  root.append(lab, track, ticks);
  return root;
}

// ─── pills, badge, source, KPIs ─────────────────────────────────────

const plural = (key: string, n: number) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n: approxCount(n) });

/** `counts` replaces c.counts (the Crossings tab passes the exact counts merged in). */
export function crossingPills(c: RouteCrossings, counts: RouteCrossings['counts'] = c.counts): HTMLElement {
  const root = h('div', 'rp-pills');
  const n = counts;
  const items: [string, number][] = [
    ['route.pill.river', n.river], ['route.pill.road', n.road], ['route.pill.rail', n.rail],
    ['route.pill.pipeline', n.pipeline], ['route.pill.lines', n.line230 + n.line100],
  ];
  for (const [key, count] of items) if (count > 0) root.append(h('span', 'rp-pill', plural(key, count)));
  const prot = c.miles.gap12 + c.miles.gap3;
  if (prot > 0) root.append(h('span', 'rp-pill', t('route.pill.protected', { mi: prot.toFixed(1) })));
  return root;
}


export function badge(optimality: RouteResult['optimality']): HTMLElement {
  const b = h('span', `rp-badge rp-badge--${optimality}`, t(`route.badge.${optimality}`));
  b.title = t(`route.badge.${optimality}.tip`);
  return b;
}

export function sourceInfo(src: string): HTMLElement {
  const b = h('button', 'rp-info', 'ⓘ');
  b.type = 'button';
  b.title = src;
  b.setAttribute('aria-label', src);
  return b;
}

export function kpis(result: RouteResult, dollars: DollarYear = 'y2025'): HTMLElement {
  const root = h('div', 'rp-kpis');
  for (const k of kpiTiles(result, dollars)) {
    const d = h('div', 'rp-kpi');
    d.append(h('span', 'rp-kpi-v', k.value), h('span', 'rp-kpi-l', k.label));
    root.append(d);
  }
  return root;
}
