// ─── URL State Codec ──────────────────────────────────────────────────────────
// Pure functions for serializing/deserializing app state to/from URL params,
// the camera segment in front of them (splitHash, parseCameraSegment,
// formatCameraSegment), plus defaultView(): the value of every view field when
// a link omits it.
// formatUrlState() drops a field that equals its default, and view-state.ts
// resolves a parsed link over the same defaults, so the two can't disagree.
// Every code → value lookup is a Map, so only the codes listed resolve.
// The view's `where` and `style` sections travel in one compact param, `vx`
// (encodeVx/decodeVx below): a trust boundary — every entry is validated with
// src/registry/view-validate.ts's validateWhere() and validateStyleOverride(),
// and parseUrlState() reports what it dropped instead of throwing.
// Touches no app state or location/history. Module-level side effects:
// encodeVx() keeps a one-entry cache of its last result (vxCache) and writes a
// diag-log.ts event when a vx passes the link cap (VX_LINK_MAX_CHARS);
// formatUrlState() builds the default view once, on first use, and compares
// against it read-only.
// Deps: fflate (deflate for vx), view-validate.ts, diag-log.ts, the registry
// (incl. displayModes). fflate deflates synchronously, as parse/format run
// synchronously on cold boot; it is in the boot bundle via pmtiles.
// CompressionStream's deflate-raw needs Safari 16.4+.

import { LAYERS, displayModes } from '../src/registry/index.js';
import { WEATHER_VARIABLES, NRI_HAZARDS, DEFAULT_NRI_HAZARD } from '../src/registry/conditions.js';
import { LEGEND_FILTERS, legendAllIds } from './ui/ui-legends.js';
import { MW_SLIDER_MAX } from './constants.js';
import { YEAR_FILTER_DEFAULT, YEAR_FILTER_MIN, YEAR_FILTER_MAX } from '../src/colors/ramps.js';
import { isValidLocale } from '../src/i18n/index.js';
import type { LayerScope, StyleOverride } from '../src/types.js';
import type { Condition } from '../src/registry/condition-compile.js';
import { Inflate, deflateSync, strToU8, strFromU8 } from 'fflate';
import { validateWhere, validateStyleOverride } from '../src/registry/view-validate.js';
import { recordDiagEvent } from './diag-log.js';

// Layer-list scopes only. Continental download packs are picked per-download in
// the layer menu, so they never reach the URL.
const VALID_REGIONS = new Set<string>(['usa', 'global']);

const invert = (m: Map<string, string>) => new Map([...m].map(([k, v]) => [v, k]));

const _URLCODE_TO_ID = new Map(LAYERS.filter(l => l.urlCode).map(l => [l.urlCode!, l.id]));
const _GENMODECODE_TO_LAYER = new Map(LAYERS.filter(l => l.genModeCode).map(l => [l.genModeCode!, l]));

// One entry per bucket-filter param: legend filters (`groupCode`, into
// legendFilters by filter key), then per-layer bucket filters
// (`filterGroupCode`, into layerFilters by layer id). Parse and format walk
// this list in this order.
interface BucketParam {
  code: string;
  target: 'legendFilters' | 'layerFilters';
  key: string;
  buckets: { id: string; urlCode?: string }[];
  codeToId: Map<string, string>;
}
const bucketParam = (code: string, target: BucketParam['target'], key: string, buckets: BucketParam['buckets']): BucketParam =>
  ({ code, target, key, buckets, codeToId: new Map(buckets.filter(b => b.urlCode).map(b => [b.urlCode!, b.id])) });
const BUCKET_PARAMS: BucketParam[] = [
  ...LEGEND_FILTERS.filter(c => c.groupCode).map(c => bucketParam(c.groupCode, 'legendFilters', c.key, c.buckets)),
  ...LAYERS.filter(e => e.filterGroupCode && e.filterBuckets)
    .map(e => bucketParam(e.filterGroupCode!, 'layerFilters', e.id, e.filterBuckets!)),
];

function _setsEqual(a: Set<unknown>, b: Set<unknown>) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// An unknown basemap code (such as the retired `v`) falls back to the default.
const BM_CODE_TO_TYPE = new Map(Object.entries({ l: "light", d: "dark", s: "street", t: "topo", a: "aerial", h: "hydro" }));
const BM_TYPE_TO_CODE = invert(BM_CODE_TO_TYPE);
const GM_CHAR_TO_MODE = new Map(Object.entries({ i: "icons", h: "heat", b: "both", c: "clusters" }));
const GM_MODE_TO_CHAR = invert(GM_CHAR_TO_MODE);
const OC_CHAR_TO_MODE = new Map(Object.entries({ r: "region", s: "status" }));
const OC_MODE_TO_CHAR = invert(OC_CHAR_TO_MODE);
const WC_CHAR_TO_MODE = new Map(Object.entries({ s: "scenario", d: "dataset" }));
const WC_MODE_TO_CHAR = invert(WC_CHAR_TO_MODE);
// Weather Forecast variable dropdown — codes come from WEATHER_VARIABLES.urlCode.
const WV_CODE_TO_ID = new Map(WEATHER_VARIABLES.map(v => [v.urlCode, v.id]));
const WV_ID_TO_CODE = invert(WV_CODE_TO_ID);

export interface UrlStateData {
  layerVisibility: Record<string, boolean>;
  legendFilters: Record<string, Set<string>>;
  layerFilters: Record<string, Set<string>>;
  mwFilter: { min: number; max: number };
  yearFilter: { enabled: boolean; year: number };
  genMode: Record<string, string>;
  ogfColorBy: string;
  westtecColorBy: string;
  weatherVar: string;
  nriHazard: string;
  smokeOpacity: number;
  basemap: string;
  projection: string;
  terrain3d: boolean;
  buildings3d: boolean;
  hillshade: boolean;
  basemapLabels: boolean;
  // Both keyed by registry id (LayerDef.id); in the link as the `vx` param.
  where?: Record<string, Condition[]>;
  style?: Record<string, StyleOverride>;
  lang?: string;
  region?: LayerScope;
  // Active Map Experience (assets/experiences.ts). The caller resolves the
  // pristine/edited question first: an edited view passes null so the link
  // stops claiming to be the curated one.
  experienceId?: string | null;
}

// ─── Hash layout ──────────────────────────────────────────────────────────────
// A link's hash is `#<camera>?<params>`: the camera segment first, then the
// URLSearchParams that parseUrlState()/formatUrlState() read and write.
export function splitHash(hash: string): { camera: string; params: URLSearchParams } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = raw.indexOf('?');
  return q >= 0
    ? { camera: raw.slice(0, q), params: new URLSearchParams(raw.slice(q + 1)) }
    : { camera: raw, params: new URLSearchParams() };
}

export interface CameraView {
  center: [number, number];   // [lng, lat]
  zoom: number;
  bearing: number;
  pitch: number;
}

// Camera segment is "zoom/lat/lng" or, when the view is rotated/tilted,
// "zoom/lat/lng/bearing/pitch" (same field order as MapLibre's own `hash: true`
// control). bearing/pitch are appended only when either is non-zero, so a
// 3-segment hash means "flat, north-up" — callers must treat it as bearing and
// pitch 0, not "leave whatever the map currently has". Returns null for an
// empty or malformed segment.
export function parseCameraSegment(segment: string): CameraView | null {
  const parts = segment.split('/');
  if (parts.length !== 3 && parts.length !== 5) return null;
  const nums = parts.map(p => p.trim() === '' ? NaN : Number(p));
  if (!nums.every(Number.isFinite)) return null;
  const [zoom, lat, lng, bearing = 0, pitch = 0] = nums;
  if (zoom < 0 || zoom > 22)   return null;
  if (lat < -90 || lat > 90)   return null;
  if (lng < -180 || lng > 180) return null;
  if (pitch < 0 || pitch > 85) return null;
  return { center: [lng, lat], zoom, bearing, pitch };
}

// Longitude is wrapped into [-180, 180): MapLibre's getCenter() is unwrapped
// after panning across the antimeridian.
export function formatCameraSegment(v: CameraView): string {
  const lng = ((v.center[0] + 180) % 360 + 360) % 360 - 180;
  const lat = v.center[1];
  const segment = v.zoom.toFixed(2) + '/' + lat.toFixed(4) + '/' + lng.toFixed(4);
  const bearing = v.bearing.toFixed(1);
  const pitch = v.pitch.toFixed(1);
  return Number(bearing) !== 0 || Number(pitch) !== 0
    ? segment + '/' + bearing + '/' + pitch
    : segment;
}

// The view a link with no params shows — also what the Reset button restores.
// Returns fresh objects each call, so callers may mutate the result.
export function defaultView(): UrlStateData {
  const layerVisibility: Record<string, boolean> = {};
  const layerFilters: Record<string, Set<string>> = {};
  const genMode: Record<string, string> = {};
  for (const entry of LAYERS) {
    layerVisibility[entry.id] = !!entry.defaultOn;
    if (entry.filterBuckets) {
      layerFilters[entry.id] = new Set(entry.filterBuckets.filter(b => b.default !== false).map(b => b.id));
    }
    if (entry.heatLayerId || entry.modes) genMode[entry.id] = entry.defaultMode || 'icons';
  }
  const legendFilters: Record<string, Set<string>> = {};
  for (const cfg of LEGEND_FILTERS) legendFilters[cfg.key] = new Set(cfg.defaultActive ?? legendAllIds(cfg));
  return {
    layerVisibility,
    legendFilters,
    layerFilters,
    mwFilter: { min: 0, max: MW_SLIDER_MAX },
    yearFilter: { enabled: false, year: YEAR_FILTER_DEFAULT },
    genMode,
    ogfColorBy: 'region',
    westtecColorBy: 'scenario',
    weatherVar: WEATHER_VARIABLES[0].id,
    nriHazard: DEFAULT_NRI_HAZARD,
    smokeOpacity: 1,
    basemap: 'light',
    projection: 'mercator',
    terrain3d: false,
    buildings3d: false,
    hillshade: false,
    basemapLabels: true,
    where: {},
    style: {},
    lang: 'en',
    region: 'usa',
  };
}

// ─── `vx`: the view's where + style sections ─────────────────────────────────
// Value = marker + base64url (no padding) of the UTF-8 JSON
// {"v":1,"w":{…where},"s":{…style}} — keys sorted at every level, `w`/`s`
// omitted when empty, the whole param omitted when both are. Marker `j`: the
// JSON as is; `z`: raw deflate (fflate), used only when it is shorter.
const VX_VERSION = 1;
const VX_RAW = 'j';
const VX_DEFLATE = 'z';
export const VX_LINK_MAX_CHARS = 8192;  // param length a link reopens with, checked before any decoding
const VX_MAX_BYTES = 64 * 1024;  // decoded JSON, enforced while inflating
// Compressed bytes per Inflate push. Deflate tops out near 1032:1, so one push
// yields at most ~66 KB and the cap trips before a bomb gets any further.
const VX_CHUNK = 64;
const B64URL = /^[A-Za-z0-9_-]*$/;

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])]));
  }
  return v;
}

function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// Inflates in VX_CHUNK pushes and stops as soon as the output passes the cap.
// Returns the bytes, or why there are none.
function inflateCapped(bytes: Uint8Array): Uint8Array | string {
  const out: Uint8Array[] = [];
  let size = 0;
  let done = false;
  const inf = new Inflate((chunk, final) => { out.push(chunk); size += chunk.length; done = final; });
  const broken = 'deflate stream is truncated or corrupt';
  try {
    for (let i = 0; i < bytes.length && size <= VX_MAX_BYTES; i += VX_CHUNK) {
      inf.push(bytes.subarray(i, i + VX_CHUNK), i + VX_CHUNK >= bytes.length);
    }
  } catch {
    return broken;
  }
  if (size > VX_MAX_BYTES) return `does not inflate within ${VX_MAX_BYTES} bytes`;
  if (!done) return broken;
  const joined = new Uint8Array(size);
  let at = 0;
  for (const c of out) { joined.set(c, at); at += c.length; }
  return joined;
}

let vxCache = { json: '', value: '' };

function encodeVx(where: UrlStateData['where'], style: UrlStateData['style']): string {
  const w = Object.fromEntries(Object.entries(where ?? {}).filter(([, cs]) => cs.length));
  const s = Object.fromEntries(Object.entries(style ?? {})
    .filter(([, o]) => Object.values(o).some(v => v !== undefined)));
  const hasW = Object.keys(w).length > 0;
  const hasS = Object.keys(s).length > 0;
  if (!hasW && !hasS) return '';
  const json = JSON.stringify(sortKeys({ v: VX_VERSION, ...(hasW && { w }), ...(hasS && { s }) }));
  if (json === vxCache.json) return vxCache.value;
  const raw = strToU8(json);
  const packed = deflateSync(raw, { level: 9 });
  const value = packed.length < raw.length ? VX_DEFLATE + toB64url(packed) : VX_RAW + toB64url(raw);
  // Still written: the view file (V6) is the way to share a view this large.
  if (value.length > VX_LINK_MAX_CHARS) {
    recordDiagEvent('link', `vx is ${value.length} chars, over the ${VX_LINK_MAX_CHARS} a link reopens with`);
  }
  vxCache = { json, value };
  return value;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

// Every problem is pushed onto `dropped`; a bad entry drops only itself, a bad
// payload only the param.
function decodeVx(param: string, dropped: string[], maxChars: number): Pick<UrlStateData, 'where' | 'style'> {
  const fail = (why: string) => { dropped.push('vx: ' + why); return {}; };
  if (param.length > maxChars) return fail(`longer than ${maxChars} characters`);
  const marker = param[0];
  const body = param.slice(1);
  if ((marker !== VX_RAW && marker !== VX_DEFLATE) || !B64URL.test(body)) return fail('not a recognised encoding');
  let payload: unknown;
  try {
    const bytes = fromB64url(body);
    const json = marker === VX_RAW ? bytes : inflateCapped(bytes);
    if (typeof json === 'string') return fail(json);
    payload = JSON.parse(strFromU8(json));
  } catch {
    return fail('could not be decoded');
  }
  if (!isRecord(payload)) return fail('not an object');
  if (payload.v !== VX_VERSION) return fail(`unknown version ${JSON.stringify(payload.v)}`);

  const out: Pick<UrlStateData, 'where' | 'style'> = {};
  for (const key of Object.keys(payload)) {
    if (key === 'v') continue;
    const section = payload[key];
    if (key !== 'w' && key !== 's') { dropped.push(`vx.${key}: unknown section`); continue; }
    if (!isRecord(section)) { dropped.push(`vx.${key}: not an object`); continue; }
    if (key === 'w') {
      const where: Record<string, Condition[]> = {};
      for (const id of Object.keys(section)) {
        const err = validateWhere(id, section[id]);
        if (err) dropped.push(`vx.w.${id}: ${err}`);
        else where[id] = section[id] as Condition[];
      }
      out.where = where;
    } else {
      const style: Record<string, StyleOverride> = {};
      for (const id of Object.keys(section)) {
        const err = validateStyleOverride(id, section[id]);
        if (err) dropped.push(`vx.s.${id}: ${err}`);
        else style[id] = section[id] as StyleOverride;
      }
      out.style = style;
    }
  }
  return out;
}

// A parsed link, plus what it carried that was dropped (only `vx` drops today),
// one human-readable reason per dropped setting; absent when nothing was.
export type ParsedUrlState = Partial<UrlStateData> & { dropped?: string[] };

// `vxMaxChars` is the longest `vx` accepted: a link's cap by default, a view
// file passes its larger one.
export function parseUrlState(
  params: URLSearchParams,
  { vxMaxChars = VX_LINK_MAX_CHARS }: { vxMaxChars?: number } = {},
): ParsedUrlState {
  const data: ParsedUrlState = {};

  // Layer visibility
  const lParam = params.get('l');
  if (lParam) {
    data.layerVisibility = {};
    for (const token of lParam.split('.').map(s => s.trim()).filter(Boolean)) {
      const id = _URLCODE_TO_ID.get(token[0] === '-' ? token.slice(1) : token);
      if (id) data.layerVisibility[id] = token[0] !== '-';
    }
  }

  // Legend filters, then layer bucket filters
  for (const p of BUCKET_PARAMS) {
    const raw = params.get(p.code);
    if (raw === null) continue;
    const ids = new Set<string>();
    for (const ch of raw) {
      const id = p.codeToId.get(ch);
      if (id) ids.add(id);
    }
    (data[p.target] ??= {})[p.key] = ids;
  }

  // MW range: two plain numbers, min ≤ max, clamped to MW_SLIDER_MAX as the slider clamps them
  const mw = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(params.get('mw') ?? '');
  if (mw) {
    const [lo, hi] = [Number(mw[1]), Number(mw[2])].map(n => Math.min(n, MW_SLIDER_MAX));
    if (lo <= hi) data.mwFilter = { min: lo, max: hi };
  }
  // Year: a whole year within the filter's bounds
  const y = params.get('y');
  if (y !== null && /^\d{4}$/.test(y)) {
    const yr = Number(y);
    if (yr >= YEAR_FILTER_MIN && yr <= YEAR_FILTER_MAX) data.yearFilter = { enabled: true, year: yr };
  }

  // Gen mode: each token is a layer's genModeCode + a mode that layer offers
  const gm = params.get('gm');
  if (gm) {
    data.genMode = {};
    for (const tok of gm.split('.')) {
      if (tok.length < 2) continue;
      const entry = _GENMODECODE_TO_LAYER.get(tok[0]), mode = GM_CHAR_TO_MODE.get(tok[1]);
      if (entry && mode && displayModes(entry).includes(mode)) data.genMode[entry.id] = mode;
    }
  }

  // OGF color-by
  const oc = params.get('oc');
  const ocMode = oc && OC_CHAR_TO_MODE.get(oc);
  if (ocMode) data.ogfColorBy = ocMode;

  // WestTEC color-by
  const wc = params.get('wc');
  const wcMode = wc && WC_CHAR_TO_MODE.get(wc);
  if (wcMode) data.westtecColorBy = wcMode;

  // Weather Forecast variable
  const wv = params.get('wv');
  const wvId = wv && WV_CODE_TO_ID.get(wv);
  if (wvId) data.weatherVar = wvId;

  // FEMA National Risk Index hazard — the NRI field prefix, lowercased
  const nr = params.get('nr')?.toUpperCase();
  if (nr && NRI_HAZARDS.some(h => h.id === nr)) data.nriHazard = nr;

  // Smoke opacity (integer percent, converted to a 0–1 factor)
  const so = params.get('so');
  if (so !== null && /^(?:100|[0-9]{1,2})$/.test(so)) data.smokeOpacity = Number(so) / 100;

  // Basemap
  const bm = params.get('bm');
  const bmType = bm && BM_CODE_TO_TYPE.get(bm);
  if (bmType) data.basemap = bmType;

  // Projection (default mercator; only 'g' = globe persisted)
  if (params.get('pj') === 'g') data.projection = 'globe';

  // 3D terrain / buildings ('t' = terrain, 'b' = buildings, either/both)
  const td = params.get('3d');
  if (td) {
    if (td.includes('t')) data.terrain3d = true;
    if (td.includes('b')) data.buildings3d = true;
  }

  // Hillshade (2D shaded relief; off by default, only '1' persisted)
  if (params.get('hs') === '1') data.hillshade = true;

  // Basemap labels (on by default, only '0' persisted)
  if (params.get('lb') === '0') data.basemapLabels = false;

  // Language
  const lang = params.get('lang');
  if (lang && isValidLocale(lang)) data.lang = lang;

  // Region
  const region = params.get('region');
  if (region && VALID_REGIONS.has(region)) data.region = region as LayerScope;
  // Map Experience — checked by shape only; assets/experiences.ts drops a slug
  // that names no story once the map is up. The pattern is a trust boundary:
  // the value is written back into the link and used as a lookup key.
  const exp = params.get('exp');
  if (exp && /^[a-z0-9-]{1,64}$/.test(exp)) data.experienceId = exp;

  // where + style (see decodeVx)
  const vx = params.get('vx');
  if (vx !== null) {
    const dropped: string[] = [];
    Object.assign(data, decodeVx(vx, dropped, vxMaxChars));
    if (dropped.length) data.dropped = dropped;
  }

  return data;
}

// defaultView(), built on first use and only ever read.
let _defaults: UrlStateData | undefined;

export function formatUrlState(data: UrlStateData): string[] {
  const parts: string[] = [];
  const dv = _defaults ??= defaultView();

  // Layer visibility
  const lDelta: string[] = [];
  for (const entry of LAYERS) {
    if (!entry.urlCode) continue;
    const cur = !!data.layerVisibility[entry.id];
    if (cur !== dv.layerVisibility[entry.id]) lDelta.push((cur ? '' : '-') + entry.urlCode);
  }
  if (lDelta.length) parts.push('l=' + lDelta.join('.'));

  // Legend filters, then layer bucket filters
  for (const p of BUCKET_PARAMS) {
    const cur = data[p.target][p.key];
    if (!cur || _setsEqual(cur, dv[p.target][p.key])) continue;
    parts.push(p.code + '=' + p.buckets.filter(b => b.urlCode && cur.has(b.id)).map(b => b.urlCode).join(''));
  }

  // MW and Year filters
  const { min, max } = data.mwFilter;
  if (min !== dv.mwFilter.min || max !== dv.mwFilter.max) parts.push('mw=' + min + '-' + max);
  if (data.yearFilter && data.yearFilter.enabled) parts.push('y=' + data.yearFilter.year);

  // Gen mode
  const gmTokens: string[] = [];
  for (const e of LAYERS) {
    if (!e.genModeCode) continue;
    const def = dv.genMode[e.id] || 'icons';
    const mode = data.genMode[e.id] || def;
    const ch = GM_MODE_TO_CHAR.get(mode);
    if (mode !== def && ch) gmTokens.push(e.genModeCode + ch);
  }
  if (gmTokens.length) parts.push('gm=' + gmTokens.join('.'));

  // OGF color-by (default omitted)
  const oc = OC_MODE_TO_CHAR.get(data.ogfColorBy);
  if (data.ogfColorBy !== dv.ogfColorBy && oc) parts.push('oc=' + oc);

  // WestTEC color-by (default omitted)
  const wc = WC_MODE_TO_CHAR.get(data.westtecColorBy);
  if (data.westtecColorBy !== dv.westtecColorBy && wc) parts.push('wc=' + wc);

  // Weather Forecast variable (default omitted)
  const wv = WV_ID_TO_CODE.get(data.weatherVar);
  if (data.weatherVar !== dv.weatherVar && wv) parts.push('wv=' + wv);

  // FEMA NRI hazard (default composite omitted)
  if (data.nriHazard && data.nriHazard !== dv.nriHazard) {
    parts.push('nr=' + data.nriHazard.toLowerCase());
  }

  // Smoke opacity (default 100% omitted)
  const smokePercent = Math.round(data.smokeOpacity * 100);
  if (smokePercent !== Math.round(dv.smokeOpacity * 100)) parts.push('so=' + smokePercent);

  // Basemap (default omitted)
  const bm = BM_TYPE_TO_CODE.get(data.basemap);
  if (data.basemap !== dv.basemap && bm) parts.push('bm=' + bm);

  // Projection (default omitted; globe is the one other value)
  if (data.projection !== dv.projection) parts.push('pj=g');

  // 3D terrain / buildings (default omitted)
  if (data.terrain3d !== dv.terrain3d || data.buildings3d !== dv.buildings3d) {
    parts.push('3d=' + (data.terrain3d ? 't' : '') + (data.buildings3d ? 'b' : ''));
  }

  // Hillshade (default omitted)
  if (data.hillshade !== dv.hillshade) parts.push('hs=1');

  // Basemap labels (default omitted)
  if (data.basemapLabels === false) parts.push('lb=0');

  // Language (default omitted)
  if (data.lang && data.lang !== dv.lang) parts.push(`lang=${encodeURIComponent(data.lang)}`);

  // Region (default omitted)
  if (data.region && data.region !== dv.region && VALID_REGIONS.has(data.region)) {
    parts.push(`region=${encodeURIComponent(data.region)}`);
  }
  // where + style (default — both empty — omitted). Before `exp`, so the
  // story-dirty string compare sees it.
  const vx = encodeVx(data.where, data.style);
  if (vx) parts.push('vx=' + vx);

  // Map Experience — always last, so url-state.ts can diff the parts above it
  // against the snapshot the experience left behind.
  if (data.experienceId) parts.push('exp=' + data.experienceId);

  return parts;
}
