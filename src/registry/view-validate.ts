// Map-free checks of a view's per-layer sections, keyed by registry id:
// validateWhere() for `where` conditions, validateStyleOverride() (and its
// per-key keyError()) for `style` overrides. Pure: no MapLibre, no state, safe
// before the map exists — the share-link decoder's trust boundary.
//
// Deps: src/registry/index.ts (layerById), condition-compile.ts
// (validateConditions), src/types.ts (StyleOverride).
// Consumed by: assets/url-state-codec.ts (decodeVx), assets/filters.ts
// (setWhere), assets/style-overrides.ts (setStyle, effectiveOverride, paint —
// which add the map-side checks on top).

import { layerById } from './index.js';
import { validateConditions } from './condition-compile.js';
import type { StyleOverride } from '../types.js';

// Registry layers whose features a filter cannot reach, with the reason.
const WHERE_REJECTED_LAYERS: Record<string, string> = {
  "nws-alerts": "NWS alerts are drawn partly by feature-state on the joined county/zone layers, which a filter cannot reach",
};

/** One registry layer's untrusted conditions: null when valid, else the reason. */
export function validateWhere(registryId: string, conditions: unknown): string | null {
  if (Object.hasOwn(WHERE_REJECTED_LAYERS, registryId)) {
    return `"${registryId}" takes no conditions: ${WHERE_REJECTED_LAYERS[registryId]}`;
  }
  const entry = layerById(registryId);
  if (!entry) return `"${registryId}" is not a layer id`;
  if (!entry.dataset) return `"${registryId}" has no field schema, so it takes no conditions`;
  const err = validateConditions(entry.dataset, conditions);
  return err ? err.message : null;
}

export type StyleKey = keyof StyleOverride;
export const STYLE_KEYS: StyleKey[] = ["opacity", "size", "color"];

// Keys a layer never takes, with the reason.
const BARRED: Record<string, Partial<Record<StyleKey, string>>> = {
  "wildfire-smoke": { opacity: `"wildfire-smoke" opacity is set by the smoke opacity slider, not a style override` },
  "weather-live": {
    size: `"weather-live" takes opacity only`,
    color: `"weather-live" takes opacity only`,
  },
};

export function barredReason(registryId: string, k: StyleKey): string | undefined {
  return Object.hasOwn(BARRED, registryId) ? BARRED[registryId][k] : undefined;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const RGBA = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+|1\.0+)\s*\)$/;

function validColor(c: unknown): boolean {
  if (typeof c !== "string") return false;
  if (HEX.test(c)) return true;
  const m = RGB.exec(c) ?? RGBA.exec(c);
  return !!m && [m[1], m[2], m[3]].every(n => Number(n) <= 255);
}

const inRange = (n: unknown, lo: number, hi: number) =>
  typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;

/** One untrusted override key and value: null when valid, else the reason. */
export function keyError(registryId: string, k: string, v: unknown): string | null {
  if (!(STYLE_KEYS as string[]).includes(k)) return `unknown style property "${k}"`;
  const barred = barredReason(registryId, k as StyleKey);
  if (barred) return barred;
  if (k === "opacity" && !inRange(v, 0, 1)) return "opacity must be a number from 0 to 1";
  if (k === "size" && !inRange(v, 0.25, 4)) return "size must be a multiplier from 0.25 to 4";
  if (k === "color" && !validColor(v)) return "color must be #rgb, #rrggbb, rgb(r,g,b) or rgba(r,g,b,a)";
  return null;
}

/** One registry layer's untrusted override: null when valid, else the reason. */
export function validateStyleOverride(registryId: string, o: unknown): string | null {
  if (!layerById(registryId)) return `"${registryId}" is not a layer id`;
  if (!o || typeof o !== "object" || Array.isArray(o)) return "style must be an object";
  for (const k of Object.keys(o)) {
    const err = keyError(registryId, k, (o as Record<string, unknown>)[k]);
    if (err) return err;
  }
  return null;
}
