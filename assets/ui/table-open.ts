// ─── Table drawer opener (main bundle) ───────────────────────────────────────
// openTable(req) loads the ui-table.ts lazy chunk and shows `req` in the
// drawer; zoomToSelection() fits the map to the selected features (the
// chunk's other entry point); restoreDrawer(resumeAsk, resumeViz) brings the
// drawer back after a reload of this tab (ui-menubar.ts's boot hook, only when
// a restorable tm-drawer snapshot exists) through drawer-open.ts, which loads
// the drawer shell; the table chunk loads only when the snapshot holds a
// table (its prepareRestore; a chunk that fails to load rejects it, so the
// shell keeps that table for the next reload), and its startRestore is then
// called on the loaded chunk synchronously. A layer row's ⋯ menu ▸ Show in
// table, the popup's "Show in table", the Selection menu and the dev
// console's tm.showTable all open the drawer through here, so none of them
// pulls the chunk into the boot bundle.
// A chunk that fails to load is recorded and retried on the next call.
// Deps: diag-log.ts; drawer-open.ts (restoreDrawer); ui-table.ts (dynamic
//       import; TableRequest is type-only), drawer-snapshot.ts (VizSnapshot, type-only).

import type { TableRequest } from './ui-table.js';
import type { VizSnapshot } from './drawer-snapshot.js';
import { recordDiagEvent } from '../diag-log.js';
import { restoreDrawer as openDrawer } from './drawer-open.js';

let chunk: Promise<typeof import('./ui-table.js') | null> | null = null;
const load = () => chunk ??= import('./ui-table.js')
  .catch(err => { chunk = null; recordDiagEvent('layer', `table chunk: ${err}`); return null; });

export function openTable(req: TableRequest): Promise<void> {
  return load().then(m => m?.showTable(req));
}

export function restoreDrawer(resumeAsk: () => Promise<void>, resumeViz?: (viz: VizSnapshot) => Promise<void>): Promise<void> {
  let mod: typeof import('./ui-table.js') | null = null;
  return openDrawer({
    ask: resumeAsk,
    viz: resumeViz,
    table: {
      prepare: s => load().then(m => { if (!m) throw new Error('table chunk'); mod = m; return m.prepareRestore(s); }),
      start: s => mod!.startRestore(s),
    },
  });
}

export function zoomToSelection(): Promise<void> {
  return load().then(m => m?.zoomToSelection());
}
