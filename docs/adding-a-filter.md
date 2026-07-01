# Adding a Filter

> *A legend filter (checkbox chips) is a ~6-file change, around half an hour,
> with no new UI to hand-write. A range filter (a slider, like MW or year) is a
> bigger job — see the last section. If you're not sure which you need, you
> want a legend filter.*
>
> *Worked example to read alongside this: the **voltage** filter is the
> canonical legend filter. Follow `kv` through `buckets.ts` → `filters.ts`
> (`applyVoltageFilter`/`buildKvFilterExpr`) → `LEGEND_FILTERS` in
> `ui-legends.ts` and this doc will map straight onto real code.*

A filter narrows which features of a layer are drawn — voltage buckets,
fuel types, MW range, year. There are two kinds, and picking the right one
saves most of the work:

- **Legend filter** — checkbox chips tied to a legend (voltage, fuel,
  pipeline type, NERC region…). Almost entirely **data-driven**: you add a
  config object and an `apply` function, no new UI wiring. Use this for
  anything that's a fixed set of categories with a legend.
- **Range / custom filter** — a slider or special control (MW range, year
  playback). Needs hand-written UI in `ui-filters.ts`. Use only when chips
  don't fit.

Most new filters are legend filters. This doc covers that path first.

The data flow is the same for both:

```
user clicks control  (assets/ui/ui-filters.ts)
   → updates state.legendFilters / state.layerFilters / state.mwFilter
   → emit('filter:X')  and  emit('url:write')          (state-bus.ts)
   → applyXFilter()    (assets/filters.ts) builds a MapLibre filter expr
   → map.setFilter(layerId, combineFilters(baseFilter, bucketExpr))
```

`combineFilters` always re-applies the layer's **base filter** (registered via
`registerBaseFilter` at layer-add time) so a user filter never clobbers a
structural one (e.g. "HV lines only").

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

### 2. Value map + apply function — `assets/filters.ts`

```ts
const MYTHING_MAP = {
  alpha: ["A", "A1"],          // feature prop value(s) → bucket id
  beta:  ["B"],
};

export function applyMyThingFilter() {
  applyBucketFilterToLayers(
    ["my-layer-fill", "my-layer-outline"],  // every mapLayerId to filter
    "the_field",                            // feature property to read
    state.legendFilters.mything,            // active set (state key = legend key)
    MYTHING_BUCKETS, MYTHING_MAP);
}
```

`applyBucketFilterToLayers` → `buildValueFilterExpr` builds an `["in", …]`
expression, returns `null` when **all** buckets are active (no filter = fast
path), and special-cases the `other` bucket as a negation.

> Voltage (`buildKvFilterExpr`) and fuel (`buildEiaFuelExpr`) are bespoke —
> they handle numeric ranges and the hydro/pumped-storage carve-out. Copy the
> generic value-map path unless your filter is genuinely range-based.

### 3. Bus subscriptions — `assets/filters.ts` (bottom of file)

Two edits, both required:

```ts
on('filter:mything', applyMyThingFilter);   // direct apply
on('filter:all', () => {
  …existing…
  applyMyThingFilter();                      // ← also call inside filter:all
});
```

**Forgetting the `filter:all` line is the classic bug:** the filter works
when toggled but silently resets/disappears after the Reset-layers button or a
fresh URL load, because `filter:all` re-applies everything and yours isn't in
the list.

### 4. Register the legend filter — `assets/ui/ui-legends.ts`

Add a config to `LEGEND_FILTERS`. This is what makes it data-driven — the
legend HTML, the checkbox chips, the URL codec, and the master toggle all read
from here:

```ts
{
  key:        "mything",                 // matches state.legendFilters.mything
  legendId:   "mythingLegend",           // the legend container in index.html
  groupCode:  "x",                       // URL param char — MUST be globally unique
  buckets:    MYTHING_BUCKETS,
  apply:      applyMyThingFilter,
  // defaultActive: [...]                // optional; default = all bucket ids on
},
```

> `groupCode` collides in one flat URL namespace. Pick a char that's **not**
> already taken — see the reserved table in [url-state.md](url-state.md) and
> add yours to it. This exact collision (`groupCode: "l"` vs the layer param)
> silently broke a filter once.

### 5. Seed default state — `assets/state.ts`

`state.legendFilters.mything` must exist as a `Set` before any apply runs (the
apply functions read `.size`). Initialize it where the other legend-filter sets
are seeded (all-buckets-active by default, or your `defaultActive`).

### 6. Emit on change

For a standard legend, **nothing to wire** — `wireLegendFilters()` in
`ui-filters.ts` already delegates by `data-legend-key` for every chip and
master checkbox, calls `cfg.apply()`, and emits `url:write`. Just make sure the
legend HTML carries `data-legend-key="mything"` and each chip
`data-bucket-id="…"` (the row builder in `ui-legends.ts` does this from your
config).

### Checklist

```
[ ] src/colors/buckets.ts     — BUCKETS array (+ urlCodes)
[ ] assets/filters.ts         — value map + applyMyThingFilter()
[ ] assets/filters.ts         — on('filter:mything', …) AND add to on('filter:all', …)
[ ] assets/ui/ui-legends.ts   — LEGEND_FILTERS config (key, groupCode, buckets, apply)
[ ] assets/state.ts           — seed state.legendFilters.mything as a Set
[ ] docs/url-state.md         — claim the new groupCode in the reserved table
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
  generic `applyBucketFilterToLayers`. A new gen-scoped range filter slots in
  there.
- Still emit `filter:generators` (or your event) **and** `url:write` on every
  change, and persist it in the codec — see [url-state.md](url-state.md).
- The year filter also drives playback (`setInterval` stepping the year). If
  your control animates, mirror `toggleYearPlayback`/`stopYearPlayback` and
  make sure playback ticks emit the filter event but **not** `url:write` on
  every frame (only on start/stop) — otherwise the URL thrashes.
