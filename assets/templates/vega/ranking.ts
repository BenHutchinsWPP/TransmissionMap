// ─── ranking (Vega-Lite): the top groups of a layer by the measure ───────────
// Role: the catalogue's `ranking` builder, (payload) → Vega-Lite spec with its
//       data inline.
//         no time field   top-N horizontal bars of payload.roles.by[0] by the
//                         measure, a label "value (share)" at each bar's end,
//                         the rest folded into a grey "Other" bar. Bars take
//                         the map legend's colours when the field has a facet,
//                         else one blue.
//         with a time field  a race: the page pre-computes, for every year,
//                         the running total of each group and its rank (the
//                         top N per year, rows ≤ N × years); one slider-bound
//                         param (`yr`, bind range, step 1) picks the year and
//                         the bars re-rank at once. It starts on the last year,
//                         where the bars equal the plain ranking; nothing moves
//                         on its own (no timer, no window events), so reduced
//                         motion is respected by construction and the slider is
//                         keyboard-operable. Features without a usable year are
//                         left out of the race and the subtitle says how many.
//       In both, clicking a bar picks its group (param `pick`, each datum
//       carrying its row `key`), which the page applies as a `where` action.
//       Both are one view inside a vconcat, so the frame does not fit-and-clip
//       the slider's widget row; sizes come from `layoutWidth()` (or
//       `opts.width`). Strings: payload labels and template.* keys; the rows
//       are the page's, no model text reaches the spec except params.title.
//
// Deps: payload.ts (types), ../groups.ts (topGroups, NEUTRAL), common.ts, i18n (t).

import type { TemplatePayload } from '../payload.js';
import { topGroups } from '../groups.js';
import { t } from '../../../src/i18n/index.js';
import { SI, CONFIG, BAR, layoutWidth, compact, full, percent, uniqueLabels, groupLabels, colourOf, head, empty } from './common.js';

export const STEP = 21;
/** Room kept right of the race's longest bar for its value label ("12.3k"), in px. */
export const VALUE_ROOM = 52;
export const YEAR_MIN = 1700, YEAR_MAX = 2200, MAX_FRAMES = 250;

export interface RankingOpts { width?: number }

/** A click on a bar picks its group: the page's `where` action (show-template.ts bridges `pick` by its label). */
const PICK = () => ({ name: 'pick', select: { type: 'point', fields: ['label'], on: 'click', clear: 'dblclick' } });

const yearOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{4}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= YEAR_MIN && n <= YEAR_MAX ? n : null;
};

export function build(p: TemplatePayload, opts: RankingOpts = {}): Record<string, unknown> {
  const W = opts.width ?? layoutWidth();
  const by = p.roles.by[0]?.field ?? '';
  if (!by) return empty(p, W);
  return p.roles.time ? race(p, W, by) ?? plain(p, W, by) : plain(p, W, by);
}

const hasFacet = (p: TemplatePayload, by: string) => Object.keys(p.colours[by] ?? {}).length > 0;

function plain(p: TemplatePayload, W: number, by: string): Record<string, unknown> {
  const top = typeof p.params.top === 'number' ? p.params.top : 10;
  const groups = topGroups(p, by, top).filter(g => g.value > 0);
  const total = groups.reduce((s, g) => s + g.value, 0);
  if (!groups.length || !(total > 0)) return empty(p, W);
  const loc = p.labels.locale || 'en';
  const facet = hasFacet(p, by);
  const labels = groupLabels(groups);
  const max = Math.max(...groups.map(g => g.value));
  const values = groups.map((g, i) => ({
    i, label: labels[i], key: g.other ? null : g.key, value: g.value, vlabel: `${compact(g.value, loc)}  (${percent(g.value / total, loc)})`,
    full: full(g.value, loc), pct: percent(g.value / total, loc), count: g.count,
    colour: g.other || g.key === null ? colourOf(g) : facet ? g.colour : BAR,
  }));
  const axisW = Math.min(150, Math.max(90, Math.round(W * 0.26)));
  const width = Math.max(120, W - axisW - 30);
  const tip = [
    { field: 'label', type: 'nominal', title: p.labels[`field.${by}`] ?? by },
    { field: 'full', type: 'nominal', title: p.labels.measure ?? '' },
    { field: 'pct', type: 'nominal', title: t('template.share') },
  ];
  const view = {
    width, height: { step: STEP },
    encoding: {
      y: { field: 'label', type: 'ordinal', sort: labels, axis: { title: null, labelLimit: axisW, ticks: false, domain: false, labelPadding: 6 }, scale: { paddingInner: 0.22, paddingOuter: 0 } },
      x: { field: 'value', type: 'quantitative', scale: { domain: [0, max * 1.3], nice: false, clamp: true }, axis: { title: null, labelExpr: SI, grid: true, tickCount: 4 } },
    },
    layer: [
      { params: [PICK()], mark: { type: 'bar', cornerRadiusEnd: 3, cursor: 'pointer' }, encoding: { color: { field: 'colour', type: 'nominal', scale: null, legend: null }, tooltip: tip } },
      { mark: { type: 'text', align: 'left', baseline: 'middle', dx: 5, fontSize: 11 }, encoding: { text: { field: 'vlabel', type: 'nominal' } } },
    ],
  };
  return {
    description: p.labels.summary ?? p.labels.title ?? '',
    title: head(p, W, total, groups.length),
    data: { values },
    vconcat: [view],
    config: CONFIG,
  };
}

/** The race over years, or null when the rows carry no usable year. */
function race(p: TemplatePayload, W: number, by: string): Record<string, unknown> | null {
  const tf = p.roles.time!.field;
  const top = typeof p.params.top === 'number' ? p.params.top : 10;
  const everyone = topGroups(p, by, Number.MAX_SAFE_INTEGER);   // label and colour per group, ranked by the total
  const meta = new Map(everyone.map(g => [g.key, g]));
  const perYear = new Map<number, Map<string | number | null, number>>();
  let undated = 0;
  for (const r of p.rows) {
    const y = yearOf(r[tf]);
    const v = r.sum ?? r.count;
    if (y === null) { undated += r.count; continue; }
    const k = r[by] ?? null;
    const m = perYear.get(y) ?? new Map();
    m.set(k, (m.get(k) ?? 0) + v);
    perYear.set(y, m);
  }
  if (!perYear.size) return null;
  const years = [...perYear.keys()].sort((a, b) => a - b);
  const last = years[years.length - 1];
  const first = Math.max(years[0], last - MAX_FRAMES + 1);

  // Running totals, ranked per year; rows only for the top N of each year.
  const run = new Map<string | number | null, number>();
  const rows: Record<string, unknown>[] = [];
  const loc = p.labels.locale || 'en';
  const labelOf = (k: string | number | null) => meta.get(k)?.label ?? String(k);
  let N = 0;
  const seen = new Set<string | number | null>();
  const unique = new Map<string | number | null, string>();
  const names = uniqueLabels(everyone.map(g => g.label));
  everyone.forEach((g, i) => unique.set(g.key, names[i]));
  const sorted = [...perYear.entries()].sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (let y = sorted[0][0]; y <= last; y++) {
    while (at < sorted.length && sorted[at][0] === y) { for (const [k, v] of sorted[at][1]) run.set(k, (run.get(k) ?? 0) + v); at++; }
    if (y < first) continue;
    const ranked = [...run].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || labelOf(a[0]).localeCompare(labelOf(b[0]))).slice(0, top);
    ranked.forEach(([k, v], rank) => {
      seen.add(k);
      rows.push({ yr: y, rank, label: unique.get(k) ?? labelOf(k), key: k, value: v, vlabel: compact(v, loc), full: full(v, loc) });
    });
    N = Math.max(N, ranked.length);
  }
  if (!rows.length) return null;
  const domain = [...seen].sort((a, b) => (everyone.findIndex(g => g.key === a)) - (everyone.findIndex(g => g.key === b))).map(k => unique.get(k) ?? labelOf(k));
  const colours = [...seen].sort((a, b) => (everyone.findIndex(g => g.key === a)) - (everyone.findIndex(g => g.key === b))).map(k => { const g = meta.get(k); return g ? colourOf(g) : BAR; });

  const longest = Math.max(...domain.map(d => d.length));
  const labelW = Math.min(150, Math.max(36, Math.round(longest * 6.6) + 6));
  const width = Math.max(120, W - labelW - 56);
  const height = N * STEP;
  const total = [...run.values()].reduce((s, v) => s + v, 0);
  const yr = { name: 'yr', value: last, bind: { input: 'range', min: first, max: last, step: 1, name: t('template.year') + ' ' } };
  const flt = [{ filter: 'datum.yr === yr' }];
  const rank = { field: 'rank', type: 'ordinal', scale: { domain: Array.from({ length: N }, (_, i) => i), paddingInner: 0.2, paddingOuter: 0 }, axis: { labels: false, ticks: false, domain: false, title: null, minExtent: labelW + 8 } };
  // The bars stop short of the plot's right edge, so the longest one's value label stays inside.
  const x = { field: 'value', type: 'quantitative', scale: { zero: true, nice: true, range: [0, Math.max(60, width - VALUE_ROOM)] }, axis: { title: null, labelExpr: SI, grid: true, tickCount: 4 } };
  const tip = [
    { field: 'label', type: 'nominal', title: p.labels[`field.${by}`] ?? by },
    { field: 'full', type: 'nominal', title: p.labels.measure ?? '' },
  ];
  const view = {
    width, height,
    layer: [
      { transform: flt, params: [PICK()], mark: { type: 'bar', cornerRadiusEnd: 3, cursor: 'pointer' }, encoding: { y: rank, x, color: { field: 'label', type: 'nominal', scale: { domain, range: colours }, legend: null }, tooltip: tip } },
      { transform: flt, mark: { type: 'text', align: 'right', baseline: 'middle', x: -8, fontSize: 11.5, limit: labelW }, encoding: { y: rank, text: { field: 'label', type: 'nominal' } } },
      { transform: flt, mark: { type: 'text', align: 'left', baseline: 'middle', dx: 5, fontSize: 11 }, encoding: { y: rank, x, text: { field: 'vlabel', type: 'nominal' } } },
      {
        // The year, big and pale in the corner: the first row of the chosen year carries it.
        transform: [{ filter: 'datum.yr === yr && datum.rank === 0' }],
        mark: { type: 'text', align: 'right', baseline: 'bottom', x: width - 6, y: height - 4, fontSize: 40, fontWeight: 700, color: '#9ca3af', opacity: 0.45, interactive: false },
        encoding: { text: { field: 'yr', type: 'quantitative', format: 'd' } },
      },
    ],
  };
  const notes = [t('template.race'), ...(undated > 0 ? [t('template.undated', { n: compact(undated, loc) })] : [])];
  return {
    description: p.labels.summary ?? p.labels.title ?? '',
    title: head(p, W, total, everyone.length, notes),
    data: { values: rows },
    params: [yr],
    padding: { left: 6, right: 12, top: 2, bottom: 2 },
    vconcat: [view],
    config: { ...CONFIG, text: { color: '#1f2937', fontSize: 11 } },
  };
}
