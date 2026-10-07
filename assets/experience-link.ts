// ─── Map Experience link tracking ─────────────────────────────────────────────
// Role: whether the address-bar link still names the active Map Experience.
//       Owns the story id, the pristine snapshot (the URL param string as the
//       story left it) and the dirty flag. url-state.ts hands every write's
//       param string to noteUrlWrite(): the first one after beginExperience()
//       becomes the snapshot, and any later one that differs marks the view
//       edited (emits `exp:dirty`) for the rest of the story. The camera is not
//       in the param string, so panning inside a story keeps the link named.
//       All three are private to this module; the rest of the app reads them
//       through activeExperienceId() and experienceIsDirty().
//
// Deps: state-bus.js (emit 'exp:dirty').
//       Imported by experiences.ts, url-state.ts, live-staleness.ts,
//       odin-outages.ts, ui/ui.ts, ui/ui-experiences.ts and
//       user-data/view-file.ts.

import { emit } from './state-bus.js';

let experienceId: string | null = null;        // active story id, or null
let experienceDirty = false;                   // the view has been edited since the story landed
let experiencePristine: string | null = null;  // URL param string the story left, once recorded

// Names `id` as the active story with no snapshot yet: the next noteUrlWrite()
// records it.
export function beginExperience(id: string): void {
  experienceId = id;
  experienceDirty = false;
  experiencePristine = null;
}

// Forgets the story. Writes no URL and emits nothing — the caller does both
// when it needs them.
export function endExperienceLink(): void {
  experienceId = null;
  experienceDirty = false;
  experiencePristine = null;
}

// Re-arms the pristine snapshot so the NEXT URL write becomes the new
// reference point. Anything that changes a shared param without the reader
// asking for it — the stale-feed kill switch switching a layer off, a language
// change — calls this, or the diff reads it as them editing their way out of
// an active Map Experience.
export function rebaselineExperience(): void {
  if (experienceId && !experienceDirty) experiencePristine = null;
}

// Called with the param string (camera excluded) of every URL write. Returns
// true while the link should still carry `exp`. A no-op with no active story
// or once the view is already edited.
export function noteUrlWrite(paramString: string): boolean {
  if (experienceId && !experienceDirty) {
    if (experiencePristine === null) experiencePristine = paramString;
    else if (paramString !== experiencePristine) {
      experienceDirty = true;
      emit('exp:dirty');
    }
  }
  return !!experienceId && !experienceDirty;
}

export function activeExperienceId(): string | null {
  return experienceId;
}

export function experienceIsDirty(): boolean {
  return experienceDirty;
}
