// ─── Live-feed poll loop ──────────────────────────────────────────────────────
// Role: the one refresh loop every live feed runs on. pollWhileVisible() calls
//       run() every intervalMs while active() is true, and again the moment the
//       page is shown — visibilitychange → visible, or a back/forward-cache
//       restore (pageshow with persisted=true, the common iOS Safari path) —
//       since mobile browsers freeze timers in background tabs. A return within
//       returnGapMs of the last run is skipped, so rapid app-switching does not
//       spam the feed. Hidden-tab polling is left to the browser (not paused).
// Callers: live-staleness.ts (GeoJSON feeds), odin-outages.ts, weather-live.ts,
//       nexrad-radar.ts. Each keeps its own in-flight guard inside run().
// Deps: none.

export interface PollOptions {
  intervalMs: number;
  active: () => boolean;                 // e.g. "is the layer on?" — false skips every trigger
  run: () => void | Promise<void>;
  returnGapMs?: number;                  // minimum gap before a return-to-page run
}

export function pollWhileVisible({ intervalMs, active, run, returnGapMs = 60_000 }: PollOptions): void {
  let lastRun = -Infinity;
  const tick = (onReturn: boolean) => {
    if (!active()) return;
    if (onReturn && Date.now() - lastRun < returnGapMs) return;
    lastRun = Date.now();
    void run();
  };
  setInterval(() => tick(false), intervalMs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick(true);
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) tick(true); });
}
