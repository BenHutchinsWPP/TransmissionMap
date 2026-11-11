// ─── Route panel widgets ─────────────────────────────────────────────────────
// Role: pure DOM builders the route tabs share — cost waterfall (+ `waterfallLines`, which
//       turns a CostResult into its lines, summing exactly to the total in either dollar
//       year; terminals as one line per kind, from `terminalSplit`; a figure the visitor entered shows
//       as such through `costSrc`), `fmtMoneyHead` (two-figure headline dollars), rough-early-estimate range bar, crossing pills, tribal note, optimality badge, source
//       ⓘ button, headline KPI tiles (`kpiTiles`, shared with the report model). Each returns an element; all text goes in through
//       textContent, so data is never parsed as HTML. Styling: widgets.css (rp-* classes,
//       app tokens only).
// Deps: route/cost.ts (greatCircleM, types), route/preset-patch.ts (USER_COST_SRC), route/categories.ts, route/route.ts and
//       route/profile.ts (types only), registry/route-presets.ts (types), i18n/index.ts, ./widgets.css.

import './widgets.css';
import { t } from '../../../src/i18n/index.js';
import { greatCircleM, type CostResult } from '../../route/cost.js';
import { USER_COST_SRC } from '../../route/preset-patch.js';
import { categoryLabelKey, routeCategory } from '../../route/categories.js';
import type { RouteResult } from '../../route/route.js';
import type { RouteCrossings } from '../../route/profile.js';
import type { RoutePreset } from '../../../src/registry/route-presets.js';
import type { DollarYear } from './types.js';

export type WaterfallGroup = 'base' | 'multipliers' | 'terminals' | 'markups' | 'contingency' | 'subtotal' | 'total' | 'other';
export interface WaterfallLine { label: string; value: number; group: WaterfallGroup; src?: string }
export interface WaterfallOpts { money: (v: number) => string; compact?: boolean; maxLines?: number }

const M_PER_MI = 1609.344;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

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
  const root = el('div', `rp-wf${opts.compact ? ' rp-wf--compact' : ''}`);
  shown.forEach((l, i) => {
    const row = el('div', `rp-wf-row rp-wf-row--${l.group}`);
    const lab = el('span', 'rp-wf-lab', l.label);
    lab.title = l.src ? `${l.label}\n${l.src}` : l.label;
    const track = el('span', 'rp-wf-track');
    track.setAttribute('aria-hidden', 'true');
    const bar = el('span', 'rp-wf-bar');
    const { lo, hi } = spans[i];
    bar.style.left = `${(Math.max(lo, 0) / scale) * 100}%`;
    bar.style.width = `${Math.max(((hi - lo) / scale) * 100, 0.35)}%`;
    track.append(bar);
    const full = l.group === 'subtotal' || l.group === 'total';
    row.append(lab, track, el('span', 'rp-wf-val', full ? opts.money(l.value) : signed(l.value, opts.money)));
    root.append(row);
  });
  const legend = el('div', 'rp-wf-legend');
  const groups: WaterfallGroup[] = ['base', 'multipliers', 'terminals', 'markups', 'contingency', 'other'];
  for (const g of groups) {
    if (!shown.some((l) => l.group === g)) continue;
    const item = el('span', `rp-wf-row--${g}`);
    item.append(el('i'), document.createTextNode(t(`route.wf.legend.${g}`)));
    legend.append(item);
  }
  const wrap = el('div', 'rp-wf-wrap');
  wrap.append(root, legend);
  return wrap;
}

/** A figure's source as shown: what the method cites, or "entered by you" for a figure from `cost_inputs` (a line figure with
 *  its year and basis; a terminal figure, `terminal`, with its year only: the basis is the line figure's). */
export function costSrc(src: string | undefined, cost: CostResult, terminal = false): string | undefined {
  if (src !== USER_COST_SRC) return src;
  const uc = cost.userCosts;
  if (terminal) return t('route.src.user.terminal', { year: uc?.year ?? '' });
  return t('route.src.user', { year: uc?.year ?? '', basis: t(uc?.basis === 'all-in' ? 'route.ci.basis.allin.short' : 'route.ci.basis.bare.short') });
}

export interface TerminalGroup { n: number; each: number; usd: number }
/** The terminals of a cost as stations (new and mid-line) and line positions, in method-year dollars. `usd` of a group
 *  is its items' sum, except that with both kinds the stations take what `terminalsUsd` leaves, so the two sum to
 *  `terminalsUsd` exactly. Null without `terminalItems` (a result from before kinds). */
export function terminalSplit(cost: CostResult): { stations: TerminalGroup | null; positions: TerminalGroup | null } | null {
  const items = cost.terminalItems;
  if (!items) return null;
  const total = cost.terminalsUsd ?? 0;
  const st = items.filter((i) => i.kind !== 'position'), po = items.filter((i) => i.kind === 'position');
  const group = (xs: typeof items, usd: number): TerminalGroup | null => (xs.length ? { n: xs.length, each: xs[0].usd, usd } : null);
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

  add(t('route.wf.base'), cost.baseUsd, 'base', costSrc(line?.base_per_mi.src, cost));
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
  if (!split) { if (cost.terminalsUsd) add(t('route.wf.terminals', { n: cost.terminalCount }), cost.terminalsUsd, 'terminals', costSrc(line?.terminals.src, cost, true)); }
  else {
    if (split.stations?.usd) add(t('route.wf.terminals', { n: split.stations.n }), split.stations.usd, 'terminals', costSrc(line?.terminals.src, cost, true));
    if (split.positions?.usd) add(t('route.wf.terminals.position', { n: split.positions.n }), split.positions.usd, 'terminals', costSrc(line?.terminals.position?.src, cost, true));
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

// ─── range bar ───────────────────────────────────────────────────────────────

/** The estimate class in the reader's language: the presets' rough-early-estimate band has a key; any other label shows as given. */
export const bandLabel = (label: string): string => (/^Rough early estimate\b/.test(label) ? t('route.range.class5') : label);

/** Estimate low / point / high. The band is stored in 2025$; `dollars: 'preset'` rescales it. */
export function rangeBar(cost: CostResult, dollars: DollarYear = 'y2025'): HTMLElement {
  const k = dollars === 'preset' && cost.total2025 ? cost.totalNominal / cost.total2025 : 1;
  const low = cost.band.low * k, high = cost.band.high * k, pt = cost.total2025 * k;
  const pad = (high - low) * 0.1 || 1;
  const a = low - pad, span = high + pad - a;
  const pos = (v: number) => `${((v - a) / span) * 100}%`;
  const pct = (v: number) => `${v < pt ? '−' : '+'}${Math.round((Math.abs(v - pt) / (pt || 1)) * 100)}`;

  const root = el('div', 'rp-range');
  const lab = el('div', 'rp-range-lab');
  lab.append(el('b', undefined, bandLabel(cost.band.label)), ' ', el('span', undefined, t('route.range.pct', { lo: pct(low), hi: pct(high) })));
  const track = el('div', 'rp-range-track');
  const band = el('span', 'rp-range-band');
  band.style.left = pos(low);
  band.style.width = `${((high - low) / span) * 100}%`;
  const mark = el('span', 'rp-range-pt');
  mark.style.left = pos(pt);
  mark.title = t('route.range.point');
  track.append(band, mark);
  const ticks = el('div', 'rp-range-ticks');
  for (const [v, bold] of [[low, false], [pt, true], [high, false]] as const) {
    const s = el('span');
    s.style.left = pos(v);
    s.append(bold ? el('b', undefined, fmtMoneyHead(v)) : document.createTextNode(fmtMoneyHead(v)));
    ticks.append(s);
  }
  root.append(lab, track, ticks);
  return root;
}

// ─── pills, tribal, badge, source, KPIs ─────────────────────────────────────

/** A crossing count as shown: "≈" + the number (counts come from 250 m cells or the drawn path, so they are estimates). */
export const approxCount = (n: number) => `≈${n}`;
const plural = (key: string, n: number) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n: approxCount(n) });

/** `counts` replaces c.counts (the Crossings tab passes the exact counts merged in). */
export function crossingPills(c: RouteCrossings, counts: RouteCrossings['counts'] = c.counts): HTMLElement {
  const root = el('div', 'rp-pills');
  const n = counts;
  const items: [string, number][] = [
    ['route.pill.river', n.river], ['route.pill.road', n.road], ['route.pill.rail', n.rail],
    ['route.pill.pipeline', n.pipeline], ['route.pill.lines', n.line230 + n.line100],
  ];
  for (const [key, count] of items) if (count > 0) root.append(el('span', 'rp-pill', plural(key, count)));
  const prot = c.miles.gap12 + c.miles.gap3;
  if (prot > 0) root.append(el('span', 'rp-pill', t('route.pill.protected', { mi: prot.toFixed(1) })));
  return root;
}

export function tribalNote(result: RouteResult): HTMLElement {
  const root = el('div', 'rp-tribal');
  root.hidden = !(result.tribalMiles > 0);
  root.append(el('b', undefined, t('route.tribal.heading', { mi: result.tribalMiles.toFixed(1) })), el('span', undefined, result.tribalNote ?? t('route.tribal.note')));
  return root;
}

export function badge(optimality: RouteResult['optimality']): HTMLElement {
  const b = el('span', `rp-badge rp-badge--${optimality}`, t(`route.badge.${optimality}`));
  b.title = t(`route.badge.${optimality}.tip`);
  return b;
}

export function sourceInfo(src: string): HTMLElement {
  const b = el('button', 'rp-info', 'ⓘ');
  b.type = 'button';
  b.title = src;
  b.setAttribute('aria-label', src);
  return b;
}

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

export function kpis(result: RouteResult, dollars: DollarYear = 'y2025'): HTMLElement {
  const root = el('div', 'rp-kpis');
  for (const k of kpiTiles(result, dollars)) {
    const d = el('div', 'rp-kpi');
    d.append(el('span', 'rp-kpi-v', k.value), el('span', 'rp-kpi-l', k.label));
    root.append(d);
  }
  return root;
}
