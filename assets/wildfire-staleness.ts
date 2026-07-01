// ─── Live-wildfire staleness safety ───────────────────────────────────────────
// Role: auto-refresh the shared `wildfire-live` GeoJSON on an interval and, when
//       the data's pull age exceeds a hard cutoff, auto-disable every live
//       wildfire layer and warn the user with a full-screen modal. An explicit
//       "I understand the risk" action re-enables them.
// Source of truth for age = the `generated_utc` property on the first feature of
//       state.sourcesData["wildfire-live"] (same field the legend age chip uses).
// Deps: state (DATA, sourcesData, layerVisibility), visibility.ts
//       (setLayerVisibility — which itself writes URL state), ui/ui-legends.ts
//       (updateLegends). Modal DOM lives in index.html (#wildfireStaleDialog).
// Wired from ui/ui.ts init() via initWildfireStaleness().

import type { GeoJSONSource } from 'maplibre-gl';
import { state, DATA } from './state.js';
import { setLayerVisibility } from './visibility.js';
import { updateLegends } from './ui/ui-legends.js';

// Re-fetch the feed this often. The GitHub-Actions feed updates ~hourly, so a
// 15-minute poll picks up a new pull within a quarter-hour without hammering it.
export const WILDFIRE_REFRESH_MS = 15 * 60_000;   // 15 minutes
// Hard cutoff: above this pull age the data is treated as unsafe and the layers
// are force-disabled. 6h = several missed hourly cycles — clearly broken/stale.
export const WILDFIRE_MAX_AGE_MS = 6 * 60 * 60_000; // 6 hours

// All three live layers share the one `wildfire-live` source + file.
const WILDFIRE_LAYER_IDS = ["wildfire-live", "wildfire-smoke", "wildfire-incidents"];

// User clicked "re-enable" and is knowingly viewing stale data — suppresses
// re-prompting until the data goes fresh again (resets the override).
let acknowledged = false;
// Which layers we auto-disabled, so "re-enable" restores exactly those.
let disabledForStale: string[] = [];

function generatedUtc(): string | undefined {
  const f = state.sourcesData["wildfire-live"]?.[0] as GeoJSON.Feature | undefined;
  return f?.properties?.generated_utc as string | undefined;
}

// Pull age in ms (now − generated_utc), or null if unknown/unparseable.
function ageMs(): number | null {
  const ts = generatedUtc();
  if (!ts) return null;
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return null;
  return Date.now() - then;
}

function visibleWildfireLayers(): string[] {
  return WILDFIRE_LAYER_IDS.filter(id => state.layerVisibility[id]);
}

// Toggle a wildfire layer AND keep its panel checkbox in sync (setLayerVisibility
// only touches map + URL state, not the DOM checkbox).
function setWildfireLayer(id: string, on: boolean) {
  setLayerVisibility(id, on);
  const cb = document.querySelector<HTMLInputElement>(`input[type=checkbox][data-layer-id="${id}"]`);
  if (cb) cb.checked = on;
}

function fmtAge(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function showStaleModal(age: number) {
  const dlg = document.getElementById("wildfireStaleDialog") as HTMLDialogElement | null;
  if (!dlg) return;
  const ageEl = document.getElementById("wildfireStaleAge");
  if (ageEl) ageEl.textContent = fmtAge(age);
  if (!dlg.open) dlg.showModal();
}

// Core safety gate. Called after every (re)load of the feed and on the interval.
function checkStaleness() {
  const age = ageMs();
  if (age === null) return;
  if (age <= WILDFIRE_MAX_AGE_MS) {
    acknowledged = false;   // fresh again → a future staleness re-prompts
    return;
  }
  if (acknowledged) return;            // user already opted in — don't nag in a loop
  const on = visibleWildfireLayers();
  if (on.length === 0) return;          // nothing on screen → nothing unsafe to show
  disabledForStale = on;
  for (const id of on) setWildfireLayer(id, false);
  updateLegends();
  showStaleModal(age);
}

// Re-fetch the feed and push it onto the existing source. Cache-busts the
// service worker (same-origin dev) and the CDN/browser cache (cross-origin prod)
// so we never re-read a stale cached copy.
async function refetchWildfire(): Promise<void> {
  if (!state.map) return;
  const src = state.map.getSource("wildfire-live") as GeoJSONSource | undefined;
  if (!src) return;   // source not added yet (no wildfire layer ever enabled)
  const url = DATA.wildfire_live;
  try {
    const resp = await fetch(url, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const geojson = await resp.json();

    // Check if the data has actually changed by comparing generated_utc timestamps
    const currentGenerated = generatedUtc();
    const newGenerated = geojson.features?.[0]?.properties?.generated_utc as string | undefined;
    if (currentGenerated && newGenerated && currentGenerated === newGenerated) {
      return; // No change in data, skip updating map/UI
    }

    state.sourcesData["wildfire-live"] = geojson.features || [];
    src.setData(geojson);
    // Same event the legend age chip listens for → it (and checkStaleness) refresh.
    window.dispatchEvent(new CustomEvent('tm:layerdata', { detail: { registryId: "wildfire-live" } }));
  } catch (err) {
    console.warn('[TransmissionMap] wildfire auto-refresh failed', err);
  }
}

export function initWildfireStaleness() {
  // Modal actions.
  const dlg = document.getElementById("wildfireStaleDialog") as HTMLDialogElement | null;
  document.getElementById("wildfireStaleReenable")?.addEventListener("click", () => {
    acknowledged = true;   // knowingly accept stale data — suppress re-prompts
    for (const id of disabledForStale) setWildfireLayer(id, true);
    disabledForStale = [];
    updateLegends();
    dlg?.close();
  });
  document.getElementById("wildfireStaleDismiss")?.addEventListener("click", () => dlg?.close());

  // Re-check whenever fresh feed data lands — covers first load (page open with
  // already-stale data) and every successful auto-refresh / lazy enable.
  window.addEventListener("tm:layerdata", (e) => {
    if ((e as CustomEvent<{ registryId: string }>).detail?.registryId !== "wildfire-live") return;
    checkStaleness();
  });

  // A wildfire layer being manually (re-)enabled in the panel must be vetted too,
  // without waiting up to a full poll interval.
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element)?.closest<HTMLInputElement>("input[type=checkbox][data-layer-id]");
    if (cb?.checked && WILDFIRE_LAYER_IDS.includes(cb.dataset.layerId!)) checkStaleness();
  });

  // Poll: refetch (which dispatches tm:layerdata → checkStaleness) only while
  // something is actually on screen — no point polling for hidden layers.
  setInterval(() => {
    if (visibleWildfireLayers().length === 0) return;
    void refetchWildfire();
  }, WILDFIRE_REFRESH_MS);

  // Periodically check staleness while layers are visible, in case the time exceeds the threshold
  // without a new feed fetch/load.
  setInterval(() => {
    if (visibleWildfireLayers().length > 0) checkStaleness();
  }, 60_000);
}
