// ─── Route panel: the solve request builder ──────────────────────────────────
// Role: pure builder of the engine's RouteRequest from the panel's inputs. A `custom:<id>`
//       method is its base preset with its saved patch, the session patch merged on top
//       (`mergePatch`; uploaded-layer rows `add_rows` merge by hash). A request
//       names its uploaded layers by hash only (`uploads`, in band order), never by geometry.
//       `makeRequestBuilder(list)` binds the saved-method list and returns
//       `methodFor` / `requestFor`; every failure is a message string, never a throw.
//       `requestFor` also names each end's terminal kind (`explainEnds`, `resolveEnds`): an end's explicit
//       choice (`RouteEnd.term`) is kept, but an explicit `position` on a line type the patched method has no
//       position figure for refuses the request (`route.err.termPosition`, naming every such end: "A", "B" or "A, B"); Auto is `position` only for an end
//       snapped to a substation whose highest voltage is known and at least the line type's, when the patched
//       method prices a line position for that line type, else `new`, with the reason as a code.
//       Batch and chat share it. No DOM, no map, no storage.
// Deps: route/preset-patch.ts (uploadHashes, validatePresetPatch; PresetPatch, AddRow types), route/route.ts (RouteRequest, OverlayMode,
//       types only), route/custom-presets.ts (CustomPreset, type only), route/snap.ts (kvFloor),
//       registry/route-presets.ts (routePreset, EndKind), route-tabs/types.ts (types), i18n (t).

import { uploadHashes, validatePresetPatch, type AddRow, type PresetPatch } from '../route/preset-patch.js';
import { kvFloor } from '../route/snap.js';
import { routePreset, type EndKind } from '../../src/registry/route-presets.js';
import type { OverlayMode, RouteRequest } from '../route/route.js';
import type { CustomPreset } from '../route/custom-presets.js';
import type { RouteEnd, RouteInputs, SolveSpec } from './route-tabs/types.js';
import { t } from '../../src/i18n/index.js';

/** Uploaded-layer rows merged by hash: base entries first in base order, a session entry with a
 *  base hash edits that entry in place (`remove: true` drops it), a new hash is appended in session order.
 *  The result has no `remove` entries; more than 4 is left for validatePresetPatch to refuse. */
function mergeAddRows(base: AddRow[], top: AddRow[]): AddRow[] {
  const out = base.map((r) => ({ ...r }));
  for (const r of top) {
    const i = out.findIndex((x) => x.layer === r.layer);
    if (r.remove) { if (i >= 0) out.splice(i, 1); continue; }
    if (i >= 0) out[i] = { ...out[i], ...r };
    else out.push({ ...r });
  }
  return out;
}

/** Merge a session patch over a saved method's patch: rows by index, uploaded-layer rows by hash
 *  (mergeAddRows), scalars replaced. */
export function mergePatch(base: PresetPatch | null | undefined, top: PresetPatch | null | undefined): PresetPatch | undefined {
  if (!base && top?.add_rows?.some((r) => r.remove)) return mergePatch({}, top);
  if (!base) return top ?? undefined;
  if (!top) return base;
  const rows = new Map((base.rows ?? []).map((r) => [r.row, { ...r }]));
  for (const r of top.rows ?? []) rows.set(r.row, { ...rows.get(r.row), ...r });
  const out: PresetPatch = { ...base, ...top };
  if (rows.size) out.rows = [...rows.values()];
  if (base.combine || top.combine) out.combine = { ...base.combine, ...top.combine };
  if (base.add_rows || top.add_rows) {
    const add = mergeAddRows(base.add_rows ?? [], top.add_rows ?? []);
    if (add.length) out.add_rows = add;
    else delete out.add_rows;
  }
  return out;
}

/** Why an end gets its kind. Explicit: `chosen`, or `positionUnavailable` (an explicit Existing on a line type
 *  with no position figure; the request is refused). Auto, tested in this order: `noPositionFigure`,
 *  `noSub` (a raw point), `kvUnknown`, `lowKv` (below the line type's kV), `snapped` (a line position). */
export type EndWhy = 'chosen' | 'positionUnavailable' | 'noPositionFigure' | 'noSub' | 'kvUnknown' | 'lowKv' | 'snapped';

/** `kv`: the substation's highest kV for `snapped`, `lowKv` and `chosen` (null when unknown or no substation);
 *  the snap floor for the line type for `noSub`; null otherwise. `positionUnavailable` carries kind `new`, so a
 *  position never reaches the engine without a figure even if the refusal were skipped. */
export interface EndExplain { kind: EndKind; why: EndWhy; kv: number | null }

/** Each end's terminal kind and the reason, for a solve of `lineType` with `patch` on `base`. A null end
 *  reads as a raw point on Auto. */
export function explainEnds(base: string, patch: PresetPatch | undefined, lineType: string,
  a: RouteEnd | null, b: RouteEnd | null): [EndExplain, EndExplain] {
  const p = routePreset(base);
  const v = p ? validatePresetPatch(p, patch) : null;
  const line = v?.ok && Object.hasOwn(v.result.line_types, lineType) ? v.result.line_types[lineType] : null;
  const figure = !!line?.terminals.position;
  const one = (e: RouteEnd | null): EndExplain => {
    const kv = e?.hit?.maxKv ?? null;
    const term = e?.term ?? 'auto';
    if (term === 'new' || term === 'none') return { kind: term, why: 'chosen', kv };
    if (term === 'position') return figure ? { kind: 'position', why: 'chosen', kv } : { kind: 'new', why: 'positionUnavailable', kv: null };
    if (!line || !figure) return { kind: 'new', why: 'noPositionFigure', kv: null };
    if (!e?.hit) return { kind: 'new', why: 'noSub', kv: kvFloor(line.kv.value) };
    if (kv === null) return { kind: 'new', why: 'kvUnknown', kv: null };
    if (kv < line.kv.value) return { kind: 'new', why: 'lowKv', kv };
    return { kind: 'position', why: 'snapped', kv };
  };
  return [one(a), one(b)];
}

/** Each end's terminal kind for a solve of `lineType` with `patch` on `base`'s preset, resolved at request time. */
export function resolveEnds(base: string, patch: PresetPatch | undefined, lineType: string, a: RouteEnd, b: RouteEnd): [EndKind, EndKind] {
  const [x, y] = explainEnds(base, patch, lineType, a, b);
  return [x.kind, y.kind];
}

export function makeRequestBuilder(list: () => CustomPreset[]) {
  /** The engine's preset id and patch for a method: a `custom:<id>` is its base + its patch, `patch` on top. */
  function methodFor(presetId: string, patch: PresetPatch | null): { preset: string; patch?: PresetPatch } | string {
    if (!presetId.startsWith('custom:')) { const p = mergePatch(null, patch); return { preset: presetId, ...(p ? { patch: p } : {}) }; }
    const c = list().find((x) => `custom:${x.id}` === presetId);
    if (!c || c.status !== 'ok') return t('route.err.preset');
    return { preset: c.base, patch: mergePatch(c.patch as PresetPatch, patch) };
  }

  function requestFor(inp: RouteInputs, spec: SolveSpec, weight: OverlayMode | null = null): RouteRequest | string {
    if (!inp.a || !inp.b) return t('route.err.ends');
    const m = methodFor(inp.presetId, spec.patch);
    if (typeof m === 'string') return m;
    const ends = explainEnds(m.preset, m.patch, inp.lineType, inp.a, inp.b);
    const stuck = (['A', 'B'] as const).filter((_, i) => ends[i].why === 'positionUnavailable');
    if (stuck.length) return t('route.err.termPosition', { end: stuck.join(', ') });
    return {
      from: inp.a.lngLat, to: inp.b.lngLat, preset: m.preset, lineType: inp.lineType,
      ...(m.patch ? { presetPatch: m.patch } : {}),
      terminals: [ends[0].kind, ends[1].kind],
      ...(uploadHashes(m.patch).length ? { uploads: uploadHashes(m.patch) } : {}),
      profile: spec.profile, surface: spec.surface, alternatives: spec.alternatives,
      ...(weight ? { weightImage: true, weightMode: weight === 'rows' ? 'route' : weight } : {}),
    };
  }
  return { methodFor, requestFor };
}
