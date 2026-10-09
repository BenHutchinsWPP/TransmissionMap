# ADR-0004: Undo replays `url:write` snapshots through `applyView`

- Status: accepted
- Date: 2026-10-08
- Files: `assets/undo.ts`, `assets/view-state.ts`, `assets/visibility.ts`, `assets/ui/ui-menubar.ts`

## Context

Undo/redo needs a record of each finished change to the view and a way to put an earlier view back. The app already has both halves:
- every finished control emits `url:write` (ADR-0002), and `applyView` emits it once for a whole view;
- `applyView` switches only what differs from the live map, and `formatUrlState(currentView())` is a complete, link-sized description of the view.

## Decision

`assets/undo.ts` keeps an in-memory list of view snapshots and restores one through `applyView`.

| Part | Choice |
|---|---|
| Snapshot | `formatUrlState(currentView()).join('&')` — the link params, without `lang` or `exp` |
| Commit signal | `url:write` (ADR-0002) |
| Restore | `applyView(parseUrlState(new URLSearchParams(s)))`, with a `restoring` flag so the apply's own `url:write` is not recorded |
| Baseline | taken at `map:ready`, after the linked view is painted |
| Storage | in memory only; `history` is never touched |

Alternatives considered:

| Alternative | Why not |
|---|---|
| Diff applier (store field deltas, apply the inverse) | A second applier beside `applyView`, which would have to learn every future view field. |
| `history.pushState` per change (browser Back/Forward) | Back fires `hashchange`, and `map.ts` reloads on a hash carrying params. |
| Replay of API calls (record setter calls, re-run them) | Each setter would need an inverse, and the log would also have to cover the UI handlers that bypass the setters. A snapshot captures the result, whatever produced it. |

## Consequences

- **Camera is off the stack.** `map.ts` writes the URL directly on `moveend` (`writeUrlState`, not `url:write`), so undo leaves the camera where it is.
- **Coalescing.** A write within 400 ms of the last replaces the top entry, so a slider drag is one step. A write equal to the top is skipped (a language change emits `url:write` with no view change), and a replace that leaves the top equal to the entry below drops it, so on-then-off within the window is no step.
- **Cap.** 50 entries; the oldest drops off. Any new commit clears redo.
- **Stories.** Undo changes the view, never which story is open. A dirty story stays dirty; the story card's *Modified view — click to restore* badge is the way back. Starting a story, Reset and opening a view file are each one entry, since each is one `applyView`. Undoing a step that never dirtied the story (a region change, a stale-feed switch) marks it dirty, because the restore's `url:write` goes through `noteUrlWrite`; accepted under U6.
- **A `?exp=` deep link starts with nothing to undo.** The story applies after `map:ready`, once its lazy chunk loads, so `ui.ts` calls `resetHistory()` right after `restoreFromUrl()`.
- **A restored toggle does what its control does.** Re-enabling a tribal layer re-opens its disclaimer; terrain off→on rebuilds the terrain. Only `where`/`style`/filter/label/colour-by changes restore with no side effect.
- **The stale-feed switch lands on the stack.** `live-staleness.ts` and `odin-outages.ts` hide and re-show stale feeds through `setLayerVisibility`, which commits with `url:write`, so those switches are undo steps too. Both gates also vet a layer on `layer:visibility`, so a stale feed that Undo switches back on (no checkbox `change`) meets the gate; the check runs in a microtask, so its switch-off is its own step after the restore.
- **Rule for new controls:** a control that changes the view must emit `url:write` — directly, or through a setter that does (`setLayerVisibility`) — or it is not undoable. A control that calls `writeUrlState()` directly updates the link but never reaches the stack.
- Keyboard (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y) and File ▸ Undo / Redo live in `assets/ui/ui-menubar.ts`; items grey out from `canUndo()`/`canRedo()` on `undo:changed`.

## Amendment (2026-10-09)

Range sliders now repaint the map on `input` and commit (`url:write`) on `change`, so a drag is one undo step however long it takes. The year slider also commits on pointer release when the drag switched the filter on or stopped playback, so a release in place still lands on the stack. The 400 ms coalescing window stays for rapid bursts of writes, such as keyboard steps.
