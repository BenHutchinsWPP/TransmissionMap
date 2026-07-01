// ─── URL State Codec ──────────────────────────────────────────────────────────
// Pure functions for serializing/deserializing app state to/from URL params.
// Does NOT touch global state or location/history.

import { LAYERS } from '../src/registry/index.js';
import { LEGEND_FILTERS, legendAllIds } from './ui/ui-legends.js';
import { MW_SLIDER_MAX } from './filters.js';

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

const BM_CODE_TO_TYPE: Record<string, string> = { l: "light", d: "dark", v: "voyager", t: "topo", a: "aerial" };
const BM_TYPE_TO_CODE: Record<string, string> = { light: "l", dark: "d", voyager: "v", topo: "t", aerial: "a" };
const GM_CHAR_TO_MODE: Record<string, string> = { i: "icons", h: "heat", b: "both" };
const GM_MODE_TO_CHAR: Record<string, string> = { icons: "i", heat: "h", both: "b" };

export interface UrlStateData {
  layerVisibility: Record<string, boolean>;
  legendFilters: Record<string, Set<string>>;
  layerFilters: Record<string, Set<string>>;
  mwFilter: { min: number; max: number };
  yearFilter: { enabled: boolean; year: number };
  genMode: Record<string, string>;
  basemap: string;
  projection: string;
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

  // Basemap
  const bm = params.get('bm');
  if (bm && BM_CODE_TO_TYPE[bm]) data.basemap = BM_CODE_TO_TYPE[bm];

  // Projection (default mercator; only 'g' = globe persisted)
  if (params.get('pj') === 'g') data.projection = 'globe';

  return data;
}

export function formatUrlState(data: UrlStateData): string[] {
  const parts: string[] = [];

  // Layer visibility
  const lDelta: string[] = [];
  for (const entry of LAYERS) {
    if (!entry.urlCode) continue;
    const cur = !!data.layerVisibility[entry.id];
    const def = !!entry.defaultOn;
    if (cur !== def) lDelta.push((cur ? '' : '-') + entry.urlCode);
  }
  if (lDelta.length) parts.push('l=' + lDelta.join('.'));

  // Legend filters
  for (const cfg of LEGEND_FILTERS) {
    if (!cfg.groupCode) continue;
    const cur = data.legendFilters[cfg.key];
    if (!cur) continue;
    const def = new Set(cfg.defaultActive ?? legendAllIds(cfg));
    if (_setsEqual(cur, def)) continue;
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
    const def = new Set(entry.filterBuckets.filter(b => b.default !== false).map(b => b.id));
    if (_setsEqual(cur, def)) continue;
    const codes = entry.filterBuckets
      .filter(b => b.urlCode && cur.has(b.id))
      .map(b => b.urlCode);
    parts.push(gc + '=' + codes.join(''));
  }

  // MW and Year filters
  const { min, max } = data.mwFilter;
  if (min !== 0 || max !== MW_SLIDER_MAX) parts.push('mw=' + min + '-' + max);
  if (data.yearFilter && data.yearFilter.enabled) parts.push('y=' + data.yearFilter.year);

  // Gen mode
  const gmTokens: string[] = [];
  for (const e of LAYERS) {
    if (!e.genModeCode) continue;
    const mode = data.genMode[e.id] || "icons";
    if (mode !== "icons") gmTokens.push(e.genModeCode + GM_MODE_TO_CHAR[mode]);
  }
  if (gmTokens.length) parts.push('gm=' + gmTokens.join('.'));

  // Basemap
  if (data.basemap !== 'street') {
    const code = BM_TYPE_TO_CODE[data.basemap];
    if (code) parts.push('bm=' + code);
  }

  // Projection
  if (data.projection === 'globe') parts.push('pj=g');

  return parts;
}
