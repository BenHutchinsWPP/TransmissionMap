// ─── Live-layer staleness safety (shared factory) ─────────────────────────────
// Role: shared factory for live-feed safety behavior.
//       Auto-refreshes a shared live GeoJSON source on an interval (and on
//       return-to-page, since mobile browsers freeze timers in background
//       tabs) and, when the data's pull age exceeds a hard cutoff, auto-
//       disables every layer sharing that source and warns the user with a
//       full-screen modal. An explicit "I understand the risk" action
//       re-enables them. Optionally prunes expired features (e.g. NWS alerts
//       past their `ends`/`expires` time) before every setData.
// Source of truth for age = the `generated_utc` property on the first
//       feature of state.sourcesData[cfg.sourceKey], falling back to the
//       FeatureCollection-level `generated_utc` stashed in
//       state.liveFcMeta[cfg.sourceKey] (needed when `features` is empty).
// Deps: state (DATA via cfg.dataUrl, sourcesData, layerVisibility),
//       visibility.ts (setLayerVisibility — which itself writes URL state),
//       ui/ui-legends.ts (updateLegends). Modal DOM ids come from cfg.
// Instantiated per live layer: wildfire-staleness.ts, nws-staleness.ts.

import type { GeoJSONSource } from 'maplibre-gl';
import { state } from './state.js';
import { setLayerVisibility } from './visibility.js';
import { updateLegends } from './ui/ui-legends.js';

// Age → short human string ("42m", "3h 5m", "2d 1h"). Shared by the stale
// modal below and the hand-rolled age chips (weather-live.ts).
export function fmtAge(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Largest-unit-only variant ("42m", "3h", "2d") for the legend age chips,
// where every character widens the whole legend. Detail belongs in the title.
export function fmtAgeShort(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export interface LiveStalenessConfig {
  sourceKey: string;            // registry id = sourcesData key = MapLibre source id
  layerIds: string[];           // registry layer ids sharing the source (checkbox/visibility ids)
  dataUrl: () => string;        // feed URL getter (reads DATA at call time)
  refreshMs: number;
  maxAgeMs: number;
  dialogId: string;
  ageElId: string;
  reenableId: string;
  dismissId: string;
  // Optional: filter out expired features. Applied before every setData
  // (post-refetch and on the 60s staleness tick) and on the initial
  // tm:layerdata lazy-load path.
  pruneExpired?: (features: GeoJSON.Feature[]) => GeoJSON.Feature[];
}

export function initLiveStaleness(cfg: LiveStalenessConfig): void {
  const {
    sourceKey, layerIds, dataUrl, refreshMs, maxAgeMs,
    dialogId, ageElId, reenableId, dismissId, pruneExpired,
  } = cfg;

  // User clicked "re-enable" and is knowingly viewing stale data — suppresses
  // re-prompting until the data goes fresh again (resets the override).
  let acknowledged = false;
  // Which layers we auto-disabled, so "re-enable" restores exactly those.
  let disabledForStale: string[] = [];

  function generatedUtc(): string | undefined {
    const f = state.sourcesData[sourceKey]?.[0] as GeoJSON.Feature | undefined;
    return (f?.properties?.generated_utc as string | undefined)
      ?? state.liveFcMeta[sourceKey]?.generated_utc;
  }

  // Pull age in ms (now − generated_utc), or null if unknown/unparseable.
  function ageMs(): number | null {
    const ts = generatedUtc();
    if (!ts) return null;
    const then = Date.parse(ts);
    if (Number.isNaN(then)) return null;
    return Date.now() - then;
  }

  function visibleLayers(): string[] {
    return layerIds.filter(id => state.layerVisibility[id]);
  }

  // Toggle a layer AND keep its panel checkbox in sync (setLayerVisibility
  // only touches map + URL state, not the DOM checkbox).
  function setLayer(id: string, on: boolean) {
    setLayerVisibility(id, on);
    const cb = document.querySelector<HTMLInputElement>(`input[type=checkbox][data-layer-id="${id}"]`);
    if (cb) cb.checked = on;
  }

  function showStaleModal(age: number) {
    const dlg = document.getElementById(dialogId) as HTMLDialogElement | null;
    if (!dlg) return;
    const ageEl = document.getElementById(ageElId);
    if (ageEl) ageEl.textContent = fmtAge(age);
    if (!dlg.open) dlg.showModal();
  }

  // Core safety gate. Called after every (re)load of the feed and on the interval.
  function checkStaleness() {
    const age = ageMs();
    if (age === null) return;
    if (age <= maxAgeMs) {
      acknowledged = false;   // fresh again → a future staleness re-prompts
      return;
    }
    if (acknowledged) return;            // user already opted in — don't nag in a loop
    const on = visibleLayers();
    if (on.length === 0) return;          // nothing on screen → nothing unsafe to show
    disabledForStale = on;
    for (const id of on) setLayer(id, false);
    updateLegends();
    showStaleModal(age);
  }

  // Re-fetch the feed and push it onto the existing source. Cache-busts the
  // service worker (same-origin dev) and the CDN/browser cache (cross-origin prod)
  // so we never re-read a stale cached copy.
  let lastFetchMs = 0;   // last refetch attempt — guards the return-to-page path
  let inflight = false;  // concurrent-call guard (interval + visibilitychange + pageshow)

  async function refetchLive(): Promise<void> {
    if (!state.map) return;
    const src = state.map.getSource(sourceKey) as GeoJSONSource | undefined;
    if (!src) return;   // source not added yet (no layer ever enabled)
    if (inflight) return; // already fetching
    inflight = true;
    lastFetchMs = Date.now();
    const url = dataUrl();
    try {
      const resp = await fetch(url, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const geojson = await resp.json();

      // Check if the data has actually changed by comparing generated_utc timestamps
      const currentGenerated = generatedUtc();
      const newGenerated = (geojson.features?.[0]?.properties?.generated_utc as string | undefined)
        ?? (geojson.generated_utc as string | undefined);
      if (currentGenerated && newGenerated && newGenerated <= currentGenerated) {
        return; // Skip if new data is not fresher (monotonic dedup)
      }

      let features: GeoJSON.Feature[] = geojson.features || [];
      if (pruneExpired) features = pruneExpired(features);
      state.sourcesData[sourceKey] = features;
      if (geojson.generated_utc !== undefined || geojson.feed_status !== undefined) {
        state.liveFcMeta[sourceKey] = {
          generated_utc: geojson.generated_utc as string | undefined,
          feed_status: geojson.feed_status as Record<string, string> | undefined,
          feed_last_ok: geojson.feed_last_ok as Record<string, string | null> | undefined,
        };
      }
      src.setData({ ...geojson, features });
      // Same event the legend age chip listens for → it (and checkStaleness) refresh.
      window.dispatchEvent(new CustomEvent('tm:layerdata', { detail: { registryId: sourceKey } }));
    } catch (err) {
      console.warn(`[TransmissionMap] ${sourceKey} auto-refresh failed`, err);
    } finally {
      inflight = false;
    }
  }

  // Modal actions.
  const dlg = document.getElementById(dialogId) as HTMLDialogElement | null;
  document.getElementById(reenableId)?.addEventListener("click", () => {
    acknowledged = true;   // knowingly accept stale data — suppress re-prompts
    for (const id of disabledForStale) setLayer(id, true);
    disabledForStale = [];
    updateLegends();
    dlg?.close();
  });
  document.getElementById(dismissId)?.addEventListener("click", () => dlg?.close());

  // Prune expired features in place and push the result to the map source.
  // No re-dispatch of tm:layerdata — avoids a loop.
  const pruneAndSetData = () => {
    if (!pruneExpired || !state.map) return;
    const current = state.sourcesData[sourceKey] as GeoJSON.Feature[] | undefined;
    if (!current) return;
    const pruned = pruneExpired(current);
    if (pruned.length !== current.length) {
      state.sourcesData[sourceKey] = pruned;
      const src = state.map.getSource(sourceKey) as GeoJSONSource | undefined;
      if (src) src.setData({ type: "FeatureCollection", features: pruned });
    }
  };

  // Re-check whenever fresh feed data lands — covers first load (page open with
  // already-stale data) and every successful auto-refresh / lazy enable.
  window.addEventListener("tm:layerdata", (e) => {
    if ((e as CustomEvent<{ registryId: string }>).detail?.registryId !== sourceKey) return;
    pruneAndSetData();
    checkStaleness();
  });

  // A layer being manually (re-)enabled in the panel must be vetted too,
  // without waiting up to a full poll interval.
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element)?.closest<HTMLInputElement>("input[type=checkbox][data-layer-id]");
    if (cb?.checked && layerIds.includes(cb.dataset.layerId!)) checkStaleness();
  });

  // Poll: refetch (which dispatches tm:layerdata → checkStaleness) only while
  // something is actually on screen — no point polling for hidden layers.
  setInterval(() => {
    if (visibleLayers().length === 0) return;
    void refetchLive();
  }, refreshMs);

  // Periodically check staleness while layers are visible, in case the time exceeds the threshold
  // without a new feed fetch/load. Also re-runs expiry pruning so features expiring
  // between refetches self-remove.
  setInterval(() => {
    if (visibleLayers().length > 0) checkStaleness();
    pruneAndSetData();
  }, 60_000);

  // Mobile browsers freeze setInterval while the tab is backgrounded, so the
  // poll never fires at the moment of return — refetch on the "page is visible
  // again" signals instead. 60s guard so rapid app-switching doesn't spam the
  // feed (refetchLive itself dedupes real data via generated_utc anyway).
  const refetchOnReturn = () => {
    if (visibleLayers().length === 0) return;
    if (Date.now() - lastFetchMs < 60_000) return;
    void refetchLive();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refetchOnReturn();
  });
  // Back/forward-cache restore (common iOS Safari path) doesn't always emit a
  // visibilitychange — pageshow with persisted=true covers it.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) refetchOnReturn();
  });
}
