// ─── Route chat summary ──────────────────────────────────────────────────────
// Role: the page-built, size-capped summary of a route result that the map chat's planRoute tool
//       returns to the model (2025$ only, estimate range, drivers as the Cost tab's category lines,
//       crossings by kind, ≤ 2 alternatives, short page-written notes; one more says the cost uses the visitor's own
//       figures, never the figures). Pure; no DOM writes.
// Deps: ./widgets.ts (waterfallLines), route/route.ts (types), registry/route-presets.ts (types), i18n/index.ts.

import { t } from '../../../src/i18n/index.js';
import type { RouteResult } from '../../route/route.js';
import type { RoutePreset } from '../../../src/registry/route-presets.js';
import { waterfallLines } from './widgets.js';

export interface ChatRouteEnd { name: string | null; kv: number | null; lngLat: [number, number] }
export interface RouteSummary {
  a: ChatRouteEnd; b: ChatRouteEnd;
  method: string; lineType: string;
  lengthMi: number;
  cost2025: { total: number; low: number; high: number };
  drivers: { label: string; usd2025: number }[];
  crossings: Record<string, number>;
  tribalMi: number;
  optimality: 'proven' | 'within-mask' | 'not-solved';
  maskLimited: boolean;
  alternatives: { lengthMi: number; total2025: number; pctUsd: number }[];
  notes: string[];
}

/** Third-party text for the model: control characters out, 60 characters at most. */
export function cleanName(s: string | null | undefined): string | null {
  if (s == null) return null;
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60);
}

const sig3 = (v: number) => Number(v.toPrecision(3));
const r1 = (v: number) => Math.round(v * 10) / 10;
const end = (e: ChatRouteEnd): ChatRouteEnd => ({ name: cleanName(e.name), kv: e.kv, lngLat: e.lngLat });

export function chatSummary(r: RouteResult, preset: RoutePreset, methodLabel: string, a: ChatRouteEnd, b: ChatRouteEnd): RouteSummary {
  const shortLine = t('route.wf.shortLine');
  const drivers = waterfallLines(r.cost, preset, { dollars: 'y2025' })
    .filter((l) => l.group === 'multipliers' && l.label !== shortLine)
    .sort((x, y) => Math.abs(y.value) - Math.abs(x.value))
    .slice(0, 5)
    .map((l) => ({ label: l.label, usd2025: sig3(l.value) }));
  const notes: string[] = [];
  if (r.routeCost === null) notes.push('straight-line method: no routing search was run');
  if (r.maskLimited) notes.push('the search area limited the route; a wider area could change it');
  if (r.altSkipped) notes.push(`alternatives: ${r.altSkipped}`);
  notes.splice(2);
  notes.push('cost is a rough early estimate range (−30 % / +50 %)');
  if (r.cost.userCosts?.items.length) notes.push(`the cost uses figures entered by the visitor (${r.cost.userCosts.basis === 'all-in' ? 'all-in cost per mile' : 'base cost per mile'})`);
  return {
    a: end(a), b: end(b),
    method: cleanName(methodLabel) ?? '',
    lineType: preset.line_types[r.cost.lineType]?.label ?? r.cost.lineType,
    lengthMi: r1(r.lengthMi),
    cost2025: { total: sig3(r.cost.total2025), low: sig3(r.cost.band.low), high: sig3(r.cost.band.high) },
    drivers,
    crossings: { ...(r.profile?.crossings.counts ?? {}) },
    tribalMi: r1(r.tribalMiles),
    optimality: r.optimality,
    maskLimited: r.maskLimited,
    alternatives: (r.alternatives ?? []).slice(0, 2).map((x) => ({ lengthMi: r1(x.lengthMi), total2025: sig3(x.cost.total2025), pctUsd: r1(x.pctUsd) })),
    notes,
  };
}
