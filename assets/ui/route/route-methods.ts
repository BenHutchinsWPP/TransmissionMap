// ─── Route methods ───────────────────────────────────────────────────────────
// Role: the route panel's method lookup, with no DOM: `methodOf` (a preset id, built-in or `custom:<id>`, to its
//       preset, base, stored patch and label), `solvedPresetOf` (the preset a solve used: method plus session patch),
//       `countEdits` and `dropRemove` over a patch, and `methodStore`, the saved-methods store the Method tab writes
//       through (the same localStorage key as the shell's own store).
// Deps: route/custom-presets.ts, route/preset-patch.ts, ui/route/route-request.ts (mergePatch), registry/route-presets.ts,
//       ui/route/tabs/types.ts (types).

import { routePreset, type RoutePreset } from '../../../src/registry/route-presets.js';
import { validatePresetPatch, type PresetPatch } from '../../route/preset-patch.js';
import { createCustomPresetStore, presetLabel } from '../../route/custom-presets.js';
import { mergePatch } from './route-request.js';
import type { RouteInputs } from './tabs/types.js';

export const methodStore = createCustomPresetStore({
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => localStorage.setItem(k, v),   // the store catches a refused write
});

export interface Method { preset: RoutePreset; base: string; stored: PresetPatch | null; label: string; customId?: string }

/** A preset id (built-in or `custom:<id>`) → its method, or null when unknown / needs review. */
export function methodOf(id: string): Method | null {
  if (id.startsWith('custom:')) {
    const c = methodStore.list().find((x) => `custom:${x.id}` === id);
    if (c?.status !== 'ok' || !c.preset) return null;
    // Uploaded-layer rows are the Uploaded layers section's, not grid rows: the table's preset has the stored patch without them.
    const stored = c.patch as PresetPatch, base = routePreset(c.base);
    let preset = c.preset;
    if (stored.add_rows && base) {
      const rest = { ...stored };
      delete rest.add_rows;
      const v = validatePresetPatch(base, Object.keys(rest).length ? rest : undefined);
      if (v.ok) preset = v.result;
    }
    return { preset, base: c.base, stored, label: c.name, customId: c.id };
  }
  const p = routePreset(id);
  return p ? { preset: p, base: p.id, stored: null, label: presetLabel(p) } : null;
}

export const dropRemove = (p: PresetPatch | null): PresetPatch | undefined =>
  !p ? undefined : p.add_rows?.some((r) => r.remove) ? { ...p, add_rows: p.add_rows.filter((r) => !r.remove) } : p;

/** The preset a solve of `inp` used: its method (a saved one over its base) with the session patch applied; null when unknown or refused. */
export function solvedPresetOf(inp: RouteInputs): RoutePreset | null {
  const m = methodOf(inp.presetId), base = m && routePreset(m.base);
  if (!m || !base) return null;
  const v = validatePresetPatch(base, dropRemove(mergePatch(m.stored, inp.patch) ?? null));
  return v.ok ? v.result : null;
}

export const countEdits = (p: PresetPatch | null) =>
  (p?.rows ?? []).reduce((n, r) => n + (r.route_w !== undefined ? 1 : 0) + (r.cost_x !== undefined ? 1 : 0) + (r.except ? 1 : 0), 0)
  + (p?.contingency !== undefined ? 1 : 0) + (p?.add_rows?.length ?? 0);
