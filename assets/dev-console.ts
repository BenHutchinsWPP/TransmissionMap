// ─── Dev console handle ───────────────────────────────────────────────────────
// Role: dev-only `window.tm`, the view API for the browser console. Loaded by
//       src/main.ts behind import.meta.env.DEV only, so it never ships.
//       A console call commits the way a control does (ADR-0002): the setters
//       below don't emit 'url:write' themselves, so tm's wrappers do — the URL
//       updates and the change reaches the undo stack.
//         setWhere / setStyle emit 'url:write' when they succeed (null).
//         clearStyle          emits 'url:write' after.
//       setLayerVisibility, applyView, undo and redo already commit (or restore) on their own.
//
// Deps: state-bus.js (emit), view-state.js (applyView, currentView),
//       url-state.js (currentHash), visibility.js (setLayerVisibility),
//       filters.js (setWhere), style-overrides.js (setStyle, clearStyle,
//       listStylable), undo.js (undo, redo).

import { emit } from './state-bus.js';
import { applyView, currentView } from './view-state.js';
import { currentHash } from './url-state.js';
import { setLayerVisibility } from './visibility.js';
import { setWhere } from './filters.js';
import { setStyle, clearStyle, listStylable } from './style-overrides.js';
import { undo, redo } from './undo.js';

const commit = <T>(r: T): T => { if (r === null || r === undefined) emit('url:write'); return r; };

const tm = {
  applyView,
  currentView,
  currentHash,
  setLayerVisibility,
  setWhere: (...a: Parameters<typeof setWhere>) => commit(setWhere(...a)),
  setStyle: (...a: Parameters<typeof setStyle>) => commit(setStyle(...a)),
  clearStyle: (...a: Parameters<typeof clearStyle>) => commit(clearStyle(...a)),
  listStylable,
  undo,
  redo,
};

declare global {
  interface Window { tm?: typeof tm }
}

window.tm = tm;
