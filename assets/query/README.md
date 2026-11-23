Map of this folder; each file's header comment is the source of truth.

- `dataset-core.ts` — the state-free half of `dataset-query.ts`: the feature test, the row, group and
  shape passes over in-memory rows, `DISPLAY_FIELDS`, the result types, and the one place the scope and
  `complete` rules live (`readFrom`, `coverageOf`, `rowSource`); imports no module that reaches `state.ts`
- `dataset-view.ts` — the map reads of `dataset-query.ts` (`drawnFilters`, `drawnView`, `featuresOf`, the
  base filters and hidden voltage tiers); imports `state.ts`
- `dataset-query.ts` — a `dataset` layer's features as rows: `describe`, async
  `query`/`count`/`aggregate` (each an `Outcome`), `summarise` (the capped copy a model may
  see); filters are the map's, run through style-spec `featureFilter`; GeoJSON layers read
  the whole file (`loadSource`), a vector layer with a columns file the whole dataset (`complete: true`; `scope: 'view'`, `fragments`, `ids` or no usable file read the view), any other vector layer the loaded tiles only (`complete: false`).
  `shapeRows` — the template data pass: `where` + area + the base filter of each map layer
  that draws the features (a symbol layer only when `clickPriority` names it), grouped by ≤ 2
  fields and a year (or a date field's month), count + a measure's sum, optional numeric `bins`
  (`binEdges`, rows `bin`/`lo`/`hi`, a bin's `where` matches exactly its rows), features on request
  (≤ 50,000, cuts reported; `complete: true` reads a second layer whole, GeoJSON only); `states`
  on a world layer is an alias of its US admin1 tags (`usOnly`);
  a tiled layer without a columns file reads the current view only, one with it the whole dataset (area applies; `geometry: 'full'` stays on the view); `shapeSlots` — what each slot takes on a layer
- `spatial-join.ts` — `joinPoints` (points per polygon) and `crossings` (polygons a line
  crosses) over `dataset-query.ts` rows; tile pieces of one feature merged; `complete` and
  tile precision stated; registry layers only

## Footguns

### Spatial joins (`joinPoints`, `crossings`)

- `joinPoints` and `crossings` stay on the view: a vector-tile layer answers from the loaded tiles only, so `complete: false`; `crossings` counts are `null` on tiled layers, where a feature is cut into pieces

### Query a dataset (rows / count / group-by)

- a field outside `allowedFields()` is refused; a vector-tile layer with a columns file (`COLUMNS_DATASETS`) answers for the whole dataset (`scope: 'dataset'`, the default; it counts features the tiles drop for drawing), and falls back to the loaded tiles — `complete: false` — for `scope: 'view'`, `fragments`, `ids`, a missing, stale or over-`COLUMNS_MAX_BYTES` file and any layer without one, so check `complete`; a number test never matches a feature without the value, and a kV of 0 or less (OSM's -1) counts as none — in tests and bins alike
