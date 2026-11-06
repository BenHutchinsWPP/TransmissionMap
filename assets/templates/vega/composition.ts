// ─── composition (Vega-Lite): how a layer splits by one category ─────────────
// Role: the catalogue's `composition` builder, (payload) → Vega-Lite spec with
//       its data inline: a donut, a table-like list (swatch, name, value,
//       share) and a bar per row, linked. Hovering or clicking a slice, a row
//       or a bar lights the other two (a point selection on the group, hover
//       and click as two params; empty = everything lit, otherwise the rest
//       dim). A click's group is also the page's `where` action (show-template.ts
//       bridges `pick` by its label; each datum carries its row `key`). The groups are payload.roles.by[0]'s, the top `params.top` by
//       the measure and the rest folded into "Other"; colours are the map
//       legend's (payload.colours) or the neutral palette; the total sits in
//       the donut's hole and under the title. Wide cards (≥ 520 px) put the
//       three side by side (hconcat); narrower ones put the donut over the
//       list and bars (vconcat). The frame cannot tell the builder its width,
//       so `layoutWidth()` reads the chat pane (or `opts.width`).
//       Every string comes from payload.labels or a template.* key; the rows
//       are the page's (shapeRows), so no model text reaches the spec except
//       params.title, already checked. Plain JSON, no data.url, one named
//       dataset at the top (validateVegaLite takes the spec without `data`).
//
// Deps: payload.ts (types), ../groups.ts (topGroups), common.ts.

import type { TemplatePayload } from '../payload.js';
import { t } from '../../../src/i18n/index.js';
import { topGroups } from '../groups.js';
import { CONFIG, INK, MUTED, GRID, layoutWidth, compact, full, percent, groupLabels, colourOf, head, empty } from './common.js';

export const WIDE_FROM = 520;
const STEP = 22;

export interface CompositionOpts { width?: number }

export function build(p: TemplatePayload, opts: CompositionOpts = {}): Record<string, unknown> {
  const W = opts.width ?? layoutWidth();
  const by = p.roles.by[0]?.field ?? '';
  const top = typeof p.params.top === 'number' ? p.params.top : 10;
  const groups = topGroups(p, by, top).filter(g => g.value > 0);
  const total = groups.reduce((s, g) => s + g.value, 0);
  if (!by || !groups.length || !(total > 0)) return empty(p, W);

  const loc = p.labels.locale || 'en';
  const labels = groupLabels(groups);
  const max = Math.max(...groups.map(g => g.value));
  const values = groups.map((g, i) => ({
    i, label: labels[i], key: g.other ? null : g.key, value: g.value, count: g.count, colour: colourOf(g),
    vlabel: compact(g.value, loc), full: full(g.value, loc),
    share: g.value / total, pct: percent(g.value / total, loc),
  }));

  const wide = W >= WIDE_FROM;
  const rows = values.length;
  const plotH = rows * STEP;
  // Widths: donut | list | bars when wide; the donut over list | bars when not.
  const donut = wide ? Math.min(190, Math.max(130, Math.round(W * 0.28))) : Math.min(170, Math.max(130, W - 40));
  const barsW = wide ? Math.max(90, Math.round(W * 0.2)) : Math.max(70, Math.round(W * 0.26));
  const listW = wide ? W - donut - barsW - 60 : W - barsW - 40;
  const dh = Math.max(donut, wide ? Math.min(plotH, 240) : donut);
  const outer = Math.round(Math.min(donut, dh) / 2) - 2;

  const where = ['arcs', 'rows', 'bars'];
  const hover = { name: 'hov', views: where, select: { type: 'point', fields: ['label'], on: 'mouseover', clear: 'mouseout', resolve: 'union' } };
  const pick = { name: 'pick', views: where, select: { type: 'point', fields: ['label'], on: 'click', toggle: true, clear: 'dblclick', resolve: 'union' } };
  // Fresh objects each time: vega-lite normalises a predicate in place.
  const hovOn = () => ({ param: 'hov', empty: false }), pickOn = () => ({ param: 'pick', empty: false });
  const either = () => ({ or: [hovOn(), pickOn()] });
  // Lit: the group is hovered or picked, or nothing is (an empty selection tests true, so
  // `hov` and `pick` both true means both are empty, or each holds this group).
  const lit = () => ({ or: [hovOn(), pickOn(), { and: [{ param: 'hov' }, { param: 'pick' }] }] });
  const dim = (on: number, off: number) => ({ condition: { test: lit(), value: on }, value: off });

  const order = labels;
  const yBand = { field: 'label', type: 'ordinal', sort: order, axis: null, scale: { paddingInner: 0.18, paddingOuter: 0 } };
  const colour = { field: 'label', type: 'nominal', scale: { domain: labels, range: groups.map(colourOf) }, legend: null };
  const tip = [
    { field: 'label', type: 'nominal', title: p.labels[`field.${by}`] ?? by },
    { field: 'full', type: 'nominal', title: p.labels.measure ?? '' },
    { field: 'pct', type: 'nominal', title: t('template.share') },
  ];

  const donutView = {
    name: 'donut', width: donut, height: dh,
    layer: [
      {
        name: 'arcs',
        mark: { type: 'arc', innerRadius: Math.round(outer * 0.58), outerRadius: outer, stroke: '#ffffff', strokeWidth: 1.5, cursor: 'pointer' },
        encoding: {
          theta: { field: 'value', type: 'quantitative', stack: true },
          order: { field: 'i', type: 'quantitative' },
          color: colour,
          opacity: dim(1, 0.35),
          tooltip: tip,
        },
      },
      { mark: { type: 'text', fontSize: 17, fontWeight: 600, color: INK, x: donut / 2, y: dh / 2 - 3, align: 'center', baseline: 'middle' }, encoding: { text: { value: compact(total, loc) } } },
      { mark: { type: 'text', fontSize: 10, color: MUTED, x: donut / 2, y: dh / 2 + 14, align: 'center', baseline: 'middle', limit: Math.round(outer * 1.05) }, encoding: { text: { value: p.roles.measure.unit && p.roles.measure.name !== 'count' ? p.roles.measure.unit : (p.labels.measure ?? '') } } },
    ],
  };

  const nameX = 18, valueX = listW - 48, pctX = listW;
  const listView = {
    name: 'list', width: listW, height: { step: STEP },
    encoding: { y: yBand },
    layer: [
      {
        name: 'rows',
        mark: { type: 'rect', cornerRadius: 3, cursor: 'pointer', x: 0, x2: listW },
        encoding: { fill: { condition: { test: either(), value: '#eef2ff' }, value: 'transparent' }, tooltip: tip },
      },
      { mark: { type: 'square', size: 70, interactive: false, x: 8 }, encoding: { color: colour, opacity: dim(1, 0.35) } },
      {
        mark: { type: 'text', align: 'left', baseline: 'middle', fontSize: 11.5, x: nameX, limit: Math.max(40, valueX - nameX - 44), interactive: false },
        encoding: { text: { field: 'label', type: 'nominal' }, opacity: dim(1, 0.45) },
      },
      {
        mark: { type: 'text', align: 'right', baseline: 'middle', fontSize: 11.5, fontWeight: 600, x: valueX, interactive: false },
        encoding: { text: { field: 'vlabel', type: 'nominal' }, opacity: dim(1, 0.45) },
      },
      {
        mark: { type: 'text', align: 'right', baseline: 'middle', fontSize: 11, color: MUTED, x: pctX, interactive: false },
        encoding: { text: { field: 'pct', type: 'nominal' }, opacity: dim(1, 0.45) },
      },
    ],
  };

  const barsView = {
    name: 'bars', width: barsW, height: { step: STEP },
    mark: { type: 'bar', cursor: 'pointer', cornerRadiusEnd: 2 },
    encoding: {
      y: yBand,
      x: { field: 'value', type: 'quantitative', axis: null, scale: { domain: [0, max], nice: false } },
      color: colour,
      opacity: dim(1, 0.35),
      tooltip: tip,
    },
  };

  const body = wide
    ? { hconcat: [donutView, listView, barsView], spacing: 14, center: false }
    : { vconcat: [donutView, { hconcat: [listView, barsView], spacing: 10 }], spacing: 10, center: false };

  return {
    description: p.labels.summary ?? p.labels.title ?? '',
    title: head(p, W, total, groups.length),
    data: { values },
    params: [hover, pick],
    ...body,
    config: { ...CONFIG, axis: { ...CONFIG.axis, gridColor: GRID } },
  };
}
