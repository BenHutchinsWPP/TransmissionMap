// ─── Proximity: Reset hook (boot bundle, zero deps) ─────────────────────────
// Role: lets both Reset paths remove the Proximity tool's `px-` map layers without
//       importing its lazy chunk. ui/proximity-map.ts registers its remover while it
//       has layers on the map; clearProximityMap() runs it (no-op otherwise).
// Used by: ui/ui.ts and map-api.ts (after applyView({})), ui/proximity-map.ts.

let remover: (() => void) | null = null;

export function setProximityClear(fn: (() => void) | null): void { remover = fn; }

/** Remove the Proximity layers from the map; the tab and its file stay. */
export function clearProximityMap(): void { remover?.(); }
