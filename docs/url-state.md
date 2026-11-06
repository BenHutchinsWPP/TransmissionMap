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
  `parseUrlState` also returns `dropped` — what an untrusted `vx` carried that
  failed validation.
- **`assets/view-state.ts`** — how a view gets into the app: `seedView()` on
  cold boot, `applyView()` on a live map (Reset, Map Experiences),
  `currentView()` for writing the link. Both entry points resolve their input
  over `defaultView()`.
- **`assets/url-state.ts`** — side-effectful glue. `readUrlState()` parses the
  hash and hands it to `seedView()`; `writeUrlState()` writes `currentView()` back to the hash via
  `history.replaceState`. Subscribes to the `url:write` bus event — anything
  that changes shareable state emits `url:write` and the URL updates.
  The emit marks a finished action, so it lives in the control or in a commit setter
  (`setLayerVisibility`, `commitArea`/`commitSelection`/`commitWhere`), never in a plain state setter.

---

## The reserved-char rule (read before adding any param)

Every param is a **single char** (a few are two). They live in one flat
`URLSearchParams` namespace, so **a new code must not collide with an existing
one** — `params.get("l")` can only return one thing.

A collision fails silently: were a legend filter given `groupCode: "l"`, the
same char as the layer-visibility param, `get("l")` would return the layer
string and the filter would never save or restore, with no error raised.

### Currently taken

| Code | Meaning | Defined in |
|---|---|---|
| `l`  | layer visibility delta | codec, `formatUrlState` |
| `mw` | MW range | codec |
| `y`  | generator year filter | codec |
| `gm` | generator display mode (icons/heat/both) | codec, via `genModeCode` |
| `oc` | OGF planned-lines color-by (`r`=region, `s`=status) | codec, `OC_*` maps |
| `wc` | WestTEC 10 Yr color-by (`s`=scenario, `d`=dataset) | codec, `WC_*` maps |
| `nr` | FEMA National Risk Index hazard (the NRI field prefix, lowercased: `wfir`, `hrcn`, …) | codec, `NRI_HAZARDS` in `registry/conditions.ts` |
| `rc` | Routing constraints concern (a `CONCERNS` id: `floodplain`, `land-manager`, …; dev server only, like the layer; an id keeps its cells and is never renamed) | codec, `CONCERNS` in `src/colors/route-constraints.ts` |
| `wv` | Weather Forecast variable dropdown (`t`=Temperature, `tw`=Temp & Wind, `w`=Wind, `ws`=Windstream, `g`=Gust, `h`=Humidity, `d`=Dew Point, `c`=Cloud, `p`=Pressure) | codec, `WEATHER_VARIABLES` in `registry/conditions.ts` |
| `so` | Fire smoke opacity (integer percent, `0`–`100`) | codec |
| `bm` | basemap | codec, `BM_*_CODE` maps |
| `pj` | projection (`g` = globe) | codec |
| `3d` | 3D terrain/buildings (`t`=terrain, `b`=buildings, `tb`=both) | codec |
| `hs` | hillshade (2D shaded relief) | codec |
| `lb` | basemap labels (`0` = off; on is the default and is omitted) | codec |
| `gt` | Grid Operations hour: UTC hour-ending as `YYYYMMDDHH` (omitted = the latest hour the data holds) | codec |
| `gg` | Grid Operations grouping (`r` = EIA region, `i` = interconnection, `w` = WECC area; by BA is the default and omitted) | codec, `GG_*` maps |
| `gd` | Grid Operations glyph (`d` = fuel discs; bubbles are the default and omitted) | codec |
| `gn` | Grid Operations numbers on bubbles (`1` on, `0` off; omitted = auto: on, except off when grouped by WECC area) | codec |
| `lang` | Language selection (`es`, `fr`, `de`, `zh`, etc.) | codec, `formatUrlState` |
| `region` | Layer-list scope (`global` only; `usa` is the default and is omitted) | codec, `VALID_REGIONS` |
| `af` | Area filter: a kind char then its codes, `.`-separated (`af=s.NM.TX`; kinds `s` states, `c` counties, `b` BA, `n` NERC, `u` retail, `k` countries, `a` admin-1) | codec, `AREA_KIND_CODES` in `registry/area-filter.ts` |
| `vx` | View `where` + `style` + `sel` + `sv` (linked services) sections, one compact encoded value (see below) | codec, `encodeVx`/`decodeVx` |
| `exp` | Active Map Experience slug (`columbia-hydro`, …) | codec (parse) + `url-state.ts` (pristine check); catalogue in `registry/experiences.ts` |
| `s`  | generator status filter | `filterGroupCode` in `registry/generators.ts` |
| `v f p h j t n r c e g u b m k d i o q x z a` | legend-filter `groupCode`s | `FACETS` in `src/colors/facets.ts` |

Per-layer bucket filters use `filterGroupCode` (currently only `s`), read as a
top-level param the same way — so they share the same key namespace as
everything above.

Legend-filter `groupCode` assignments: `v`=voltage, `f`=fuel, `p`=pipeline,
`h`=crithab, `j`=padus, `t`=tribal, `n`=natgasLine, `r`=natgasPts, `c`=nerc,
`e`=retail, `g`=ogfStatus, `u`=substance (OSM pipeline commodity),
`b`=ogfRegion, `m`=ogfWork (OGF type of work), `k`=mines (commodity),
`d`=minesStatus, `i`=sector (EIA Plants sector), `o`=underground (line placement,
overhead/underground), `q`=nwsGroup (NWS weather alert group), `x`=westtecScenario,
`z`=westtecDataset, `a`=dcm (data center moratorium status).

> **Pick a code in none of the rows above.** When you take one, add it here and
> to the table the same commit, or the next person re-collides.

Within a single param the **values** are also coded chars (e.g. basemap
`l/d/v/t/a`, gen mode `i/h/b`, each bucket's `urlCode`). Those share no
namespace with the param keys, so a bucket `urlCode: "l"` is fine — only the
top-level param keys must be globally unique.

A retired bucket `urlCode` stays readable through `LEGACY_BUCKET_CODES` in
`assets/url-state-codec.ts` (parse only — links are always written with the
current codes), and is not reused within its param:

| Param | Retired code | Reads as |
|---|---|---|
| `g` | `N` (conceptual) | `planning` (`L`) |

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
| Routing constraints concern | `rc` | `what-constrains` (an unknown id is dropped with a reason, as `af` is) |
| Fire smoke opacity | `so` | `100` |
| 3D terrain/buildings | `3d` | both off |
| Hillshade | `hs` | off |
| Basemap labels | `lb` | on |
| Grid Operations hour / grouping / glyph / numbers | `gt` / `gg` / `gd` / `gn` | latest hour / by BA / bubbles / auto |
| Language | `lang` | `en` |
| Area filter | `af` | no area (every feature draws) |
| Feature conditions + style overrides + selection + linked services | `vx` | `where` and `style` empty, no selection, no services |
| Map Experience | `exp` | no experience active, **or** the view edited away from one |

### `vx` — the compact param

`where` (registry id → `Condition[]`), `style` (registry id →
`StyleOverride`), `sel` (the selection) and `sv` (linked GIS services) are
nested, so they share one param rather than extending the flat codec. A link without any of them has no `vx`,
so older links are byte-identical.

- **Value** = one marker char + base64url (no padding) of the UTF-8 JSON
  `{"s":{…},"sel":{"ids":{…},"m":"i"},"sv":[…],"v":1,"w":{…}}`. Marker `j`: the JSON bytes as they are; `z`: raw
  deflate (`fflate` `deflateSync`), chosen only when it is shorter — which is
  almost always. `w`/`s`/`sel`/`sv` are left out when empty.
- **Keys are sorted at every level**, so the same view always formats to the
  same string — the `exp` pristine check below is a plain string compare.
  `vx` is formatted just before `exp`. The encoded string is cached against
  its JSON, since the link is rewritten on every `moveend`.
- **Versioning:** `v` is 1. Any other value drops the whole param; there is no
  migration code until a v2 ships with its own. A build
  that does not know a section drops it and opens the rest of the link.
- **Decoding is a trust boundary** (`decodeVx`): the param is capped at 8,192
  chars before anything else (a view file's hash may run to 16 KB, so view files
  open with a 16,384-char cap through `parseUrlState(params, { vxMaxChars })`);
  deflate is inflated with `fflate`'s streaming
  `Inflate` in 64-byte pushes and abandoned once the output passes 64 KB; base64
  and `JSON.parse` failures are caught. Each `w` entry must be a list of
  literal-valued `{field, op, value}` conditions passing `validateWhere()`; each `s` entry must pass `validateStyleOverride()`
  (both in `src/registry/view-validate.ts`). A bad entry drops only itself, a bad payload drops
  only `vx`, and the rest of the link applies.
- **`sel` — the selection.** `m` is the mode — `i` isolate (a listed layer
  draws only its selected features, within its filters), `k` keep (its filtered
  features plus every selected one its style layer's own base filter — geometry,
  voltage tier — admits; `assets/filters.ts` `effectiveFilter()`); `ids` maps a registry id to the stable ids
  (`data.id`, `assets/feature-id.ts`) of its selected features, deduplicated and
  sorted. Only a layer with a `dataset` and a stable id takes one; the mode
  touches only the listed layers. An id is a safe integer (on an OSM layer, a
  `fid` with type digit 1–3; a native tile id is always a number) or a string
  of 1–64 characters with no control characters. A bad layer entry drops only
  itself (`vx.sel.<id>`); a bad mode, an unknown key or more than 500 ids in all
  drops the selection (`vx.sel`). 500 OSM ids encode to ~4.3 KB, under the
  8,192 cap and past the 2,000-char share target (~200 OSM ids), so a large
  selection takes the `toast.linkTooLarge` path below.
- **`sv` — linked services.** A list, in view order, one entry per service
  (`src/registry/view-validate.ts` `serviceLinkEntry` / `serviceFromLinkEntry`):

  | Key | Field | Notes |
  |---|---|---|
  | `i` | id | 1–32 of `[A-Za-z0-9_-]`; distinct |
  | `u` | url | normalised (`normaliseServiceUrl`: https, origin + path, no query; ArcGIS layer / op tails folded), ≤ 1,024 chars |
  | `k` | kind | `geojson`, `arcgis-feature`, `arcgis-export`, `arcgis-image`, `wms`, `xyz`, `pmtiles-raster` |
  | `y` | layer | ArcGIS layer index or WMS layer name(s); absent when none |
  | `v` | WMS version | `1.1.1` only; absent = 1.3.0 |
  | `st` | style | a `ServiceStyle` of scalars (`validateStyle`) — never an expression |
  | `t` | title | ≤ 200 chars; absent when it equals the host |
  | `c` | credit | ≤ 300 chars; absent when it equals the host |
  | `h` | hidden | `1` when the service is switched off; absent when shown |
  | `l` | library id | provenance only; trust comes from the URL. Kept only when `u`, `k` and `y` match that library entry (checked once the library loads); a kept one shows the library's own title and credit, not `t`/`c` |

  Every field a view holds is in the entry, because Undo replays the link form;
  `host` is derived from `u`. A library entry carries its full spec beside `l`: the library loads by dynamic
  import and a link decodes synchronously on cold boot. Map Experiences name
  library services only (`assets/experiences.test.ts` § 1). Entry keys are local
  to `sv` and share no namespace with the top-level params.
  **Caps:** at most 5 services, and the link form's `JSON.stringify` at most
  3,000 UTF-8 bytes before deflate (bytes, not characters: a CJK title counts
  three bytes a character). On decode each entry is checked on its own with
  `validateLinkedService`: a bad entry, a sixth, a repeated id or one that takes
  the kept entries past 3,000 bytes drops only itself (`vx.sv.<n>`, n its index);
  a non-list drops `vx.sv`. The setters (`setServices` / `addService` in
  `assets/view-state.ts`, through `validateServices`) refuse the same list
  whole with a message, so a view never holds what a link cannot carry. Five
  services at the byte cap beside `where`, `style` and a full 500-id selection
  fit inside the 8,192 cap (`assets/url-state-sv.test.ts`).
  **Trust:** a link, a view file, an Undo or a story may name any https URL;
  `renderServices()` fetches a service only when its URL is vetted
  (`service-hosts.ts` `isVetted`) or in the session's approved set
  (`assets/services/service-trust.ts`, `sessionStorage` `tm-svc-approved`,
  grown only by the visitor's Add, Load or a confirmed chat call). Any other
  entry stays in the view as *pending* (`pendingServices()`): it keeps its
  place in the hash across the boot write and reloads, and draws nothing until
  Load (`approveAndLoad`). Skip (`skipService`) removes it with one `url:write`;
  an Undo brings it back, still pending in a new session. Reset clears `sv`.
- **What was dropped** comes back as `parseUrlState()`'s `dropped` list;
  `readUrlState()` holds it, and `paintLinkedView()` (called from `map.ts`'s
  load handler) adds the style keys the map could not take, then shows one
  non-blocking notice (`toast.linkDropped`) and logs the reasons to the console.
- **Region conditions.** The region fields (`states`, `counties`, `ba`, `nerc`,
  `retail`, `countries`, `admin1`) hold wrapped lists such as `|TX|NM|`. They
  take `contains` (one code) and `contains_any` (up to 100 codes) and no other
  operator; a code is matched exactly, so `USA1` never matches `|USA10|`. The
  code `none` also matches a feature whose key is absent. Codes are checked
  against each field's domain in `src/registry/field-schema.ts`.
- **Number conditions.** `=`, `<`, `<=`, `>`, `>=` and `in` on a number field
  match only a feature that has a value, so `output_mw < 10` counts no plant
  without a capacity; `!=` and `not_in` still match one.
- **What `where` and the area reach.** Map layers, click, hover and
  copy-to-My-Data use the filter; feature search lists only what the map draws.
  My Data layers are never filtered by `where` or the area.
- Size: a view with three `where` layers and five style entries encodes to
  ~340 chars, well inside the 2,000-char link target. A view whose `vx` passes
  8,192 chars is still written, with one notice per session
  (`toast.linkTooLarge`) pointing to File ▸ Save ▸ Save view; the view file carries it.

### `af` — the Area filter

One map-wide area scopes every layer that carries a matching region field.
The value is a kind char, then its codes, all `.`-separated: `af=s.NM.TX`.

| char | kind | codes |
|---|---|---|
| `s` | states | USPS (`TX`) |
| `c` | counties | 5-digit GEOID (`48201`) |
| `b` | BA | EIA balancing authority abbreviation (`ERCO`) |
| `n` | NERC | region code (`TRE`) |
| `u` | retail | retail territory id |
| `k` | countries | ISO3 (`FRA`) |
| `a` | admin-1 | short code from `scripts/admin1_codes.csv` |

- One kind per area, 1 to 100 codes, formatted sorted so equal views give equal links.
- Codes are `[0-9A-Za-z_]`, so `.` is a safe separator. A bad kind or code
  drops the whole `af` with a reason in `parseUrlState()`'s `dropped`; it is
  never half applied.
- `af` is formatted before `vx` and `exp`. It is a view field: Undo, Reset,
  stories and view files carry it, and `writeUrlState()` runs after the picker
  commits through `commitArea()`.

### `exp` carries a runtime condition

Every other param is a pure function of state. `exp` is written only while the
view still matches the story: `writeUrlState()` formats the other params first
and hands that string to `noteUrlWrite()` (`assets/experience-link.ts`), which
compares it against the snapshot recorded by the first write after the story
began. An edit marks the story dirty, emits `exp:dirty`, and drops `exp` from
the link for the rest of the session. The camera is outside the comparison, so
panning inside a story keeps the link on the story — and a shared `exp` link
opens at the story's camera, not the hash's.

The "omit the default" rule is what keeps links short. It also means **both
sides must agree on the default** — `formatUrlState` skips a value when it
equals the default, and a missing param resolves to the default. Both read it
from `defaultView()`, so there is one place to change it.

---

## View files

File ▸ Save ▸ Save view downloads `map-view.tmview.json`:
`{"format":"tmview","v":1,"title":…,"note":…,"hash":…}`, where `hash` is exactly
the address-bar hash (`url-state.ts`'s `currentHash()`). File ▸ Open ▸ View file treats a
`.json` as a view file when its `format` is `tmview` (or its name ends in
`.tmview.json`); anything else goes to the GeoJSON importer as before. A view
file is untrusted input: `v` must be 1, `hash` a string of at most 16 KB, and
the hash runs through the same codec as a link (`splitHash`, `parseUrlState`,
`parseCameraSegment`) before `applyView()`. Dropped settings show the one
link notice. A hash naming a known `exp` restores that story; any other file ends
the active story first. `lang` in the file is ignored: language is the viewer's
choice once the app is open. Code: `assets/user-data/view-file.ts`.

---

## Undo

`assets/undo.ts` records a view snapshot on every `url:write` — the link params,
`formatUrlState(currentView()).join('&')` — and undo replays one through
`applyView()`. The rationale is in the `undo.ts` header.

| On the stack | Not on the stack |
|---|---|
| every param a control commits with `url:write`: layers, filters, `where`, `style`, linked services, basemap, labels, 3D, region | camera — `map.ts` calls `writeUrlState()` on `moveend`, not `url:write` |
| a whole `applyView()` as one step: Reset, a story, an opened view file | `lang` — not in the snapshot; a language change adds no step |
| stale-feed switches (`live-staleness.ts`, `odin-outages.ts`) | `exp` — undo never opens or closes a story; a restore marks an open story Modified |

Writes within 400 ms of each other merge into one step (bursts such as
keyboard steps on a slider). A range slider paints on `input` and emits
`url:write` only on `change`, so one drag is one step at any speed; the stack
holds 50. Keys and File ▸ Undo / Redo: `assets/ui/ui-menubar.ts`.

---

## Adding a new shareable param — checklist

```
[ ] Pick an unused key char (see reserved table above)
[ ] url-state-codec.ts: parse it in parseUrlState()  (params.get → state)
[ ] url-state-codec.ts: give it a default in defaultView(), and emit it in formatUrlState()
    (state → key=val) only when it differs from that default
[ ] view-state.ts: if it's a new state field, merge it in resolve(), write it in
    writeState() (or through its setter in both seedView() and applyView(),
    a setter that writes state before its map guard), read it in currentView()
[ ] Emit 'url:write' wherever the value changes (usually assets/ui/ui-*.ts) —
    the emit is also what puts the change on the undo stack
[ ] Add the char to the reserved table in this doc
```

Bucket/legend filters need none of the codec edits — they're data-driven from
`LEGEND_FILTERS` / `filterBuckets`. You only pick a `groupCode` and give each
bucket a `urlCode`; the codec loops over the registry. See
[adding-a-filter.md](adding-a-filter.md).
