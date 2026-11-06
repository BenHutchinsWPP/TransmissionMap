// ─── Saved custom route presets ──────────────────────────────────────────────
// Role: the store behind "Save as custom…" in the route planner. A custom preset is a
//       built-in preset id plus a PresetPatch, kept under localStorage key `tm-route-presets`
//       as `{ v: 1, items: StoredCustom[] }`. Every item is re-validated on each read
//       (unknown base, or a patch the current registry refuses → status 'needs-review');
//       such items stay in storage, are never auto-removed and are not usable until the
//       visitor deletes them. Malformed storage reads as an empty list and is left
//       untouched until the next successful save, which writes only well-formed items.
//       Names and problem text are plain data: this module never builds HTML. presetLabel()
//       is a built-in preset's name in the reader's language (`route.preset.<id>`, else its label).
//       Method files (`*.tmroute.json`, `{ format: 'tmroute', v: 1, name, base, patch }`):
//       buildMethodFile() writes one; readMethodFile() is the trust boundary for one opened from
//       disk — size, shape and name checked, the patch through validatePresetPatch like storage.
//       A patch may hold uploaded-layer rows (`add_rows`: hash, label, weights); the geometry is never
//       stored, and validatePresetPatch refuses any field beyond those.
// Deps: preset-patch.ts (validatePresetPatch), src/registry/route-presets.ts, i18n (t), dataset-query.ts (Outcome, type only).

import type { Outcome } from '../dataset-query.js';
import { ROUTE_PRESETS, type RoutePreset } from '../../src/registry/route-presets.js';
import { validatePresetPatch } from './preset-patch.js';
import { t } from '../../src/i18n/index.js';

export function presetLabel(p: RoutePreset): string {
  const key = `route.preset.${p.id}`, v = t(key);
  return v === key ? p.label : v;
}

export const CUSTOM_PRESETS_KEY = 'tm-route-presets';
export const MAX_CUSTOM_PRESETS = 20;
export const MAX_NAME_LENGTH = 60;

export interface StoredCustom { id: string; name: string; base: string; patch: unknown; savedAt: string }

export interface CustomPreset extends StoredCustom {
  status: 'ok' | 'needs-review';
  /** The base preset with the patch applied; present when status is 'ok'. */
  preset?: RoutePreset;
  problem?: string;
}

export interface PresetStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStored = (v: unknown): v is StoredCustom =>
  isObj(v) && ['id', 'name', 'base', 'savedAt'].every((k) => typeof v[k] === 'string') && 'patch' in v;

// eslint-disable-next-line no-control-regex
const cleanName = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();

function check(base: string, patch: unknown): Outcome<RoutePreset> {
  const preset = ROUTE_PRESETS.find((p) => p.id === base);
  if (!preset) return { ok: false, reason: `unknown base preset "${base}"` };
  return validatePresetPatch(preset, patch);
}

export const METHOD_FILE_SUFFIX = '.tmroute.json';
export const MAX_METHOD_FILE_CHARS = 256 * 1024;

export function buildMethodFile(name: string, base: string, patch: unknown): string {
  return JSON.stringify({ format: 'tmroute', v: 1, name, base, patch: patch ?? {} }, null, 2);
}

/** A download name for `name`: letters, digits and dashes, then the suffix. */
export function methodFileName(name: string): string {
  return (name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'route-method') + METHOD_FILE_SUFFIX;
}

/** An opened method file → its name, base and patch, or why it cannot be used. */
export function readMethodFile(text: string): Outcome<{ name: string; base: string; patch: unknown }> {
  if (text.length > MAX_METHOD_FILE_CHARS) return { ok: false, reason: `file is over ${MAX_METHOD_FILE_CHARS / 1024} KB` };
  let o: unknown;
  try { o = JSON.parse(text); } catch { return { ok: false, reason: 'not a JSON file' }; }
  if (!isObj(o) || o.format !== 'tmroute') return { ok: false, reason: 'not a route method file' };
  if (o.v !== 1) return { ok: false, reason: `unsupported method file version ${String(o.v)}` };
  if (typeof o.name !== 'string' || typeof o.base !== 'string') return { ok: false, reason: 'method file has no name or base method' };
  const name = cleanName(o.name);
  if (!name || name.length > MAX_NAME_LENGTH) return { ok: false, reason: `name must be 1-${MAX_NAME_LENGTH} characters` };
  const r = check(o.base, o.patch ?? {});
  return r.ok ? { ok: true, result: { name, base: o.base, patch: o.patch ?? {} } } : r;
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 10);

export function createCustomPresetStore(storage: PresetStorage) {
  /** Well-formed stored items. Absent or malformed storage reads as []; malformed-shape entries are
   *  skipped here and so dropped from storage on the next save. */
  function read(): StoredCustom[] {
    try {
      const raw = storage.getItem(CUSTOM_PRESETS_KEY);
      if (raw === null) return [];
      const p: unknown = JSON.parse(raw);
      if (!isObj(p) || p.v !== 1 || !Array.isArray(p.items)) return [];
      return p.items.filter(isStored).map(({ id, name, base, patch, savedAt }) => ({ id, name, base, patch, savedAt }));
    } catch {
      return [];
    }
  }
  function write(items: StoredCustom[]): boolean {
    try {
      storage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify({ v: 1, items }));
      return true;
    } catch {
      return false;
    }
  }
  function view(s: StoredCustom): CustomPreset {
    const r = check(s.base, s.patch);
    return r.ok ? { ...s, status: 'ok', preset: r.result } : { ...s, status: 'needs-review', problem: r.reason };
  }

  return {
    list(): CustomPreset[] { return read().map(view); },

    save(name: string, base: string, patch: unknown): Outcome<CustomPreset> {
      const n = cleanName(String(name));
      if (!n || n.length > MAX_NAME_LENGTH) return { ok: false, reason: `name must be 1-${MAX_NAME_LENGTH} characters` };
      const r = check(base, patch);
      if (!r.ok) return r;
      const items = read();
      if (items.length >= MAX_CUSTOM_PRESETS)
        return { ok: false, reason: `at most ${MAX_CUSTOM_PRESETS} custom presets; delete one first` };
      let id = newId();
      while (items.some((i) => i.id === id)) id = newId();
      const item: StoredCustom = { id, name: n, base, patch: structuredClone(patch ?? {}), savedAt: new Date().toISOString() };
      if (!write([...items, item])) return { ok: false, reason: 'could not write to browser storage' };
      return { ok: true, result: view(item) };
    },

    rename(id: string, name: string): boolean {
      const n = cleanName(String(name));
      const items = read();
      const it = items.find((i) => i.id === id);
      if (!it || !n || n.length > MAX_NAME_LENGTH) return false;
      it.name = n;
      return write(items);
    },

    /** Replaces a saved method's patch (validated against its base like save); other fields stay. */
    update(id: string, patch: unknown): Outcome<CustomPreset> {
      const items = read();
      const it = items.find((i) => i.id === id);
      if (!it) return { ok: false, reason: 'no such saved method' };
      const r = check(it.base, patch);
      if (!r.ok) return r;
      it.patch = structuredClone(patch ?? {});
      it.savedAt = new Date().toISOString();
      if (!write(items)) return { ok: false, reason: 'could not write to browser storage' };
      return { ok: true, result: view(it) };
    },

    remove(id: string): boolean {
      const items = read();
      const rest = items.filter((i) => i.id !== id);
      return rest.length < items.length && write(rest);
    },
  };
}
