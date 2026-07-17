// ─── NWS zone-alert feature-state join (phase 2) ───────────────────────────────
// Role: join the `zone_alerts` sidecar emitted by scripts/fetch_nws_alerts.py
//       (null-geometry curated US alerts, keyed by NWS zone (type,ugc) and/or
//       county FIPS) onto TWO vector sources via MapLibre feature-state under
//       the namespaced keys `nws_group`/`nws_sev`:
//         - `nws_zones` pmtiles (own source, lazy-added here; fill+line layers
//           `nws-zone-fill`/`nws-zone-line`, gated visible only when the
//           `nws-alerts` registry layer is on) — promoteId "key", where `key`
//           is a tile property computed in scripts/extract_nws_zones.py as
//           "z"+ugc (type=forecast) / "f"+ugc (type=fire) / "m"+ugc (type=marine). Bare ugc collides
//           across the two zone sets (3016 codes shared, different geometry),
//           so the join key is (type,ugc) via that single-char-prefixed
//           `key` string — a load-bearing contract with extract_nws_zones.py
//           and tile_manifest.yaml's nws_zones `select`.
//         - the SHARED `county_boundaries` source (owned by layers/layer-init.ts,
//           ensureCountyBoundaries(), promoteId=GEOID) — for `/zones/county/`
//           alerts whose `fips` join county GEOID; rendered here via
//           `nws-county-fill`/`nws-county-line` (same paint pattern as the
//           zone pair, source-layer COUNTY_SRC_LAYER).
//       Several alerts can hit one zone/county; precedence = severity rank
//       (Extreme>Severe>Moderate>Minor>unknown), tie-break earliest `ends`.
//       The popup lookup index is keyed by exact (type,ugc), same
//       as the feature-state join, so a click on one polygon lists only the
//       alerts that actually named that zone type.
//       Legend-chip gating: property filters can't see feature-state,
//       so the nwsGroup legend chips (assets/filters.ts applyNwsGroupFilter)
//       call setZoneGroupFilter() here, which recomputes the winner among
//       ONLY the alerts matching the active groups and repaints feature-state
//       (a county with Flood+RedFlag recolors to fire under the fire chip,
//       never disappears); features with no matching alert are unpainted.
//       `nws_multi` feature-state flags >1 matching alert and thickens the
//       outline.
// Deps: state (map, DATA, layerVisibility), layers/layer-init.ts
//       (ensureCountyBoundaries, COUNTY_SRC/COUNTY_SRC_LAYER, pmtilesUrl,
//       initialVisibility), src/colors/buckets.ts (NWS_GROUP_BUCKETS — same
//       palette map-layers-conditions.ts's NWS_GROUP_COLOR paints the storm
//       polygons with; reused here, not duplicated).
// Wired from ui/ui.ts init() via initNwsZoneJoin(), which listens for the
//       `tm:layerdata` event (registryId "nws-alerts") dispatched by
//       nws-staleness.ts's refresh factory and does its OWN fetch of
//       DATA.nws_alerts to read the top-level `zone_alerts` sidecar (that
//       field is stripped off before the polygon features are cached into
//       state.sourcesData, so it isn't available from that path). This is a
//       small redundant fetch on the same ~5 min cadence; the shared
//       live-staleness.ts/layer-init.ts fetch paths are left untouched.
// Staleness wiring (in nws-staleness.ts): the kill-switch watches
//       #nwsStaleDialog's `open` attribute via MutationObserver and calls
//       clearZoneAlerts() the moment the modal opens (no callback hook exists
//       on live-staleness.ts's factory). Expiry pruning reuses the polygon prune tick: this
//       module exports pruneExpiredZoneAlerts(), called from nws-staleness.ts's
//       pruneExpiredAlerts() (which the shared factory invokes on every prune
//       point — post-refetch, initial tm:layerdata load, and the 60s tick),
//       so joined zones/counties expire on the same cadence as the polygons.

import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';
import { state, DATA } from './state.js';
import {
  ensureCountyBoundaries, COUNTY_SRC, COUNTY_SRC_LAYER, pmtilesUrl, initialVisibility,
} from './layers/layer-init.js';
import { NWS_GROUP_BUCKETS } from '../src/colors/buckets.js';

export const ZONE_SRC = "nws_zones";
export const ZONE_SRC_LAYER = "nws_zones";

export interface ZoneAlertEntry {
  zones: [string, string][];   // [type, ugc] (e.g., "forecast", "fire", "marine")
  fips: string[];
  event: string;
  severity?: string;
  certainty?: string;
  urgency?: string;
  headline?: string;
  onset?: string;
  ends?: string;
  expires?: string;
  areaDesc?: string;
  senderName?: string;
  id: string;
  _group: string;
}

// ── Severity precedence ────────────────────────────────────────────────────
const SEV_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
function sevRank(sev?: string): number {
  return sev ? (SEV_RANK[sev] ?? 0) : 0;
}
function endsMs(e: ZoneAlertEntry): number {
  const t = e.ends ? Date.parse(e.ends) : NaN;
  return Number.isNaN(t) ? Infinity : t;
}
// Highest severity wins; ties broken by earliest `ends`.
function pickWinner(entries: ZoneAlertEntry[]): ZoneAlertEntry {
  return entries.reduce((best, e) => {
    const r = sevRank(e.severity), br = sevRank(best.severity);
    if (r !== br) return r > br ? e : best;
    return endsMs(e) < endsMs(best) ? e : best;
  });
}

// ── Colors, reused from the same palette map-layers-conditions.ts paints the
//    storm-polygon layer with (do not hand-roll hex values here). ──────────
const OTHER_COLOR = NWS_GROUP_BUCKETS.find(b => b.id === "other")?.color ?? "#9ca3af";

// feature-state-driven color expression (vs. NWS_GROUP_COLOR's `["get","_group"]`
// used by the storm-polygon layer — this reads the joined feature-state instead).
const ZONE_GROUP_COLOR: ExpressionSpecification = [
  "match", ["feature-state", "nws_group"],
  ...NWS_GROUP_BUCKETS.flatMap(b => [b.id, b.color]),
  OTHER_COLOR,
] as unknown as ExpressionSpecification;

// ── Indexes for the popup ───────────────────────────────────────────────────
// Exact (type,ugc) -> entries that explicitly named that zone.
let zoneIndex = new Map<string, ZoneAlertEntry[]>();
// fips -> entries.
let fipsIndex = new Map<string, ZoneAlertEntry[]>();
// tile `key` ("z"/"f"+ugc, i.e. (type,ugc)) -> entries, used to compute the
// feature-state winner per exact zone (same keying as zoneIndex, just tile-
// key-shaped for setFeatureState/removeFeatureState targets).
let keyGroups = new Map<string, ZoneAlertEntry[]>();

function zoneKey(type: string, ugc: string): string {
  return `${type}|${ugc}`;
}

// The tile `key` property extract_nws_zones.py computes: single-char type
// prefix + ugc. Load-bearing contract — keep in sync with that script.
function tileKey(type: string, ugc: string): string {
  return `${type === "fire" ? "f" : type === "marine" ? "m" : "z"}${ugc}`;
}

// Feature ids we currently hold feature-state on, so a refresh (or clear) can
// unpaint exactly what we painted last time — never a bare removeFeatureState
// (the county source's state bag is shared with odin-outages.ts).
let appliedKeys = new Set<string>();
let appliedFips = new Set<string>();

export function lookupByZone(type: string, ugc: string): ZoneAlertEntry[] {
  return zoneIndex.get(zoneKey(type, ugc)) ?? [];
}
export function lookupByFips(fips: string): ZoneAlertEntry[] {
  return fipsIndex.get(fips) ?? [];
}

// Fill/line opacity expressions — the null-guard so unlit features (no joined
// alert passing the active legend filter) stay invisible. Filtering is done in
// JS at repaint time (winner recomputed among matching alerts, non-matching
// features unpainted), so these expressions never change.
const DEFAULT_FILL_OPACITY: ExpressionSpecification = [
  "case", ["==", ["feature-state", "nws_group"], null], 0, 0.12,
] as unknown as ExpressionSpecification;
const DEFAULT_LINE_OPACITY: ExpressionSpecification = [
  "case", ["==", ["feature-state", "nws_group"], null], 0, 0.6,
] as unknown as ExpressionSpecification;
// >1 matching alert on the polygon → thicker outline cue.
const MULTI_LINE_WIDTH: ExpressionSpecification = [
  "case", ["to-boolean", ["feature-state", "nws_multi"]], 2.5, 1,
] as unknown as ExpressionSpecification;

const ZONE_FILL_LAYERS = ["nws-zone-fill", "nws-county-fill"];
const ZONE_LINE_LAYERS = ["nws-zone-line", "nws-county-line"];

// ── Lazy source/layer creation (idempotent — safe to call on every apply) ──
function ensureZoneLayers() {
  if (!state.map) return;
  if (!state.map.getSource(ZONE_SRC)) {
    state.map.addSource(ZONE_SRC, {
      type: "vector",
      url: pmtilesUrl(DATA.nws_zones),
      promoteId: { [ZONE_SRC_LAYER]: "key" },
    });
  }
  ensureCountyBoundaries();
  const vis = initialVisibility("nws-alerts");
  // These layers lazy-add on first data load, which would land them on top of
  // the whole stack — anchor below the storm-polygon layer instead so all
  // area fills stay under infra lines/points (z-order design rule).
  const before = state.map.getLayer("nws-alerts-fill") ? "nws-alerts-fill" : undefined;
  // Fill opacity is lower than the storm-polygon layer's 0.25 — these are
  // approximate zone-area fills, not storm-drawn polygons.
  const fillPaint = { "fill-color": ZONE_GROUP_COLOR, "fill-opacity": DEFAULT_FILL_OPACITY };
  const linePaint = { "line-color": ZONE_GROUP_COLOR, "line-width": MULTI_LINE_WIDTH,
                      "line-opacity": DEFAULT_LINE_OPACITY };
  const specs = [
    { id: "nws-zone-fill",   type: "fill", source: ZONE_SRC,   srcLayer: ZONE_SRC_LAYER,   paint: fillPaint },
    { id: "nws-zone-line",   type: "line", source: ZONE_SRC,   srcLayer: ZONE_SRC_LAYER,   paint: linePaint },
    { id: "nws-county-fill", type: "fill", source: COUNTY_SRC, srcLayer: COUNTY_SRC_LAYER, paint: fillPaint },
    { id: "nws-county-line", type: "line", source: COUNTY_SRC, srcLayer: COUNTY_SRC_LAYER, paint: linePaint },
  ];
  for (const s of specs) {
    if (state.map.getLayer(s.id)) continue;
    state.map.addLayer({
      id: s.id,
      type: s.type,
      source: s.source,
      "source-layer": s.srcLayer,
      layout: { visibility: vis },
      paint: s.paint,
    } as LayerSpecification, before);
  }
}

function syncZoneVisibility() {
  if (!state.map) return;
  const vis = initialVisibility("nws-alerts");
  for (const id of [...ZONE_FILL_LAYERS, ...ZONE_LINE_LAYERS]) {
    if (state.map.getLayer(id)) state.map.setLayoutProperty(id, "visibility", vis);
  }
}

// ── Legend-chip gating ──────────────────────────────────────────────────────
// null = all groups on. A list = only those groups count: the winner is
// recomputed among matching alerts and non-matching features are unpainted,
// so the paint expressions themselves never change.
let activeGroupFilter: string[] | null = null;

function matchesFilter(e: ZoneAlertEntry): boolean {
  return activeGroupFilter === null || activeGroupFilter.includes(e._group);
}

// Called by assets/filters.ts applyNwsGroupFilter() with the active nwsGroup
// bucket ids (or null for "all groups on"). Property filters (setFilter)
// can't see feature-state, so this re-runs the feature-state join with the
// filter applied instead.
export function setZoneGroupFilter(active: string[] | null): void {
  activeGroupFilter = active;
  repaint();
}

// True when a zone/county feature is actually painted (non-zero opacity):
// repaint() only writes nws_group for features with a filter-matching alert,
// so a null check suffices. Used by popup.ts to drop hit-test matches on
// transparent features.
export function zoneFeatureLit(featureState: Record<string, unknown> | undefined): boolean {
  return featureState?.nws_group != null;
}

// ── Feature-state clear (namespaced — NEVER a bare removeFeatureState) ─────
const ZONE_TGT   = { source: ZONE_SRC,   sourceLayer: ZONE_SRC_LAYER };
const COUNTY_TGT = { source: COUNTY_SRC, sourceLayer: COUNTY_SRC_LAYER };

function clearFeature(tgt: typeof ZONE_TGT, id: string) {
  if (!state.map) return;
  const target = { ...tgt, id };
  state.map.removeFeatureState(target, "nws_group");
  state.map.removeFeatureState(target, "nws_sev");
  state.map.removeFeatureState(target, "nws_multi");
}
const clearKey  = (key: string)  => clearFeature(ZONE_TGT, key);
const clearFips = (fips: string) => clearFeature(COUNTY_TGT, fips);

// Removes ONLY this module's feature-state keys, from both sources.
export function clearZoneAlerts() {
  for (const key of appliedKeys) clearKey(key);
  for (const fips of appliedFips) clearFips(fips);
  appliedKeys = new Set();
  appliedFips = new Set();
  zoneIndex = new Map();
  fipsIndex = new Map();
  keyGroups = new Map();
}

// ── Expiry pruning ──────────────────────────────────────────────────────────
// Mirrors nws-staleness.ts's polygon pruneExpiredAlerts EXACTLY, including
// key order — `ends` (fallback `expires`) — so a zone never outlives its
// storm polygon; entries with no parseable time are kept (fail open, same
// as the polygon path). Called on the same prune tick as the polygon layer
// so a joined zone/county never lags up to a full poll cycle stale.
function isExpired(entry: ZoneAlertEntry, now: number): boolean {
  const end = entry.ends ?? entry.expires;
  if (!end) return false;
  const t = Date.parse(end);
  return !Number.isNaN(t) && t < now;
}

export function pruneExpiredZoneAlerts(nowMs: number = Date.now()): void {
  if (!appliedKeys.size && !appliedFips.size && !zoneIndex.size && !fipsIndex.size) return;

  let removed = false;
  const nextZoneIndex = new Map<string, ZoneAlertEntry[]>();
  for (const [key, entries] of zoneIndex) {
    const kept = entries.filter(e => !isExpired(e, nowMs));
    if (kept.length !== entries.length) removed = true;
    if (kept.length) nextZoneIndex.set(key, kept);
  }
  const nextFipsIndex = new Map<string, ZoneAlertEntry[]>();
  for (const [fips, entries] of fipsIndex) {
    const kept = entries.filter(e => !isExpired(e, nowMs));
    if (kept.length !== entries.length) removed = true;
    if (kept.length) nextFipsIndex.set(fips, kept);
  }
  const nextKeyGroups = new Map<string, ZoneAlertEntry[]>();
  for (const [key, entries] of keyGroups) {
    const kept = entries.filter(e => !isExpired(e, nowMs));
    if (kept.length) nextKeyGroups.set(key, kept);
  }

  if (!removed) return;

  // Clear keys/fips that dropped out entirely, same as applyZoneAlerts.
  for (const key of appliedKeys) if (!nextKeyGroups.has(key)) clearKey(key);
  for (const fips of appliedFips) if (!nextFipsIndex.has(fips)) clearFips(fips);

  zoneIndex = nextZoneIndex;
  fipsIndex = nextFipsIndex;
  keyGroups = nextKeyGroups;
  appliedKeys = new Set(nextKeyGroups.keys());
  appliedFips = new Set(nextFipsIndex.keys());

  repaint();
}

function paintFeature(tgt: typeof ZONE_TGT, id: string, kept: ZoneAlertEntry[]) {
  if (!state.map) return;
  const winner = pickWinner(kept);
  state.map.setFeatureState(
    { ...tgt, id },
    { nws_group: winner._group, nws_sev: winner.severity ?? null, nws_multi: kept.length > 1 },
  );
}
const paintKey  = (key: string,  kept: ZoneAlertEntry[]) => paintFeature(ZONE_TGT, key, kept);
const paintFips = (fips: string, kept: ZoneAlertEntry[]) => paintFeature(COUNTY_TGT, fips, kept);

// Re-paint everything from the current indexes, applying the active legend
// filter: winner picked among matching alerts only; features whose alerts
// all fail the filter are unpainted (cleared). Feature-state only sticks to
// features present in currently-loaded tiles, so callers re-invoke this on
// `sourcedata` the same way odin-outages.ts does (see initNwsZoneJoin).
function repaint() {
  if (!state.map) return;
  for (const [key, entries] of keyGroups) {
    const kept = entries.filter(matchesFilter);
    if (kept.length) paintKey(key, kept); else clearKey(key);
  }
  for (const [fips, entries] of fipsIndex) {
    const kept = entries.filter(matchesFilter);
    if (kept.length) paintFips(fips, kept); else clearFips(fips);
  }
}

// ── Main entry point: apply a freshly-fetched alerts FeatureCollection ─────
export function applyZoneAlerts(fc: { zone_alerts?: ZoneAlertEntry[] } | null | undefined) {
  if (!state.map) return;
  const entries = fc?.zone_alerts ?? [];
  if (!entries.length) { clearZoneAlerts(); return; }

  ensureZoneLayers();
  ensureCountyBoundaries();

  const nextZoneIndex = new Map<string, ZoneAlertEntry[]>();
  const nextFipsIndex = new Map<string, ZoneAlertEntry[]>();
  const nextKeyGroups = new Map<string, ZoneAlertEntry[]>();

  for (const entry of entries) {
    for (const [type, ugc] of entry.zones ?? []) {
      const zk = zoneKey(type, ugc);
      const tk = tileKey(type, ugc);
      (nextZoneIndex.get(zk) ?? nextZoneIndex.set(zk, []).get(zk)!).push(entry);
      (nextKeyGroups.get(tk) ?? nextKeyGroups.set(tk, []).get(tk)!).push(entry);
    }
    for (const fips of entry.fips ?? []) {
      (nextFipsIndex.get(fips) ?? nextFipsIndex.set(fips, []).get(fips)!).push(entry);
    }
  }

  // Clear keys/fips that dropped out of the new snapshot (else they'd stay
  // painted forever, same trap odin-outages.ts guards against).
  for (const key of appliedKeys) if (!nextKeyGroups.has(key)) clearKey(key);
  for (const fips of appliedFips) if (!nextFipsIndex.has(fips)) clearFips(fips);

  zoneIndex = nextZoneIndex;
  fipsIndex = nextFipsIndex;
  keyGroups = nextKeyGroups;
  appliedKeys = new Set(nextKeyGroups.keys());
  appliedFips = new Set(nextFipsIndex.keys());

  repaint();
  syncZoneVisibility();
}

// ── Wiring: refetch DATA.nws_alerts (for the zone_alerts sidecar) whenever
//    the polygon layer's own refresh factory lands fresh data, and re-paint
//    on tile (re)load the same way odin-outages.ts does. ───────────────────
let inflight = false;
// Exported for nws-staleness.ts: the kill-switch modal's "re-enable" button
// must restore the zone/county join that clearZoneAlerts() wiped when the
// modal opened (the shared factory only restores the polygon layers, and its
// monotonic generated_utc dedup means no tm:layerdata will re-fire for the
// same stale snapshot).
export async function refetchZoneAlerts(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const resp = await fetch(DATA.nws_alerts, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const fc = await resp.json();
    applyZoneAlerts(fc);
  } catch (err) {
    console.warn("[TransmissionMap] NWS zone-alert refresh failed", err);
  } finally {
    inflight = false;
  }
}

export function initNwsZoneJoin() {
  if (!state.map) return;

  window.addEventListener("tm:layerdata", (e) => {
    const registryId = (e as CustomEvent<{ registryId: string }>).detail?.registryId;
    if (registryId !== "nws-alerts") return;
    void refetchZoneAlerts();
  });

  // Re-apply feature-state whenever either source finishes (re)loading tiles.
  state.map.on("sourcedata", (e) => {
    const ev = e as { sourceId?: string; isSourceLoaded?: boolean };
    if (!ev.isSourceLoaded) return;
    if (ev.sourceId === ZONE_SRC || ev.sourceId === COUNTY_SRC) repaint();
  });

  // Keep the zone fill/line layers' visibility synced to the nws-alerts
  // checkbox instantly, rather than waiting on the next data refresh.
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element | null)?.closest<HTMLInputElement>(
      `input[type=checkbox][data-layer-id="nws-alerts"]`);
    if (cb) syncZoneVisibility();
  });
}
