// ─── Tool mutual-exclusion mediator ───────────────────────────────────────────
// Neutral module breaking the measure ↔ user-data-draw cycle. Each tool assigns
// its own hook here; the other tool calls it without a direct import.
// No imports → no cycle. Assignment happens in initMeasure / initDraw.

export const toolHooks = {
  deactivateMeasure: () => {},
  exitEdit: () => {},
};
