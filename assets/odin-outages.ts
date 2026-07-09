// ─── ODIN live county-outage feature-state join + refresh ─────────────────────
// Role: fetch the geometry-less ODIN snapshot (FIPS → [customers_out,
//       incident_count]) and join it onto the SHARED `county_boundaries` vector
//       source (owned by layers/layer-init.ts, promoteId=GEOID) via MapLibre
//       feature-state, under the namespaced keys `odin_out`/`odin_n` so other
//       county-keyed layers can share the same per-feature state bag. Feature-state only sticks to features in currently-loaded
//       tiles, so we keep the parsed snapshot in module scope and RE-APPLY it on
//       the source's `sourcedata` event, so panning/zooming into new tiles paints.
//       Refreshes every 15 min while the layer is visible; a snapshot older than
//       6 h is not painted (console warning only — deliberately no modal, unlike
//       wildfire-staleness.ts, which this must NOT touch/generalize).
// Source of truth for age = the snapshot's `generated_utc` (the legend chip too).
// Deps: state (map, DATA, layerVisibility). Legend age chip = #odinAge in index.html.
//       The map source/layers are built by layers/map-layers-hazards.ts
//       (addOdinOutages); the click popup reads numbers from odinSnapshot().
// Wired from ui/ui.ts init() via initOdinOutages().

import { state, DATA } from './state.js';
import { COUNTY_SRC as SRC, COUNTY_SRC_LAYER as SRC_LAYER } from './layers/layer-init.js';

const REGISTRY_ID = "odin-outages";

// 15-minute poll — the CI feed refreshes on a similar cadence; picks up a new
// snapshot within a quarter-hour without hammering raw.githubusercontent.com.
const REFRESH_MS = 15 * 60_000;
// Above this pull age the snapshot is treated as unsafe and NOT painted.
const MAX_AGE_MS = 6 * 60 * 60_000;   // 6 hours

// Parsed snapshot kept in module scope so `sourcedata` can re-apply it.
let snapshot: Record<string, [number, number]> = {};
// FIPS we currently have feature-state on, so a refresh can clear counties that
// dropped out of the new snapshot (else restored counties stay lit forever).
let appliedFips = new Set<string>();
let generatedUtc: string | undefined;
let inflight = false;

// Popup (popup-format.ts) reads the numbers for a clicked county from here as a
// fallback; the primary path merges feature-state in popup.ts.
export function odinSnapshot(): Record<string, [number, number]> {
  return snapshot;
}

// Apply the whole in-memory snapshot as feature-state. Idempotent + cheap
// (~few hundred counties), safe to call on every relevant tile load.
function applyJoin() {
  if (!state.map) return;
  if (!state.map.getSource(SRC)) return;
  for (const fips in snapshot) {
    const v = snapshot[fips];
    state.map.setFeatureState(
      { source: SRC, sourceLayer: SRC_LAYER, id: fips },
      { odin_out: v[0], odin_n: v[1] },
    );
  }
}

// Drop only OUR keys — the county's feature-state bag is shared with any other
// county-keyed layer, so a bare removeFeatureState(target) would wipe theirs too.
function clearFips(fips: string) {
  if (!state.map) return;
  const target = { source: SRC, sourceLayer: SRC_LAYER, id: fips };
  state.map.removeFeatureState(target, "odin_out");
  state.map.removeFeatureState(target, "odin_n");
}

// Unpaint everything we've painted (used when a snapshot goes stale).
function clearJoin() {
  for (const fips of appliedFips) clearFips(fips);
  appliedFips = new Set();
  snapshot = {};
}

async function refetch(): Promise<void> {
  if (!state.map || !state.map.getSource(SRC) || inflight) return;
  inflight = true;
  try {
    const resp = await fetch(DATA.odin_outages, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    const gen = data.generated_utc as string | undefined;

    // Staleness gate: stale data is never painted. If a feed dies while the tab
    // is open we must also UNPAINT what's already there — otherwise the map goes
    // on showing hours-old outages while the legend quietly says "stale".
    const then = gen ? Date.parse(gen) : NaN;
    if (!Number.isNaN(then) && Date.now() - then > MAX_AGE_MS) {
      console.warn("[TransmissionMap] ODIN snapshot is stale (>6h) — not painting", gen);
      clearJoin();
      generatedUtc = gen;
      renderOdinAge();
      return;
    }

    const next = (data.counties || {}) as Record<string, [number, number]>;
    // Clear feature-state for counties that dropped out of the new snapshot.
    for (const fips of appliedFips) {
      if (!(fips in next)) clearFips(fips);
    }
    snapshot = next;
    appliedFips = new Set(Object.keys(next));
    generatedUtc = gen;
    applyJoin();
    renderOdinAge();
  } catch (err) {
    console.warn("[TransmissionMap] ODIN refresh failed", err);
  } finally {
    inflight = false;
  }
}

// ── Legend age chip ("updated 12 min ago") ────────────────────────────────────
function renderOdinAge() {
  const el = document.getElementById("odinAge");
  if (!el) return;
  if (!generatedUtc) { el.textContent = ""; return; }
  const then = Date.parse(generatedUtc);
  if (Number.isNaN(then)) { el.textContent = ""; return; }
  const min = Math.max(0, Math.round((Date.now() - then) / 60_000));
  el.textContent =
    min < 1    ? "updated just now"
    : min < 60   ? `updated ${min} min ago`
    : min < 1440 ? `updated ${Math.round(min / 60)}h ago`
    :              `updated ${Math.round(min / 1440)}d ago`;
  const stale = Date.now() - then > MAX_AGE_MS;
  el.className = "legend-age legend-age--" + (stale ? "stale" : min <= 60 ? "fresh" : "aging");
}

function isVisible(): boolean {
  return !!state.layerVisibility[REGISTRY_ID];
}

export function initOdinOutages() {
  if (!state.map) return;

  // Re-apply the join whenever the source finishes (re)loading tiles — feature
  // state only sticks to features present in currently-loaded tiles. This also
  // covers the first paint: when the layer is enabled (user toggle or URL
  // restore) the source starts loading its tiles → this fires → if we have no
  // snapshot yet and the layer is visible, kick off the first fetch.
  state.map.on("sourcedata", (e) => {
    const ev = e as { sourceId?: string; isSourceLoaded?: boolean };
    if (ev.sourceId !== SRC || !ev.isSourceLoaded) return;
    if (Object.keys(snapshot).length) { applyJoin(); return; }
    if (isVisible() && !inflight) void refetch();
  });

  // Enabling the layer's panel checkbox fetches immediately (in parallel with
  // tile loading) rather than waiting on the first `sourcedata`.
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element | null)?.closest<HTMLInputElement>(
      `input[type=checkbox][data-layer-id="${REGISTRY_ID}"]`);
    if (cb?.checked) void refetch();
  });

  // URL-restored default-on (or already-visible) at load time.
  if (isVisible()) void refetch();

  // Poll only while something is on screen — no point refetching for a hidden layer.
  setInterval(() => { if (isVisible()) void refetch(); }, REFRESH_MS);
  // Keep the displayed age honest while the page sits open.
  setInterval(renderOdinAge, 60_000);
}
