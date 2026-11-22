// ─── Drawer opener (main bundle) ─────────────────────────────────────────────
// restoreDrawer(resume) loads the drawer shell (drawer.ts, a lazy chunk) and
// brings the drawer back as this tab's tm-drawer snapshot left it. Called by
// table-open.ts's restoreDrawer for ui-menubar.ts's boot hook (only when a
// restorable tm-drawer exists), with lazy loaders for the chat, Visualize and
// the table, so none of those chunks loads unless the snapshot holds its pane.
// A chunk that fails to load is recorded; the drawer opens from its buttons.
// Deps: diag-log.ts; drawer.ts (dynamic import; its restoreDrawer's type only).

import type * as Drawer from './drawer.js';
import { recordDiagEvent } from '../diag-log.js';

export function restoreDrawer(resume: Parameters<typeof Drawer.restoreDrawer>[0]): Promise<void> {
  return import('./drawer.js').then(m => m.restoreDrawer(resume),
    err => { recordDiagEvent('layer', `drawer chunk: ${err}`); });
}
