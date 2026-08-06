// assets/diag-log.ts — in-memory diagnostics ring buffer for "what actually
// failed for this user". Leaf module: no imports, so map.ts and layer-init.ts
// can call recordDiagEvent() from hot startup paths without pulling in a
// dependency graph. recordDiagEvent must never throw — it runs inside catch
// blocks and error listeners, where a throw would mask the original error.

export type DiagSource = 'map' | 'layer' | 'basemap' | 'live';

export type DiagEntry = {
  ts: number;
  source: DiagSource;
  detail: string;
};

const MAX_ENTRIES = 50;

// Fired on every recorded event — see recordDiagEvent.
export const DIAG_EVENT = 'tm:diagerror';

let buffer: DiagEntry[] = [];

// detail is `unknown` so callers can hand over a raw caught error without
// stringifying it first — a value whose toString() throws is stringified here,
// inside the guard, rather than at the call site inside someone else's catch.
export function recordDiagEvent(source: DiagSource, detail: unknown): void {
  try {
    buffer.push({ ts: Date.now(), source, detail: String(detail) });
    if (buffer.length > MAX_ENTRIES) buffer.shift();
  } catch {
    buffer.push({ ts: Date.now(), source, detail: '(undescribable error)' });
  }
  // Announced rather than exposed as a subscriber list, so this module keeps
  // its zero imports and hot startup paths can call it freely. ui/ui.ts listens
  // to raise the File-menu badge; layer-init.ts uses the same CustomEvent idiom.
  try {
    window.dispatchEvent(new CustomEvent(DIAG_EVENT));
  } catch { /* no window (unit tests) — the buffer is still recorded */ }
}

export function getDiagLog(): DiagEntry[] {
  return buffer.slice();
}

export function clearDiagLog(): void {
  buffer = [];
}
