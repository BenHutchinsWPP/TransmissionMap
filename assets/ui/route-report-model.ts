// ─── Route report model ──────────────────────────────────────────────────────
// Role: the printed route report as plain data: every heading, sentence and figure of
//       `route-report.ts`, built from a route session by `buildReportModel` — title, badge, the disclaimer (the route usage notice), KPIs (five tiles) and
//       estimate range, endpoints, waterfall lines (label, value, formatted text, group), strip
//       segments (miles, cost multiple, agency), crossings table (counts, miles),
//       method (custom label, edit lines, wording) and sources. `fmtMoney` is the dollar formatter the panel and the PDF share. No DOM, no map. `reportText` lists
//       the text in the order the printed report shows it (the DOM report is its test reference).
//       `parts` holds the lines that mix app wording with visitor text (the A/B names, a saved method's name)
//       as a template + parameters (`Tpl`, `fillTpl`), so the PDF can map the wording and keep the visitor's text exact.
//       `observations` carries the shown path's aviation data as given; their tables and notes stay
//       with route-observations.ts and are not in `reportText`. `method.uploads` lists the method's uploaded layers
//       (a saved method's stored patch with the session patch on top, `mergePatch`; label, routing weight, cost
//       multiplier, barrier) as templates whose label is visitor text. The method's edit list also carries the figures the
//       visitor entered for the line type shown (`cost_inputs`: amount, dollar year, basis) and the ends they set; each
//       endpoint line names its terminal (new station, line position, none) from the result's `terminalItems`.
//       The waterfall and the sources read the preset as the solve used it (`solvedPresetOf`), so an entered figure
//       is cited as such. `costCsv` is the cost.csv text (pane download and batch ZIP).
// Deps: route-tabs/widgets.ts (waterfallLines, bandLabel, approxCount, kpiTiles, fmtMoneyHead), route-tabs/method.ts (methodOf, countEdits, solvedPresetOf),
//       route-tabs/cost-inputs.ts (effectiveInputs),
//       route-tabs/crossings.ts (shownExact), route-tabs/weights-table.ts (rowLabel, fmtFactor), route/custom-presets.ts (presetLabel), route/screening.ts (types), route/preset-patch.ts (uploadLabel, CostInputs type), ./route-request.ts (mergePatch),
//       registry/route-presets.ts, registry/route-band-data.ts (methodSources), user-data/user-data-export.ts (toCsv), i18n.

import { t } from '../../src/i18n/index.js';
import { ROUTE_PRESETS, routePreset } from '../../src/registry/route-presets.js';
import type { RoutePreset } from '../../src/registry/route-presets.js';
import type { CrossingPoint, RouteProfile } from '../route/profile.js';
import { uploadLabel, type CostInputs, type PresetPatch } from '../route/preset-patch.js';
import type { RouteScreening } from '../route/screening.js';
import type { RouteResult } from '../route/route.js';
import { methodSources } from '../../src/registry/route-band-data.js';
import { presetLabel } from '../route/custom-presets.js';
import type { DollarYear, RouteInputs, RouteSession } from './route-tabs/types.js';
import { toCsv } from '../user-data/user-data-export.js';
import { countEdits, methodOf, solvedPresetOf } from './route-tabs/method.js';
import { effectiveInputs } from './route-tabs/cost-inputs.js';
import { shownExact } from './route-tabs/crossings.js';
import { aviationMiles, aviationNote } from './route-observations.js';
import { mergePatch } from './route-request.js';
import { fmtFactor, rowLabel } from './route-tabs/weights-table.js';
import { approxCount, bandLabel, fmtMoneyHead, kpiTiles, waterfallLines, type WaterfallGroup, type WaterfallLine } from './route-tabs/widgets.js';

/** Dollars as the panel and the PDF show them (`$3.10 B`, `$716 M`, `$33.4 M`, `$12 k`). */
export function fmtMoney(v: number): string {
  const a = Math.abs(v), s = v < 0 ? '\u2212' : '';
  // The unit is chosen after rounding, so 999.6 M reads "$1.00 B", not "$1000 M".
  // A no-break space keeps "$3.12 B" on one line in narrow cells.
  if (a >= 999.5e6) return `${s}$${(a / 1e9).toFixed(2)}\u00a0B`;
  if (a >= 99.95e6) return `${s}$${(a / 1e6).toFixed(0)}\u00a0M`;
  if (a >= 999.5e3) return `${s}$${(a / 1e6).toFixed(1)}\u00a0M`;
  if (a >= 999.5) return `${s}$${Math.round(a / 1e3)}\u00a0k`;
  return `${s}$${Math.round(a)}`;
}

export const AGENCY_COLOURS = ['#9aa5b1', '#d9a441', '#4f9d69', '#7b6cc4', '#4a90c2', '#a0522d', '#c0504d', '#6b8e23', '#b0b0b0', '#2e8b8b', '#c28fb0', '#d2691e', '#7a7a7a'];

/** A line as its template and parameters: `visitor` names the parameters that are the visitor's own text. */
export interface Tpl { template: string; params: Record<string, string | number | Tpl>; visitor?: string[] }

/** The finished line. `map` (default none) is applied to app wording only, never to a visitor parameter. */
export function fillTpl(p: Tpl, map: (s: string) => string = (s) => s): string {
  const raw = new Set(p.visitor ?? []);
  return map(p.template).replace(/\{([^{}]+)\}/g, (m, k: string) => {
    if (!Object.hasOwn(p.params, k)) return m;
    const v = p.params[k];
    if (typeof v === 'object') return fillTpl(v, map);
    return raw.has(k) ? String(v) : map(String(v));
  });
}

const tpl = (key: string, params: Tpl['params'], visitor?: string[]): Tpl => ({ template: t(key), params, ...(visitor ? { visitor } : {}) });

export interface ReportLine extends WaterfallLine { text: string }
export interface ReportRun { mi0: number; mi1: number; costX: number; agency: number | null; costFill: string; agencyFill: string }

export interface RouteReportModel {
  /** The lines of the model that carry visitor text, as templates; `title` etc. are their `fillTpl`. */
  parts: { title: Tpl; subtitle: Tpl; endpointA: Tpl; endpointB: Tpl; methodPreset: Tpl };
  title: string;
  subtitle: string;
  badge: { optimality: RouteResult['optimality']; label: string; tip: string };
  /** The route usage notice's text, printed under the title of every report. */
  disclaimer: { heading: string; paras: string[] };
  /** The drawn route, [lng, lat] — what a picture is framed on. */
  path: [number, number][];
  lengthMi: number;
  snapshot: { alt: string; unavailable: string };
  cost: {
    heading: string;
    kpis: { value: string; label: string }[];
    range: { label: string; pct: string; low: string; point: string; high: string };
    note: string;
  };
  endpoints: { heading: string; a: string; b: string; optimality: string };
  waterfall: { heading: string; lines: ReportLine[]; legend: { group: WaterfallGroup; label: string }[] };
  /** Null without a profile. */
  strip: null | { heading: string; legend: string; title: string; lengthMi: number; runs: ReportRun[]; startLabel: string; endLabel: string };
  /** Null without a profile. */
  crossings: null | { heading: string; head: string[]; rows: { label: string; count: string; miles: string }[]; note: string; aviationNote: string | null };
  /** Null unless the shown path has exact crossings; `screening` is absent when observations were not read. */
  observations: null | { screening?: RouteScreening };
  method: {
    heading: string; preset: string; editsSummary: string | null; edits: string[];
    /** One line per uploaded layer in the method; `label` is the visitor's text (a `visitor` parameter, never glyph-mapped). */
    uploads: Tpl[];
    attribution: string; caveat: string; class5: string; grid: string; sourcesHeading: string; sources: string;
  };
  caveats: { heading: string; screening: string; credit: string };
}

type End = { lngLat: [number, number]; hit: { name: string | null; maxKv: number | null } | null } | null;

/** ", terminal: new station" for an end of a result whose terminals are known; '' otherwise. */
function terminalOf(cost: RouteResult['cost'], side: 'A' | 'B', preset: RoutePreset): string {
  if (!cost.terminalItems || cost.terminalsUsd === null) return '';
  const kind = cost.terminalItems.find((i) => i.end === side)?.kind ?? 'none';
  const key = kind === 'new' && preset.study_terminals ? 'route.report.term.newStudy' : `route.report.term.${kind}`;
  return t('route.report.endTerminal', { kind: t(key) });
}

function endpoint(label: string, end: End, terminal = ''): Tpl {
  if (!end) return { template: '', params: {} };
  const named = !!end.hit?.name;
  const name = end.hit?.name || t(end.hit ? 'route.report.endUnnamedSub' : 'route.report.endUnnamed');
  const kv = end.hit?.maxKv ? `, ${t('route.report.endKv', { kv: end.hit.maxKv })}` : '';
  return { template: '{label}: {name}{kv} ({lng}, {lat}){terminal}', params: { label, name, kv, lng: end.lngLat[0].toFixed(4), lat: end.lngLat[1].toFixed(4), terminal }, ...(named ? { visitor: ['name'] } : {}) };
}

function endName(end: End): string {
  if (!end) return '';
  return end.hit?.name || `${end.lngLat[1].toFixed(3)}, ${end.lngLat[0].toFixed(3)}`;
}

/** The figures entered for `lineType` (amount, dollar year, basis) and the ends set, one line each. */
export function costInputLines(ci: CostInputs | undefined, lineType: string): string[] {
  const out: string[] = [];
  if (!ci) return out;
  const e = ci.line_types?.[lineType];
  const basis = t(ci.basis === 'all-in' ? 'route.ci.basis.allin.short' : 'route.ci.basis.bare.short');
  if (e?.usd_per_mi !== undefined) out.push(t('route.report.edit.userLine', { usd: fmtMoney(e.usd_per_mi), year: ci.year, basis }));
  if (e?.station_usd !== undefined) out.push(t('route.report.edit.userStation', { usd: fmtMoney(e.station_usd), year: ci.year }));
  if (e?.position_usd !== undefined) out.push(t('route.report.edit.userPosition', { usd: fmtMoney(e.position_usd), year: ci.year }));
  const [a, b] = ci.ends ?? ['auto', 'auto'];
  const kind = (c: string) => t(c === 'auto' ? 'route.ci.end.autoShort' : `route.report.term.${c}`);
  if (a !== 'auto' || b !== 'auto') out.push(t('route.report.edit.ends', { a: kind(a), b: kind(b) }));
  return out;
}

/** One line per edited row (and contingency): "Slope — mountain, ≥ 4°: routing ×1.75→2, cost ×1→1.5"; then the cost inputs' lines. */
export function editLines(preset: RoutePreset, patch: PresetPatch | null, ci?: CostInputs, lineType = ''): string[] {
  const out: string[] = [];
  for (const e of patch?.rows ?? []) {
    const row = preset.rows[e.row];
    if (!row) continue;
    const parts: string[] = [];
    if (e.route_w !== undefined) parts.push(t('route.report.edit.routeW', { a: fmtFactor(row.route_w), b: fmtFactor(e.route_w) }));
    if (e.cost_x !== undefined) parts.push(t('route.report.edit.costX', { a: fmtFactor(row.cost_x), b: fmtFactor(e.cost_x) }));
    if (e.except) parts.push(t('route.report.edit.except'));
    if (parts.length) out.push(`${rowLabel(row)}: ${parts.join(', ')}`);
  }
  if (patch?.contingency !== undefined && preset.contingency) {
    const pct = (x: number) => String(+(x * 100).toFixed(6));
    out.push(t('route.report.edit.contingency', { a: pct(preset.contingency.pct), b: pct(patch.contingency) }));
  }
  out.push(...costInputLines(ci, lineType));
  return out;
}

/** "uploaded layer: <label> — routing weight a, cost × b[, barrier]" for each whole add_rows entry. */
export function uploadLines(patch: PresetPatch | null): Tpl[] {
  const out: Tpl[] = [];
  for (const r of patch?.add_rows ?? []) {
    if (!r || r.remove) continue;
    const num = (v: number | undefined) => (v === undefined ? t('route.cross.na') : fmtFactor(v));
    out.push(tpl(r.barrier ? 'route.report.method.uploadBarrier' : 'route.report.method.upload',
      { label: uploadLabel(r.label ?? r.layer), w: num(r.route_w), x: num(r.cost_x) }, ['label']));
  }
  return out;
}

const signed = (v: number, money: (v: number) => string) => (v < 0 ? '−' : '+') + money(Math.abs(v));

function stripRuns(profile: RouteProfile): ReportRun[] {
  return profile.runs.map((run) => {
    const u = Math.min(1, Math.max(0, (run.costX - 1) / 1.5));
    return {
      mi0: run.mi0, mi1: run.mi1, costX: run.costX, agency: run.agency ?? null,
      costFill: `hsl(${45 - 45 * u} 85% ${82 - 42 * u}%)`,
      agencyFill: AGENCY_COLOURS[((run.agency ?? 1) - 1 + AGENCY_COLOURS.length) % AGENCY_COLOURS.length],
    };
  });
}

function crossingsOf(session: RouteSession, profile: RouteProfile) {
  const ex = shownExact(session);
  const c = profile.crossings;
  const rows: { label: string; count: string; miles: string }[] = [];
  const counted: [CrossingPoint['kind'], number][] = [
    ['river', c.counts.river], ['road', c.counts.road], ['rail', c.counts.rail], ['pipeline', c.counts.pipeline],
    ['line230', c.counts.line230], ['line100', c.counts.line100],
  ];
  const isExact = (k: string) => !!ex && ex.exact.includes(k as CrossingPoint['kind']);
  const allExact = counted.every(([k]) => isExact(k));
  const na = t('route.cross.na');
  for (const [k, n] of counted) {
    const label = t(`route.cross.row.${k}`);
    if (!isExact(k)) rows.push({ label, count: approxCount(n), miles: na });
    else rows.push({ label: allExact ? label : `${label} (${t('route.cross.note.exact')})`, count: approxCount(ex!.result.counts[k]), miles: na });
  }
  const miled: [string, number][] = [
    ['follows', c.miles.follows], ['s368', c.miles.s368], ['gap12', c.miles.gap12], ['gap3', c.miles.gap3],
    ['critHab', c.miles.critHab], ['phma', c.miles.phma], ['tribal', c.miles.tribal], ['park', c.miles.park], ['wetland', c.miles.wetland],
  ];
  for (const [k, mi] of miled) rows.push({ label: t(`route.cross.row.${k}`), count: na, miles: mi.toFixed(1) });
  for (const { code, miles } of aviationMiles(c)) rows.push({ label: t(`route.cross.row.av${code}`), count: na, miles: miles.toFixed(1) });
  return {
    crossings: {
      heading: t('route.report.crossings'),
      head: [t('route.cross.head.feature'), t('route.cross.head.crossings'), t('route.cross.head.miles')],
      rows,
      note: t(allExact ? 'route.report.crossings.exact' : 'route.report.crossings.approx'),
      aviationNote: aviationNote(c),
    },
    observations: ex ? { ...(ex.screening ? { screening: ex.screening } : {}) } : null,
  };
}

/** The report of the session's shown result, or null without one. `money` formats a dollar figure in the shown year. */
export function buildReportModel(session: RouteSession, money: (v: number) => string, date: string = new Date().toLocaleDateString()): RouteReportModel | null {
  const result = session.result;
  if (!result) return null;
  const cost = result.cost;
  const preset = routePreset(result.preset.id);
  if (!preset) throw new Error(`route report: unknown preset ${result.preset.id}`);
  const lineType = preset.line_types[cost.lineType]?.label ?? cost.lineType;
  const inp = session.resultInputs ?? session.inputs;
  const custom = inp.presetId.startsWith('custom:') ? methodOf(inp.presetId) : null;
  const baseLabel = presetLabel(preset);
  const methodLabel: Tpl = custom ? tpl('route.report.method.custom', { name: custom.label, base: baseLabel }, ['name']) : { template: '{base}', params: { base: baseLabel } };
  const parts = {
    title: tpl('route.report.title', { a: endName(inp.a), b: endName(inp.b) }, ['a', 'b']),
    subtitle: tpl('route.report.sub', { lineType, method: methodLabel, date }),
    endpointA: endpoint(t('route.report.endA'), inp.a, terminalOf(cost, 'A', preset)),
    endpointB: endpoint(t('route.report.endB'), inp.b, terminalOf(cost, 'B', preset)),
    methodPreset: tpl('route.report.method.preset', { label: methodLabel }),
  };
  const dollars = session.dollars;

  const solved = solvedPresetOf(inp) ?? custom?.preset ?? preset;
  const lines: ReportLine[] = waterfallLines(cost, solved, { dollars }).map((l) => ({
    ...l, text: l.group === 'subtotal' || l.group === 'total' ? money(l.value) : signed(l.value, money),
  }));
  const legend = (['base', 'multipliers', 'terminals', 'markups', 'contingency', 'other'] as WaterfallGroup[])
    .filter((g) => lines.some((l) => l.group === g)).map((group) => ({ group, label: t(`route.wf.legend.${group}`) }));

  const coords = result.path.coordinates as [number, number][];
  const kpis = kpiTiles(result, dollars);
  const k = dollars === 'preset' && cost.total2025 ? cost.totalNominal / cost.total2025 : 1;
  const low = cost.band.low * k, high = cost.band.high * k, pt = cost.total2025 * k;
  const pct = (v: number) => `${v < pt ? '−' : '+'}${Math.round((Math.abs(v - pt) / (pt || 1)) * 100)}`;

  const profile = result.profile;
  const edits: string[] = [];
  const n = countEdits(inp.patch);
  const ci = effectiveInputs(custom?.stored ?? null, inp.patch);
  const own = costInputLines(ci, cost.lineType);
  if (n > 0) edits.push(...editLines(custom?.preset ?? preset, inp.patch, ci, cost.lineType));
  else edits.push(...own);

  return {
    parts,
    title: fillTpl(parts.title),
    subtitle: fillTpl(parts.subtitle),
    badge: { optimality: result.optimality, label: t(`route.badge.${result.optimality}`), tip: t(`route.badge.${result.optimality}.tip`) },
    path: coords,
    lengthMi: result.lengthMi,
    snapshot: { alt: t('route.report.snap.alt'), unavailable: t('route.report.snap.na') },
    cost: {
      heading: t('route.report.cost'), kpis,
      range: { label: bandLabel(cost.band.label), pct: t('route.range.pct', { lo: pct(low), hi: pct(high) }), low: fmtMoneyHead(low), point: fmtMoneyHead(pt), high: fmtMoneyHead(high) },
      note: t('route.report.cost.range'),
    },
    endpoints: {
      heading: t('route.report.endpoints'), a: fillTpl(parts.endpointA), b: fillTpl(parts.endpointB),
      optimality: t(`route.report.opt.${result.optimality}`),
    },
    waterfall: { heading: t('route.report.waterfall'), lines, legend },
    strip: profile ? {
      heading: t('route.report.strip'), legend: `${t('route.report.strip.cost')} / ${t('route.report.strip.agency')}`, title: t('route.report.strip'),
      lengthMi: result.lengthMi, runs: stripRuns(profile),
      startLabel: t('route.report.strip.miles', { mi: 0 }), endLabel: t('route.report.strip.miles', { mi: Math.round(result.lengthMi) }),
    } : null,
    ...(profile ? crossingsOf(session, profile) : { crossings: null, observations: null }),
    method: {
      heading: t('route.report.method'), preset: fillTpl(parts.methodPreset),
      editsSummary: n > 0 ? t(`route.report.method.edits.${n === 1 ? 'one' : 'other'}`, { n }) : own.length ? t('route.report.method.own') : null, edits, uploads: uploadLines(mergePatch(custom?.stored ?? null, inp.patch) ?? null),
      attribution: result.preset.attribution, caveat: result.preset.caveat,
      class5: t('route.report.method.class5'), grid: t('route.report.method.grid'),
      sourcesHeading: t('route.report.sources'), sources: methodSources(solved, cost.lineType).join('; '),
    },
    disclaimer: { heading: t('route.report.disclaimer'), paras: ['p1', 'p2', 'p3', 'p4'].map((k) => t(`route.notice.${k}`)) },
    caveats: { heading: t('route.report.caveats'), screening: t('route.report.caveat.screening'), credit: t('route.report.credit') },
  };
}

/** The report's text segments in print order (the printed report's textContent is their concatenation,
 *  less the observations tables). */
export function reportText(m: RouteReportModel): string[] {
  const out: string[] = [m.title, m.subtitle, m.badge.label, m.disclaimer.heading, ...m.disclaimer.paras, m.snapshot.unavailable, m.cost.heading];
  for (const k of m.cost.kpis) out.push(k.value, k.label);
  out.push(m.cost.range.label, ' ', m.cost.range.pct, m.cost.range.low, m.cost.range.point, m.cost.range.high, m.cost.note);
  out.push(m.endpoints.heading, m.endpoints.a, m.endpoints.b, m.endpoints.optimality);
  out.push(m.waterfall.heading);
  for (const l of m.waterfall.lines) out.push(l.label, l.text);
  for (const l of m.waterfall.legend) out.push(l.label);
  if (m.strip) out.push(m.strip.heading, m.strip.legend, m.strip.title, m.strip.startLabel, m.strip.endLabel);
  if (m.crossings) {
    out.push(m.crossings.heading, ...m.crossings.head);
    for (const r of m.crossings.rows) out.push(r.label, r.count, r.miles);
    if (m.crossings.aviationNote) out.push(m.crossings.aviationNote);
    out.push(m.crossings.note);
  }
  const me = m.method;
  out.push(me.heading, me.preset);
  if (me.editsSummary !== null) out.push(me.editsSummary, ...me.edits);
  for (const u of me.uploads) out.push(fillTpl(u));
  out.push(me.attribution, me.caveat, me.class5, me.grid, me.sourcesHeading, me.sources);
  out.push(m.caveats.heading, m.caveats.screening, m.caveats.credit);
  return out;
}

/** The cost.csv text: one waterfall line per row, the method's attribution as the footer. */
export function costCsv(r: RouteResult, dollars: DollarYear, inp?: RouteInputs | null): string {
  const preset = (inp ? solvedPresetOf(inp) : null) ?? routePreset(r.preset.id) ?? ROUTE_PRESETS[0];
  const year = dollars === 'y2025' ? '2025' : String(r.cost.dollarYear);
  const rows = waterfallLines(r.cost, preset, { dollars }).map((l) => ({
    item: l.label, group: l.group, usd: Math.round(l.value), dollars: year, source: l.src ?? '',
  }));
  return toCsv(rows, ['item', 'group', 'usd', 'dollars', 'source'], r.preset.attribution);
}
