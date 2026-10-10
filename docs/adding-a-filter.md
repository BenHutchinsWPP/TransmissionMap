# Adding a Filter

> *A legend filter (checkbox chips) is buckets, one `FACETS` record, a URL
> code and a legend container — with no applier or event wiring to hand-write. A range filter (a slider, like MW or year) is a
> bigger job — see the last section. If you're not sure which you need, you
> want a legend filter.*
>
> *Worked example to read alongside this: the **NERC region** filter is the
> canonical legend filter. Follow `nerc` from `NERC_BUCKETS` in `buckets.ts` →
> its record in `FACETS` (`facets.ts`) → `FACET_APPLIERS` in `filters.ts` →
> `LEGEND_FILTERS` in `ui-legends.ts` and this doc will map straight onto real code.*

A filter narrows which features of a layer are drawn — voltage buckets,
fuel types, MW range, year. There are two kinds, and picking the right one
saves most of the work:

- **Legend filter** — checkbox chips tied to a legend (voltage, fuel,
  pipeline type, NERC region…). **Data-driven**: you add buckets and one
  `FACETS` record; the applier and the UI wiring come from it. Use this for
  anything that's a fixed set of categories with a legend.
- **Range / custom filter** — a slider or special control (MW range, year
  playback). Needs hand-written UI in `ui-filters.ts`. Use only when chips
  don't fit.

Most new filters are legend filters. This doc covers that path first.

The data flow is the same for both:

```
user clicks control  (assets/ui/ui-filters.ts)
   → updates state.legendFilters / state.layerFilters / state.mwFilter
   → calls cfg.apply() directly, then emit('url:write')   (state-bus.ts)
   → FACET_APPLIERS[key]() (assets/filters.ts) builds a MapLibre filter expr
   → map.setFilter(layerId, effectiveFilter(layerId))
```

(Generator controls — MW, fuel, status, year — all call the one shared
`applyGeneratorFilters()` directly.)

`effectiveFilter(layerId)` is the one filter a layer carries: its **base
filter** (the layer spec's own `filter`, registered by `applyLayerPlan()`) ∧ the
expression your apply function last built ∧ the view's `where` conditions for
the registry layer that owns it (`setWhere`, layers with a `dataset` only). So
a user filter never clobbers a structural one (e.g. "HV lines only"), and a
`where` change re-filters just that layer without re-running the appliers.
Write through `setBucketFilter` (or the module's `applyBucketFilterToLayers` helper over it) — never call
`map.setFilter` yourself (`assets/filters-where.test.ts` allowlists every call
site). Put a structural filter in the layer's plan spec as `filter:`;
`applyLayerPlan()` registers it as the base (`assets/layers/layer-plan.test.ts`
checks every layer).

---

## Legend filter (the common case)

### 1. Define buckets — `src/colors/buckets.ts`

The buckets *are* the chips a user sees — one per checkbox. Export a
`BucketDef[]` (id, label, swatch, `urlCode`); the value map in step 2 says which
raw feature-property values each bucket matches.

```ts
export const MYTHING_BUCKETS: BucketDef[] = [
  { id: "alpha", label: "Alpha", color: "#e11", urlCode: "a" },
  { id: "beta",  label: "Beta",  color: "#1a1", urlCode: "b" },
  // optional catch-all — buildValueFilterExpr treats id "other" as
  // "anything not in any other bucket's value list"
  { id: "other", label: "Other", color: "#888", urlCode: "o" },
];
```

`urlCode` must be unique **within this bucket set** (not globally). Skip
`urlCode` on a bucket to leave it out of the URL.

### 2. Feature values — `src/colors/buckets.ts`

Give each bucket in step 1 the feature values it matches
(`values: ["A", "A1"]`). The `other` catch-all takes no values: leave `values`
off it or give it `values: []` (PAD-US and retail do) — both build the same
filter. A bucket set where no bucket declares `values` matches each bucket id
as the literal feature value (the moratorium classes do this); an `other`
bucket there would match the literal string `"other"`. Code that needs the
bucket id → values map reads it off the facet — `facetValueMap(facet("mything"))`
(`src/colors/facets.ts`) — rather than a `*_MAP` exported beside the buckets.

### 3. Register the facet — `src/colors/facets.ts`

Add a record to `FACETS` (a `BucketedField`, `src/types.ts`). That is the whole
filter logic: `filters.ts` derives its applier into `FACET_APPLIERS`,
`ui-legends.ts` turns the record into a `LEGEND_FILTERS` row, and the checkbox
chips, the master toggle, the URL codec and the default view (`defaultView()`
seeds `state.legendFilters` from it) all read from there. The legend box
itself needs the four additions in step 3b:

```ts
{
  key:        "mything",                 // state.legendFilters.mything
  groupCode:  "x",                       // URL param char — MUST be globally unique
  buckets:    MYTHING_BUCKETS,
  field:      "the_field",               // feature property the buckets match
  mapLayerIds: ["my-layer-fill", "my-layer-outline"],   // or layerRef: "<registry id>"
  title: "My thing", titleKey: "legend.mything", swatch: "color",
  // defaultActive: [...]                // optional; default = all bucket ids on
  // DOM ids default to mythingAllCb / mythingLegend / mythingLegendItems
},
```

The derived applier compiles the active set with `compileBucketExpr` and writes
it to every map layer in `mapLayerIds` (or the `layerRef` registry layer's
`mapLayerIds`). `compileBucketExpr` routes a field that `BUCKET_FILTER_DATASETS`
maps to a `FIELD_SCHEMA` dataset through `toMapLibreFilter`; every other field,
and any set with the `other` catch-all active, goes to `buildValueFilterExpr`,
which builds an `["in", …]` expression, returns `null` when **all** buckets are
active (no filter = fast path), and treats `other` as "any value no bucket
lists", missing values included.

A new field needs no `FIELD_SCHEMA` or `BUCKET_FILTER_DATASETS` entry: leave it
out and the facet uses `buildValueFilterExpr`. `BUCKET_FILTER_DATASETS` is
keyed by field name alone, so check it before you pick `field`. A field already
listed there (`code`, `type`, `source`, …) is validated against that entry's
dataset; when your values fall outside its domain, the filter still works
through `buildValueFilterExpr`, but every apply records a `layer` diagnostic.

> `groupCode` collides in one flat URL namespace. Pick a char that's **not**
> already taken — see the reserved table in [url-state.md](url-state.md) and
> add yours to it. A `groupCode` equal to another param's char (e.g. `l`, the
> layer param) shares one `params.get()` slot with it, so the facet reads the
> other param's value.

### 3b. Show the legend

`buildLegendSection` (`assets/ui/ui-legends.ts`) fills an existing container
and `updateLegends` unhides it; with either piece missing the chips never show.

- **`index.html`** — inside `#legendContainer`, at the position matching the
  facet's place in `FACETS` (and `LEGEND_ROWS`), copy the `#nercLegend` block:
  a `<div class="legend collapsed" id="mythingLegend" hidden data-collapsible>`
  holding a `.legend-title` with an empty `<span class="legend-title-label">`
  and a `<div class="legend-items collapsible-content" id="mythingLegendItems">`.
  The ids must match the record's `legendId` (default `<key>Legend`).
- **`LEGEND_VISIBILITY`** (`assets/ui/ui-legends.ts`) — add
  `{ el: "mythingLegend", show: () => !!state.layerVisibility["my-layer"] }`.
  The key is the **registry layer id** (e.g. `control-areas`), not a map-layer
  id like `ba-fill`.
- **`titleKey`** — add the string to `src/i18n/locales/en.ts` **and every other
  file in `src/i18n/locales/`**; `src/i18n/i18n.test.ts` requires full key
  parity with English. Only the key is checked, so the other locales may carry
  the English text until translated. Reusing an existing key (NERC uses `popup.nercRegion`)
  needs no new string.
- **`LEGEND_ROWS`** (`src/colors/facets.test.ts`) — add the facet's snapshot
  row at the same position as its `FACETS` record (key, groupCode,
  `[id, urlCode]` buckets, masterId, legendId, itemsId, titleKey, title, swatch).

### 4. A non-standard facet: hand applier — `assets/filters.ts`

The derived applier covers a facet that is one field on map layers no other
facet filters. Write a hand applier and add it to `HAND_APPLIERS` (which feeds
`FACET_APPLIERS`) when the facet

- shares map layers with another facet — their expressions must be combined in
  one write, or each clobbers the other. One line does it:
  `applyFacetGroup(["ogfStatus", "ogfRegion", "ogfWork"])` combines the listed
  facets onto the first one's `mapLayerIds` (`applyOGFFilters`,
  `applyWestTECFilters`, `applyMinesFilter`: several keys, one function);
- targets registry layers by `filterType`/`group` rather than a fixed list
  (`applyVoltageFilter`, `applyGeneratorFilters`);
- needs a numeric range or a carve-out (`buildKvFilterExpr`, `buildEiaFuelExpr`);
- drives something besides `setFilter` (`applyNwsGroupFilter` also sets the
  zone-join feature-state).

Read the field, buckets and value map from the record (`facet(key)`,
`facetValueMap()`) rather than importing a bucket table by name, write through
`setBucketFilter` (or `applyBucketFilterToLayers`), keep the `state.mapReady`
guard, and export the function. `applyAllFilters()` runs every
`FACET_APPLIERS` function once, so there is no separate list to update; the
drift guard in `assets/filters.test.ts` fails when an exported `apply*Filter`
is neither in `FACET_APPLIERS` nor called by `applyAllFilters()`, and
`assets/filters-facets.test.ts` fails when a `FACETS` key has no applier.

### 5. Emit on change

For a standard legend, **nothing to wire** — `wireLegendFilters()` in
`ui-filters.ts` already delegates by `data-legend-key` for every chip and
master checkbox, calls `cfg.apply()`, and emits `url:write`. The row builder in
`ui-legends.ts` writes `data-legend-key="mything"` and each chip's
`data-bucket-id="…"` from your record.

### Checklist

```
[ ] src/colors/buckets.ts     — BUCKETS array (+ urlCodes, values)
[ ] src/colors/facets.ts      — FACETS record (key, groupCode, buckets, field,
                                mapLayerIds | layerRef, title, titleKey, swatch)
[ ] index.html                — #<key>Legend / #<key>LegendItems container (step 3b)
[ ] assets/ui/ui-legends.ts   — LEGEND_VISIBILITY entry for the legend id
[ ] src/i18n/locales/*.ts     — titleKey string in every locale (unless reused)
[ ] src/colors/facets.test.ts — LEGEND_ROWS snapshot row, same position as FACETS
[ ] docs/url-state.md         — claim the new groupCode in the reserved table
                                and the groupCode assignments list
[ ] assets/filters.ts         — only for a non-standard facet (step 4):
                                hand applier + HAND_APPLIERS entry
```

---

## Range / custom filter (MW, year — the rare case)

No legend config. You hand-write the control wiring in `ui-filters.ts` (see
`wireMwFilter` / `wireYearFilter` as templates) and a `build*FilterExpr` in
`filters.ts` that returns a numeric MapLibre expression. Key points from the
existing two:

- Keep the **canonical value in `state`** (actual MW, actual year); convert at
  the control boundary only. The MW slider is log-scaled — `state` stores real
  MW, `mwPosToMw`/`mwToPos` convert at the slider edge.
- Generator filters are combined per-layer in `applyGeneratorFilters`
  (fuel + MW + status + year all `combineFilters`'d together), not via the
  generic `applyBucketFilterToLayers` path. A new gen-scoped range filter slots in
  there.
- Still call `applyGeneratorFilters()` (or your apply) **and** emit `url:write`
  on every change, and persist it in the codec — see [url-state.md](url-state.md).
- Your `url:write` emit is what puts the control on the undo stack
  ([ADR-0004](adr/0004-undo-replays-url-write-snapshots.md)). On a range
  slider, apply on `input` but emit `url:write` on `change`, as the MW, year
  and smoke sliders do, so one drag is one undo step however slow it is.
- Paint the control's value from `state` in `syncPanel()` in
  `assets/ui/panel-mirror.ts` (see the MW and year sliders there), not in its
  HTML template or its wire function. That one line is what makes Reset, Undo,
  a story or a link show the value; the input handler only writes state.
- The year filter also drives playback (`setInterval` stepping the year). If
  your control animates, mirror `toggleYearPlayback`/`stopYearPlayback` and
  make sure playback ticks emit the filter event but **not** `url:write` on
  every frame (only on start/stop) — otherwise the URL thrashes.
