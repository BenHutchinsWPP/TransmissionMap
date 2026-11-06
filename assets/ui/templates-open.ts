// ─── Visualize pane opener (main bundle) ─────────────────────────────────────
// openVisualize(layerId?, from?) loads the ui-templates.ts lazy chunk (which
// brings the table drawer chunk with it) and opens the drawer's Visualize tab,
// with `layerId` picked when given; resumeVisualize(viz) brings the pane back
// after a reload of this tab (ui-menubar.ts's boot hook passes it to
// restoreDrawer). File ▸ Visualize… and a layer row's ⋯ menu ▸ Visualize open it
// through here, so neither pulls the template code into the boot bundle.
// A chunk that fails to load is recorded and retried on the next call.
// Deps: diag-log.ts; ui-templates.ts (dynamic import); drawer-snapshot.ts
//       (VizSnapshot, type-only).

import type { VizSnapshot } from './drawer-snapshot.js';
import { recordDiagEvent } from '../diag-log.js';

let chunk: Promise<typeof import('./ui-templates.js') | null> | null = null;
const load = () => chunk ??= import('./ui-templates.js')
  .catch(err => { chunk = null; recordDiagEvent('layer', `templates chunk: ${err}`); return null; });

export function openVisualize(layerId?: string, from?: HTMLElement | null): Promise<void> {
  return load().then(m => m?.openVisualize(layerId, from));
}

export function resumeVisualize(viz: VizSnapshot): Promise<void> {
  return load().then(m => m?.resumeVisualize(viz));
}
