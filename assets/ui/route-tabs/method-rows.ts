// ─── Method rows: the pure model behind the Method grid ──────────────────────
// Role: turns a route method (a RoutePreset plus the session's PresetPatch) into flat grid rows —
//       group headers, preset rows, and one `except` row per exemption under its parent — and holds
//       the filter / sort / edited-only view over them and every edit (route_w, cost ×, the Excl.
//       tick, exemption on/off, contingency). No DOM, no Tabulator: the grid only renders.
//       `asciiText` turns its symbols into plain ASCII for copies and the CSV. Applies to is the match in words
//       (inspect.ts matchText); `match` keeps the cube's form for the tooltip and the CSV's Cube match column.
//       Every edit leaves through one `commit()`, which drops entries with nothing left and runs
//       validatePresetPatch, the trust boundary; this module does no range check of its own, so a
//       refusal's reason is the validator's. `preset` is always the method's preset (a saved
//       method's stored patch already applied); a patch holds only values that differ from it.
//       Uploaded-layer rows are not grid rows: `uploadRowsOf` lists the merged `add_rows`
//       (saved entries + the session's, mergePatch), and `upsertUpload` / `dropUpload` return the
//       new session patch — a session entry per edited hash, `{layer, remove: true}` for a saved
//       row removed — after the merged result passes validatePresetPatch; a layer that takes the held
//       layers past UPLOAD_TOTAL_VERTICES gets its own reason (`uploadTotalRefusal`, `UPLOAD_TOTAL`).
//       Entries hold hashes and numbers, never geometry.
// Deps: ui/route-request.ts (mergePatch), route/preset-patch.ts, route/cost.ts (setNames), route/inspect.ts (matchText, textOf), registry/route-presets.ts,
//       registry/route-band-data.ts (bandDataLabel), i18n (t: two fallback strings, the Applies to words).

import { t } from '../../../src/i18n/index.js';
import { EXCLUDED_W, type Combine, type CostRow, type Factor, type Match, type RoutePreset } from '../../../src/registry/route-presets.js';
import { bandDataLabel } from '../../../src/registry/route-band-data.js';
import { setNames } from '../../route/cost.js';
import { matchText, textOf } from '../../route/inspect.js';
import type { UploadLayer } from '../../route/upload-layer.js';
import { UPLOAD_TOTAL_VERTICES, validatePresetPatch, type AddRow, type PresetPatch, type RowPatch } from '../../route/preset-patch.js';
import { mergePatch } from '../route-request.js';

export type RowKind = 'group' | 'row' | 'except';
type Val = number | [number, number];
export interface MethodRow {
  key: string;            // 'g:<group>' | 'r:<i>' | 'x:<i>:<j>' (Tabulator index)
  kind: RowKind;
  row: number;            // preset row index (-1 for a group header)
  except?: number;
  group: string;          // combine group, '' = ungrouped
  label: string;          // group: group name; row: note ?? band; except: entry label
  rule?: Combine;         // group header only
  applies: string;        // the match in words
  match: string;          // the match as the cube reads it (tooltip, CSV)
  routeW: Val | null;  routeW0: Val | null;   // null: barrier / except / group
  costX: Val | null;   costX0: Val | null;
  sets: (number | null)[];                    // effective per set, setNames order
  barrier: boolean;
  excludable: boolean;  excluded: boolean;  excluded0?: boolean;  link?: string;
  exceptOn?: boolean;   exceptOn0?: boolean;
  dataFrom: string;     src: string;            // src: the full trail (tooltip)
  ref: string;          // the short reference the column shows (row.ref, else src)
  edited: boolean;
}
export type ColId = 'excl' | 'map' | 'label' | 'group' | 'applies' | 'match' | 'routeW' | 'costX' | `set:${string}` | 'dataFrom' | 'src';
export interface ViewOpts { q: string; flat: boolean; editedOnly: boolean; sort: { col: ColId; dir: 1 | -1 } | null }
export type Edit = { ok: true; patch: PresetPatch | null } | { ok: false; reason: string };

const asVal = (f: Factor): Val => (typeof f === 'number' ? f : [f.ramp[0], f.ramp[1]]);
const sameVal = (a: Val | null, b: Val | null): boolean =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1]);
const fmt = (v: Val | null): string => (v === null ? '' : Array.isArray(v) ? `${v[0]}, ${v[1]}` : String(v));
/** t() with an English fallback while a key is missing from the locales. */
const tf = (key: string, params: Record<string, string | number>, fallback: string): string => {
  const s = t(key, params);
  return s === key ? fallback : s;
};

/** The match as the cube reads it: "landcover 21, 52" / "desig bit 0" / "protect field 2" / "slope 2–3". */
function matchOf(band: string, m: Match): string {
  if ('range' in m) return `${band} ${m.range[0]}–${m.range[1]}`;
  if ('bit' in m) return `${band} bit ${m.bit}`;
  if ('field' in m) return `${band} field ${m.codes.join(', ')}`;
  return `${band} ${m.codes.join(', ')}`;
}
/** The match in words ("Developed, open space; Shrub/scrub"); names may hold commas, so "; " separates them. */
const applies = (band: CostRow['band'], m: Match): string => matchText(band, m).map((x) => textOf(x, t)).join('; ');
function dataFrom(band: CostRow['band'], m: Match): string {
  try { return bandDataLabel(band, m); } catch { return band; }
}

export function columnsOf(preset: RoutePreset): ColId[] {
  const sets: ColId[] = preset.regions ? setNames(preset).map((n): ColId => `set:${n}`) : [];
  return ['excl', 'map', 'label', 'group', 'applies', 'routeW', 'costX', ...sets, 'dataFrom', 'src'];
}

export function methodRows(preset: RoutePreset, patch: PresetPatch | null): MethodRow[] {
  const v = validatePresetPatch(preset, patch ?? undefined);
  const cur = v.ok ? v.result : preset;
  const names = preset.regions ? setNames(preset) : [];
  const linkRows = (link: string) => cur.rows.filter((r) => r.excludable?.link === link);
  const isEx = (r: CostRow) => typeof r.route_w === 'number' && r.route_w >= EXCLUDED_W;

  const rows: MethodRow[] = [];
  const groups: string[] = [];
  const perGroup = new Map<string, MethodRow[]>();
  preset.rows.forEach((r0, i) => {
    const r = cur.rows[i];
    const barrier = r0.barrier === 'hard';
    const routeW = barrier ? null : asVal(r.route_w), routeW0 = barrier ? null : asVal(r0.route_w);
    const costX = asVal(r.cost_x), costX0 = asVal(r0.cost_x);
    const link = r0.excludable?.link;
    const excludable = !!r0.excludable;
    const group = r0.group ?? '';
    const sets = names.map((n) => {
      if (r.cost_by_region) return typeof r.cost_x === 'number' && n in r.cost_by_region ? +(r.cost_by_region[n] * r.cost_x).toPrecision(6) : null;
      return typeof r.cost_x === 'number' ? r.cost_x : null;
    });
    const row: MethodRow = {
      key: `r:${i}`, kind: 'row', row: i, group, label: r0.note ?? r0.band, applies: applies(r0.band, r0.match), match: matchOf(r0.band, r0.match),
      routeW, routeW0, costX, costX0, sets, barrier, excludable,
      excluded: excludable && (link ? linkRows(link).every(isEx) : isEx(r)),
      excluded0: excludable && (link ? preset.rows.filter((x) => x.excludable?.link === link).every(isEx) : isEx(r0)),
      ...(link !== undefined ? { link } : {}),
      dataFrom: dataFrom(r0.band, r0.match), src: r0.src, ref: r0.ref ?? r0.src,
      edited: !sameVal(routeW, routeW0) || !sameVal(costX, costX0),
    };
    if (!perGroup.has(group)) { perGroup.set(group, []); groups.push(group); }
    const list = perGroup.get(group)!;
    list.push(row);
    (r0.except ?? []).forEach((e, j) => {
      const on = cur.rows[i].except![j].active !== false, on0 = e.active !== false;
      list.push({
        key: `x:${i}:${j}`, kind: 'except', row: i, except: j, group, label: e.label, applies: applies(e.band, e.match), match: matchOf(e.band, e.match),
        routeW: null, routeW0: null, costX: null, costX0: null, sets: names.map(() => null), barrier: false,
        excludable: false, excluded: false, exceptOn: on, exceptOn0: on0,
        dataFrom: dataFrom(e.band, e.match), src: e.src, ref: e.ref ?? e.src, edited: on !== on0,
      });
    });
  });
  for (const g of groups) {
    rows.push({
      key: `g:${g}`, kind: 'group', row: -1, group: g, label: g || tf('route.mg.grp.ungrouped', {}, 'Ungrouped'),
      ...(g ? { rule: preset.combine[g] ?? 'multiply' } : {}), applies: '', match: '',
      routeW: null, routeW0: null, costX: null, costX0: null, sets: names.map(() => null), barrier: false,
      excludable: false, excluded: false, dataFrom: '', src: '', ref: '', edited: false,
    });
    rows.push(...perGroup.get(g)!);
  }
  return rows;
}

function sortKey(r: MethodRow, col: ColId, names: string[]): string | number | null {
  switch (col) {
    case 'excl': return r.excludable ? (r.excluded ? 1 : 0) : null;
    case 'map': return null;
    case 'label': return r.label;
    case 'group': return r.group;
    case 'applies': return r.applies;
    case 'match': return r.match;
    case 'dataFrom': return r.dataFrom;
    case 'src': return r.ref;
    case 'routeW': case 'costX': {
      const v = col === 'routeW' ? r.routeW : r.costX;
      return v === null ? null : Array.isArray(v) ? (v[0] + v[1]) / 2 : v;
    }
    default: {
      return r.sets[names.indexOf(col.slice(4))] ?? null;
    }
  }
}

/** q: "ours" (whole word) matches src by /\bours\b/i; other text is a case-insensitive substring of label, applies, match,
 *  group, dataFrom, ref, src. An except row shows when its parent does. Edited-only: a row or any of its except rows edited.
 *  Group headers omitted when flat or empty. `names` = setNames order, to sort a `set:` column. Sort inside groups (flat: all rows); except rows stay under the parent. */
export function viewRows(all: MethodRow[], o: ViewOpts, names: string[] = []): MethodRow[] {
  const q = o.q.trim().toLowerCase();
  const hit = (r: MethodRow) => q === ''
    || (q === 'ours' ? /\bours\b/i.test(r.src)
      : [r.label, r.applies, r.match, r.group, r.dataFrom, r.ref, r.src].some((s) => s.toLowerCase().includes(q)));
  const kids = new Map<number, MethodRow[]>();
  for (const r of all) if (r.kind === 'except') kids.set(r.row, [...(kids.get(r.row) ?? []), r]);
  const tops = all.filter((r) => r.kind === 'row').filter((r) =>
    hit(r) && (!o.editedOnly || r.edited || (kids.get(r.row) ?? []).some((x) => x.edited)));
  const cmp = (a: MethodRow, b: MethodRow): number => {
    if (!o.sort) return 0;
    const x = sortKey(a, o.sort.col, names), y = sortKey(b, o.sort.col, names);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return d * o.sort.dir;
  };
  const withKids = (rs: MethodRow[]) => rs.flatMap((r) => [r, ...(kids.get(r.row) ?? [])]);
  const headers = new Map(all.filter((r) => r.kind === 'group').map((r) => [r.group, r]));
  if (o.flat) return withKids([...tops].sort(cmp));
  const out: MethodRow[] = [];
  for (const [g, h] of headers) {
    const rs = tops.filter((r) => r.group === g);
    if (rs.length) out.push(h, ...withKids([...rs].sort(cmp)));
  }
  return out;
}

// ── edits ────────────────────────────────────────────────────────────────────

/** The one exit of every edit: drop entries with nothing left, null when empty, then validatePresetPatch. */
function commit(preset: RoutePreset, next: PresetPatch | null): Edit {
  const p: PresetPatch = structuredClone(next ?? {});
  if (p.rows) {
    p.rows = p.rows.filter((e) => e.route_w !== undefined || e.cost_x !== undefined || e.except !== undefined)
      .sort((a, b) => a.row - b.row);
    if (!p.rows.length) delete p.rows;
  }
  if (p.combine && !Object.keys(p.combine).length) delete p.combine;
  const out = Object.keys(p).length ? p : null;
  const v = validatePresetPatch(preset, out ?? undefined);
  return v.ok ? { ok: true, patch: out } : { ok: false, reason: v.reason };
}

/** The patch with `row`'s entry changed by `f` (the entry is created from the preset row's band and note). */
function withRow(preset: RoutePreset, patch: PresetPatch | null, row: number, f: (e: RowPatch) => void): PresetPatch {
  const p: PresetPatch = structuredClone(patch ?? {});
  const rows = p.rows ?? [];
  let e = rows.find((x) => x.row === row);
  if (!e) {
    const r = preset.rows[row];
    e = { row, band: r.band, ...(r.note !== undefined ? { note: r.note } : {}) };
    rows.push(e);
  }
  f(e);
  p.rows = rows;
  return p;
}
const noRow = (row: number): Edit => ({ ok: false, reason: `row ${row} does not exist` });

/** Input text → a number, or [from, to] for a ramp row; anything else stays NaN for the validator. */
function parse(text: string, like: Factor): Val {
  const n = (s: string) => (s.trim() === '' ? NaN : Number(s));
  if (typeof like === 'number') return n(text);
  const parts = text.split(',');
  return parts.length === 2 ? [n(parts[0]), n(parts[1])] : [NaN, NaN];
}

/** Set `field` of `row` to `v`; a value equal to the preset's leaves the patch. */
function setField(preset: RoutePreset, patch: PresetPatch | null, row: number, field: 'route_w' | 'cost_x', v: Val): PresetPatch {
  const orig = asVal(preset.rows[row][field]);
  return withRow(preset, patch, row, (e) => { if (sameVal(v, orig)) delete e[field]; else e[field] = v; });
}

export function setRouteW(preset: RoutePreset, patch: PresetPatch | null, row: number, text: string): Edit {
  const r = preset.rows[row];
  if (!r) return noRow(row);
  return commit(preset, setField(preset, patch, row, 'route_w', parse(text, r.route_w)));
}
export function setCostX(preset: RoutePreset, patch: PresetPatch | null, row: number, text: string): Edit {
  const r = preset.rows[row];
  if (!r) return noRow(row);
  return commit(preset, setField(preset, patch, row, 'cost_x', parse(text, r.cost_x)));
}

/** `base` = the registry preset (routePreset(method.base)); `preset` = the method's (a saved one has its stored
 *  patch applied). on: route_w = EXCLUDED_W on the row and every row sharing its `link`. off: each such row to
 *  `preset`'s route_w when < EXCLUDED_W (the entry leaves the patch), else the base row's route_w when < EXCLUDED_W,
 *  else its excludable.off_w; a value equal to `preset`'s leaves the patch. */
export function setExcluded(preset: RoutePreset, base: RoutePreset, patch: PresetPatch | null, row: number, on: boolean): Edit {
  const r = preset.rows[row];
  if (!r?.excludable) return { ok: false, reason: `row ${row} cannot be excluded` };
  const link = r.excludable.link;
  let p = patch;
  preset.rows.forEach((x, i) => {
    if (!x.excludable || (i !== row && (link === undefined || x.excludable.link !== link))) return;
    const b = base.rows[i];
    const lo = (f: Factor | undefined) => (typeof f === 'number' && f < EXCLUDED_W ? f : undefined);
    const baseW = b && b.band === x.band && b.note === x.note ? lo(b.route_w) : undefined;
    const w = on ? EXCLUDED_W : lo(x.route_w) ?? baseW ?? x.excludable.off_w;
    if (w === undefined) return;
    p = setField(preset, p, i, 'route_w', w);
  });
  return commit(preset, p);
}

export function setExcept(preset: RoutePreset, patch: PresetPatch | null, row: number, j: number, on: boolean): Edit {
  const r = preset.rows[row];
  if (!r) return noRow(row);
  const defaults = (r.except ?? []).map((x) => x.active !== false);
  const have = patch?.rows?.find((e) => e.row === row)?.except;
  const flags = defaults.map((d, k) => have?.[k] ?? d);
  flags[j] = on;
  const unchanged = flags.length === defaults.length && flags.every((f, k) => f === defaults[k]);
  return commit(preset, withRow(preset, patch, row, (e) => { if (unchanged) delete e.except; else e.except = flags; }));
}

export function setContingency(preset: RoutePreset, patch: PresetPatch | null, pctText: string): Edit {
  const n = pctText.trim() === '' ? NaN : Number(pctText);
  const p: PresetPatch = structuredClone(patch ?? {});
  const frac = n / 100;
  if (preset.contingency && Math.abs(frac - preset.contingency.pct) < 1e-9) delete p.contingency;
  else p.contingency = frac;
  return commit(preset, p);
}

export function wasText(r: MethodRow, field: 'routeW' | 'costX' | 'excl'): string | null {
  const was = (v: Val | null) => t('route.wt.was', { v: fmt(v) });
  if (field === 'excl') {
    if (!r.excludable) return null;
    const w0 = r.routeW0;
    const ex0 = !!r.excluded0;
    if (ex0 === r.excluded) return null;
    return ex0 ? tf('route.mg.wasExcl', { v: fmt(w0) }, `was ${fmt(w0)} · excluded`) : was(w0);
  }
  const [v, v0] = field === 'routeW' ? [r.routeW, r.routeW0] : [r.costX, r.costX0];
  return v === null || sameVal(v, v0) ? null : was(v0);
}

/** Typographic symbols the method text uses, as plain ASCII, for what leaves the page (copy, CSV):
 *  a spreadsheet or editor that guesses the wrong encoding garbles them. Letters of other scripts
 *  are left as they are. */
const ASCII_OUT: [RegExp, string][] = [
  [/×/g, 'x'], [/[–—−]/g, '-'], [/→/g, '->'], [/≥/g, '>='], [/≤/g, '<='], [/≈/g, '~'], [/…/g, '...'],
  [/°/g, ' deg'], [/²/g, '^2'], [/¼/g, '1/4'], [/·/g, ','], [/§/g, 'Sec. '], [/∪/g, ' or '], [/∈/g, ' in '],
  [/Π/g, 'product '], [/©/g, '(c)'], [/[‘’]/g, "'"], [/[“”]/g, '"'], [/\u00a0/g, ' '],
];
export function asciiText(s: string): string {
  for (const [re, to] of ASCII_OUT) s = s.replace(re, to);
  return s.replace(/ {2,}/g, ' ');
}

/** Shown rows (no group headers) × cols, raw values: numbers as numbers, ramps "a, b", Excl "excluded" / "",
 *  except checkbox "on" / "off", Map "shown" / "" (shown = set of row keys on the map). */
export function tableValues(rows: MethodRow[], cols: ColId[], shown: Set<string>, names: string[] = []): (string | number)[][] {
  const num = (v: Val | null): string | number => (v === null ? '' : Array.isArray(v) ? fmt(v) : v);
  return rows.filter((r) => r.kind !== 'group').map((r) => cols.map((c): string | number => {
    switch (c) {
      case 'excl': return r.kind === 'except' ? (r.exceptOn ? 'on' : 'off') : r.excluded ? 'excluded' : '';
      case 'map': return shown.has(r.key) ? 'shown' : '';
      case 'label': return r.label;
      case 'group': return r.group;
      case 'applies': return r.applies;
      case 'match': return r.match;
      case 'routeW': return num(r.routeW);
      case 'costX': return num(r.costX);
      case 'dataFrom': return r.dataFrom;
      case 'src': return r.ref;
      default: {
        return r.sets[names.indexOf(c.slice(4))] ?? '';
      }
    }
  }));
}


// ── uploaded-layer rows ────────────────────────────────────────────────

/** Defaults of a new uploaded-layer row: a mild avoidance, no barrier. */
export const UPLOAD_DEFAULTS = { route_w: 2, cost_x: 1 } as const;
/** The reason when the registered layers' positions would total more than UPLOAD_TOTAL_VERTICES. */
export const UPLOAD_TOTAL = `uploaded layers have more than ${UPLOAD_TOTAL_VERTICES} positions in all`;
/** The positions of one layer's geometry. */
export const uploadVertices = (layer: UploadLayer): number => {
  let n = 0;
  for (const poly of layer.geometry) for (const ring of poly) n += ring.length;
  return n;
};
/** UPLOAD_TOTAL when `layer` added to `held` (layers by hash, a layer already held counted once) passes the total; else null. */
export function uploadTotalRefusal(held: ReadonlyMap<string, UploadLayer>, layer: UploadLayer): string | null {
  let n = uploadVertices(layer);
  for (const [h, l] of held) if (h !== layer.hash) n += uploadVertices(l);
  return n > UPLOAD_TOTAL_VERTICES ? UPLOAD_TOTAL : null;
}

export interface UploadRow { layer: string; label: string; route_w: number; cost_x: number; barrier: boolean; saved: boolean }

/** The merged `add_rows` as rows, in add_rows order; `saved` = the saved method holds the hash. */
export function uploadRowsOf(stored: PresetPatch | null, session: PresetPatch | null): UploadRow[] {
  const have = new Set((stored?.add_rows ?? []).map((r) => r.layer));
  return (mergePatch(stored, session)?.add_rows ?? []).map((r) => ({
    layer: r.layer, label: r.label ?? '', route_w: r.route_w ?? 1, cost_x: r.cost_x ?? 1, barrier: !!r.barrier, saved: have.has(r.layer),
  }));
}

/** The session patch with its `add_rows` replaced (empty → key dropped; nothing left → null), merged result validated. */
function withAdd(base: RoutePreset, stored: PresetPatch | null, session: PresetPatch | null, add: AddRow[]): Edit {
  const p: PresetPatch = structuredClone(session ?? {});
  if (add.length) p.add_rows = add; else delete p.add_rows;
  const out = Object.keys(p).length ? p : null;
  const merged = mergePatch(stored, out);
  const v = validatePresetPatch(base, merged ?? undefined);
  return v.ok ? { ok: true, patch: out } : { ok: false, reason: v.reason };
}

/** Add a layer row, or change the fields of the row with that hash: one whole session entry per hash.
 *  `base` is the built-in preset the method is built on (`stored` is the saved patch, `session` the edits). */
export function upsertUpload(base: RoutePreset, stored: PresetPatch | null, session: PresetPatch | null, row: Omit<UploadRow, 'saved'>): Edit {
  const entry: AddRow = { layer: row.layer, label: row.label, route_w: row.route_w, cost_x: row.cost_x, barrier: row.barrier };
  const add = (session?.add_rows ?? []).filter((r) => r.layer !== row.layer);
  const at = (session?.add_rows ?? []).findIndex((r) => r.layer === row.layer);
  add.splice(at < 0 ? add.length : at, 0, entry);
  return withAdd(base, stored, session, add);
}

/** Remove the row with that hash: a session-only row leaves the session patch, a saved one gets `{layer, remove: true}`. */
export function dropUpload(base: RoutePreset, stored: PresetPatch | null, session: PresetPatch | null, layer: string): Edit {
  const add = (session?.add_rows ?? []).filter((r) => r.layer !== layer);
  if ((stored?.add_rows ?? []).some((r) => r.layer === layer)) add.push({ layer, remove: true });
  return withAdd(base, stored, session, add);
}
