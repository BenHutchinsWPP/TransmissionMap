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
| `assets/experiences.ts` | Runtime controller: applies a preset, tracks the active story. No DOM. |
| `assets/ui/ui-experiences.ts` | Gallery dialog + floating story card. Lazy chunk. |

The last two are reached only by dynamic `import()` — from `ui-menubar.ts` on
the File-menu click, and from `ui.ts` when the hash carries `exp` — which keeps
the narratives out of the initial bundle.

## Applying a preset

`applyExperience(id, camera)` starts from `resetLayersToDefaults()` — the same
function the Reset button calls — so a story cannot inherit the leftovers of the
last one, and the two paths cannot drift apart.

It **hides** a live layer rather than shutting its feed down: `live-staleness.ts`
gates its refetch on the source existing, not on visibility, so once a story has
switched a live layer on that poller runs for the rest of the session.

Then, in order:

1. `map.stop()` — cancels whatever the last `flyTo` is still easing.
2. `switchBasemap()`. No projection call is needed — the reset above has already
   pinned the projection back to mercator, which is what a 3D story requires.
3. Filter/mode/colour-by/weather-variable state, then `setLayerVisibility()` for
   `layersOff` and `layersOn`.
4. `setTerrain3d()` / `setHillshade()`.
5. `syncWeatherLiveVisibility()` + `syncZoneVisibility()` — **these are the
   silent footgun.** `setLayerVisibility()` flips map layout visibility without
   dispatching the checkbox `change` event those two modules listen for, so a
   programmatic switch-on leaves wind particles stopped and alert zones
   unpainted until they're told by hand.
6. `emit('filter:all')`, `applyAllGenModes()`, the colour-by appliers,
   `buildLayersPanel()`, `buildLegends()`, and a control sync that ticks the
   basemap radios and 3D checkboxes (they fire on user input only).
7. `flyTo` (or `jumpTo` for a cold deep link — there is nothing to fly from).

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
[ ] npm test — experiences.test.ts checks the above against the live registry
```

Nothing else needs touching: the gallery groups by category, derives its
"3D Terrain" / "Live Data" / "Aerial" badges from the preset and the layer
registry, and the story card counts `Story n of N` from the array length.
