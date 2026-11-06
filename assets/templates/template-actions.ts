// ─── Template actions: what a page-owned template frame may do to the map ───
// Role: the page's side of TM.action for the frames it made for its own
//       templates (canvas-host.ts forwards a template frame's actions only,
//       kind checked, ≤ 50 per frame; a model's showCanvas frame never gets
//       here). Every payload is untrusted: a template renders data anyone may
//       have written, so each action is checked against what the page itself
//       sent the frame and with the link's validators, and applied the way a
//       control applies it.
//         conditionForBin(layer, field, bin)  the conditions one group of a
//                    chart stands for, built by the page (a template sends a
//                    group, never a condition).
//         mergeWhere(existing, add)  the layer's conditions with every one on
//                    the fields `add` names replaced by `add`, the rest kept (AND).
//         templateActions(ctx)  → onAction for one frame, bound to its
//                    {templateId, layer} and the payload it was sent:
//           where  {layer?, field, bin}: `field` one of the payload's `by`
//                  fields, binned field or month-binned time field, `bin` one
//                  of its row keys (a vega frame sends the group's label,
//                  mapped back through ctx.labels); merged into the layer's
//                  conditions → map-api setWhere (one url:write, its own undo
//                  step). A card rendered with its own `where` (ctx.where)
//                  merges those too; its Area is not applied (Area is a
//                  view-wide choice, chat trust model).
//           select {layer?, ids}: 1–MAX_SELECTION_IDS ids, each one of the
//                  payload features' ids and of the layer's id shape
//                  (selectionIdsError); replaces the layer's ids in the
//                  selection → map-api setSelection (its own undo step).
//           fly    {bbox} or {layer?, id}: a bbox within the payload features'
//                  extent (+10 %), clamped to ±180 / ±85, at least MIN_SPAN
//                  degrees wide and tall, max zoom 14; or one feature's own
//                  extent. The camera is not on the undo stack (undo.ts): no
//                  toast.
//           table  {layer?, ids?}: the table drawer on the layer (table-open.ts
//                  through map-api showTable), with only those ids (≤ 500, each
//                  a payload feature's) when given. No link write.
//         A card whose features are region outlines (points-per-polygon:
//         ctx.regions) flies to a region by its code but never selects or
//         tables those ids: they are not the layer's features.
//         `layer`, when given, must be the card's own. Committing actions
//         (where, select) are rate-limited: ≤ RATE_MAX per RATE_MS per frame;
//         past it a "busy" toast and nothing changes. A committed action that
//         recorded an undo step shows a toast with an Undo bound to THAT step and
//         takes keyboard focus out of the frame (to Undo when made by keyboard,
//         else to the page), so Ctrl+Z / Ctrl+Y reach the page's undo; a
//         no-change or a refusal shows a neutral toast without Undo (the refusal
//         reason goes to the console only). Toasts are text-only, one at a time.
//
// Deps: map-api.ts (setWhere, setSelection, showTable, undo), state.ts (map,
//       where, sel), field-roles.ts (rolesOf, aliasFields), region-codes.ts
//       (STATE_TO_ADMIN1), field-schema.ts (FIELD_SCHEMA),
//       view-validate.ts (selectionIdsError, MAX_SELECTION_IDS), facets.ts
//       (facet, facetValueMap), fuel.ts (FUEL_LEGEND), buckets.ts
//       (KV_BUCKET_RANGES), registry (layerById), catalogue.ts (templateById),
//       i18n (t); types: canvas-host.ts, payload.ts, condition-compile.ts.
// Loaded by: show-template.ts (one handler per template render).

import * as api from '../map-api.js';
import { state } from '../state.js';
import { on } from '../state-bus.js';
import { historyStamp } from '../undo.js';
import { rolesOf, aliasFields } from '../../src/registry/field-roles.js';
import { STATE_TO_ADMIN1 } from '../../src/registry/region-codes.js';
import { FIELD_SCHEMA, type FieldOp } from '../../src/registry/field-schema.js';
import { selectionIdsError, MAX_SELECTION_IDS } from '../../src/registry/view-validate.js';
import { layerById } from '../../src/registry/index.js';
import { facet, facetValueMap } from '../../src/colors/facets.js';
import { FUEL_LEGEND } from '../../src/colors/fuel.js';
import { KV_BUCKET_RANGES } from '../../src/colors/buckets.js';
import { templateById } from './catalogue.js';
import { t } from '../../src/i18n/index.js';
import type { Condition } from '../../src/registry/condition-compile.js';
import type { Outcome } from '../dataset-query.js';
import type { TemplateAction, FrameControl } from '../sandbox/canvas-host.js';
import type { TemplatePayload } from './payload.js';
import type { FeatureId } from '../feature-id.js';

export const RATE_MAX = 5;
export const RATE_MS = 10_000;
export const FLY_MAX_ZOOM = 14;
/** The smallest bbox side a fly takes, in degrees (≈ 1 km): a point's bbox is widened to it. */
export const MIN_SPAN = 0.01;
const TOAST_MS = 6000;

type Bin = string | number;
const no = <T>(reason: string): Outcome<T> => ({ ok: false, reason });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ─── Groups → conditions ─────────────────────────────────────────────────────
/** The conditions the group `bin` of `field` stands for on `layer`, built by the page.
 *  A kV-class bucket → its numeric range; a fuel or other legend-facet bucket → `in` its
 *  values ("other" → `not_in` the rest plus `has`); a region list → `contains_any` [code];
 *  any other category → `=`. With `range` (a numeric bin's own edges) → `>= lo` ∧ `< hi`;
 *  on a `date` field a "YYYY-MM" month or a year → its first to last day. The field must
 *  be a FIELD_SCHEMA field of the layer whose ops take the condition; validateWhere checks the result. */
export function conditionForBin(layer: string, field: string, bin: unknown, range?: { lo: unknown; hi: unknown }): Outcome<Condition[]> {
  if (typeof bin !== 'string' && !(typeof bin === 'number' && Number.isFinite(bin))) return no('a group is a string or a number');
  const entry = layerById(layer);
  const roles = rolesOf(layer);
  // The states alias on a world layer: a state is its admin-1 code there.
  if (roles && aliasFields(roles).some(f => f.name === field)) {
    const code = String(bin);
    return Object.hasOwn(STATE_TO_ADMIN1, code)
      ? { ok: true, result: [{ field: 'admin1', op: 'contains_any', value: [STATE_TO_ADMIN1[code]] }] }
      : no(`"${code}" is not a US state or territory`);
  }
  const def = entry?.dataset ? FIELD_SCHEMA[entry.dataset]?.[field] : undefined;
  if (!def) return no(`"${field}" takes no condition on "${layer}"`);
  const takes = (...ops: FieldOp[]) => ops.every(op => def.ops.includes(op));
  const role = roles?.fields.find(f => f.name === field);
  const key = String(bin);
  const one = (op: FieldOp, value: unknown): Outcome<Condition[]> =>
    takes(op) ? { ok: true, result: [{ field, op, value }] } : no(`"${field}" takes no "${op}" condition`);
  const between = (lo: number | string, hi: number | string): Outcome<Condition[]> =>
    takes('>=', '<') ? { ok: true, result: [{ field, op: '>=', value: lo }, { field, op: '<', value: hi }] } : no(`"${field}" takes no range condition`);

  // A numeric bin: [lo, hi), the edges the page binned the rows by.
  if (range) {
    const { lo, hi } = range;
    if (def.type !== 'number') return no(`"${field}" is not a number field`);
    if (typeof lo !== 'number' || typeof hi !== 'number' || !Number.isFinite(lo) || !Number.isFinite(hi) || !(lo < hi)) return no('a bin has finite edges, lo < hi');
    return between(lo, hi);
  }
  // A month or a year of a date field: its first day to its last (days 01–31, as dataset-query.ts monthOf reads them).
  if (role?.time === 'date') {
    const span = /^(?:18|19|20)\d\d-(?:0[1-9]|1[0-2])$/.test(key) ? [`${key}-01`, `${key}-31`]
      : /^(?:18|19|20)\d\d$/.test(key) ? [`${key}-01-01`, `${key}-12-31`] : null;
    if (!span) return no(`"${key}" is not a month (YYYY-MM) or a year`);
    return takes('>=', '<=') ? { ok: true, result: [{ field, op: '>=', value: span[0] }, { field, op: '<=', value: span[1] }] } : no(`"${field}" takes no range condition`);
  }

  // "Other" is every value no bucket names and never a missing one (the chart's fold keeps a missing value apart).
  const notIn = (values: string[]): Outcome<Condition[]> => {
    const r = one('not_in', values);
    return r.ok ? { ok: true, result: [...r.result, { field, op: 'has' }] } : r;
  };
  if (role?.facet === 'kv') {
    const range = Object.hasOwn(KV_BUCKET_RANGES, key) ? KV_BUCKET_RANGES[key] : undefined;
    if (!range) return no(`"${key}" is not a voltage class`);
    if (key === 'unknown') return no('the unknown voltage class has no value to filter on');
    const conds = range.filter((b): b is NonNullable<typeof b> => !!b).map(([op, value]) => ({ field, op, value }) as Condition);
    return takes(...conds.map(c => c.op)) ? { ok: true, result: conds } : no(`"${field}" takes no range condition`);
  }
  if (role?.facet === 'fuel') {
    const pick = field === 'energy_source' ? (f: typeof FUEL_LEGEND[number]) => f.eiaCodes : (f: typeof FUEL_LEGEND[number]) => f.osmValues;
    const row = FUEL_LEGEND.find(f => f.id === key);
    if (!row) return no(`"${key}" is not a fuel`);
    if (row.id === 'other') return notIn(FUEL_LEGEND.flatMap(pick));
    const values = pick(row);
    return values.length ? one('in', values) : no(`"${key}" has no values of its own in "${field}"`);
  }
  if (role?.facet) {
    let rec;
    try { rec = facet(role.facet); } catch { return no(`"${field}" has no legend`); }
    const map = facetValueMap(rec);
    const bucket = rec.buckets.find(b => b.id === key);
    if (bucket && !bucket.values?.length && rec.buckets.some(b => b.values?.length)) {
      return key === 'other' ? notIn(rec.buckets.flatMap(b => b.values ?? [])) : no(`"${key}" has no values of its own in "${field}"`);
    }
    if (bucket && bucket.values?.length) return one('in', map[key]);
    // Not a bucket: a raw value the fold left as it was (validateWhere checks its domain).
  }
  if (def.list) return one('contains_any', [key]);
  return one('=', def.type === 'number' ? Number(bin) : key);
}

/** `existing` with every condition on a field `add` names replaced by `add`, in the place the field's
 *  first condition held (so the same group again is the same list); the rest kept (AND). */
export function mergeWhere(existing: readonly Condition[], add: readonly Condition[]): Condition[] {
  const fields = new Set(add.map(c => c.field));
  const out: Condition[] = [];
  const placed = new Set<string>();
  for (const c of existing) {
    if (!fields.has(c.field)) { out.push(c); continue; }
    if (placed.has(c.field)) continue;
    placed.add(c.field);
    out.push(...add.filter(a => a.field === c.field));
  }
  for (const a of add) if (!placed.has(a.field)) out.push(a);
  return out;
}

// ─── Toast ───────────────────────────────────────────────────────────────────
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let undoBound: { stamp: number; btn: HTMLElement } | null = null;

// Undo is offered for one step only: once anything else is recorded (or undone), the button goes.
on('undo:changed', () => {
  if (undoBound && historyStamp() !== undoBound.stamp) { undoBound.btn.remove(); undoBound = null; }
});

export interface ToastOptions {
  /** The history stamp the action recorded its step at (undo.ts historyStamp()); absent: no Undo. */
  stamp?: number;
  /** The action came from the keyboard: focus moves to Undo (or the toast). */
  focus?: boolean;
  /** Runs after the toast's Undo undid the step. */
  onUndo?: () => void;
}

/** One text-only toast at a time, top centre. Stays while hovered or focused; Esc closes it. */
export function showToast(text: string, opts: ToastOptions = {}): void {
  toastEl?.remove();
  clearTimeout(toastTimer);
  undoBound = null;
  const box = document.createElement('div');
  box.className = 'rotate-hint-toast rotate-hint-toast--top tpl-toast';
  box.setAttribute('role', 'status');
  box.tabIndex = -1;
  const span = document.createElement('span');
  span.textContent = text;
  box.append(span);
  const arm = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => box.remove(), TOAST_MS); };
  let undoBtn: HTMLButtonElement | null = null;
  if (opts.stamp !== undefined) {
    const b = undoBtn = document.createElement('button');
    b.type = 'button';
    b.className = 'tpl-toast-undo';
    b.textContent = t('menu.undo');
    const stamp = opts.stamp;
    b.addEventListener('click', () => {
      if (historyStamp() === stamp) { api.undo(); opts.onUndo?.(); }
      box.remove();
    });
    box.append(b);
    undoBound = { stamp, btn: b };
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', t('canvas.close'));
  close.addEventListener('click', () => box.remove());
  box.append(close);
  box.addEventListener('keydown', e => { if (e.key === 'Escape') box.remove(); });
  for (const e of ['mouseenter', 'focusin']) box.addEventListener(e, () => clearTimeout(toastTimer));
  for (const e of ['mouseleave', 'focusout']) box.addEventListener(e, arm);
  toastEl = box;
  arm();
  (document.getElementById('rotateHintToast')?.parentElement ?? document.body).append(box);
  if (opts.focus) (undoBtn ?? box).focus();
}

// ─── One frame's handler ─────────────────────────────────────────────────────
export interface ActionContext {
  templateId: string;
  layer: string;
  payload: Pick<TemplatePayload, 'rows' | 'roles' | 'labels' | 'features' | 'second'>;
  /** The conditions the card was rendered with (its params.where, page-validated): a group's `where` keeps them. */
  where?: readonly Condition[];
  /** A vega frame: per field, the label it sends → the row key it stands for (null: "Other" / none).
   *  A field with no map here is sent as its row key (a month bar's "YYYY-MM"). */
  labels?: ReadonlyMap<string, ReadonlyMap<string, Bin | null>>;
  /** The payload's features are region outlines (points-per-polygon), not the layer's: fly only, no ids to select or table. */
  regions?: boolean;
  /** Tests: the clock. */
  now?: () => number;
}

type BBox = [number, number, number, number];

function bboxOf(g: GeoJSON.Geometry | null | undefined): BBox | null {
  if (!g) return null;
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
      return;
    }
    for (const x of c) walk(x);
  };
  if (g.type === 'GeometryCollection') {
    for (const x of g.geometries) { const c = bboxOf(x); if (c) walk([[c[0], c[1]], [c[2], c[3]]]); }
  } else walk(g.coordinates);
  return b[0] <= b[2] && b[1] <= b[3] ? b : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A bbox clamped to the world and `within`, widened to MIN_SPAN; null when it falls outside `within`. */
export function flyBox(b: BBox, within: BBox | null): BBox | null {
  let [w, s, e, n] = [clamp(b[0], -180, 180), clamp(b[1], -85, 85), clamp(b[2], -180, 180), clamp(b[3], -85, 85)];
  if (within) {
    const px = (within[2] - within[0]) * 0.1 + MIN_SPAN, py = (within[3] - within[1]) * 0.1 + MIN_SPAN;
    w = Math.max(w, within[0] - px); s = Math.max(s, within[1] - py); e = Math.min(e, within[2] + px); n = Math.min(n, within[3] + py);
  }
  if (w > e || s > n) return null;
  if (e - w < MIN_SPAN) { const c = (w + e) / 2; w = clamp(c - MIN_SPAN / 2, -180, 180 - MIN_SPAN); e = w + MIN_SPAN; }
  if (n - s < MIN_SPAN) { const c = (s + n) / 2; s = clamp(c - MIN_SPAN / 2, -85, 85 - MIN_SPAN); n = s + MIN_SPAN; }
  return [w, s, e, n];
}

const idKey = (id: FeatureId) => `${typeof id}:${id}`;

/** The handler for one template frame's actions. */
export function templateActions(ctx: ActionContext): (a: TemplateAction, frame?: FrameControl) => void {
  const now = ctx.now ?? Date.now;
  const def = templateById(ctx.templateId);
  const name = def ? t(def.nameKey) : ctx.templateId;
  const binned = ctx.payload.roles.bins?.field;
  const byFields = new Set(ctx.payload.roles.by.map(b => b.field));
  // Row keys per group field, as strings: the groups this frame was sent (a binned field's are its rows' bin indexes).
  const keys = new Map<string, Set<string>>();
  for (const f of byFields) keys.set(f, new Set(ctx.payload.rows.map(r => r[f]).filter((k): k is Bin => k !== null && k !== undefined).map(String)));
  const ranges = new Map<string, { lo: unknown; hi: unknown }>();
  if (binned) {
    for (const r of ctx.payload.rows) if (typeof r.bin === 'number') ranges.set(String(r.bin), { lo: r.lo, hi: r.hi });
    byFields.add(binned);
    keys.set(binned, new Set(ranges.keys()));
  }
  // Month bars (a timeline over a date field): the months this frame was sent.
  const time = ctx.payload.roles.time;
  if (time?.bin === 'month' && !byFields.has(time.field)) {
    byFields.add(time.field);
    keys.set(time.field, new Set(ctx.payload.rows.map(r => r[time.field]).filter((k): k is string => typeof k === 'string')));
  }
  // Feature ids and extents: the features this frame was sent. A second layer's (nearest's targets) widen
  // the extent a fly may reach (extent2) but are never ids to select, table or fly to by id.
  const boxes = new Map<string, BBox>();
  let extent: BBox | null = null;
  const grow = (b: BBox) => { extent = extent ? [Math.min(extent[0], b[0]), Math.min(extent[1], b[1]), Math.max(extent[2], b[2]), Math.max(extent[3], b[3])] : b; };
  for (const f of ctx.payload.features ?? []) {
    const b = bboxOf(f.geometry);
    if (!b) continue;
    grow(b);
    if (typeof f.id === 'string' || typeof f.id === 'number') boxes.set(idKey(f.id), b);
  }
  for (const f of ctx.payload.second?.features ?? []) { const b = bboxOf(f.geometry); if (b) grow(b); }
  const commits: number[] = [];

  // Set per action: the frame to tell when the action did not stick, and whether the visitor used the keyboard.
  let frameCtl: FrameControl | undefined;
  let kb = false;
  const refused = (reason: string) => {
    console.warn(`[TransmissionMap] template action refused (${ctx.templateId}): ${reason}`);
    frameCtl?.reset();
    showToast(t('template.toast.refused', { template: name }), { focus: kb });
  };
  const busy = () => {
    const at = now();
    while (commits.length && at - commits[0] >= RATE_MS) commits.shift();
    if (commits.length >= RATE_MAX) { frameCtl?.reset(); showToast(t('template.toast.busy', { template: name }), { focus: kb }); return true; }
    commits.push(at);
    return false;
  };
  const layerOk = (p: Record<string, unknown>) => p.layer === undefined || p.layer === ctx.layer;
  const idsOf = (v: unknown): Outcome<FeatureId[]> => {
    if (ctx.regions) return no('this chart\'s features are regions, not the layer\'s features');
    if (!Array.isArray(v) || !v.length) return no('ids must be a list of 1 or more feature ids');
    if (v.length > MAX_SELECTION_IDS) return no(`more than ${MAX_SELECTION_IDS} ids: use a group (where) or a zoom instead`);
    const err = selectionIdsError(ctx.layer, v);
    if (err) return no(err);
    const ids = v as FeatureId[];
    const stranger = ids.find(id => !boxes.has(idKey(id)));
    return stranger === undefined ? { ok: true, result: [...new Set(ids)] } : no(`${JSON.stringify(stranger)} is not a feature this chart was sent`);
  };

  /** Commit through `apply`; offer Undo only when it recorded a step (and bind it to that step). */
  const commit = (apply: () => Outcome<unknown>, text: string): void => {
    const before = historyStamp();
    const r = apply();
    if (!r.ok) { refused(r.reason); return; }
    const after = historyStamp();
    if (after === before) {
      frameCtl?.reset();
      showToast(t('template.toast.same', { template: name }), { focus: kb });
      return;
    }
    // A click left focus in the frame, where Ctrl+Z never reaches the page: hand it back.
    if (!kb) frameCtl?.release();
    showToast(text, { stamp: after, focus: kb, onUndo: () => frameCtl?.reset() });
  };

  return (a: TemplateAction, frame?: FrameControl) => {
    frameCtl = frame;
    const p = a.payload;
    kb = isObj(p) && p.kb === true;
    if (!isObj(p)) { refused('the payload must be an object'); return; }
    if (!layerOk(p)) { refused(`layer must be "${ctx.layer}"`); return; }

    if (a.kind === 'where') {
      const field = p.field;
      if (typeof field !== 'string' || !byFields.has(field)) { refused('field must be one of the chart\'s groups'); return; }
      let bin = p.bin as unknown;
      const byLabel = ctx.labels?.get(field);
      if (byLabel) {
        if (typeof bin !== 'string' || !byLabel.has(bin)) { refused('not a group of this chart'); return; }
        bin = byLabel.get(bin);
      }
      if ((typeof bin !== 'string' && typeof bin !== 'number') || !keys.get(field)!.has(String(bin))) { refused('not a group of this chart'); return; }
      const conds = field === binned ? conditionForBin(ctx.layer, field, bin, ranges.get(String(bin))) : conditionForBin(ctx.layer, field, bin);
      if (!conds.ok) { refused(conds.reason); return; }
      if (busy()) return;
      const value = ctx.payload.labels[`value.${field}.${bin}`] ?? String(bin);
      const scoped = !!ctx.where?.length;
      const next = mergeWhere(mergeWhere(state.where[ctx.layer] ?? [], ctx.where ?? []), conds.result);
      commit(() => api.setWhere(ctx.layer, next), t(scoped ? 'template.toast.whereScoped' : 'template.toast.where', { template: name, value }));
      return;
    }

    if (a.kind === 'select') {
      const ids = idsOf(p.ids);
      if (!ids.ok) { refused(ids.reason); return; }
      if (busy()) return;
      commit(() => api.setSelection({ mode: state.sel?.mode ?? 'isolate', ids: { ...(state.sel?.ids ?? {}), [ctx.layer]: ids.result } }),
        t('template.toast.select', { template: name, n: ids.result.length.toLocaleString() }));
      return;
    }

    if (a.kind === 'fly') {
      let box: BBox | null;
      if (p.id !== undefined) {
        if (typeof p.id !== 'string' && typeof p.id !== 'number') { refused('id must be a feature id'); return; }
        box = boxes.get(idKey(p.id)) ?? null;
        if (!box) { refused('not a feature this chart was sent'); return; }
      } else {
        const b = p.bbox;
        if (!Array.isArray(b) || b.length !== 4 || !b.every(x => typeof x === 'number' && Number.isFinite(x))) { refused('bbox must be [west, south, east, north]'); return; }
        box = b as BBox;
      }
      const fit = extent ? flyBox(box, extent) : null;
      if (!fit) { refused('the box is outside what this chart shows'); return; }
      if (!state.mapReady || !state.map) { refused('the map is still loading'); return; }
      state.map.fitBounds([[fit[0], fit[1]], [fit[2], fit[3]]], { padding: 40, maxZoom: FLY_MAX_ZOOM, essential: true });
      return;
    }

    if (a.kind === 'table') {
      let ids: FeatureId[] | undefined;
      if (p.ids !== undefined) {
        const r = idsOf(p.ids);
        if (!r.ok) { refused(r.reason); return; }
        ids = r.result;
      }
      void api.showTable({ layerId: ctx.layer, ...(ids && { ids }) });
      return;
    }
    refused(`unknown action "${String(a.kind)}"`);
  };
}
