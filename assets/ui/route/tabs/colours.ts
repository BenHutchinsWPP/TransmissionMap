// ─── Route panel: route colours ──────────────────────────────────────────────
// Role: the map and list colours of the optimal route (plain mode) and its alternatives,
//       shared by the shell's map layers / legend / export (ui-route.ts) and the
//       Alternatives tab's swatches, so the two always agree. Pure constants.
// Deps: none.

/** The optimal route in plain colour mode. */
export const PLAIN = '#d0008a';
/** The least-cost route drawn beside a shown alternative ("Make Alt n the result"). */
export const OPTIMAL_OTHER = '#1e3a8a';
/** Alt 1, Alt 2, Alt 3 (cycled beyond). */
export const ALT_COLOURS = ['#0d9488', '#c2410c', '#334155'];
