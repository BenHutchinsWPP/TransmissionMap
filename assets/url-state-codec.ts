// ─── URL State Codec ──────────────────────────────────────────────────────────
// Pure functions for serializing/deserializing app state to/from URL params,
// the camera segment in front of them (splitHash, parseCameraSegment,
// formatCameraSegment), plus defaultView(): the value of every view field when
// a link omits it.
// formatUrlState() drops a field that equals its default, and view-state.ts
// resolves a parsed link over the same defaults, so the two can't disagree.
// Does NOT touch global state or location/history.

import { LAYERS } from '../src/registry/index.js';
import { WEATHER_VARIABLES, NRI_HAZARDS, DEFAULT_NRI_HAZARD } from '../src/registry/conditions.js';
import { LEGEND_FILTERS, legendAllIds } from './ui/ui-legends.js';
import { MW_SLIDER_MAX } from './constants.js';
import { YEAR_FILTER_DEFAULT } from '../src/colors/ramps.js';
import { isValidLocale } from '../src/i18n/index.js';
import type { LayerScope } from '../src/types.js';

// Layer-list scopes only. Continental download packs are picked per-download in
// the layer menu, so they never reach the URL.
export const VALID_REGIONS = new Set<string>(['usa', 'global']);

// Build lookup maps once for fast urlCode ↔ id resolution.
const _URLCODE_TO_ID = Object.fromEntries(
  LAYERS.filter(l => l.urlCode).map(l => [l.urlCode, l.id])
);
// groupCode → Map<urlCode → bucketId>
const _BUCKET_CODE_MAP: Record<string, Record<string, string>> = {};
for (const cfg of LEGEND_FILTERS) {
  if (!cfg.groupCode) continue;
  const m: Record<string, string> = {};
  for (const b of cfg.buckets) {
    if (b.urlCode) m[b.urlCode] = b.id;
  }
  _BUCKET_CODE_MAP[cfg.groupCode] = m;
}
// groupCode → { entry, codeToId }
const _LAYER_BUCKET_CODE_MAP: Record<string, { entry: (typeof LAYERS)[number]; codeToId: Record<string, string> }> = {};
for (const entry of LAYERS) {
  if (!entry.filterGroupCode || !entry.filterBuckets) continue;
  const codeToId: Record<string, string> = {};
  for (const b of entry.filterBuckets) {
    if (b.urlCode) codeToId[b.urlCode] = b.id;
  }
  _LAYER_BUCKET_CODE_MAP[entry.filterGroupCode] = { entry, codeToId };
}

function _setsEqual(a: Set<unknown>, b: Set<unknown>) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// "v" (voyager) retired with the CARTO→OpenFreeMap migration; old &b=v URLs
// fail the lookup and fall back to the default basemap.
const BM_CODE_TO_TYPE: Record<string, string> = { l: "light", d: "dark", s: "street", t: "topo", a: "aerial", h: "hydro" };
const BM_TYPE_TO_CODE: Record<string, string> = { light: "l", dark: "d", street: "s", topo: "t", aerial: "a", hydro: "h" };
const GM_CHAR_TO_MODE: Record<string, string> = { i: "icons", h: "heat", b: "both", c: "clusters" };
const GM_MODE_TO_CHAR: Record<string, string> = { icons: "i", heat: "h", both: "b", clusters: "c" };
const OC_CHAR_TO_MODE: Record<string, string> = { s: "status", w: "scenario", a: "planauth" };
const OC_MODE_TO_CHAR: Record<string, string> = { status: "s", scenario: "w", planauth: "a" };
const WC_CHAR_TO_MODE: Record<string, string> = { s: "scenario", d: "dataset" };
const WC_MODE_TO_CHAR: Record<string, string> = { scenario: "s", dataset: "d" };
// Weather Forecast variable dropdown — codes come from WEATHER_VARIABLES.urlCode.
const WV_CODE_TO_ID = Object.fromEntries(WEATHER_VARIABLES.map(v => [v.urlCode, v.id]));
const WV_ID_TO_CODE = Object.fromEntries(WEATHER_VARIABLES.map(v => [v.id, v.urlCode]));

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
  const [zoom, lat, lng] = parts.slice(0, 3).map(parseFloat);
  if ([zoom, lat, lng].some(isNaN)) return null;
  if (zoom < 0 || zoom > 22)   return null;
  if (lat < -90 || lat > 90)   return null;
  if (lng < -180 || lng > 180) return null;
  let bearing = 0;
  let pitch = 0;
  if (parts.length === 5) {
    bearing = parseFloat(parts[3]);
    pitch   = parseFloat(parts[4]);
    if ([bearing, pitch].some(isNaN)) return null;
    if (pitch < 0 || pitch > 85)      return null;
  }
  return { center: [lng, lat], zoom, bearing, pitch };
}

export function formatCameraSegment(v: CameraView): string {
  const [lng, lat] = v.center;
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
    ogfColorBy: 'status',
    westtecColorBy: 'scenario',
    weatherVar: WEATHER_VARIABLES[0].id,
    nriHazard: DEFAULT_NRI_HAZARD,
    smokeOpacity: 1,
    basemap: 'light',
    projection: 'mercator',
    terrain3d: false,
    buildings3d: false,
    hillshade: false,
    region: 'usa',
  };
}

export function parseUrlState(params: URLSearchParams): Partial<UrlStateData> {
  const data: Partial<UrlStateData> = {};

  // Layer visibility
  const lParam = params.get('l');
  if (lParam) {
    data.layerVisibility = {};
    for (const token of lParam.split('.').map(s => s.trim()).filter(Boolean)) {
      const id = _URLCODE_TO_ID[token[0] === '-' ? token.slice(1) : token];
      if (id) data.layerVisibility[id] = token[0] !== '-';
    }
  }

  // Legend filters
  for (const cfg of LEGEND_FILTERS) {
    const raw = params.get(cfg.groupCode);
    if (raw === null) continue;
    const bm = _BUCKET_CODE_MAP[cfg.groupCode];
    if (!bm) continue;
    if (!data.legendFilters) data.legendFilters = {};
    const ids: Set<string> = new Set();
    for (const ch of raw) {
        if (bm[ch]) ids.add(bm[ch]);
    }
    data.legendFilters[cfg.key] = ids;
  }

  // Layer bucket filters
  for (const [gc, { entry, codeToId }] of Object.entries(_LAYER_BUCKET_CODE_MAP)) {
    const raw = params.get(gc);
    if (raw === null) continue;
    if (!data.layerFilters) data.layerFilters = {};
    const ids: Set<string> = new Set();
    for (const ch of raw) if (codeToId[ch]) ids.add(codeToId[ch]);
    data.layerFilters[entry.id] = ids;
  }

  // MW and Year filters
  const mw = params.get('mw');
  if (mw) {
    const [lo, hi] = mw.split('-').map(Number);
    if (!isNaN(lo) && !isNaN(hi)) data.mwFilter = { min: lo, max: hi };
  }
  const y = params.get('y');
  if (y !== null) {
    const yr = parseInt(y, 10);
    if (!isNaN(yr)) { data.yearFilter = { enabled: true, year: yr }; }
  }

  // Gen mode
  const gm = params.get('gm');
  if (gm) {
    data.genMode = {};
    const codeToId: Record<string, string> = {};
    for (const e of LAYERS) if (e.genModeCode) codeToId[e.genModeCode] = e.id;
    for (const tok of gm.split('.')) {
      if (tok.length < 2) continue;
      const id = codeToId[tok[0]], mode = GM_CHAR_TO_MODE[tok[1]];
      if (id && mode) data.genMode[id] = mode;
    }
  }

  // OGF color-by
  const oc = params.get('oc');
  if (oc && OC_CHAR_TO_MODE[oc]) data.ogfColorBy = OC_CHAR_TO_MODE[oc];

  // WestTEC color-by
  const wc = params.get('wc');
  if (wc && WC_CHAR_TO_MODE[wc]) data.westtecColorBy = WC_CHAR_TO_MODE[wc];

  // Weather Forecast variable
  const wv = params.get('wv');
  if (wv && WV_CODE_TO_ID[wv]) data.weatherVar = WV_CODE_TO_ID[wv];

  // FEMA National Risk Index hazard — the NRI field prefix, lowercased
  const nr = params.get('nr')?.toUpperCase();
  if (nr && NRI_HAZARDS.some(h => h.id === nr)) data.nriHazard = nr;

  // Smoke opacity (integer percent, converted to a 0–1 factor)
  const so = params.get('so');
  if (so !== null && /^(?:100|[0-9]{1,2})$/.test(so)) data.smokeOpacity = Number(so) / 100;

  // Basemap
  const bm = params.get('bm');
  if (bm && BM_CODE_TO_TYPE[bm]) data.basemap = BM_CODE_TO_TYPE[bm];

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

  // Language
  const lang = params.get('lang');
  if (lang && isValidLocale(lang)) data.lang = lang;

  // Region
  const region = params.get('region');
  if (region && VALID_REGIONS.has(region)) data.region = region as LayerScope;
  // Map Experience — validated by shape only. Resolving the slug against the
  // catalogue here would pull all sixteen narratives into the initial bundle,
  // so a slug that no longer names a story is dropped by assets/experiences.ts
  // once the map is up. The pattern is still a trust boundary: the value is
  // written back into the link and used as a lookup key.
  const exp = params.get('exp');
  if (exp && /^[a-z0-9-]{1,64}$/.test(exp)) data.experienceId = exp;

  return data;
}

export function formatUrlState(data: UrlStateData): string[] {
  const parts: string[] = [];
  const dv = defaultView();

  // Layer visibility
  const lDelta: string[] = [];
  for (const entry of LAYERS) {
    if (!entry.urlCode) continue;
    const cur = !!data.layerVisibility[entry.id];
    if (cur !== dv.layerVisibility[entry.id]) lDelta.push((cur ? '' : '-') + entry.urlCode);
  }
  if (lDelta.length) parts.push('l=' + lDelta.join('.'));

  // Legend filters
  for (const cfg of LEGEND_FILTERS) {
    if (!cfg.groupCode) continue;
    const cur = data.legendFilters[cfg.key];
    if (!cur) continue;
    if (_setsEqual(cur, dv.legendFilters[cfg.key])) continue;
    const codes: string[] = [];
    for (const b of cfg.buckets) {
      if (b.urlCode && cur.has(b.id)) codes.push(b.urlCode);
    }
    parts.push(cfg.groupCode + '=' + codes.join(''));
  }

  // Layer bucket filters
  for (const [gc, { entry }] of Object.entries(_LAYER_BUCKET_CODE_MAP)) {
    const cur = data.layerFilters[entry.id];
    if (!cur || !entry.filterBuckets) continue;
    if (_setsEqual(cur, dv.layerFilters[entry.id])) continue;
    const codes = entry.filterBuckets
      .filter(b => b.urlCode && cur.has(b.id))
      .map(b => b.urlCode);
    parts.push(gc + '=' + codes.join(''));
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
    if (mode !== def) gmTokens.push(e.genModeCode + GM_MODE_TO_CHAR[mode]);
  }
  if (gmTokens.length) parts.push('gm=' + gmTokens.join('.'));

  // OGF color-by (default omitted)
  if (data.ogfColorBy && data.ogfColorBy !== dv.ogfColorBy && OC_MODE_TO_CHAR[data.ogfColorBy]) {
    parts.push('oc=' + OC_MODE_TO_CHAR[data.ogfColorBy]);
  }

  // WestTEC color-by (default omitted)
  if (data.westtecColorBy && data.westtecColorBy !== dv.westtecColorBy && WC_MODE_TO_CHAR[data.westtecColorBy]) {
    parts.push('wc=' + WC_MODE_TO_CHAR[data.westtecColorBy]);
  }

  // Weather Forecast variable (default omitted)
  if (data.weatherVar && data.weatherVar !== dv.weatherVar && WV_ID_TO_CODE[data.weatherVar]) {
    parts.push('wv=' + WV_ID_TO_CODE[data.weatherVar]);
  }

  // FEMA NRI hazard (default composite omitted)
  if (data.nriHazard && data.nriHazard !== dv.nriHazard) {
    parts.push('nr=' + data.nriHazard.toLowerCase());
  }

  // Smoke opacity (default 100% omitted)
  const smokePercent = Math.round(data.smokeOpacity * 100);
  if (smokePercent !== Math.round(dv.smokeOpacity * 100)) parts.push('so=' + smokePercent);

  // Basemap (default omitted)
  if (data.basemap !== dv.basemap) {
    const code = BM_TYPE_TO_CODE[data.basemap];
    if (code) parts.push('bm=' + code);
  }

  // Projection
  if (data.projection === 'globe') parts.push('pj=g');

  // 3D terrain / buildings (both off by default, omitted)
  const td = (data.terrain3d ? 't' : '') + (data.buildings3d ? 'b' : '');
  if (td) parts.push('3d=' + td);

  // Hillshade (off by default, omitted)
  if (data.hillshade) parts.push('hs=1');

  // Language (default 'en' omitted)
  if (data.lang && data.lang !== 'en') parts.push(`lang=${encodeURIComponent(data.lang)}`);

  // Region (default omitted)
  if (data.region && data.region !== dv.region && VALID_REGIONS.has(data.region)) {
    parts.push(`region=${encodeURIComponent(data.region)}`);
  }
  // Map Experience — always last, so url-state.ts can diff the parts above it
  // against the snapshot the experience left behind.
  if (data.experienceId) parts.push('exp=' + data.experienceId);

  return parts;
}
