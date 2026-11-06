// ─── timeline (Vega-Lite): a measure by year, stacked by category ────────────
// Role: the catalogue's `timeline` builder, (payload) → Vega-Lite spec with
//       its data inline: payload.rows summed per (year of payload.roles.time,
//       group of roles.by[0]) with the top `params.top` groups and the rest
//       folded into "Other"; no `by` field = one series.
//         marks      a stacked area when the years are dense (≥ 60 % of the
//                    span have data), else stacked bars; years with no data
//                    are zero-filled so a gap reads as a gap, not a bridge.
//         legend     a point selection bound to the legend (`bind: 'legend'`)
//                    and to the marks: click to focus a group (the rest fade),
//                    click again to release. A focused group is also the
//                    page's `where` action (show-template.ts bridges `leg`
//                    by its label; each datum carries its row `key`).
//         years      two range sliders, From and To (params `y0`, `y1`), cut
//                    the span the chart shows; the axis rescales to it. (A
//                    scale-bound drag-zoom needs window events, which the
//                    frame turns off.)
//         view       a select param `mode`: Per year, Cumulative; when the rows
//                    carry both sides (`side: 'add' | 'retire'`, retirements
//                    negative, which the page sends when the layer has an
//                    opening and a retirement year) also Added and Retired
//                    alone. With both sides the default shows additions up and
//                    retirements down.
//         months     a date field the page binned by month (roles.time.bin
//                    'month', rows keyed "YYYY-MM"; show-template.ts does it
//                    when ≥ 90 % of the dated features fall in the last 6
//                    years): one bar per month of the last MAX_MONTHS (older
//                    ones counted in the subtitle), zero-filled,
//                    labelled in the locale ("Mar 2025"), no year sliders, view
//                    Per month / Cumulative. A click on a bar picks its month
//                    (param `mon`, each datum carrying `mkey`), which the page
//                    applies as a `where` date range on the field.
//       The year field is read as an integer 1700–2200; features without one
//       are counted in the subtitle, not drawn. One view in a vconcat so the
//       frame keeps the sliders' widget row; sizes from `layoutWidth()`.
//
// Deps: payload.ts (types), ../groups.ts (topGroups), common.ts, i18n (t).

import type { TemplatePayload } from '../payload.js';
import { topGroups } from '../groups.js';
import { t } from '../../../src/i18n/index.js';
import { SI, CONFIG, BAR, layoutWidth, compact, full, groupLabels, colourOf, empty, wrap, titleChars, subtitleChars, monthText } from './common.js';

export const YEAR_MIN = 1700, YEAR_MAX = 2200, MAX_SPAN = 300;
/** By month: the last six years' months are drawn; older months are counted in the subtitle. */
export const MAX_MONTHS = 72;
export const DENSE = 0.6;

export interface TimelineOpts { width?: number }

const yearOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{4}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= YEAR_MIN && n <= YEAR_MAX ? n : null;
};
/** A "YYYY-MM" month as a running month number (year × 12 + month − 1), else null. */
const monthOf = (v: unknown): number | null => {
  const m = typeof v === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(v) : null;
  const y = m ? Number(m[1]) : NaN;
  return m && y >= YEAR_MIN && y <= YEAR_MAX ? y * 12 + Number(m[2]) - 1 : null;
};
const monthKey = (n: number) => `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}`;
const monthLabel = (n: number, loc: string) => monthText(monthKey(n), loc);

export function build(p: TemplatePayload, opts: TimelineOpts = {}): Record<string, unknown> {
  const W = opts.width ?? layoutWidth();
  const tf = p.roles.time?.field;
  if (!tf) return empty(p, W);
  const loc = p.labels.locale || 'en';
  const by = p.roles.by[0]?.field;
  const top = typeof p.params.top === 'number' ? p.params.top : 8;
  const month = p.roles.time?.bin === 'month';
  const posOf = month ? monthOf : yearOf;

  // Groups: the top ones by the total, the rest "Other"; no field → one series.
  const grouped = by ? topGroups(p, by, top) : [];
  const keyOf = new Map<string | number | null, number>();
  grouped.forEach((g, i) => { if (!g.other) keyOf.set(g.key, i); });
  const otherAt = grouped.findIndex(g => g.other);
  const series: { key: string | number | null; label: string; colour: string; other?: true }[] = by ? grouped : [{ key: 'all', label: p.labels.measure ?? '', colour: BAR }];
  const names = groupLabels(series);

  // Years, sides, per-group sums.
  const sums = new Map<string, number>();      // `${group}|${year}|${side}` → value
  const sides = new Set<string>();
  let undated = 0;
  let lo = Infinity, hi = -Infinity;
  const raw: { y: number; g: number; side: string; v: number; n: number }[] = [];
  for (const r of p.rows) {
    const y = posOf(r[tf]);
    if (y === null) { undated += r.count; continue; }
    const g = !by ? 0 : keyOf.get(r[by] ?? null) ?? otherAt;
    if (g < 0) continue;
    const side = typeof r.side === 'string' ? r.side : 'add';
    sides.add(side);
    raw.push({ y, g, side, v: (r.sum ?? r.count) * (side === 'retire' ? -1 : 1), n: r.count });
    lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  if (!raw.length) return empty(p, W);
  const first = Math.max(lo, hi - (month ? MAX_MONTHS : MAX_SPAN) + 1);
  let before = 0;
  for (const r of raw) {
    if (r.y < first) { if (month) before += r.n; else undated += r.n; continue; }
    const k = `${r.g}|${r.y}|${r.side}`;
    sums.set(k, (sums.get(k) ?? 0) + r.v);
  }
  const both = sides.has('retire') && sides.has('add');
  const sideList = both ? ['add', 'retire'] : [sides.has('retire') && !sides.has('add') ? 'retire' : 'add'];

  // Dense rows: every group × year × side, with the group's running net total.
  const values: Record<string, unknown>[] = [];
  const present = new Set<number>();
  for (const k of sums.keys()) present.add(Number(k.split('|')[1]));
  const span = hi - first + 1;
  const dense = !month && span >= 5 && present.size / span >= DENSE;
  for (let g = 0; g < series.length; g++) {
    let cum = 0;
    for (let y = first; y <= hi; y++) {
      const net = sideList.reduce((s, sd) => s + (sums.get(`${g}|${y}|${sd}`) ?? 0), 0);
      cum += net;
      for (const sd of sideList) {
        const v = sums.get(`${g}|${y}|${sd}`) ?? 0;
        values.push({ year: y, label: names[g], key: series[g].other ? null : series[g].key, side: sd, value: v, cum, vfull: full(Math.abs(v), loc),
          ...(month && { tl: monthLabel(y, loc), mkey: monthKey(y) }) });
      }
    }
  }

  const colours = series.map(colourOf);
  const mode = [
    { id: 'year', label: t(month ? 'template.modeMonth' : 'template.modeYear') },
    { id: 'cum', label: t('template.modeCum') },
    ...(both ? [{ id: 'add', label: t('template.modeAdded') }, { id: 'retire', label: t('template.modeRetired') }] : []),
  ];
  const params: Record<string, unknown>[] = [
    { name: 'mode', value: 'year', bind: { input: 'select', options: mode.map(m => m.id), labels: mode.map(m => m.label), name: t('template.mode') + ' ' } },
    // Months: no From / To sliders (a running month number means nothing to read).
    ...(month ? [] : [
      { name: 'y0', value: first, bind: { input: 'range', min: first, max: hi, step: 1, name: t('template.yearFrom') + ' ' } },
      { name: 'y1', value: hi, bind: { input: 'range', min: first, max: hi, step: 1, name: t('template.yearTo') + ' ' } },
    ]),
  ];
  // A selection lives in the one view that draws it (a top-level one would be declared twice).
  // A legend-bound one takes no clicks on the marks (no `on`), so a month bar's click is `mon` alone.
  const legend = { name: 'leg', select: { type: 'point', fields: ['label'], toggle: true }, bind: 'legend' };
  const monthPick = { name: 'mon', select: { type: 'point', fields: ['mkey'], on: 'click', clear: 'dblclick' } };
  const labelW = 54;
  const width = Math.max(140, W - labelW - 24);
  const height = Math.round(Math.min(240, Math.max(120, W * 0.2)));
  const unit = p.roles.measure.unit && p.roles.measure.name !== 'count' ? p.roles.measure.unit : '';
  const step = Math.max(1, Math.ceil(span / Math.max(4, Math.floor(width / (month ? 62 : 38)))));
  const ticks = Array.from({ length: span }, (_, i) => first + i).filter(y => (y - first) % step === 0);

  const flt = [
    ...(month ? [] : [{ filter: 'datum.year >= min(y0, y1) && datum.year <= max(y0, y1)' }]),
    { filter: "mode === 'add' ? datum.side === 'add' : mode === 'retire' ? datum.side === 'retire' : mode === 'cum' ? datum.side === '" + sideList[0] + "' : true" },
    { calculate: "mode === 'cum' ? datum.cum : datum.value", as: 'v' },
  ];
  const xTitle = p.labels[`field.${tf}`] ?? t('template.year');
  const monthNames = month ? Array.from({ length: span }, (_, i) => monthLabel(first + i, loc)) : [];
  const x = month
    ? { field: 'tl', type: 'ordinal', sort: monthNames, axis: { title: null, values: ticks.map(y => monthLabel(y, loc)), labelAngle: 0, labelOverlap: true, grid: false } }
    : dense
    ? { field: 'year', type: 'quantitative', scale: { zero: false, nice: false }, axis: { title: null, format: 'd', values: ticks, grid: false, labelFlush: true } }
    : { field: 'year', type: 'ordinal', axis: { title: null, values: ticks, labelAngle: 0, labelOverlap: true, grid: false } };
  const tip = [
    { field: 'label', type: 'nominal', title: by ? (p.labels[`field.${by}`] ?? by) : '' },
    month ? { field: 'tl', type: 'nominal', title: xTitle } : { field: 'year', type: 'quantitative', title: xTitle, format: 'd' },
    { field: 'v', type: 'quantitative', title: p.labels.measure ?? '', format: ',.2~f' },
  ];
  const view = {
    width, height,
    params: month ? [legend, monthPick] : [legend],
    transform: flt,
    mark: dense ? { type: 'area', interpolate: 'monotone', line: { strokeWidth: 1 }, opacity: 0.92 } : { type: 'bar', cornerRadiusEnd: 1, ...(month && { cursor: 'pointer' }) },
    encoding: {
      x,
      y: { field: 'v', type: 'quantitative', stack: 'zero', axis: { title: null, labelExpr: SI, tickCount: 4 } },
      color: { field: 'label', type: 'nominal', scale: { domain: names, range: colours },
        legend: { title: null, orient: 'top', columns: Math.max(1, Math.floor(W / 84)), symbolType: 'square', labelLimit: 72, direction: 'horizontal' } },
      order: { field: 'label', type: 'nominal', sort: 'descending' },
      opacity: { condition: { param: 'leg', value: 0.95 }, value: 0.18 },
      tooltip: tip,
    },
  };
  const net = [...sums.values()].reduce((a, v) => a + v, 0);
  const sub = [t('template.total', { value: compact(net, loc) + (unit ? ` ${unit}` : '') })];
  if (by) sub.push(t('template.groupsN', { n: grouped.length }));
  if (undated > 0) sub.push(t(month ? 'template.undatedDate' : 'template.undated', { n: compact(undated, loc) }));
  if (before > 0) sub.push(t('template.before', { n: compact(before, loc), date: monthLabel(first, loc) }));
  return {
    description: p.labels.summary ?? p.labels.title ?? '',
    title: { text: wrap(p.labels.title ?? '', titleChars(W)), subtitle: wrap(sub.join('  ·  '), subtitleChars(W)), ...CONFIG.title, offset: 8 },
    data: { values },
    params,
    padding: { left: 6, right: 12, top: 2, bottom: 2 },
    vconcat: [view],
    config: CONFIG,
  };
}
