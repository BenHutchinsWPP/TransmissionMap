// ─── Tool mutual-exclusion mediator ───────────────────────────────────────────
// Neutral module breaking the measure ↔ user-data-draw cycle. Each tool registers
// its own deactivator here; the other tool triggers it without a direct import.
// No imports → no cycle. Registration happens in initMeasure / initDraw.

let deactivateMeasure: () => void = () => {};
let exitEditMode: () => void = () => {};

export function registerMeasureDeactivator(fn: () => void) { deactivateMeasure = fn; }
export function registerEditExit(fn: () => void) { exitEditMode = fn; }

export function deactivateMeasureTool() { deactivateMeasure(); }
export function exitEdit() { exitEditMode(); }
