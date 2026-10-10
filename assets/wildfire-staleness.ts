// ─── Live-wildfire staleness safety ───────────────────────────────────────────
// Role: thin config shell — the actual auto-refresh + stale-data kill-switch
//       behavior lives in the shared factory (live-staleness.ts). Wildfire's
//       parameters: 15 min poll, 6 h max age, the three live wildfire layers
//       sharing the one `wildfire-live` source, #wildfireStaleDialog modal.
//       No expiry pruning — wildfire features carry no end time.
// Exports WILDFIRE_LIVE, the config itself: ui/ui-legends.ts reads its maxAgeMs
//       for the age chips' stale edge and diagnostics.ts for the feed check, so
//       neither can disagree with the kill switch.
// Deps: live-staleness.ts (factory), constants (DATA). Modal DOM in index.html.
// Wired from ui/ui.ts init() via initWildfireStaleness().

import { DATA } from './constants.js';
import { initLiveStaleness, type LiveStalenessConfig } from './live-staleness.js';

export const WILDFIRE_LIVE: LiveStalenessConfig = {
  sourceKey: "wildfire-live",
  layerIds: ["wildfire-live", "wildfire-smoke", "wildfire-incidents"],
  dataUrl: () => DATA.wildfire_live,
  // Re-fetch the feed this often. The GitHub-Actions feed updates ~hourly, so a
  // 15-minute poll picks up a new pull within a quarter-hour without hammering it.
  refreshMs: 15 * 60_000,
  // Hard cutoff: above this pull age the data is treated as unsafe and the layers
  // are force-disabled. 6h = several missed hourly cycles.
  maxAgeMs: 6 * 60 * 60_000,
  dialogId: "wildfireStaleDialog",
  ageElId: "wildfireStaleAge",
  reenableId: "wildfireStaleReenable",
  dismissId: "wildfireStaleDismiss",
};

export function initWildfireStaleness() {
  initLiveStaleness(WILDFIRE_LIVE);
}
