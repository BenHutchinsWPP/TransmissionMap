// ─── Live NWS weather-alert staleness safety ──────────────────────────────────
// Role: thin config shell over the shared factory (live-staleness.ts) for the
//       `nws-alerts` live layer: 5 min poll, 3 h max age, #nwsStaleDialog
//       modal, PLUS expiry pruning — alerts past their `ends`/`expires` time
//       are dropped client-side before every setData and on the 60 s tick, so
//       a stale feed self-prunes instead of showing dead warnings. Features
//       with no parseable end time are KEPT (fail open — the feed-level
//       staleness gate covers them).
// Deps: live-staleness.ts (factory), state (DATA). Modal DOM in index.html.
// Wired from ui/ui.ts init() via initNwsStaleness().

import { DATA } from './state.js';
import { initLiveStaleness } from './live-staleness.js';

export const NWS_REFRESH_MS = 5 * 60_000;        // 5 minutes (feed cadence ~10 min)
export const NWS_MAX_AGE_MS = 3 * 60 * 60_000;   // 3 hours = many missed cycles

function pruneExpiredAlerts(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
  const now = Date.now();
  return features.filter(f => {
    const end = f.properties?.ends ?? f.properties?.expires;
    if (!end) return true;
    const t = Date.parse(end as string);
    if (Number.isNaN(t)) return true;
    return t >= now;
  });
}

export function initNwsStaleness() {
  initLiveStaleness({
    sourceKey: "nws-alerts",
    layerIds: ["nws-alerts"],
    dataUrl: () => DATA.nws_alerts,
    refreshMs: NWS_REFRESH_MS,
    maxAgeMs: NWS_MAX_AGE_MS,
    dialogId: "nwsStaleDialog",
    ageElId: "nwsStaleAge",
    reenableId: "nwsStaleReenable",
    dismissId: "nwsStaleDismiss",
    pruneExpired: pruneExpiredAlerts,
  });
}
