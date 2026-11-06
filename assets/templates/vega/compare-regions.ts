// ─── compare-regions (Vega-Lite): one category, side by side per region ─────
// Role: the catalogue's `compare-regions` builder, (payload) → Vega-Lite spec
//       with its data inline. The rows are grouped by roles.by[0] (the
//       category, its top `params.top` groups and the rest folded into
//       "Other", colours the map legend's) and roles.by[1] (the split region
//       field); show-template.ts has already cut them to the panels' regions
//       (the Area's codes, a `where` on the split field, else the largest,
//       ≤ 6) and named each region (labels `value.<split>.<code>`).
//         regions    a bar per region (its total), largest first; a click
//                    picks the region (param `reg`, each datum carrying its
//                    `rkey`), which the page applies as a `where` on the split
//                    field.
//         panels     a facet, one panel per region in the same order, each the
//                    same groups in the same order on one shared x scale; a
//                    click on a bar picks its group (param `pick`, each datum
//                    carrying its row `key`), lit in every panel, which the
//                    page applies as a `where` on the category.
//         view       a select param `cmp`: Values or Share of each region (each
//                    bar over its region's total).
//       Panels wrap to 3 columns on a wide card (≥ 760 px), 2 from 520 px, one
//       per row below (a phone). Notes under the title: regions left out, a
//       tiled layer's "regions in the current view", and the overlap note when
//       a feature is tagged with several regions. Strings: payload labels and
//       template.* keys; no model text reaches the spec except params.title.
//
// Deps: payload.ts (types), ../groups.ts (topGroups), common.ts, i18n (t).

import type { TemplatePayload } from '../payload.js';
import { topGroups } from '../groups.js';
import { t } from '../../../src/i18n/index.js';
import { CONFIG, BAR, SI, MUTED, layoutWidth, compact, full, percent, groupLabels, uniqueLabels, colourOf, head, empty } from './common.js';

export const STEP = 18;
export const TWO_FROM = 520, THREE_FROM = 760;

export interface CompareOpts { width?: number }

export function build(p: TemplatePayload, opts: CompareOpts = {}): Record<string, unknown> {
  const W = opts.width ?? layoutWidth();
  const by = p.roles.by[0]?.field, split = p.roles.by[1]?.field;
  if (!by || !split) return empty(p, W);
  const loc = p.labels.locale || 'en';
  const top = typeof p.params.top === 'number' ? p.params.top : 8;

  // Groups across every panel: the top ones, the rest "Other".
  const groups = topGroups(p, by, top).filter(g => g.value > 0);
  const gIndex = new Map<string | number | null, number>();
  groups.forEach((g, i) => { if (!g.other) gIndex.set(g.key, i); });
  const otherAt = groups.findIndex(g => g.other);
  const gNames = groupLabels(groups);

  // Regions: their totals, largest first.
  const cells = new Map<string, number[]>();     // region key → value per group
  for (const r of p.rows) {
    const rk = r[split];
    if (rk === null || rk === undefined || rk === 'none') continue;
    const g = gIndex.get(r[by] ?? null) ?? otherAt;
    if (g < 0) continue;
    const k = String(rk);
    const row = cells.get(k) ?? new Array<number>(groups.length).fill(0);
    row[g] += Math.abs(r.sum ?? r.count);
    cells.set(k, row);
  }
  const regions = [...cells].map(([k, vs]) => ({ k, total: vs.reduce((a, b) => a + b, 0), vs })).filter(x => x.total > 0).sort((a, b) => b.total - a.total);
  if (!groups.length || !regions.length) return empty(p, W);
  const rNames = uniqueLabels(regions.map(x => p.labels[`value.${split}.${x.k}`] ?? x.k));

  const values: Record<string, unknown>[] = [];
  let maxV = 0, maxS = 0;
  regions.forEach((reg, ri) => {
    values.push({ kind: 'r', region: rNames[ri], rkey: reg.k, value: reg.total, vlabel: compact(reg.total, loc), full: full(reg.total, loc) });
    reg.vs.forEach((v, gi) => {
      const share = v / reg.total;
      maxV = Math.max(maxV, v); maxS = Math.max(maxS, share);
      values.push({
        kind: 'c', region: rNames[ri], rkey: reg.k, label: gNames[gi], key: groups[gi].other ? null : groups[gi].key,
        colour: colourOf(groups[gi]), value: v, share, vlabel: compact(v, loc), pct: percent(share, loc), full: full(v, loc),
      });
    });
  });

  const cols = Math.min(regions.length, W >= THREE_FROM ? 3 : W >= TWO_FROM ? 2 : 1);
  const longest = Math.max(...gNames.map(n => n.length));
  const axisW = Math.min(120, Math.max(48, Math.round(longest * 6.2) + 6));
  const panelW = Math.max(90, Math.floor((W - cols * (axisW + 14)) / cols));
  const regionAxisW = Math.min(140, Math.max(48, Math.round(Math.max(...rNames.map(n => n.length)) * 6.4) + 6));
  const regionW = Math.max(120, W - regionAxisW - 30);

  const cmp = [{ id: 'abs', label: t('template.cmp.values') }, { id: 'share', label: t('template.cmp.shares') }];
  const params = [{ name: 'cmp', value: 'abs', bind: { input: 'select', options: cmp.map(c => c.id), labels: cmp.map(c => c.label), name: t('template.mode') + ' ' } }];
  const pick = { name: 'pick', select: { type: 'point', fields: ['label'], on: 'click', clear: 'dblclick' } };
  const reg = { name: 'reg', select: { type: 'point', fields: ['region'], on: 'click', clear: 'dblclick' } };
  const measure = p.labels.measure ?? '';

  const regionView = {
    width: regionW, height: { step: STEP },
    transform: [{ filter: "datum.kind === 'r'" }],
    title: { text: t('template.cmp.regions'), fontSize: 11, color: MUTED, fontWeight: 400, anchor: 'start' },
    encoding: {
      y: { field: 'region', type: 'nominal', sort: rNames, axis: { title: null, labelLimit: regionAxisW, ticks: false, domain: false, labelPadding: 6 }, scale: { paddingInner: 0.25, paddingOuter: 0 } },
      x: { field: 'value', type: 'quantitative', scale: { domain: [0, regions[0].total * 1.3], nice: false }, axis: { title: null, labelExpr: SI, grid: true, tickCount: 4 } },
    },
    layer: [
      {
        params: [reg], mark: { type: 'bar', cornerRadiusEnd: 3, cursor: 'pointer', color: BAR },
        encoding: {
          opacity: { condition: { param: 'reg', empty: true, value: 0.9 }, value: 0.35 },
          tooltip: [{ field: 'region', type: 'nominal', title: p.labels[`field.${split}`] ?? split }, { field: 'full', type: 'nominal', title: measure }],
        },
      },
      { mark: { type: 'text', align: 'left', baseline: 'middle', dx: 5, fontSize: 11 }, encoding: { text: { field: 'vlabel', type: 'nominal' } } },
    ],
  };

  const x = {
    field: 'v', type: 'quantitative',
    scale: { domainMin: 0, domainMax: { expr: `cmp === 'share' ? ${maxS * 1.35} : ${maxV * 1.35}` }, nice: false },
    axis: { title: null, grid: true, tickCount: 3, labelExpr: "cmp === 'share' ? format(datum.value, '.0%') : (datum.value == 0 ? '0' : format(datum.value, '~s'))" },
  };
  const panel = {
    width: panelW, height: { step: STEP },
    encoding: {
      y: { field: 'label', type: 'nominal', sort: gNames, axis: { title: null, labelLimit: axisW, ticks: false, domain: false, labelPadding: 4 }, scale: { paddingInner: 0.2, paddingOuter: 0 } },
      x,
    },
    layer: [
      {
        params: [pick], mark: { type: 'bar', cornerRadiusEnd: 2, cursor: 'pointer' },
        encoding: {
          color: { field: 'colour', type: 'nominal', scale: null, legend: null },
          opacity: { condition: { param: 'pick', empty: true, value: 1 }, value: 0.3 },
          tooltip: [
            { field: 'region', type: 'nominal', title: p.labels[`field.${split}`] ?? split },
            { field: 'label', type: 'nominal', title: p.labels[`field.${by}`] ?? by },
            { field: 'full', type: 'nominal', title: measure },
            { field: 'pct', type: 'nominal', title: t('template.share') },
          ],
        },
      },
      { mark: { type: 'text', align: 'left', baseline: 'middle', dx: 4, fontSize: 10.5 }, encoding: { text: { field: 'tl', type: 'nominal' } } },
    ],
  };
  const panels = {
    transform: [{ filter: "datum.kind === 'c'" }, { calculate: "cmp === 'share' ? datum.share : datum.value", as: 'v' }, { calculate: "cmp === 'share' ? datum.pct : datum.vlabel", as: 'tl' }],
    facet: { field: 'region', type: 'nominal', sort: rNames, header: { title: null, labelAnchor: 'start', labelFontSize: 12, labelFontWeight: 600, labelColor: '#1f2937', labelLimit: panelW + axisW } },
    columns: cols,
    spacing: { row: 14, column: 18 },
    spec: panel,
  };

  const total = regions.reduce((s, r) => s + r.total, 0);
  const notes = [p.labels['cmp.more'], p.labels['cmp.view'], p.labels['cmp.overlap']].filter((x): x is string => !!x);
  return {
    description: p.labels.summary ?? p.labels.title ?? '',
    title: head(p, W, total, groups.length, notes),
    data: { values },
    params,
    padding: { left: 6, right: 12, top: 2, bottom: 2 },
    vconcat: [regionView, panels],
    spacing: 16,
    resolve: { scale: { x: 'independent', y: 'independent' } },
    config: CONFIG,
  };
}
