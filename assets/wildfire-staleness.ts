// ─── Live-wildfire staleness safety ───────────────────────────────────────────
// Role: thin config shell — the actual auto-refresh + stale-data kill-switch
//       behavior lives in the shared factory (live-staleness.ts). Wildfire's
//       parameters: 15 min poll, 6 h max age, the three live wildfire layers
//       sharing the one `wildfire-live` source, #wildfireStaleDialog modal.
//       No expiry pruning — wildfire features carry no end time.
// Deps: live-staleness.ts (factory), state (DATA). Modal DOM in index.html.
// Wired from ui/ui.ts init() via initWildfireStaleness().

import { DATA } from './state.js';
import { initLiveStaleness } from './live-staleness.js';

// Re-fetch the feed this often. The GitHub-Actions feed updates ~hourly, so a
// 15-minute poll picks up a new pull within a quarter-hour without hammering it.
export const WILDFIRE_REFRESH_MS = 15 * 60_000;   // 15 minutes
// Hard cutoff: above this pull age the data is treated as unsafe and the layers
// are force-disabled. 6h = several missed hourly cycles.
export const WILDFIRE_MAX_AGE_MS = 6 * 60 * 60_000; // 6 hours

export function initWildfireStaleness() {
  initLiveStaleness({
    sourceKey: "wildfire-live",
    layerIds: ["wildfire-live", "wildfire-smoke", "wildfire-incidents"],
    dataUrl: () => DATA.wildfire_live,
    refreshMs: WILDFIRE_REFRESH_MS,
    maxAgeMs: WILDFIRE_MAX_AGE_MS,
    dialogId: "wildfireStaleDialog",
    ageElId: "wildfireStaleAge",
    reenableId: "wildfireStaleReenable",
    dismissId: "wildfireStaleDismiss",
  });
}
