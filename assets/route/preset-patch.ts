// ─── Route preset patch + request option checks ──────────────────────────────
// Role: the trust boundary for the Route settings editor and the route() request
//       options. `validatePresetPatch` applies a session-only
//       edit — route_w / cost_x per row, each row's `except` entries on/off (one boolean
//       per entry, in order; a shorter list, saved before an entry was appended, leaves the
//       later entries at the preset's default; a patch never adds a band), contingency, the combine rule of an existing
//       group, the short-line factors on/off — to a deep copy of a
//       preset and returns it; the registry preset is never touched. Rows have no id:
//       a row is addressed by its index in `preset.rows` and also carries that row's
//       `band` and `note`, and a patch whose band or note differs from the row at that
//       index is refused (an edit made against another registry order never lands on
//       the wrong row). On a `cost_by_region` row cost_x is a scale onto every regional
//       set's value, so each scaled value must also stay in COST_X_RANGE. `add_rows`
//       appends one row per uploaded layer after the preset's rows: an entry reads band `upl_<hash>` (uploadBand)
//       (cells inside the layer = 1), `layer` its 16-hex hash (distinct), `label` 1–60 characters
//       once control characters are stripped (it becomes the row's `note`), scalar `route_w` in
//       ROUTE_W_RANGE and `cost_x` in COST_X_RANGE, optional `barrier`; any other field, a `remove`
//       key among them (a session-only edit, route-request.ts mergePatch), is refused. `rows` address
//       the preset's own rows only. `uploadHashes` gives a patch's layers in add_rows order.
//       `UPLOAD_BYTES_BUDGET` (512 MiB of 1 B per bbox cell per layer), `uploadBudgetReason` and `parseUploadBudget`, `localBudget`
//       (the refusal and its parts, which the views word in the locale); `UPLOAD_TOTAL_VERTICES`.
//       `cost_inputs` (CostInputs) replaces a line type's base $/mi, station figure and line-position figure with
//       the visitor's, each with its own dollar year; `all-in` then removes every multiplier, markup, mitigation,
//       ROW land, contingency and short-line factor (routing weights stay, so the route is the bare route) and
//       records `user_costs`. `validateTerminals` checks a request's end kinds against the patched preset.
//       `validateRouteOptions` checks
//       `alternatives` / `altStretch` / `surface` / `profile` and gives the defaults. Refusals are
//       Outcomes, never throws; numbers must be finite JS numbers (a string, NaN,
//       Infinity or a JSON `1e400` is refused).
//       Pure: no DOM, no I/O.
// Deps: src/registry/route-presets.ts (types only), dataset-query.ts (Outcome, type only).

import type { Outcome } from '../dataset-query.js';
import type { Combine, EndKind, Factor, RoutePreset, UploadBand } from '../../src/registry/route-presets.js';
import { UPLOAD_MAX_VERTICES } from './upload-layer.js';

type Result<T> = Outcome<T>;

export interface RowPatch {
  /** Index into `preset.rows`. */
  row: number;
  /** The addressed row's `band` and `note`, checked against the row at `row`. */
  band: string;
  note?: string;
  /** A number for a constant factor, [from, to] for a ramp row. */
  route_w?: number | [number, number];
  cost_x?: number | [number, number];
  /** One flag per `except` entry of the row, in order (true = exemption active); missing trailing entries keep the preset's default. */
  except?: boolean[];
}

export interface PresetPatch {
  rows?: RowPatch[];
  /** Contingency fraction (0.3 = 30 %), on a preset that has a contingency line. */
  contingency?: number;
  /** Group → rule, for a group the preset already combines. */
  combine?: Record<string, Combine>;
  /** false drops the preset's short-line length factors; true keeps them (needs a preset that has them). */
  length_factor?: boolean;
  /** One row per uploaded layer, band `upl{i}` by position. A session patch may also carry partial
   *  entries and `{layer, remove: true}` (route-request.ts mergePatch); a solve's patch takes only
   *  whole entries without `remove`. */
  add_rows?: AddRow[];
  /** The visitor's own cost figures, on any method (see CostInputs). */
  cost_inputs?: CostInputs;
}

export type EndChoice = 'auto' | EndKind;
/** Entered cost figures; every figure carries `year` and escalates from it by the BLS year index.
 *  `bare`: the entered $/mi replaces the base $/mi (cell multipliers and the short-line factor still apply),
 *  station / position figures replace the method's. `all-in`: the entered $/mi is the whole line cost per mile
 *  (no multipliers, markups, mitigation, ROW land, contingency). */
export interface CostInputs {
  basis: 'bare' | 'all-in';
  year: number;
  line_types?: Record<string, { usd_per_mi?: number; station_usd?: number; position_usd?: number }>;
  /** What each end is (UI only; not applied to the preset). */
  ends?: [EndChoice, EndChoice];
}
/** `src` of every figure that came from `cost_inputs`. */
export const USER_COST_SRC = 'user-entered';

/** An uploaded layer's Method row: whole (as a solve takes it), or a session edit of a saved one. */
export interface AddRow {
  /** The uploaded layer's hash (upload-layer.ts `hash`, 16 hex). */
  layer: string;
  label?: string;
  route_w?: number;
  cost_x?: number;
  barrier?: boolean;
  /** Session only: drop the saved method's entry with this hash. */
  remove?: true;
}

export const ROUTE_W_RANGE: readonly [number, number] = [0.01, 10000];
export const COST_X_RANGE: readonly [number, number] = [0.1, 100];
export const MAX_ALTERNATIVES = 3;
export const MAX_UPLOAD_LABEL = 60;
/** An uploaded layer's band: keyed by its hash, so removing another layer never shifts it. */
export const uploadBand = (hash: string): UploadBand => `upl_${hash}`;
/** Uploaded layers are held at 1 B per bbox cell each; a solve is refused above this many bytes of them. */
export const UPLOAD_BYTES_BUDGET = 512 * 1024 * 1024;
/** The sum of the Method tab's registered layers' positions at most (8 × the one-file cap). */
export const UPLOAD_TOTAL_VERTICES = 8 * UPLOAD_MAX_VERTICES;
export const UPLOAD_BUDGET_MSG = 'uploaded layers exceed the memory budget';
const MIB = 1024 * 1024;
const mibText = (bytes: number): number => { const v = bytes / MIB; return v >= 10 ? Math.round(v) : +v.toFixed(2); };
/** The refusal for `n` layers over `cells` bbox cells against `budget` bytes. */
export const uploadBudgetReason = (n: number, cells: number, budget: number): string =>
  `${UPLOAD_BUDGET_MSG}: ${n} layers × ${cells} cells = ${mibText(n * cells)} MiB, at most ${mibText(budget)} MiB`;
/** {n, mib, max} out of an uploadBudgetReason, or null for any other reason. */
export function parseUploadBudget(reason: string): { n: string; mib: string; max: string } | null {
  const m = reason.startsWith(UPLOAD_BUDGET_MSG) ? /: (\d+) layers × \d+ cells = ([\d.]+) MiB, at most ([\d.]+) MiB/.exec(reason) : null;
  return m ? { n: m[1], mib: m[2], max: m[3] } : null;
}
/** parseUploadBudget's parts with the MiB figures in a locale's number format. */
export const localBudget = (b: { n: string; mib: string; max: string }, locale: string): { n: string; mib: string; max: string } =>
  ({ ...b, mib: Number(b.mib).toLocaleString(locale), max: Number(b.max).toLocaleString(locale) });
const HASH = /^[0-9a-f]{16}$/;
/** A label as a row note: control characters stripped, trimmed. */
export const uploadLabel = (s: string): string => s.replace(/\p{Cc}/gu, '').trim();
/** The uploaded layers a patch's `add_rows` name, in add_rows order; [] without any. */
export const uploadHashes = (patch: PresetPatch | null | undefined): string[] =>
  Array.isArray(patch?.add_rows) ? patch.add_rows.map((r) => String((r as AddRow | null)?.layer)) : [];
export const MAX_ALT_STRETCH = 0.5;
export const DEFAULT_ALT_STRETCH = 0.2;

const COMBINES: readonly string[] = ['max', 'min', 'multiply'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const err = (reason: string): Outcome<never> => ({ ok: false, reason });

function factor(v: unknown, current: Factor, range: readonly [number, number], what: string): Result<Factor> {
  const inRange = (x: unknown) => finite(x) && x >= range[0] && x <= range[1];
  const bad = `${what} must be ${typeof current === 'number' ? 'a number' : 'a [from, to] pair of numbers'} in [${range[0]}, ${range[1]}]`;
  if (typeof current === 'number') return inRange(v) ? { ok: true, result: v as number } : err(bad);
  return Array.isArray(v) && v.length === 2 && inRange(v[0]) && inRange(v[1])
    ? { ok: true, result: { ramp: [v[0], v[1]] } } : err(bad);
}

/** The preset with `patch` applied (a deep copy), or why the patch is refused. */
export function validatePresetPatch(preset: RoutePreset, patch: unknown): Result<RoutePreset> {
  if (patch === undefined) return { ok: true, result: preset };
  if (!isObj(patch)) return err('presetPatch must be an object');
  const unknown = Object.keys(patch).filter((k) => !['rows', 'contingency', 'combine', 'length_factor', 'add_rows', 'cost_inputs'].includes(k));
  if (unknown.length) return err(`presetPatch has unknown field "${unknown[0]}"`);
  const out: RoutePreset = structuredClone(preset);

  if (patch.rows !== undefined) {
    if (!Array.isArray(patch.rows)) return err('presetPatch.rows must be an array');
    for (const [k, e] of patch.rows.entries()) {
      if (!isObj(e)) return err(`presetPatch.rows[${k}] must be an object`);
      const extra = Object.keys(e).filter((f) => !['row', 'band', 'note', 'route_w', 'cost_x', 'except'].includes(f));
      if (extra.length) return err(`presetPatch.rows[${k}] has unknown field "${extra[0]}"`);
      const i = e.row;
      if (!(typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < out.rows.length))
        return err(`presetPatch.rows[${k}].row must be an integer in [0, ${out.rows.length - 1}]`);
      const target = out.rows[i];
      if (e.band !== target.band || e.note !== target.note)
        return err(`presetPatch.rows[${k}] names band "${String(e.band)}" / note "${String(e.note)}", but row ${i} is ${target.band} / "${target.note ?? ''}"`);
      if (e.route_w !== undefined) {
        const r = factor(e.route_w, target.route_w, ROUTE_W_RANGE, `row ${i} route_w`);
        if (!r.ok) return r;
        target.route_w = r.result;
      }
      if (e.cost_x !== undefined) {
        const r = factor(e.cost_x, target.cost_x, COST_X_RANGE, `row ${i} cost_x`);
        if (!r.ok) return r;
        if (target.cost_by_region && typeof r.result === 'number') {
          const vals = Object.values(target.cost_by_region), k = r.result;
          const hi = Math.max(...vals), lo = Math.min(...vals);
          if (k * hi > COST_X_RANGE[1] || k * lo < COST_X_RANGE[0])
            return err(`row ${i} cost_x scales every regional cost set: ×${k} gives ${+(k * lo).toPrecision(6)}–${+(k * hi).toPrecision(6)}, outside [${COST_X_RANGE[0]}, ${COST_X_RANGE[1]}]`);
        }
        target.cost_x = r.result;
      }
      if (e.except !== undefined) {
        const have = target.except ?? [];
        if (!(Array.isArray(e.except) && e.except.length <= have.length && e.except.every((x) => typeof x === 'boolean')))
          return err(`row ${i} except must be an array of at most ${have.length} true/false value${have.length === 1 ? '' : 's'} (one per exemption of the row)`);
        e.except.forEach((on, j) => { have[j].active = on as boolean; });
      }
    }
  }

  if (patch.contingency !== undefined) {
    if (!out.contingency) return err(`preset ${out.id} has no contingency line to edit`);
    const c = patch.contingency;
    if (!(finite(c) && c >= 0 && c <= 1)) return err('contingency must be a number in [0, 1]');
    out.contingency.pct = c;
  }

  if (patch.combine !== undefined) {
    if (!isObj(patch.combine)) return err('presetPatch.combine must be an object');
    for (const [g, rule] of Object.entries(patch.combine)) {
      if (!Object.hasOwn(out.combine, g)) return err(`unknown combine group "${g}" (has ${Object.keys(out.combine).join(', ') || 'none'})`);
      if (typeof rule !== 'string' || !COMBINES.includes(rule)) return err(`combine rule for "${g}" must be max, min or multiply`);
      out.combine[g] = rule as Combine;
    }
  }
  if (patch.length_factor !== undefined) {
    if (typeof patch.length_factor !== 'boolean') return err('length_factor must be true or false');
    if (!out.length_factor) return err(`preset ${out.id} has no short-line factors to switch`);
    if (!patch.length_factor) delete out.length_factor;
  }
  if (patch.add_rows !== undefined) {
    const a = patch.add_rows;
    if (!Array.isArray(a)) return err('presetPatch.add_rows must be an array');
    const seen = new Set<string>();
    for (const [k, e] of a.entries()) {
      const at = `presetPatch.add_rows[${k}]`;
      if (!isObj(e)) return err(`${at} must be an object`);
      if (Object.hasOwn(e, 'remove')) return err(`${at} has "remove": a removal is a session edit, merged before a solve or a save`);
      const extra = Object.keys(e).filter((f) => !['layer', 'label', 'route_w', 'cost_x', 'barrier'].includes(f));
      if (extra.length) return err(`${at} has unknown field "${extra[0]}"`);
      if (typeof e.layer !== 'string' || !HASH.test(e.layer)) return err(`${at}.layer must be an uploaded layer's 16-hex hash`);
      if (seen.has(e.layer)) return err(`${at} repeats uploaded layer ${e.layer}`);
      seen.add(e.layer);
      const label = typeof e.label === 'string' ? uploadLabel(e.label) : '';
      if (!label || [...label].length > MAX_UPLOAD_LABEL) return err(`${at}.label must be 1–${MAX_UPLOAD_LABEL} characters`);
      const w = factor(e.route_w, 1, ROUTE_W_RANGE, `${at}.route_w`);
      if (!w.ok) return w;
      const c = factor(e.cost_x, 1, COST_X_RANGE, `${at}.cost_x`);
      if (!c.ok) return c;
      if (e.barrier !== undefined && typeof e.barrier !== 'boolean') return err(`${at}.barrier must be true or false`);
      out.rows.push({
        band: uploadBand(e.layer), match: { codes: [1] }, route_w: w.result, cost_x: c.result,
        ...(e.barrier ? { barrier: 'hard' as const } : {}), note: label, src: `uploaded layer ${e.layer}`,
      });
    }
  }
  if (patch.cost_inputs !== undefined) {
    const r = applyCostInputs(out, patch);
    if (!r.ok) return r;
  }
  return { ok: true, result: out };
}

const END_CHOICES: readonly string[] = ['auto', 'new', 'position', 'none'];
const KINDS: readonly string[] = ['new', 'position', 'none'];
const FIGURES = ['usd_per_mi', 'station_usd', 'position_usd'] as const;

/** Applies `patch.cost_inputs` to `out` (already patched), or why it is refused. */
function applyCostInputs(out: RoutePreset, patch: Record<string, unknown>): Result<true> {
  const ci = patch.cost_inputs;
  if (!isObj(ci)) return err('cost_inputs must be an object');
  const top = Object.keys(ci).find((k) => !['basis', 'year', 'line_types', 'ends'].includes(k));
  if (top !== undefined) return err(`cost_inputs has unknown field "${top}"`);
  if (ci.basis !== 'bare' && ci.basis !== 'all-in') return err('cost_inputs.basis must be "bare" or "all-in"');
  const year = ci.year;
  if (!(typeof year === 'number' && Number.isInteger(year) && year >= 1990 && year <= out.escalation.to_year))
    return err(`cost_inputs.year must be an integer in [1990, ${out.escalation.to_year}]`);
  if (ci.ends !== undefined && !(Array.isArray(ci.ends) && ci.ends.length === 2 && ci.ends.every((e) => typeof e === 'string' && END_CHOICES.includes(e))))
    return err('cost_inputs.ends must be two of auto, new, position, none');
  const entries: [string, Record<string, number>][] = [];
  if (ci.line_types !== undefined) {
    if (!isObj(ci.line_types)) return err('cost_inputs.line_types must be an object');
    for (const [lt, e] of Object.entries(ci.line_types)) {
      const at = `cost_inputs.line_types.${lt}`;
      if (!Object.hasOwn(out.line_types, lt)) return err(`${at}: preset ${out.id} has no line type "${lt}" (has ${Object.keys(out.line_types).join(', ')})`);
      if (!isObj(e)) return err(`${at} must be an object`);
      const extra = Object.keys(e).find((f) => !(FIGURES as readonly string[]).includes(f));
      if (extra !== undefined) return err(`${at} has unknown field "${extra}"`);
      if (!FIGURES.some((f) => e[f] !== undefined)) return err(`${at} needs at least one of ${FIGURES.join(', ')}`);
      if (e.usd_per_mi !== undefined && !(finite(e.usd_per_mi) && e.usd_per_mi > 0 && e.usd_per_mi <= 1e9))
        return err(`${at}.usd_per_mi must be a number in (0, 1e9]`);
      for (const f of ['station_usd', 'position_usd'] as const)
        if (e[f] !== undefined && !(finite(e[f]) && e[f] >= 0 && e[f] <= 1e10)) return err(`${at}.${f} must be a number in [0, 1e10]`);
      entries.push([lt, e as Record<string, number>]);
    }
  }
  const allIn = ci.basis === 'all-in';
  if (allIn) {
    if (!entries.length) return err('all-in cost_inputs needs at least one line type with usd_per_mi');
    const none = entries.find(([, e]) => e.usd_per_mi === undefined);
    if (none) return err(`all-in cost_inputs.line_types.${none[0]} needs usd_per_mi`);
    const clash = patch.contingency !== undefined ? 'contingency'
      : patch.combine !== undefined ? 'combine'
      : patch.length_factor !== undefined ? 'length_factor'
      : Array.isArray(patch.rows) && patch.rows.some((r) => isObj(r) && r.cost_x !== undefined) ? 'rows[].cost_x'
      : Array.isArray(patch.add_rows) && patch.add_rows.some((r) => isObj(r) && r.cost_x !== undefined && r.cost_x !== 1) ? 'add_rows[].cost_x'
      : null;
    if (clash) return err(`all-in cost_inputs has no use for ${clash}: it has no effect on an all-in $/mi`);
  }
  for (const [lt, e] of entries) {
    const line = out.line_types[lt];
    if (e.usd_per_mi !== undefined) line.base_per_mi = { usd: e.usd_per_mi, year, src: USER_COST_SRC };
    if (e.station_usd !== undefined) {
      line.terminals.usd_each = e.station_usd;
      line.terminals.year = year;
      line.terminals.src = USER_COST_SRC;
      delete line.terminals.arithmetic;
      delete line.terminals.markup_in;
    }
    if (e.position_usd !== undefined) line.terminals.position = { usd_each: e.position_usd, year, arithmetic: '', src: USER_COST_SRC };
  }
  if (allIn) {
    out.markups = [];
    delete out.contingency;
    delete out.mitigation;
    delete out.row_land;
    delete out.length_factor;
    for (const r of out.rows) { r.cost_x = 1; delete r.cost_by_region; }
  }
  const items = (['line', 'station', 'position'] as const).filter((it) =>
    entries.some(([, e]) => e[it === 'line' ? 'usd_per_mi' : it === 'station' ? 'station_usd' : 'position_usd'] !== undefined));
  out.user_costs = { basis: ci.basis, year, items, line_types: entries.map(([lt]) => lt) };
  return { ok: true, result: true };
}

/** A request's end kinds checked against the patched preset and the solve's line type (default both `new`). */
export function validateTerminals(kinds: unknown, preset: RoutePreset, lineType: string): Result<[EndKind, EndKind]> {
  if (!(Array.isArray(kinds) && kinds.length === 2 && kinds.every((k) => typeof k === 'string' && KINDS.includes(k))))
    return err('terminals must be two of new, position, none');
  const line = Object.hasOwn(preset.line_types, lineType) ? preset.line_types[lineType] : undefined;
  if (!line) return err(`preset ${preset.id} has no line type "${lineType}"`);
  const uc = preset.user_costs;
  if (uc?.basis === 'all-in' && !uc.line_types.includes(lineType))
    return err(`the all-in figures name no $/mi for line type "${lineType}" (they name ${uc.line_types.join(', ')})`);
  if (kinds.includes('position') && !line.terminals.position)
    return err(`line type "${lineType}" of preset ${preset.id} has no line position figure`);
  return { ok: true, result: kinds as [EndKind, EndKind] };
}

export interface RouteOptions { alternatives: number; altStretch: number; surface: boolean; profile: boolean }

/** `alternatives` integer 0–3 (default 0), `altStretch` in (0, 0.5] (default 0.2), `surface` and `profile` booleans (default false). */
export function validateRouteOptions(o: { alternatives?: unknown; altStretch?: unknown; surface?: unknown; profile?: unknown }): Result<RouteOptions> {
  const alternatives = o.alternatives ?? 0, altStretch = o.altStretch ?? DEFAULT_ALT_STRETCH, surface = o.surface ?? false, profile = o.profile ?? false;
  if (!(typeof alternatives === 'number' && Number.isInteger(alternatives) && alternatives >= 0 && alternatives <= MAX_ALTERNATIVES))
    return err(`alternatives must be an integer in [0, ${MAX_ALTERNATIVES}]`);
  if (!(finite(altStretch) && altStretch > 0 && altStretch <= MAX_ALT_STRETCH))
    return err(`altStretch must be a number in (0, ${MAX_ALT_STRETCH}]`);
  if (typeof surface !== 'boolean') return err('surface must be true or false');
  if (typeof profile !== 'boolean') return err('profile must be true or false');
  return { ok: true, result: { alternatives, altStretch, surface, profile } };
}

/** The search limit as a multiple of the optimum cost C: (1 + max(0.20, altStretch)) · C. */
export const searchLimitFactor = (altStretch: number): number => 1 + Math.max(DEFAULT_ALT_STRETCH, altStretch);
