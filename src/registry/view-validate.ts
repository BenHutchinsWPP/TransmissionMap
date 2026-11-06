// Map-free checks of a view's per-layer sections, keyed by registry id:
// validateWhere() for `where` conditions, validateStyleOverride() (and its
// per-key keyError()) for `style` overrides; of its map-wide Area filter,
// validateArea(); and of its selection, validateSelection() (per layer:
// selectionIdsError(); canonical form: normalizeSelection(); its id count:
// selectionSize()); of its linked services (the link's `sv`), the link form
// (serviceLinkEntry / serviceFromLinkEntry) and the whole-list check with the
// link's caps (validateServices). Pure: no
// MapLibre, no state, safe before the map exists — the share-link decoder's
// trust boundary.
//
// Deps: src/registry/index.ts (layerById), condition-compile.ts
// (validateConditions, valueError, MAX_LIST_VALUES), field-schema.ts
// (REGION_FIELD_DEFS), area-filter.ts (AREA_KINDS), osm-fid.ts (OSM_FID,
// OSM_NATIVE_FID, osmRef), src/types.ts (StyleOverride,
// Selection), assets/services/service-spec.ts (validateLinkedService and the caps).
// Consumed by: assets/url-state-codec.ts (decodeVx, `af`, `sv`), assets/view-state.ts
// (setServices), assets/filters.ts
// (setWhere, setArea, setSelection), assets/style-overrides.ts (setStyle, effectiveOverride, paint —
// which add the map-side checks on top); selectionSize() also by
// assets/map-api.ts and assets/ui/panel-mirror.ts.

import { layerById } from './index.js';
import { validateConditions, valueError, MAX_LIST_VALUES } from './condition-compile.js';
import { FIELD_SCHEMA, REGION_FIELD_DEFS } from './field-schema.js';
import { AREA_KINDS, type AreaKind } from './area-filter.js';
import { OSM_FID, OSM_NATIVE_FID, osmRef } from './osm-fid.js';
import type { Selection, StyleOverride } from '../types.js';
import {
  validateLinkedService, MAX_SERVICES, MAX_SERVICES_JSON,
  type LinkedService, type ServiceKind, type ServiceStyle,
} from '../../assets/services/service-spec.js';
import type { Outcome } from '../../assets/dataset-query.js';

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

/** An untrusted Area filter: null when it is {kind, codes} with a known kind
 *  and 1–MAX_LIST_VALUES codes, each in that kind's region domain; else the
 *  reason. Duplicates are allowed (normalizeArea() drops them). */
export function validateArea(a: unknown): string | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return "an area must be an object";
  const { kind, codes, ...rest } = a as Record<string, unknown>;
  if (Object.keys(rest).length) return `unknown area key "${Object.keys(rest)[0]}"`;
  if (typeof kind !== "string" || !(AREA_KINDS as string[]).includes(kind)) return `unknown area kind ${JSON.stringify(kind)}`;
  if (!Array.isArray(codes) || codes.length < 1 || codes.length > MAX_LIST_VALUES) {
    return `an area takes 1–${MAX_LIST_VALUES} codes`;
  }
  const def = REGION_FIELD_DEFS[kind as AreaKind];
  for (const c of codes) {
    if (valueError(def, c)) return `${JSON.stringify(c)} is not a ${kind} code`;
  }
  return null;
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

// ─── Selection ────────────────────────────────────────────────────────────────
// Ids across every layer of one selection; a larger set is a rule, not a pick.
export const MAX_SELECTION_IDS = 500;
const SELECTION_MODES = ["isolate", "keep"];
const MAX_ID_CHARS = 64;
// Layers whose served id column holds strings ('1:1', 'lng_terminal:12', '107655', 'CA-MX US', 'AESO', retail '40429', control area '19547', BIA 'LAR0001', BOEM '3c19bdc18b22', WECC path '66' / corridor '66c').
const STRING_ID_LAYERS = new Set(["eia-generators", "hifld-natgas-lines", "hifld-natgas-points", "hifld-substations", "nerc-regions", "eia-ba", "retail-territories", "control-areas", "us-states", "countries", "admin1", "tribal-lands", "us-counties", "bia-tribal-lands", "boem-wind-leases", "wecc-paths"]);
const hasControlChar = (s: string) => [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** One layer's untrusted selected ids: null when the layer takes a selection
 *  (a `dataset` layer with a stable id) and the list is 1+ ids of its id shape —
 *  a safe integer (an OSM `fid` osmRef() accepts; a native tile id is always a
 *  number) or a string of 1–64 chars with no control characters; else the reason. */
export function selectionIdsError(registryId: string, ids: unknown): string | null {
  const entry = layerById(registryId);
  if (!entry) return `"${registryId}" is not a layer id`;
  const decl = entry.data?.id;
  if (!entry.dataset || !decl) return `"${registryId}" has no stable feature id, so it takes no selection`;
  if (!Array.isArray(ids) || ids.length < 1) return "a selection lists 1 or more ids per layer";
  const osm = decl === OSM_FID || decl === OSM_NATIVE_FID;
  // An OSM or native id is a number; any other layer's id type comes from its
  // schema entry, else from the layers measured to carry string ids.
  const want = osm || decl.native ? "number"
    : FIELD_SCHEMA[entry.dataset]?.[decl.field]?.type ?? (STRING_ID_LAYERS.has(registryId) ? "string" : undefined);
  for (const id of ids) {
    const ok = typeof id === "number"
      ? want !== "string" && Number.isSafeInteger(id) && (!osm || osmRef(id) !== null)
      : typeof id === "string" && want !== "number"
        && id.length >= 1 && id.length <= MAX_ID_CHARS && !hasControlChar(id);
    if (!ok) return `${JSON.stringify(id)} is not a "${registryId}" feature id`;
  }
  return null;
}

/** An untrusted selection: null when it is {mode, ids} with a known mode, 1+
 *  layers each passing selectionIdsError(), and at most MAX_SELECTION_IDS ids
 *  in all; else the reason. Duplicates are allowed (normalizeSelection() drops them). */
export function validateSelection(sel: unknown): string | null {
  if (!sel || typeof sel !== "object" || Array.isArray(sel)) return "a selection must be an object";
  const { mode, ids, ...rest } = sel as Record<string, unknown>;
  if (Object.keys(rest).length) return `unknown selection key "${Object.keys(rest)[0]}"`;
  if (typeof mode !== "string" || !SELECTION_MODES.includes(mode)) return `unknown selection mode ${JSON.stringify(mode)}`;
  if (!ids || typeof ids !== "object" || Array.isArray(ids) || !Object.keys(ids).length) {
    return "a selection names 1 or more layers";
  }
  for (const [id, list] of Object.entries(ids)) {
    const err = selectionIdsError(id, list);
    if (err) return err;
  }
  const total = selectionSize(ids as Selection["ids"]);
  return total > MAX_SELECTION_IDS ? `a selection takes at most ${MAX_SELECTION_IDS} ids (this one has ${total})` : null;
}

const byId = (a: string | number, b: string | number) =>
  typeof a !== typeof b ? (typeof a === "number" ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0;

/** How many ids a selection's layers hold in all (duplicates counted). */
export function selectionSize(ids: Selection["ids"] | undefined): number {
  return Object.values(ids ?? {}).reduce((n, list) => n + list.length, 0);
}

/** A valid selection in canonical form: each layer's ids deduplicated and
 *  sorted, and a layer left with no ids dropped, so equal selections give equal links; a copy, never the input. */
export function normalizeSelection(sel: Selection): Selection {
  return {
    mode: sel.mode,
    ids: Object.fromEntries(Object.entries(sel.ids).filter(([, list]) => list.length).map(([id, list]) => [id, [...new Set(list)].sort(byId)])),
  };
}

// ─── Linked services (the link's `sv`) ────────────────────────────────────────
// One entry per LinkedService, short keys: i id, u url (normalised), k kind,
// y layer, v WMS version (only 1.1.1 is stored), st style, t title and c credit (each
// left out when it equals the host), h 1 when hidden, l library id. Every field
// a view holds is here, since undo replays the link form; `host` is derived
// from the url. A library entry carries its full spec too: the library loads by
// dynamic import and a link decodes synchronously on cold boot.
export interface ServiceLinkEntry {
  i: string; u: string; k: ServiceKind; st: ServiceStyle;
  y?: string; v?: "1.1.1" | "1.3.0"; t?: string; c?: string; h?: 1; l?: string;
}
const SV_KEYS = new Set(["i", "u", "k", "y", "v", "st", "t", "c", "h", "l"]);

export function serviceLinkEntry(s: LinkedService): ServiceLinkEntry {
  const e: ServiceLinkEntry = { i: s.id, u: s.url, k: s.kind, st: s.style };
  if (s.layer !== undefined) e.y = s.layer;
  if (s.version !== undefined) e.v = s.version;
  if (s.title !== s.host) e.t = s.title;
  if (s.credit !== s.host) e.c = s.credit;
  if (!s.visible) e.h = 1;
  if (s.libraryId !== undefined) e.l = s.libraryId;
  return e;
}

/** One untrusted `sv` entry → the LinkedService it names, checked whole by validateLinkedService. */
export function serviceFromLinkEntry(e: unknown): Outcome<LinkedService> {
  const fail = (reason: string): Outcome<LinkedService> => ({ ok: false, reason });
  if (!e || typeof e !== "object" || Array.isArray(e)) return fail("a service entry must be an object");
  const o = e as Record<string, unknown>;
  const unknownKey = Object.keys(o).find(k => !SV_KEYS.has(k));
  if (unknownKey) return fail(`unknown service key "${unknownKey}"`);
  if (o.h !== undefined && o.h !== 1) return fail('"h" is 1 or left out');
  const r = validateLinkedService({
    id: o.i, kind: o.k, url: o.u, style: o.st, visible: o.h !== 1,
    title: o.t ?? "", credit: o.c ?? "",
    ...(o.y !== undefined && { layer: o.y }),
    ...(o.v !== undefined && { version: o.v }),
    ...(o.l !== undefined && { libraryId: o.l }),
  });
  if (!r.ok) return r;
  if (o.t === undefined) r.result.title = r.result.host;
  if (o.c === undefined) r.result.credit = r.result.host;
  return r;
}

/** UTF-8 bytes the services take in the link's JSON, before deflate (what the
 *  link encodes, so a CJK title counts three times its character count). */
export const servicesLinkBytes = (list: LinkedService[]) =>
  new TextEncoder().encode(JSON.stringify(list.map(serviceLinkEntry))).length;

/** A whole untrusted list, with the link's caps: at most MAX_SERVICES entries,
 *  each valid, distinct ids, the link form at most MAX_SERVICES_JSON UTF-8 bytes.
 *  Returns the canonical copies. */
export function validateServices(list: unknown): Outcome<LinkedService[]> {
  if (!Array.isArray(list)) return { ok: false, reason: "Linked services must be a list." };
  if (list.length > MAX_SERVICES) return { ok: false, reason: `A view links at most ${MAX_SERVICES} services.` };
  const out: LinkedService[] = [];
  for (const e of list) {
    const v = validateLinkedService(e);
    if (!v.ok) return v;
    if (out.some(o => o.id === v.result.id)) return { ok: false, reason: "Linked service ids must be distinct." };
    out.push(v.result);
  }
  const bytes = servicesLinkBytes(out);
  if (bytes > MAX_SERVICES_JSON) {
    return { ok: false, reason: `These services take ${bytes} bytes in a link; the most is ${MAX_SERVICES_JSON}.` };
  }
  return { ok: true, result: out };
}
