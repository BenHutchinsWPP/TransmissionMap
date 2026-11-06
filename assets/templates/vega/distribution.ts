// ─── distribution (Vega-Lite): how one measure's values spread ──────────────
// Role: the catalogue's `distribution` builder, (payload) → Vega-Lite spec with
//       its data inline: a histogram of roles.bins.field over the page's own
//       bins (dataset-query.ts binEdges: 1/2/5 steps, log when skewed; rows
//       `bin`, `lo`, `hi`, count). Every bin is drawn, empty ones as zero; a
//       bin is a band labelled "lo–hi" (whole numbers in full, the rest
//       compact), the axis titled with the field and its unit.
//         by         optional (roles.by[0]): the bars stack its top groups
//                    (params.top, rest "Other"; legend colours).
//         view       a select param `dv`: Histogram (features per bin) or
//                    Smooth area (the same bins as a monotone area through
//                    each bin's centre) or Cumulative share (the share of features below each bin's
//                    upper edge, a step line with its points on those edges).
//         median     a dashed rule on the median's bin, labelled with the
//                    median itself (roles.bins.stats: the values' own
//                    quantiles, not the bins'); the subtitle says the median
//                    and the 10th–90th percentile range.
//         click      a bar picks its bin (param `pick`, each datum carrying its
//                    bin index as `key`), which the page applies as a `where`
//                    range [lo, hi) on the field — only when roles.bins.filter
//                    (length / area and years read out of text have no field to
//                    filter on: no param, no pointer, and a note says so).
//       Features without a value are counted in the subtitle, not drawn. One
//       view inside a vconcat, so the frame keeps the select's widget row.
//
// Deps: payload.ts (types), ../groups.ts (topGroups), common.ts, i18n (t).

import type { TemplatePayload } from '../payload.js';
import { topGroups } from '../groups.js';
import { t } from '../../../src/i18n/index.js';
import { CONFIG, BAR, MUTED, layoutWidth, compact, full, percent, groupLabels, colourOf, empty, wrap, wrapLines, titleChars, subtitleChars, edgeText, binLabels } from './common.js';

export interface DistributionOpts { width?: number }
const PAD_INNER = 0.06, PAD_OUTER = 0.02;

export function build(p: TemplatePayload, opts: DistributionOpts = {}): Record<string, unknown> {
  const W = opts.width ?? layoutWidth();
  const bins = p.roles.bins;
  if (!bins) return empty(p, W);
  const loc = p.labels.locale || 'en';
  const by = p.roles.by[0]?.field;
  const top = typeof p.params.top === 'number' ? p.params.top : 8;

  // Edges: the payload's, else read back from the rows.
  let edges = bins.edges ? [...bins.edges] : [];
  if (edges.length < 2) {
    // Bin i's lo is edge i and its hi edge i + 1; an empty bin between two others has both from its neighbours.
    const e: number[] = [];
    for (const r of p.rows) if (typeof r.bin === 'number' && r.bin >= 0 && r.bin < 1000 && typeof r.lo === 'number' && typeof r.hi === 'number') { e[r.bin] = r.lo; e[r.bin + 1] = r.hi; }
    edges = e.length >= 2 && Array.from({ length: e.length }, (_, i) => i in e).every(Boolean) ? e : [];
  }
  const nb = edges.length - 1;
  if (nb < 1) return empty(p, W);
  const binNames = binLabels(edges, loc);

  // Groups from the binned rows only (a feature without a value is not drawn).
  const grouped = by ? topGroups({ ...p, rows: p.rows.filter(r => typeof r.bin === 'number') }, by, top) : [];
  const keyOf = new Map<string | number | null, number>();
  grouped.forEach((g, i) => { if (!g.other) keyOf.set(g.key, i); });
  const otherAt = grouped.findIndex(g => g.other);
  const series = by ? grouped : [{ key: 'all', label: p.labels.count ?? '', colour: BAR }];
  const names = groupLabels(series);

  const counts = Array.from({ length: nb }, () => new Array<number>(series.length).fill(0));
  const sums = Array.from({ length: nb }, () => new Array<number>(series.length).fill(0));
  let noValue = 0;
  for (const r of p.rows) {
    const b = r.bin;
    if (typeof b !== 'number' || b < 0 || b >= nb) { noValue += r.count; continue; }
    const g = by ? keyOf.get(r[by] ?? null) ?? otherAt : 0;
    if (g < 0) continue;
    counts[b][g] += r.count;
    sums[b][g] += r.sum ?? 0;
  }
  const all = counts.reduce((s, row) => s + row.reduce((a, c) => a + c, 0), 0);
  if (!all) return empty(p, W);

  const st = bins.stats;
  const medianBin = st ? Math.max(0, Math.min(nb - 1, edges.findIndex((e, i) => i < nb && st.median >= e && st.median < edges[i + 1]))) : -1;
  const unit = p.labels[`field.${bins.field}`] ?? bins.field;
  const hasSum = p.roles.measure.name !== 'count';
  const values: Record<string, unknown>[] = [];
  let cum = 0;
  for (let b = 0; b < nb; b++) {
    const binTotal = counts[b].reduce((a, c) => a + c, 0);
    cum += binTotal;
    for (let g = 0; g < series.length; g++) {
      values.push({
        label: binNames[b], key: b, g: names[g], colour: colourOf(series[g]), value: counts[b][g],
        cum: cum / all, cpct: percent(cum / all, loc), first: g === 0, med: g === 0 && b === medianBin,
        n: full(counts[b][g], loc), ...(hasSum && { s: full(sums[b][g], loc) }),
      });
    }
  }

  const clickable = bins.filter === true;
  const dv = [{ id: 'hist', label: t('template.dist.hist') }, { id: 'area', label: t('template.dist.area') }, { id: 'ecdf', label: t('template.dist.ecdf') }];
  const params = [{ name: 'dv', value: 'hist', bind: { input: 'select', options: dv.map(d => d.id), labels: dv.map(d => d.label), name: t('template.mode') + ' ' } }];
  const pick = { name: 'pick', select: { type: 'point', fields: ['label'], on: 'click', clear: 'dblclick' } };
  const labelW = 46;
  const width = Math.max(160, W - labelW - 24);
  const height = Math.round(Math.min(240, Math.max(150, W * 0.3)));
  const tilt = nb * 44 > width;
  const x = { field: 'label', type: 'ordinal', sort: binNames, axis: { title: unit, labelAngle: tilt ? -40 : 0, labelOverlap: true, grid: false, labelLimit: 70 }, scale: { paddingInner: PAD_INNER, paddingOuter: PAD_OUTER } };
  // The y domain is the page's (the tallest stacked bin, or 0–100 %): each view's layer is empty in the other, which leaves no extent to read.
  const tallest = Math.max(...counts.map(row => row.reduce((a, c) => a + c, 0)));
  const y = { field: 'v', type: 'quantitative', stack: 'zero', scale: { domain: { expr: `[0, dv === 'ecdf' ? 1 : ${tallest * 1.05}]` }, nice: false }, axis: { title: null, tickCount: 4, minExtent: 36, labelExpr: "dv === 'ecdf' ? format(datum.value, '.0%') : (datum.value == 0 ? '0' : format(datum.value, '~s'))" } };
  const tip = [
    { field: 'label', type: 'nominal', title: unit },
    ...(by ? [{ field: 'g', type: 'nominal', title: p.labels[`field.${by}`] ?? by }] : []),
    { field: 'n', type: 'nominal', title: p.labels.count ?? '' },
    ...(hasSum ? [{ field: 's', type: 'nominal', title: p.labels.measure ?? '' }] : []),
    { field: 'cpct', type: 'nominal', title: t('template.dist.ecdf') },
  ];
  const layers: Record<string, unknown>[] = [
    {
      ...(clickable && { params: [pick] }),
      transform: [{ filter: "dv === 'hist'" }, { calculate: 'datum.value', as: 'v' }],
      mark: { type: 'bar', cornerRadiusEnd: 1, ...(clickable && { cursor: 'pointer' }) },
      encoding: {
        x, y,
        color: { field: 'g', type: 'nominal', scale: { domain: names, range: series.map(colourOf) },
          legend: by ? { title: null, orient: 'top', columns: Math.max(1, Math.floor(W / 84)), symbolType: 'square', labelLimit: 72, direction: 'horizontal' } : null },
        order: { field: 'g', type: 'nominal', sort: 'descending' },
        ...(clickable && { opacity: { condition: { param: 'pick', empty: true, value: 1 }, value: 0.35 } }),
        tooltip: tip,
      },
    },
    {
      // The same bins as one continuous shape: a smoothed area through each bin's centre (stacked by group).
      transform: [{ filter: "dv === 'area'" }, { calculate: 'datum.value', as: 'v' }],
      mark: { type: 'area', interpolate: 'monotone', line: { strokeWidth: 1.5 }, opacity: 0.75 },
      encoding: {
        x: { ...x, bandPosition: 0.5 }, y,
        color: { field: 'g', type: 'nominal', scale: { domain: names, range: series.map(colourOf) }, legend: null },
        order: { field: 'g', type: 'nominal', sort: 'descending' },
        tooltip: tip,
      },
    },
    {
      transform: [{ filter: "dv === 'ecdf' && datum.first" }, { calculate: 'datum.cum', as: 'v' }],
      mark: { type: 'line', interpolate: 'step-after', color: BAR, strokeWidth: 2, point: { filled: true, size: 26, color: BAR } },
      // Each point at its bin's upper edge: the share of features below it.
      encoding: { x: { ...x, bandPosition: 1 }, y: { ...y, stack: null }, tooltip: tip },
    },
  ];
  if (st && medianBin >= 0) {
    const medText = t('template.dist.median', { value: edgeText(Number(st.median.toPrecision(3)), Number.isInteger(st.median), loc) });
    // At the median's place within its bin: the band's start plus its share of the bin's width, in px.
    const step = width / (nb - PAD_INNER + 2 * PAD_OUTER);
    const off = Math.round(step * (1 - PAD_INNER) * Math.min(1, Math.max(0, (st.median - edges[medianBin]) / (edges[medianBin + 1] - edges[medianBin]))) * 10) / 10;
    const at = { ...x, bandPosition: 0 };
    layers.push({
      transform: [{ filter: 'datum.med' }],
      layer: [
        { mark: { type: 'rule', strokeDash: [4, 3], color: '#111827', strokeWidth: 1.2, xOffset: off }, encoding: { x: at } },
        { mark: { type: 'text', align: off > step * 0.5 ? 'right' : 'left', baseline: 'top', dx: off > step * 0.5 ? -4 : 4, xOffset: off, y: 2, fontSize: 10.5, color: '#111827' }, encoding: { x: at, text: { value: medText } } },
      ],
    });
  }
  const view = { width, height, layer: layers, resolve: { scale: { y: 'shared' } } };

  const sub = [t('template.total', { value: compact(all, loc) })];
  if (st) {
    const e = (v: number) => edgeText(Number(v.toPrecision(3)), Number.isInteger(v), loc);
    sub.push(t('template.dist.stats', { median: e(st.median), p10: e(st.p10), p90: e(st.p90) }));
  }
  if (noValue > 0) sub.push(t('template.dist.noValue', { n: compact(noValue, loc) }));
  if (bins.scale === 'log') sub.push(t('template.dist.log'));
  if (!clickable) sub.push(t('template.dist.noFilter'));
  return {
    description: p.labels.summary ?? p.labels.title ?? '',
    title: { text: wrap(p.labels.title ?? '', titleChars(W)), subtitle: wrapLines(sub, subtitleChars(W)), ...CONFIG.title, subtitleColor: MUTED, offset: 8 },
    data: { values },
    params,
    padding: { left: 6, right: 12, top: 2, bottom: 2 },
    vconcat: [view],
    config: CONFIG,
  };
}
