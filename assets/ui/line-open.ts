// ─── Line tools opener (main bundle) ─────────────────────────────────────────
// openLineTools(req, from) loads the ui-line.ts lazy chunk (which brings the
// table drawer chunk and the line GeoParquet reader with it) and opens the
// drawer's Line tab on one transmission line. The popup's "Line tools" button
// opens it through here, so the locator never lands in the boot bundle.
// A chunk that fails to load is recorded and retried on the next call.
// Deps: diag-log.ts; ui-line.ts (dynamic import; LineRequest is type-only).

import type { LineRequest } from './ui-line.js';
import { recordDiagEvent } from '../diag-log.js';

let chunk: Promise<typeof import('./ui-line.js') | null> | null = null;
const load = () => chunk ??= import('./ui-line.js')
  .catch(err => { chunk = null; recordDiagEvent('layer', `line tools chunk: ${err}`); return null; });

export function openLineTools(req: LineRequest, from?: HTMLElement | null): Promise<void> {
  return load().then(m => m?.openLineTools(req, from));
}
