// ─── Undo / redo of the view ──────────────────────────────────────────────────
// Role: an in-memory history of views. Each entry is the view's link params,
//       formatUrlState(currentView()).join('&') — no `lang`, no `exp` — so
//       every entry is a link, and undo replays one through applyView().
//       The commit signal is 'url:write': every finished control emits it
//       (docs/url-state.md) and applyView() emits it once. The camera writes the URL
//       directly on moveend, so it never reaches the stack and stays put on undo.
//         undo() / redo()        step back / forward; false when there is none.
//         canUndo() / canRedo()  for the menu; 'undo:changed' fires on change.
//         historyStamp()         a number that changes with every stack change; read-only,
//                                for a toast that offers Undo for one step only.
//         resetHistory()         the view on the map becomes the baseline; run
//                                at 'map:ready' and after a ?exp= story applies.
//         asOwnStep(fn)          the commits fn makes form their own step, never
//                                merged with the one before or after (map-api.ts:
//                                one call, one step, however fast calls come).
//       A write equal to the top is skipped (a language change writes with no
//       view change); one within REPLACE_MS of the last replaces the top (a
//       burst of commits is one entry; a range slider commits once, on
//       'change', so a drag is one at any speed), and drops it when that
//       leaves it equal to the entry below. The baseline is taken at
//       'map:ready', after the linked view is painted, so the cold-boot write
//       is not a commit.
//       Never history.pushState: Back would fire hashchange, and map.ts reloads
//       on a hash carrying params. Undo changes the view, never which story is
//       open; a dirty story stays dirty. A restored toggle does what its control
//       does (a tribal layer re-opens its disclaimer, terrain rebuilds).
//
// Deps: state-bus.js (on 'url:write' / 'map:ready', emit 'undo:changed'),
//       url-state-codec.js (formatUrlState, parseUrlState),
//       view-state.js (applyView, currentView).

import { on, emit } from './state-bus.js';
import { formatUrlState, parseUrlState } from './url-state-codec.js';
import { applyView, currentView } from './view-state.js';

const CAP = 50;
const REPLACE_MS = 400;

let past: string[] = [];   // past.at(-1) is the view on the map
let future: string[] = [];
let lastWrite = 0;         // when the top was last written by a commit; 0 after a restore
let restoring = false;
let stamp = 0;            // bumped whenever the stack changes: a step's identity

const snapshot = () => formatUrlState(currentView()).join('&');

// Make the view on the map the baseline, with nothing to undo or redo.
export function resetHistory() {
  stamp++;
  past = [snapshot()];
  future = [];
  lastWrite = 0;
  emit('undo:changed');
}

on('map:ready', resetHistory);

export function asOwnStep<T>(fn: () => T): T {
  lastWrite = 0;
  try { return fn(); } finally { lastWrite = 0; }
}

on('url:write', () => {
  if (!past.length || restoring) return;
  const s = snapshot();
  if (s === past.at(-1)) return;
  const now = Date.now();
  stamp++;
  if (past.length > 1 && now - lastWrite < REPLACE_MS) {
    past[past.length - 1] = s;
    if (s === past.at(-2)) past.pop();   // on then off again: no step left
  } else past.push(s);
  if (past.length > CAP) past.shift();
  lastWrite = now;
  future = [];
  emit('undo:changed');
});

// The snapshot came from this session, so its vx is held to no link cap.
function restore(s: string) {
  restoring = true;
  try {
    applyView(parseUrlState(new URLSearchParams(s), { vxMaxChars: Infinity }));
  } finally {
    restoring = false;
  }
  lastWrite = 0;
  emit('undo:changed');
}

/** Changes whenever a step is recorded, replaced, undone or redone; read-only (a toast binds its Undo to the value it saw). */
export const historyStamp = (): number => stamp;
export function canUndo(): boolean { return past.length > 1; }
export function canRedo(): boolean { return future.length > 0; }

export function undo(): boolean {
  if (!canUndo()) return false;
  stamp++;
  future.push(past.pop()!);
  restore(past.at(-1)!);
  return true;
}

export function redo(): boolean {
  if (!canRedo()) return false;
  stamp++;
  past.push(future.pop()!);
  restore(past.at(-1)!);
  return true;
}
