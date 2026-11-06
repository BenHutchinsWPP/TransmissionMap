// ─── Proximity pane opener (main bundle) ─────────────────────────────────────
// openProximity(from?) loads the ui-proximity.ts lazy chunk (which brings the
// table drawer chunk, Tabulator and the proximity core with it) and opens the
// drawer's Proximity tab. Tools ▸ Proximity opens it through here, so
// none of that lands in the boot bundle. A chunk that fails to load is
// recorded and retried on the next call.
// Deps: diag-log.ts; ui-proximity.ts (dynamic import).

import { recordDiagEvent } from '../diag-log.js';

let chunk: Promise<typeof import('./ui-proximity.js') | null> | null = null;
const load = () => chunk ??= import('./ui-proximity.js')
  .catch(err => { chunk = null; recordDiagEvent('layer', `proximity chunk: ${err}`); return null; });

export function openProximity(from?: HTMLElement | null): Promise<void> {
  return load().then(m => m?.openProximity(from));
}
