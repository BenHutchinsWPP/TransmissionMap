// ─── Grid Ops pane opener (main bundle) ──────────────────────────────────────
// openGridOps(nodeId, from?) loads the ui-grid-ops.ts lazy chunk (which brings
// the table drawer chunk with it) and opens the drawer's Grid Ops tab on that
// node (null: keep the node it shows). A bubble tap (grid-ops/grid-ops.ts)
// opens it through here, so none of that lands in the boot bundle. A chunk
// that fails to load is recorded and retried on the next call.
// Deps: diag-log.ts; ui-grid-ops.ts (dynamic import).

import { recordDiagEvent } from '../diag-log.js';

let chunk: Promise<typeof import('./ui-grid-ops.js') | null> | null = null;
const load = () => chunk ??= import('./ui-grid-ops.js')
  .catch(err => { chunk = null; recordDiagEvent('layer', `grid ops chunk: ${err}`); return null; });

export function openGridOps(nodeId: string | null, from?: HTMLElement | null): Promise<void> {
  return load().then(m => m?.openGridOps(nodeId, from));
}
