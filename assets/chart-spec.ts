// ─── Chart spec: the data a chat chart is drawn from, checked ────────────────
// Role: the declarative chart the map chat shows (ui-chart.ts draws it), and
//       the trust boundary it passes. A chart is data, never code: a type, a
//       title, category labels and up to MAX_SERIES numeric series.
//         validateChart(v)      the one check for a spec from outside this
//                               module (a model's runAnalysis value): own keys
//                               only, types, sizes (MAX_CATEGORIES, MAX_SERIES,
//                               MAX_PIE slices), finite numbers, #rrggbb
//                               colours; labels and title clipped. Refusals
//                               say what to fix, so a model can retry.
//         chartCsv(chart)       the chart's numbers as CSV: a UTF-8 BOM, one
//                               row per category, the title (humanised, with its unit once) as a note row and
//                               the layers' credit (toCsv guards formula cells).
//         humanise(field)       snake_case → "Words", a trailing unit token as
//                               "(MW)"; also what templates/show-template.ts
//                               titles a field with.
//       Session only: a chart is never in the view, the link or undo.
//       Loaded with the chat chunk (agent/tools.ts, ui/ui-chart.ts).
//
// Deps: dataset-query.ts (Outcome; type only), registry (layerById), utils/field-label.ts (humanise),
//       user-data-export.ts (toCsv).

import type { Outcome } from './dataset-query.js';
import { layerById } from '../src/registry/index.js';
import { toCsv } from './user-data/user-data-export.js';
import { humanise } from './utils/field-label.js';
export { humanise };

export const CHART_TYPES = ['bar', 'pie', 'line'] as const;
export type ChartType = typeof CHART_TYPES[number];
export const MAX_CATEGORIES = 40;
export const MAX_SERIES = 8;
export const MAX_PIE = 8;
const MAX_TITLE = 120;
const MAX_LABEL = 60;
const MAX_UNIT = 24;

export interface ChartSeries { name: string; values: number[] }
export interface ChartSpec {
  type: ChartType;
  title: string;
  categories: string[];
  series: ChartSeries[];
  unit?: string;            // of the values, e.g. MW
  xLabel?: string;          // what the categories are (the CSV's first header)
  colors?: string[];        // one #rrggbb per category (single-series bar or pie)
}
/** A checked spec, plus what page code knows about where it came from. */
export interface Chart extends ChartSpec { layers: string[]; complete: boolean }

const KEYS = new Set(['type', 'title', 'categories', 'series', 'unit', 'xLabel', 'colors']);
const HEX = /^#[0-9a-f]{6}$/i;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ok = <T>(result: T): Outcome<T> => ({ ok: true, result });
const fail = <T = never>(reason: string): Outcome<T> => ({ ok: false, reason });
const SHAPE = 'return {title, categories: [...], series: [{name, values: [...]}]}';

/** Check a chart spec from outside this module; see the header. */
export function validateChart(v: unknown): Outcome<ChartSpec> {
  if (!isObj(v)) return fail(`a chart must be an object: ${SHAPE}`);
  const extra = Object.keys(v).find(k => !KEYS.has(k));
  if (extra !== undefined) return fail(`"${extra}" is not a chart key (type, title, categories, series, unit, xLabel, colors)`);
  const { type, title, categories, series, unit, xLabel, colors } = v;
  if (!CHART_TYPES.includes(type as ChartType)) return fail('chart type must be bar, pie or line');
  if (typeof title !== 'string' || !title.trim()) return fail('a chart needs a title');
  const cap = type === 'pie' ? MAX_PIE : MAX_CATEGORIES;
  if (!Array.isArray(categories) || categories.length < 1 || categories.length > cap) {
    return fail(`categories must be an array of 1–${cap} labels${type === 'pie' ? ' (fold the rest into "Other")' : ''}`);
  }
  if (!categories.every(c => typeof c === 'string' || (typeof c === 'number' && Number.isFinite(c)))) return fail('each category must be a string or a number');
  const maxSeries = type === 'pie' ? 1 : MAX_SERIES;
  if (!Array.isArray(series) || series.length < 1 || series.length > maxSeries) return fail(`series must be an array of 1–${maxSeries}`);
  const out: ChartSeries[] = [];
  for (const [i, s] of series.entries()) {
    if (!isObj(s) || Object.keys(s).some(k => k !== 'name' && k !== 'values')) return fail(`series[${i}] must be {name, values}`);
    if (typeof s.name !== 'string') return fail(`series[${i}].name must be a string`);
    if (!Array.isArray(s.values) || s.values.length !== categories.length) return fail(`series[${i}].values needs one number per category (${categories.length})`);
    if (!s.values.every(n => typeof n === 'number' && Number.isFinite(n))) return fail(`series[${i}].values must be finite numbers`);
    if (type === 'pie' && (s.values.some(n => n < 0) || !s.values.some(n => n > 0))) return fail('pie values must be ≥ 0 with at least one above 0');
    out.push({ name: clip(s.name, MAX_LABEL), values: [...s.values] });
  }
  if (unit !== undefined && typeof unit !== 'string') return fail('unit must be a string');
  if (xLabel !== undefined && typeof xLabel !== 'string') return fail('xLabel must be a string');
  if (colors !== undefined) {
    if (!Array.isArray(colors) || colors.length !== categories.length || !colors.every(c => typeof c === 'string' && HEX.test(c))) {
      return fail('colors must be one #rrggbb per category');
    }
  }
  return ok({
    type: type as ChartType, title: clip(title.trim(), MAX_TITLE),
    categories: categories.map(c => clip(String(c), MAX_LABEL)), series: out,
    ...(unit && { unit: clip(unit, MAX_UNIT) }), ...(xLabel && { xLabel: clip(xLabel, MAX_LABEL) }),
    ...(colors && { colors: [...colors as string[]] }),
  });
}

/** The chart's numbers as CSV (with a BOM for Excel). */
export function chartCsv(c: Chart): string {
  const head = c.xLabel ?? 'category';
  const fields = [head, ...c.series.map((s, i) => c.series.slice(0, i).some(p => p.name === s.name) ? `${s.name} (${i + 1})` : s.name)];
  const rows = c.categories.map((cat, i) => Object.fromEntries([[head, cat], ...c.series.map((s, j) => [fields[j + 1], s.values[i]])]));
  const credit = c.layers.map(l => layerById(l)?.data?.credit).filter(Boolean).join('; ');
  const notes = [c.unit && !c.title.includes(`(${c.unit})`) ? `${c.title} (${c.unit})` : c.title];
  return '﻿' + toCsv(rows, fields, credit || undefined, notes);
}
