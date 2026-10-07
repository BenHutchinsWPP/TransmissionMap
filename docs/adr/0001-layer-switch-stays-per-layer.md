# ADR-0001: Switching a layer stays a per-layer effect sequence

- Status: accepted
- Date: 2026-10-07
- Files: `assets/visibility.ts`, `assets/view-state.ts`

## Context

A whole view could be applied as a single step: compute the set of visible map layer ids from `(layerVisibility, genMode, registry)`, diff it against the map, and apply the difference.

`setLayerVisibility()` does more than set layout. For each registry layer it emits a `layer:visibility` event, and other modules depend on that event:
- the legends (`assets/ui/ui-legends.ts`);
- the weather wash (`assets/weather-live.ts`);
- the NWS zone and county layers (`assets/nws-zone-join.ts`);
- the live-feed modals (`assets/live-staleness.ts`).

It also:
- fetches the layer's data (`ensureLayerData`);
- loads raster hover LUTs;
- switches exclusive-group rivals off before switching the requested layer on;
- shows the tribal disclaimer.

## Decision

Switching stays a per-layer effect sequence in `setLayerVisibility()`. The pure parts are separate functions that callers and tests use directly:
- `wantedLayout()`: the visibility of each map layer for a registry layer, its on/off state and its mode;
- `settleExclusiveGroups()`: the exclusive-group rule over a whole view, before the map exists.

Modules that keep their own per-layer machinery subscribe to `layer:visibility` rather than being called from `visibility.ts`.

## Consequences

- A set-and-diff adapter would have to rebuild the per-layer events, the rival off-before-on order, the data fetches and the disclaimer. Don't propose one unless that event contract changes.
- Applying a whole view refreshes the legends once per switched layer, and `view:applied` then rebuilds them. That repeated refresh is expected.
