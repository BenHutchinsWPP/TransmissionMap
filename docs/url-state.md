# URL State — the shareable map link

> *Read this if you're touching how the map link is built, or adding any new
> piece of state that should survive a page reload / be shareable. The one
> thing you must not skip: the **reserved-char rule** below — getting a param
> code wrong fails silently, with no error to tell you.*

The map serializes its whole view into the URL hash so a link reproduces it
exactly. Format:

```
#<zoom>/<lat>/<lng>[/<bearing>/<pitch>]?<param>=<val>&<param>=<val>…
```

`bearing`/`pitch` (rotation/tilt) are appended only when the view isn't flat
and north-up — a 3-segment hash means bearing=0, pitch=0. This keeps the
common link short while still round-tripping a rotated or tilted 3D view.

e.g. `#5.20/39.8283/-98.5795?l=-SUB.WND&v=550+&bm=d`
e.g. rotated/tilted: `#12.40/39.8283/-98.5795/34.5/52.0?3d=t`

Everything after `?` is a compact param string. State that equals the default
is **omitted** — a default view has a bare `#zoom/lat/lng` and no query.

Two files, split by side effects:

- **`assets/url-state-codec.ts`** — pure parse/format. No globals, no
  `location`/`history`. `parseUrlState(params)` → partial state object;
  `formatUrlState(state)` → array of `key=val` strings. This codec is also the
  serialisation format a Map Experience preset must fit
  (`assets/experiences.test.ts` round-trips every preset through
  `formatUrlState`/`parseUrlState`) — so a param's parse/format behaviour is
  load-bearing for stories as well as for shared links. See
  [map-experiences.md](map-experiences.md). `defaultView()` here is the value
  of every field when a link omits it. The camera segment lives here too:
  `splitHash(hash)` → `{ camera, params }` (the one place the hash is split —
  `map.ts`, `url-state.ts` and `ui.ts` all call it), and
  `parseCameraSegment`/`formatCameraSegment` read and write `zoom/lat/lng[/bearing/pitch]`.
- **`assets/view-state.ts`** — how a view gets into the app: `seedView()` on
  cold boot, `applyView()` on a live map (Reset, Map Experiences),
  `currentView()` for writing the link. Both entry points resolve their input
  over `defaultView()`.
- **`assets/url-state.ts`** — side-effectful glue. `readUrlState()` parses the
  hash and hands it to `seedView()`; `writeUrlState()` writes `currentView()` back to the hash via
  `history.replaceState`. Subscribes to the `url:write` bus event — anything
  that changes shareable state emits `url:write` and the URL updates.

---

## The reserved-char rule (read before adding any param)

Every param is a **single char** (a few are two). They live in one flat
`URLSearchParams` namespace, so **a new code must not collide with an existing
one** — `params.get("l")` can only return one thing.

This bit us once: a PAD-US legend filter was given `groupCode: "l"`, the same
char as the layer-visibility param. `get("l")` returned the layer string, the
filter never saved or restored, silently. No error — just broken state.

### Currently taken

| Code | Meaning | Defined in |
|---|---|---|
| `l`  | layer visibility delta | codec, `formatUrlState` |
| `mw` | MW range | codec |
| `y`  | generator year filter | codec |
| `gm` | generator display mode (icons/heat/both) | codec, via `genModeCode` |
| `oc` | OGF planned-lines color-by (`s`=status, `w`=scenario, `a`=planauth) | codec, `OC_*` maps |
| `wc` | WestTEC 10 Yr color-by (`s`=scenario, `d`=dataset) | codec, `WC_*` maps |
| `nr` | FEMA National Risk Index hazard (the NRI field prefix, lowercased: `wfir`, `hrcn`, …) | codec, `NRI_HAZARDS` in `registry/conditions.ts` |
| `wv` | Weather Forecast variable dropdown (`t`=Temperature, `tw`=Temp & Wind, `w`=Wind, `ws`=Windstream, `g`=Gust, `h`=Humidity, `d`=Dew Point, `c`=Cloud, `p`=Pressure) | codec, `WEATHER_VARIABLES` in `registry/conditions.ts` |
| `so` | Fire smoke opacity (integer percent, `0`–`100`) | codec |
| `bm` | basemap | codec, `BM_*_CODE` maps |
| `pj` | projection (`g` = globe) | codec |
| `3d` | 3D terrain/buildings (`t`=terrain, `b`=buildings, `tb`=both) | codec |
| `hs` | hillshade (2D shaded relief) | codec |
| `lang` | Language selection (`es`, `fr`, `de`, `zh`, etc.) | codec, `formatUrlState` |
| `region` | Layer-list scope (`global` only; `usa` is the default and is omitted) | codec, `VALID_REGIONS` |
| `exp` | Active Map Experience slug (`columbia-hydro`, …) | codec (parse) + `url-state.ts` (pristine check); catalogue in `registry/experiences.ts` |
| `s`  | generator status filter | `filterGroupCode` in `registry/generators.ts` |
| `v f p h j t n r c e g u w a k d i o q x z` | legend-filter `groupCode`s | `LEGEND_FILTERS` in `ui-legends.ts` |

Per-layer bucket filters use `filterGroupCode` (currently only `s`), read as a
top-level param the same way — so they share the same key namespace as
everything above.

Legend-filter `groupCode` assignments: `v`=voltage, `f`=fuel, `p`=pipeline,
`h`=crithab, `j`=padus, `t`=tribal, `n`=natgasLine, `r`=natgasPts, `c`=nerc,
`e`=retail, `g`=ogfStatus, `u`=substance (OSM pipeline commodity),
`w`=ogfScenario (WestTEC Portfolio), `a`=ogfPlanAuth, `k`=mines (commodity),
`d`=minesStatus, `i`=sector (EIA Plants sector), `o`=underground (line placement,
overhead/underground), `q`=nwsGroup (NWS weather alert group), `x`=westtecScenario,
`z`=westtecDataset.

> **Pick a code in none of the rows above.** When you take one, add it here and
> to the table the same commit, or the next person re-collides.

Within a single param the **values** are also coded chars (e.g. basemap
`l/d/v/t/a`, gen mode `i/h/b`, each bucket's `urlCode`). Those share no
namespace with the param keys, so a bucket `urlCode: "l"` is fine — only the
top-level param keys must be globally unique.

---

## How each kind of state round-trips

| State | Param | Default that gets omitted |
|---|---|---|
| Layer on/off | `l` | layer at its `defaultOn` — only the **delta** is encoded (`-CODE` = forced off, `CODE` = forced on) |
| Legend filter | `groupCode` | all buckets active (or the filter's `defaultActive`) |
| Per-layer bucket filter | `filterGroupCode` | all buckets with `default !== false` |
| MW range | `mw` | `0-MW_SLIDER_MAX` |
| Year | `y` | filter disabled |
| Gen mode | `gm` | `icons` |
| Basemap | `bm` | `light` |
| Projection | `pj` | mercator |
| Weather variable | `wv` | `tempwind` |
| FEMA NRI hazard | `nr` | `risk` (the composite) |
| Fire smoke opacity | `so` | `100` |
| 3D terrain/buildings | `3d` | both off |
| Hillshade | `hs` | off |
| Language | `lang` | `en` |
| Map Experience | `exp` | no experience active, **or** the view edited away from one |

### `exp` carries a runtime condition

Every other param is a pure function of state. `exp` is written only while the
view still matches the story: `writeUrlState()` formats the other params first
and compares that string against the snapshot `assets/experiences.ts` left in
`state.experiencePristine`. An edit sets `state.experienceDirty`, emits
`exp:dirty`, and drops `exp` from the link for the rest of the session. The
camera is outside the comparison, so panning inside a story keeps the link on
the story — and a shared `exp` link opens at the story's camera, not the hash's.

The "omit the default" rule is what keeps links short. It also means **both
sides must agree on the default** — `formatUrlState` skips a value when it
equals the default, and a missing param resolves to the default. Both read it
from `defaultView()`, so there is one place to change it.

---

## Adding a new shareable param — checklist

```
[ ] Pick an unused key char (see reserved table above)
[ ] url-state-codec.ts: parse it in parseUrlState()  (params.get → state)
[ ] url-state-codec.ts: give it a default in defaultView(), and emit it in formatUrlState()
    (state → key=val) only when it differs from that default
[ ] view-state.ts: if it's a new state field, merge it in resolve(), write it in
    writeState() (or through its setter in applyView()), read it in currentView()
[ ] Emit 'url:write' wherever the value changes (usually assets/ui/ui-*.ts)
[ ] Add the char to the reserved table in this doc
```

Bucket/legend filters need none of the codec edits — they're data-driven from
`LEGEND_FILTERS` / `filterBuckets`. You only pick a `groupCode` and give each
bucket a `urlCode`; the codec loops over the registry. See
[adding-a-filter.md](adding-a-filter.md).
