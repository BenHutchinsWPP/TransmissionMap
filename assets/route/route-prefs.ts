// ─── Route planner default preferences ───────────────────────────────────────
// Role: the visitor's defaults for new routes (method, line type, alternatives, similar-cost
//       areas, snap radius, colour-by), kept under localStorage key `tm-route-prefs` as
//       `{ v: 1, ...fields }`. Stored data is untrusted: loadRoutePrefs checks every field,
//       drops unknown keys and replaces a bad value with its default. A `custom:<id>` method
//       survives only while that saved method exists and is ok; a line type only while the
//       method offers it. Pure apart from the storage adapter it is given.
// Deps: preset-patch.ts (DEFAULT_ALT_STRETCH, MAX_ALTERNATIVES, MAX_ALT_STRETCH),
//       custom-presets.ts (store, PresetStorage), src/registry/route-presets.ts.

import { ROUTE_PRESETS, type RoutePreset } from '../../src/registry/route-presets.js';
import { createCustomPresetStore, type PresetStorage } from './custom-presets.js';
import { DEFAULT_ALT_STRETCH, MAX_ALTERNATIVES, MAX_ALT_STRETCH } from './preset-patch.js';

export const ROUTE_PREFS_KEY = 'tm-route-prefs';
export const DEFAULT_PRESET_ID = 'tm-default';
export const SNAP_KM = [1, 3, 5] as const;
export const ROUTE_COLOURS = ['cost', 'driver', 'plain'] as const;
export const CUSTOM_PREFIX = 'custom:';

export interface RoutePrefs {
  v: 1;
  presetId: string;
  lineType: string;
  autoAlternatives: boolean;
  altCount: number;
  altStretch: number;
  showSurface: boolean;
  snapKm: 1 | 3 | 5;
  colour: (typeof ROUTE_COLOURS)[number];
}

/** The preset a method id names: a built-in, or an ok saved method (base with its patch applied). */
export function presetForId(storage: PresetStorage, id: string): RoutePreset | null {
  if (!id.startsWith(CUSTOM_PREFIX)) return ROUTE_PRESETS.find((p) => p.id === id) ?? null;
  const c = createCustomPresetStore(storage).list().find((x) => CUSTOM_PREFIX + x.id === id);
  return c?.status === 'ok' && c.preset ? c.preset : null;
}

const firstLine = (p: RoutePreset | null) => Object.keys(p?.line_types ?? {})[0] ?? '';

export function defaultRoutePrefs(): RoutePrefs {
  const p = ROUTE_PRESETS.find((x) => x.id === DEFAULT_PRESET_ID) ?? ROUTE_PRESETS[0];
  return {
    v: 1, presetId: p.id, lineType: firstLine(p), autoAlternatives: false, altCount: MAX_ALTERNATIVES,
    altStretch: DEFAULT_ALT_STRETCH, showSurface: true, snapKm: 3, colour: 'cost',
  };
}

export function loadRoutePrefs(storage: PresetStorage): RoutePrefs {
  const d = defaultRoutePrefs();
  let raw: unknown;
  try {
    const s = storage.getItem(ROUTE_PREFS_KEY);
    raw = s === null ? null : JSON.parse(s);
  } catch {
    return d;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { v?: unknown }).v !== 1) return d;
  const o = raw as Record<string, unknown>;
  let preset = typeof o.presetId === 'string' ? presetForId(storage, o.presetId) : null;
  const presetId = preset ? (o.presetId as string) : d.presetId;
  preset ??= presetForId(storage, d.presetId);
  const lineType = typeof o.lineType === 'string' && preset && Object.hasOwn(preset.line_types, o.lineType)
    ? o.lineType : firstLine(preset);
  const n = o.altCount;
  const st = o.altStretch;
  return {
    v: 1,
    presetId,
    lineType,
    autoAlternatives: typeof o.autoAlternatives === 'boolean' ? o.autoAlternatives : d.autoAlternatives,
    altCount: typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_ALTERNATIVES ? n : d.altCount,
    altStretch: typeof st === 'number' && Number.isFinite(st) && st > 0 && st <= MAX_ALT_STRETCH ? st : d.altStretch,
    showSurface: typeof o.showSurface === 'boolean' ? o.showSurface : d.showSurface,
    snapKm: (SNAP_KM as readonly unknown[]).includes(o.snapKm) ? (o.snapKm as 1 | 3 | 5) : d.snapKm,
    colour: (ROUTE_COLOURS as readonly unknown[]).includes(o.colour) ? (o.colour as RoutePrefs['colour']) : d.colour,
  };
}

/** Writes the prefs; false when storage refuses. */
export function saveRoutePrefs(storage: PresetStorage, prefs: RoutePrefs): boolean {
  try {
    storage.setItem(ROUTE_PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

const memory = (): PresetStorage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

/** The browser's localStorage as a PresetStorage; an in-memory stand-in when it is unavailable. */
export function localStorageAdapter(): PresetStorage {
  try {
    const ls = globalThis.localStorage;
    if (ls) return { getItem: (k) => ls.getItem(k), setItem: (k, v) => ls.setItem(k, v) };
  } catch { /* blocked storage */ }
  return memory();
}
