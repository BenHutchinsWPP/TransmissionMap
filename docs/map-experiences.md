# Map Experiences — guided grid stories

> *Read this before adding or editing a curated map view. The one thing you
> must not skip: **a legend filter only narrows layers that are already on**, so
> every filter in a preset needs its base layers in `layersOn` or the story
> renders an empty map. `experiences.test.ts` enforces that for fuel.*

An **experience** is a hand-built view of the map — camera, layers, filters,
basemap, 3D — paired with a short narrative explaining the engineering behind
it. Users reach them from `File ▸ Experiences…` or from a `?exp=<slug>` link.

## The four files

| File | Role |
|---|---|
| `src/registry/experiences.ts` | The catalogue. Pure data, no side effects, no MapLibre. |
| `src/registry/experiences.test.ts` | Validates every id, bucket and basemap code against the live registry. |
| `assets/experiences.ts` | Runtime controller: renders a preset as `UrlStateData` — the shape a shared link parses to — hands it to `view-state.ts`'s `applyView()`, tracks the active story. No DOM. |
| `assets/ui/ui-experiences.ts` | Gallery dialog + floating story card. Lazy chunk. |

The last two are reached only by dynamic `import()` — from `ui-menubar.ts` on
the File-menu click, and from `ui.ts` when the hash carries `exp` — which keeps
the narratives out of the initial bundle.

## Applying a preset

A preset reaches the map in the same shape a shared link parses to, so a story
and a pasted link restore a view identically:

1. `experienceUrlState(preset)` renders the preset's `state` as `UrlStateData`
   — the codec's `defaultView()` with the preset's fields laid over it.
2. `applyExperience()` hands that to `applyView()` (`assets/view-state.ts`),
   along with the camera, which travels beside the view rather than inside it.
   `applyView()` is the one path a whole view takes onto a **live** map — the
   Reset button is `applyView({})`. A cold boot is the other path: `ui.ts`
   calls `readUrlState()` (`assets/url-state.ts`), which hands the parsed hash
   to `seedView()` before the map is built, and `initMap()` renders from it.

> **The silent footgun: a new field on `MapExperience.state` has to be
> representable in `assets/url-state-codec.ts`.** A preset that can't be written
> to the URL is a story whose link shows a different map: `experienceUrlState()`
> can set a field on the `UrlStateData` it builds, but if
> `formatUrlState`/`parseUrlState` don't know that field, it never reaches a
> shared link and never survives a reload. So adding state to a preset means
> adding it to the codec first (see [url-state.md](url-state.md)), not just to
> `MapExperience.state`. `experiences.test.ts` § 1 pins this: it round-trips
> every catalogue entry through the codec and fails on a field the codec can't
> carry.

`applyView(data, camera)`, in order:

1. Resolve `data` over `defaultView()`. The codec omits any value that equals
   its default, so a field the incoming view wants at its default is simply
   absent from `data`; resolving supplies it. This is also why a story leaves
   the next one clean — nothing carries over.
2. Write the state-only fields (filters, gen mode, MW, year, colour-by modes,
   smoke opacity, region), then `switchBasemap()`, `switchProjection()`,
   `setWeatherVar()`, `setNriHazard()`.
3. `setLayerVisibility()` for each layer whose visibility changes — every `off`
   first, then every `on`, so a layer losing its map layers never races one
   claiming them. `setLayerVisibility()` ticks the panel checkbox and emits
   `layer:visibility`, which `weather-live.ts` and `nws-zone-join.ts` follow,
   so a programmatic switch reaches them the same way a click does.
4. `setTerrain3d()` / `setBuildings3d()` / `setHillshade()` where they change.
5. `applySmokeOpacity()`, `emit('filter:all')`, `applyAllGenModes()`, the
   colour-by appliers.
6. `emit('view:applied')` — `ui.ts` rebuilds the layer panel and legends and
   mirrors the view onto the basemap radios, 3D checkboxes and sliders — then
   `emit('url:write')`.
7. Camera last: `flyTo` (or `jumpTo` for a cold deep link — there is nothing
   to fly from).

`applyExperience()` wraps this with story bookkeeping: `map.stop()` (cancels
whatever the last `flyTo` is still easing), clearing `state.experienceId` up
front so the apply's own `url:write` can't be read as the reader editing their
way out of the story being replaced, then the steps above, then setting
`state.experienceId`/pristine snapshot once the view is live.

It **hides** a live layer rather than shutting its feed down: `live-staleness.ts`
gates its refetch on the source existing, not on visibility, so once a story has
switched a live layer on that poller runs for the rest of the session.

## Pristine vs. edited

The active story's id lives in `state.experienceId`. `writeUrlState()` compares
the param string it is about to write against `state.experiencePristine` — the
snapshot the preset left behind. Matching means the view is still the story, and
`exp` goes on the link. Differing means the reader has edited it: the story card
swaps in a *Modified view — click to restore* badge and `exp` drops off the link.
The camera is outside that comparison, so panning inside a story keeps the link
on the story. See [url-state.md](url-state.md).

Anything that changes a shared param *without the reader asking for it* must call
`rebaselineExperience()` (`assets/state.ts`) first, or the diff reads it as an
edit and the story is falsely marked modified. Two callers today: the stale-feed
kill switch in `live-staleness.ts`, and the `lang:changed` subscription in
`url-state.ts`.

## Adding an experience — checklist

```
[ ] Add the entry to EXPERIENCES in src/registry/experiences.ts
[ ] Use REAL layer ids — copy them from src/registry/*.ts, not from memory
[ ] Every legendFilters / layerFilters entry has its base layers in layersOn
[ ] legendFilters values are bucket ids ("hydro"), not URL codes ("h")
[ ] Aerial stories stay at or under AERIAL_MAX_ZOOM
[ ] Category is one of ExperienceCategory and appears in EXPERIENCE_CATEGORY_ORDER
[ ] 2–4 takeaways; keywords for anything the title doesn't already say
[ ] A new MapExperience.state field is representable in assets/url-state-codec.ts
    (parseUrlState/formatUrlState) — a field the codec doesn't know reaches the
    map from the catalogue but never reaches a shared link; experiences.test.ts
    round-trips every preset through the codec and fails when one appears
[ ] npm test — experiences.test.ts checks the above against the live registry
```

Nothing else needs touching: the gallery groups by category, derives its
"3D Terrain" / "Live Data" / "Aerial" badges from the preset and the layer
registry, and the story card counts `Story n of N` from the array length.
