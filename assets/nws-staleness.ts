// ─── Live NWS weather-alert staleness safety ──────────────────────────────────
// Role: thin config shell over the shared factory (live-staleness.ts) for the
//       `nws-alerts` live layer: 5 min poll, 3 h max age, #nwsStaleDialog
//       modal, PLUS expiry pruning — alerts past their `ends`/`expires` time
//       are dropped client-side before every setData and on the 60 s tick, so
//       a stale feed self-prunes instead of showing dead warnings. Features
//       with no parseable end time are KEPT (fail open — the feed-level
//       staleness gate covers them).
//       Also drives nws-zone-join.ts's joined zone/county
//       feature-state, since that module only knows the polygon layer's
//       cadence indirectly (via its own 'layer:data' refetch, see its
//       header): every polygon prune tick here also calls
//       pruneExpiredZoneAlerts() so joined zones/counties expire in step.
//       The kill-switch (feed older than maxAgeMs → modal + layers hidden)
//       has no callback hook out of live-staleness.ts's factory, so this
//       module watches #nwsStaleDialog's `open` attribute via
//       MutationObserver and calls clearZoneAlerts() the instant it opens —
//       cheaper than modifying the shared factory for a single caller. The
//       modal's re-enable button gets a matching click listener that calls
//       refetchZoneAlerts(), since the factory only restores polygon layers.
// Exports NWS_LIVE, the config itself: ui/ui-legends.ts reads its maxAgeMs for
//       the age chip's stale edge and diagnostics.ts for the feed check.
// Deps: live-staleness.ts (factory), constants (DATA), nws-zone-join.ts
//       (pruneExpiredZoneAlerts, clearZoneAlerts). Modal DOM in index.html.
// Wired from ui/ui.ts init() via initNwsStaleness().

import { DATA } from './constants.js';
import { initLiveStaleness, type LiveStalenessConfig } from './live-staleness.js';
import { pruneExpiredZoneAlerts, clearZoneAlerts, refetchZoneAlerts } from './nws-zone-join.js';

function pruneExpiredAlerts(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
  const now = Date.now();
  // Same tick prunes the joined zone/county feature-state nws-zone-join.ts
  // holds, so a zone never lags the polygon layer by up to a full poll cycle.
  pruneExpiredZoneAlerts(now);
  return features.filter(f => {
    const end = f.properties?.ends ?? f.properties?.expires;
    if (!end) return true;
    const t = Date.parse(end as string);
    if (Number.isNaN(t)) return true;
    return t >= now;
  });
}

const STALE_DIALOG_ID = "nwsStaleDialog";

// No callback hook exists on live-staleness.ts's factory for "kill-switch
// fired" (it's all internal to checkStaleness()), so watch the modal's
// `open` attribute directly — it's only ever set via dlg.showModal() in the
// kill-switch path. Cheaper than threading a new option through the shared
// factory for a single caller.
function watchKillSwitch(): void {
  const dlg = document.getElementById(STALE_DIALOG_ID);
  if (!dlg) return;
  const observer = new MutationObserver(() => {
    if ((dlg as HTMLDialogElement).open) clearZoneAlerts();
  });
  observer.observe(dlg, { attributes: true, attributeFilter: ["open"] });
  // Mirror of the clear above: the factory's re-enable button only restores
  // the polygon layers; the zone/county join it can't see about must be
  // re-applied here or US geometry-null alerts stay dark until the feed's
  // generated_utc actually advances (never, for a stale snapshot).
  document.getElementById("nwsStaleReenable")?.addEventListener("click", () => {
    void refetchZoneAlerts();
  });
}

export const NWS_LIVE: LiveStalenessConfig = {
  sourceKey: "nws-alerts",
  layerIds: ["nws-alerts"],
  dataUrl: () => DATA.nws_alerts,
  refreshMs: 5 * 60_000,          // 5 minutes (feed cadence ~10 min)
  maxAgeMs: 3 * 60 * 60_000,      // 3 hours = many missed cycles
  dialogId: STALE_DIALOG_ID,
  ageElId: "nwsStaleAge",
  reenableId: "nwsStaleReenable",
  dismissId: "nwsStaleDismiss",
  pruneExpired: pruneExpiredAlerts,
};

export function initNwsStaleness() {
  initLiveStaleness(NWS_LIVE);
  watchKillSwitch();
}
