# ADR-0002: Each UI control requests its own URL write

- Status: accepted
- Date: 2026-10-07
- Files: `assets/ui/ui-filters.ts`, `assets/ui/ui.ts`, `assets/url-state.ts`

## Context

About 25 UI handlers end with `emit('url:write')`, mostly in `ui-filters.ts` and `ui.ts`. Moving that write inside a generic state setter would remove the repeated line.

## Decision

Each control keeps its own `emit('url:write')`.
- The emit marks a user action that has finished. It is not part of writing state.
- Some state changes deliberately skip the URL write. Year-filter playback ticks emit the filter event but not `url:write` (see `docs/adding-a-filter.md`).
- `applyView` writes many fields and then emits a single `url:write` for the whole view.
- `setLayerVisibility` is the one setter that emits it: a layer switch is always a finished action. A caller switching many layers passes `writeUrl = false` and emits once itself.

## Consequences

- A new control that changes view state must emit `url:write` itself; see `docs/url-state.md`.
- Don't propose moving URL writes into state setters. The emits are per-control events, not a seam.
- `url:write` is also the undo stack's commit signal; see [ADR-0004](0004-undo-replays-url-write-snapshots.md). A control that calls `writeUrlState()` directly is not undoable.
