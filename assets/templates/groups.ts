// ─── Template groups: one field's rows as ranked, labelled, coloured groups ──
// Role: topGroups(payload, field, top) — the rows of a payload summed per
//       value of `field` (over any second field or year), ranked by the
//       measure's magnitude (|sum|, else count; a net timeline's rows tagged
//       side 'retire' count too, so its groups rank by additions + retirements
//       — the chart, its legend and the summary a model sees alike), the
//       first `top` kept and the rest summed
//       into "Other"; each with its display label (labels `value.<field>.<v>`,
//       null → labels.none) and colour (payload.colours, else NEUTRAL by rank,
//       OTHER_COLOUR for "Other"). Shared by the Vega builders and
//       show-template.ts's summary, so the chart and what a model is told agree.
//
// Deps: payload.ts (types).

import type { TemplatePayload } from './payload.js';

/** The neutral categorical palette (kit.js uses the same eight). */
export const NEUTRAL = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#9c755f'];
export const OTHER_COLOUR = '#9ca3af';

export interface Group { key: string | number | null; label: string; value: number; count: number; colour: string; other?: true }

export function topGroups(p: Pick<TemplatePayload, 'rows' | 'labels' | 'colours'>, field: string, top: number): Group[] {
  const sums = new Map<string | number | null, { value: number; count: number }>();
  for (const r of p.rows) {
    const k = r[field] ?? null;
    const g = sums.get(k) ?? { value: 0, count: 0 };
    g.value += Math.abs(r.sum ?? r.count);
    g.count += r.count;
    sums.set(k, g);
  }
  const ranked = [...sums].sort((a, b) => b[1].value - a[1].value);
  const colours = p.colours[field] ?? {};
  const out: Group[] = ranked.slice(0, top).map(([key, g], i) => ({
    key, ...g,
    label: key === null ? (p.labels.none ?? '—') : (p.labels[`value.${field}.${key}`] ?? String(key)),
    colour: (key !== null && colours[String(key)]) || (key === null ? OTHER_COLOUR : NEUTRAL[i % NEUTRAL.length]),
  }));
  const rest = ranked.slice(top);
  if (rest.length) {
    out.push({
      key: null, label: p.labels.other ?? 'Other', other: true, colour: OTHER_COLOUR,
      value: rest.reduce((s, [, g]) => s + g.value, 0), count: rest.reduce((s, [, g]) => s + g.count, 0),
    });
  }
  return out;
}
