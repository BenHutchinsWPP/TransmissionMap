// ─── Table drawer opener (main bundle) ───────────────────────────────────────
// openTable(req) loads the ui-table.ts lazy chunk and shows `req` in the
// drawer; zoomToSelection() fits the map to the selected features (the
// chunk's other entry point); restoreDrawer(resumeAsk) brings the drawer back
// after a reload of this tab (ui-menubar.ts's boot hook, only when a
// restorable tm-drawer snapshot exists). A layer row's ⋯ menu ▸ Show in table, the popup's "Show in
// table", the Selection menu and the dev console's tm.showTable all open the
// drawer through here, so none of them pulls the chunk into the boot bundle.
// A chunk that fails to load is recorded and retried on the next call.
// Deps: diag-log.ts; ui-table.ts (dynamic import; TableRequest is type-only),
//       drawer-snapshot.ts (VizSnapshot, type-only).

import type { TableRequest } from './ui-table.js';
import type { VizSnapshot } from './drawer-snapshot.js';
import { recordDiagEvent } from '../diag-log.js';

let chunk: Promise<typeof import('./ui-table.js') | null> | null = null;
const load = () => chunk ??= import('./ui-table.js')
  .catch(err => { chunk = null; recordDiagEvent('layer', `table chunk: ${err}`); return null; });

export function openTable(req: TableRequest): Promise<void> {
  return load().then(m => m?.showTable(req));
}

export function restoreDrawer(resumeAsk: () => Promise<void>, resumeViz?: (viz: VizSnapshot) => Promise<void>): Promise<void> {
  return load().then(m => m?.restoreDrawer(resumeAsk, resumeViz));
}

export function zoomToSelection(): Promise<void> {
  return load().then(m => m?.zoomToSelection());
}
