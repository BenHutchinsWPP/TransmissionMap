Map of this folder; each file's header comment is the source of truth.

# src

- `index.html` — single page; Vite entry via `<script type="module" src="/src/main.ts">`
- `src/main.ts` — top-level import orchestrator; imports `assets/ui/ui.ts` (and, in dev only, `assets/dev-console.ts`)
- `src/types.ts` — shared `LayerDef` interface and the registry/view types it
  carries (includes the optional `clickPriority` — map-layer id → click
  hit-test priority — `fromZoom` — minimum zoom to fetch the layer's data — and
  `data` — `LayerData` `{ kind, key, credit, id? }`: where the layer's map source gets
  its data, who it credits and which column is each feature's stable id
  (`FeatureIdDecl` `{ field, native? }`, mirroring `tile_manifest.yaml`'s
  `id_field` / `native_id`) — fields), `BucketedField` (the legend facet record) and `Selection` (`vx` `sel`). Single-owner types live beside their owner: `AppState` in
  `assets/state.ts`, `UserLayer` in `assets/user-data/user-data.ts`,
  `RasterMeta` in `assets/raster-probes.ts`
- `src/units.ts` — display-unit preferences (temp/speed/distance/area/elevation/pressure)
  as ambient module state; SI-in/display-string-out formatters + raw converters; imports nothing
- `src/outcome.ts` — `Refusal` and `Outcome<T>`, the answer shape of the refusable dataset and route calls; types only, imports nothing
- `src/i18n/` — `index.ts` engine (`t`, `loadDictionary`, `loadRouteStrings`); `locales/<code>.ts` the base dictionaries (boot-read `route.*` keys included); `route/<code>.ts` the route planner's strings, one lazy chunk per locale, loaded when the panel is asked for (`t()` falls back active base → active route → English base → English route → the key)
- `sw.js` — service worker (network-first app shell with offline fallback; map data is cross-origin and bypasses it)
- `src/colors/` — color/style logic (no MapLibre side effects, safe to import anywhere)
  - `voltage.ts` — `voltageColorExpr()`
  - `ramps.ts` — wind/solar/geo/pop/heat ramps, year-filter constants and `MW_SLIDER_MAX` (the MW range's no-upper-bound sentinel)
  - `route-constraints.ts` — the Routing constraints layer's concerns (id, group, band rule (`pd_`, or `osm_flags`/`adj` for the OpenStreetMap entries), colour, classes concerns (ordered `max`, nominal `mode`)), the "What constrains" precedence palette, the Land manager palette and their rules; `scripts/route_constraints.json` is generated from it by a vitest check (`UPDATE_ROUTE_CONSTRAINTS=1 npm test` rewrites it, together with `scripts/route_constraints_sets.json`, the class value sets `scripts/test_route_constraints.py` reads) and read by the tile build
  - `fuel.ts` — `FUEL_LEGEND`, the one fuel table (legend row + OSM `source` values +
    EIA codes + per-value icon/colour overrides); the gen icon/colour expressions and
    `OSM_FUEL_MAP`/`EIA_FUEL_MAP` filter maps are derived from it
  - `buckets.ts` — `bucketColorExpr`, `bucketValueMap`, KV/fuel/region
    bucket arrays, each bucket with its `values` (feature values it matches);
    `KV_BUCKET_RANGES` (each kV bucket's numeric range — the voltage legend filter's
    `buildKvFilterExpr` reads it) and `kvBucketOf` (a kV value → its bucket, for templates)
  - `facets.ts` — `FACETS`: one `BucketedField` record per legend filter (group code,
    buckets, field — or, for kv and fuel, the per-layer `fields` — map layers, defaults, title,
    swatch); `facet(key)` looks one up, `facetAllIds(f)` lists its bucket ids (its sync buckets when it has them), and
    `facetValueMap()` is its bucket id → values map (no `*_MAP` exports); `assets/filters.ts`
    derives its applier and `assets/ui/ui-legends.ts` pairs the two into `LEGEND_FILTERS`.
    Also the OGF/WestTEC colour-by (`ogfColorExpr`/`westtecColorExpr`: mode → facet key)
- `src/registry/` — layer definitions (pure data, no side effects)
  - `service-library.json` — the curated linked-service library (id, kind, url, style, credit, licence);
    `service-hosts.json` — the vetted hosts (provenance, not a security boundary);
    `scripts/check_service_library.mjs` re-probes every entry (network; not in CI) and writes `docs/library-hosts.md`
  - `canvas-hosts.json` — the basemap/tile hosts the canvas frame's CSP admits for images and fetches
    (read by `scripts/build_sandbox.mjs`); held equal to the tile-host subset of `CSP_HOSTS` by `assets/sandbox/canvas.test.ts`
  - `sources.ts` — provenance: `LAYER_SOURCES` (panel label/tooltip, Data Credits heading) + the shared map credits (`OSM_CREDIT`, `HIFLD_CREDIT`…); `index.ts` — `LAYERS[]`, `layerById`
  - `osm-fid.ts` — the OSM stable id: `OSM_FID`/`OSM_NATIVE_FID` (the shared `data.id` decls —
    the only instances, as `view-validate.ts` tells an OSM id by `===`) and `osmRef` (OSM `fid` =
    osm_id × 10 + type digit 1 node/2 way/3 relation → the openstreetmap.org object); pure.
    `osm-fid.test.ts` also checks every `osm_*` layer uses a shared decl by reference
  - `generators.ts` EIA+OSM; `transmission.ts` lines+substations; `pipelines.ts` natgas
  - `renewable.ts` wind/solar/geo/hydro; `land.ts` PAD-US/tribal/crithab; `regions.ts` NERC/BA/retail
  - `conditions.ts` — hazards + everything live: static WHP & seismic PGA, live wildfire
    (perimeters/incidents/smoke), NWS alerts, ODIN outages, NEXRAD radar, Grid Operations (EIA-930); `rail.ts` railroads
  - `experiences.ts` — Map Experiences catalogue (curated camera/layer/filter presets + narratives)
  - `field-schema.ts` — `FIELD_SCHEMA`: per-dataset field types, operators, and
    (where closed) value domains, keyed by `tile_manifest.yaml` `id` and
    `select:` field names; a `list` field (the region tags, `|TX|NM|`) takes
    `contains`/`contains_any`; each field's `role` (category/measure/time/region),
    a measure's `unit` (`additive: false` for kV), a time field's `time` granularity;
    `YEAR_IN_TEXT` reads the year out of a free-text OSM `start_date`; pure data, no runtime logic
  - `field-roles.ts` — `FIELD_ROLES`/`rolesOf(layerId)`: per queryable layer what the schema
    cannot hold — geometry, label field, roles of `dataset-core.ts` `DISPLAY_FIELDS`, field →
    legend facet, derived measures (count, length_km, area_km2) and `pending` fields (in the data,
    not yet readable); `describe()` returns them. `field-roles.test.ts` holds a new queryable layer
    to an entry and writes `docs/templates-coverage.md`
  - `template-signatures.ts` — `TEMPLATE_SIGNATURES`: the visualization archetypes as role
    slots (C/R/CR/M/MT/T, geometry, second layer, the region fields an R slot takes) and `fit()`; pure
  - `condition-compile.ts` — `validateConditions`/`toMapLibreFilter`:
    compiles a `{field, op, value}` condition array checked against
    `field-schema.ts` into a MapLibre filter expression;
    consumed by `assets/filters.ts`'s `compileBucketExpr()`
  - `view-validate.ts` — map-free `validate*`: the trust-boundary checks for a view's
    `where`/`style`/`area`/`sel` (share-link decode and the setters)
  - `area-filter.ts` — the Area filter: `areaCondition` (dataset + area → its condition) and `areaFlag`; pure
  - `region-codes.ts`, `region-labels.json` — generated (`make region-domains`): region codes and labels
  - `route-band-data.ts` — the Method grid's "Map data from" labels: `bandData(band, match)` (publisher, dataset, vintage, and the source-text tokens `assets/route/band-data.validate.test.ts` checks against the cube's `grid.json`); pure
  - `route-presets.ts` — `ROUTE_PRESETS`: each routing/costing method as data (rows: band + match →
    routing weight and cost multiplier, groups, exemptions, line types, $ rules), every number with a `src`
  - `escalation-index.json` — the BLS year index the route cost engine escalates with; generated by `scripts/build_escalation_index.py` (network, not in CI)
- `src/registry/data-versions.json` — the `?v=` table of the data host: repo path → token, written by `scripts/publish_r2.sh` (`scripts/data_versions.py`), never hand-edited; `assets/data-versions.test.ts` fails for any data-host URL the app builds that it does not name
- `src/registry/columns.ts` — `COLUMNS_DATASETS`: the tiled datasets that have a columns file; pure data

## Footguns

### Change a display unit / add a setting

- a convertible ramp's legend label must use `RampDef.fmt`, not `unit`/`maxLabel` — those freeze at module-load time

### Add a field to a dataset's filter schema (types, operators, closed value domains)

- every field needs a `role`, a measure its `unit`, a year its `time` — `field-roles.test.ts` fails otherwise — and a new field can change `docs/templates-coverage.md`, so regenerate it with `UPDATE_TEMPLATES_COVERAGE=1 npm test`

### Area filter / which layers a region choice reaches

- a new region kind needs its `FIELD_SCHEMA` line, a mapping in `area-filter.ts` and an unused `af` kind char
