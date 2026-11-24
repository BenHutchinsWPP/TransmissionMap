Map of this folder; each file's header comment is the source of truth.

# assets

- `assets/` — frontend modules (all TypeScript), split into subfolders:
  - **Root** (`assets/`): cross-cutting modules used by multiple subfolders
    - `map.ts` MapLibre init: Map constructor, controls, load handler, camera hashchange, WebGL banner
    - `basemap.ts` — raster + OpenFreeMap basemaps, Map Labels, Esri → USGS aerial fallback,
      projection/atmosphere; `basemapVisibility` is the pure basemap × labels × fallback matrix
    - `state.ts` mutable global singleton and its `AppState` interface (type-only imports); constants live in `constants.ts` — import them from there. The Map Experience link (story id, dirty flag) is not on it — read it through `experience-link.ts`'s `activeExperienceId()` / `experienceIsDirty()`
    - `state-bus.ts` typed pub/sub (broadcast events — `layer:visibility`, `layer:data`, `view:applied`, `url:write`, `lang:changed`, `undo:changed` — plus the few one-subscriber events a direct import would cycle or pull into the main bundle; see `Events`). Filters are called directly: `applyAllFilters()`, `applyGeneratorFilters()`; no deps
    - `visibility.ts` — `setLayerVisibility` (the one way to switch a layer: state, map, commits with `url:write`, then emits `layer:visibility`, which refreshes the legends and the panel row), `applyGenMode`, `applyAllGenModes`; pure `wantedLayout` (layer → map-layer visibility), `heatRampShown` (heat ramp legend rule) and `settleExclusiveGroups` (one member per exclusive group, for a whole view); writes no panel control
    - `filters.ts` — `FACET_APPLIERS` (facet key → applier: one derived `applyFacet()` for a
      single-field facet, hand appliers for voltage/generators/OGF/WestTEC/mines/NWS, each reading
      its field and buckets from the facet record) and
      `applyAllFilters()`, which runs each applier once and is called by `repaintView`;
      `effectiveFilter()` (base ∧ legend/range part ∧ `where` ∧ area, and the selection) is the one
      filter each map layer carries; `setWhere()` / `setSelection()` set conditions / `sel`
    - `style-overrides.ts` — a view's per-layer `style` (opacity/size multipliers,
      colour): `setStyle`, `clearStyle`, `applyAllStyles`; baselines restored exactly.
      Also the OGF/WestTEC colour-by: `setColorBy` (validated mode → state → line-color;
      a view colour override still wins), repainted by `applyAllStyles`
    - `url-state.ts` — `readUrlState`, `writeUrlState` + bus subscription
    - `view-state.ts` — the one path a whole view takes into the app: `seedView`
      (cold boot, state only), `applyView` (live map — Reset is `applyView({})`,
      Map Experiences use it too), `currentView` (for the link); resolves every
      input over the codec's `defaultView()`. `repaintView` is the one repaint both
      paths run (filters incl. `where`, colour-bys, `style` overrides)
    - `undo.ts` — undo/redo of the view: records `formatUrlState(currentView())` on
      every `url:write`, restores through `applyView`; `undo`/`redo`/`canUndo`/`canRedo`,
      emits `undo:changed`; camera and `lang` stay off the stack; `asOwnStep(fn)`
      makes fn's commits one step (a 400 ms burst otherwise merges)
    - `chart-spec.ts` — the chat's charts as data: `validateChart` (the trust boundary a model's
      `runAnalysis` value passes: own keys, types, ≤ 40 categories, ≤ 8 series, ≤ 8 pie slices),
      `chartCsv` (BOM, formula-guarded); session only; chat chunk
    - `vega-spec.ts` — a model's Vega-Lite `chart` object: `validateVegaLite` (page-side check: plain
      JSON, ≤ 20 KB, no `data`/`url`/`href`/…), row injection as `data.values` (`rowsFromValue`),
      `rowsCsv`; Vega itself runs only in the canvas frame; chat chunk
    - `query/` — the dataset query modules (rows, counts, group-bys, the template data pass, the map reads) and the spatial joins: `query/README.md`
    - `area-labels.ts` — the lazy region-label table (the only importer of `region-labels.json`)
    - `map-api.ts` — the view as calls (the chat's tools, `window.tm`): each returns an
      `Outcome`; a committing call is one `url:write` and its own undo step (`asOwnStep`);
      includes `addService`/`removeService`/`listServices`, `joinPoints`/`crossings`, `runAnalysis`,
      `showTemplate` (a ready catalogue template over a layer, page-built; the model is told only the page's figures),
      and `layerRows` (registry layers → FeatureCollections of allowed fields, for `runAnalysis` and `showCanvas`), and `copyToMyData` (a queryable layer's rows, picked by the link's validators, into a new My Data layer: a non-view
      write with no `url:write` and no undo step; more than 1,000 matching features are refused with the count; a save the browser refuses offers the GeoJSON download)
    - `agent/` — the map chat, in the chat chunk only (`docs/internal/chat-trust-model.md`): `tools.ts` (`toolSchemas`,
      `dispatch` — arguments checked by `checkArgs`, an off-page call only after `confirm`),
      `local-commands.ts` (English phrases → one call), `loop.ts` (`ask`: a local command, else
      the model), `openrouter.ts` (the one client), `key-store.ts` (the visitor's key); tools
      include `addService`/`removeService`/`listServices` (a URL only after `confirm`), `copyToMyData` (asks above 50
      features per ask, the 50 a running total over the ask's model calls; the model sees counts only),
      `joinPoints`/`crossings`, `runAnalysis` (code shown in the chat first) and `planRoute` (solves through `route-panel-open.ts`'s `planRouteFromChat`); `runAnalysis`
      takes `chart` (bar/pie/line, drawn by `ui/chat/ui-chart.ts`, or a Vega-Lite spec shown
      in the canvas frame); `showCanvas` shows a model-written page in the canvas frame (code shown first)
    - `dev-console.ts` — dev-only `window.tm` (the `map-api.ts` calls and more); loaded by
      `src/main.ts` behind `import.meta.env.DEV`, never in the production bundle
    - `hover.ts` — polygon hover + line click-highlight
    - `feature-id.ts` — stable feature ids: `featureId(layerId, feature)` (the id a
      layer's `data.id` declares: the native tile id, or the promoted column),
      `featureIdExpr` (the same inside a filter); pure.
      `feature-id.test.ts` also holds the registry ↔ `tile_manifest.yaml` `id_field` parity
    - `map-input.ts` — **the only module allowed to subscribe to MapLibre pointer
      events**; normalises mouse and touch into `onMapTap` / `onMapDoubleTap` /
      `onMapPoint` / `onMapHover` / `onMapContextMenu` (ESLint enforces the seam)
    - `raster-probes.ts` — `RASTER_PROBES`, `ensureRasterLut`, `updateRasterArrow`; owns the hover LUT
      cache (a grid is used only while its URL is the probe's current `lut()`; a fetch landing after
      its URL moved on is dropped) and the weather step/bake the weather LUT URLs carry (`setWeatherLutStep`)
    - `popup.ts` click popups; `popup-format.ts` HTML builder
    - `click-resolve.ts` — `resolveHits`: the pure click decision (painted-feature
      filter via each choropleth owner's `*FeatureLit` predicate, tile-duplicate
      dedupe, single vs picker, edit-mode copy rules); `popup.ts` renders its result
    - `highlights.ts` search and table highlights; `measure.ts` distance tool
    - `terrain.ts` — 3D Terrain (raster-dem) + 3D Buildings (OFM fill-extrusion) + Hillshade toggles
    - `url-state-codec.ts` — URL parse/format (no side effects), including the
      `#zoom/lat/lng[/bearing/pitch]` camera segment and `splitHash` (the one hash splitter)
    - `icons.ts` SVG icon loading; `tool-mode.ts` draw/measure mutex
    - `units-store.ts` — load/save display-unit preferences (`localStorage` key
      `tm-units`, validated against `UNIT_OPTIONS` — a trust boundary, see
      `units-store.test.ts`)
    - `constants.ts` — shared constants, imports only `src/registry/data-versions.json`: `DATA` paths (each data-host URL the table names carries `?v=<token>`, through `versioned`), `RELEASES_ORIGIN`/`weatherLiveUrl`,
      the external hosts `diagnostics.ts` also probes (`OPENROUTER_ORIGIN` among them), `CSP_HOSTS`/`CSP_POLICY` (the build's CSP);
      `EMPTY_FC`, `COUNTY_SRC*`, `WEATHER_WASH_OPACITY`; a single-owner constant lives in its owner
      (`MW_SLIDER_MAX` → `src/colors/ramps.ts`, default viewport → `map.ts`, `BLANK_STYLE`/fog/atmosphere → `basemap.ts`, terrain tuning → `terrain.ts`)
    - `download-packs.ts` — `packLinks(downloads)`: a layer's download packs → the formats and links its
      Download menu offers (one link per continent for an OSM pack, Release URLs in prod); pure.
      `download-packs.test.ts` holds the continent codes and continental packs to `build_releases.py` /
      `release_manifest.yaml`
    - `session-snapshot.ts` — per-tab state that survives a reload of the tab (boot bundle, no deps):
      `saveSnapshot`/`readSnapshot`/`hasSnapshot`/`restampSnapshot`/`clearSnapshot` over versioned
      `{v, hash, at, data}` envelopes in `sessionStorage` (read only on a reload/back-forward of the same hash),
      `onHidden`; also the Diagnostics "Page load" line (`initPageLifecycle`, run first by `src/main.ts`;
      `tm-lifecycle`); `endSnapshots` (map.ts, before its reload for a pasted link). Keys: `tm-chat` (the conversation, owned by
      `ui-chat.ts`), `tm-drawer` (the drawer's layout and the table, owned by `ui/drawer.ts`; shape in `ui/drawer-snapshot.ts`)
    - `live/` — the live feeds' refresh loop, staleness shells, weather, radar and outage joins, and the NWS zone join: `live/README.md`
    - `fema-nri.ts` — FEMA National Risk Index county feature-state join (static table; the hazard picker's `setNriHazard`)
    - `county-overlay.ts` — a template's per-county colours on the main map: `paintCountyOverlay` /
      `clearCountyOverlay` / `countyOverlayToken` / `onCountyOverlay`; feature-state key `tpl_v` on the shared
      county source, its own fill + outline above the county choropleths and a legend card; session only
    - `route-constraints.ts` — the Routing constraints layer's concern: `setRouteConcern` (state, legend, the raster url via `layer-plan.ts`'s `setRasterUrl`), `routeConcernUrl`, `routeConcernLegendHtml`; link param `rc`
    - `tribal-disclaimer.ts` — tribal-layer disclaimer dialog (used by `visibility.ts` + `ui.ts`)
    - `experiences.ts` — Map Experiences controller: renders a curated preset as
      `UrlStateData` — the shape a shared link parses to — and applies it with
      `view-state.ts`'s `applyView()`. See
      `docs/map-experiences.md`; tracks the active story; no DOM
    - `experience-link.ts` — whether the link still names the active story:
      `beginExperience`/`endExperienceLink`, `noteUrlWrite` (the pristine/dirty
      diff `writeUrlState()` runs, emits `exp:dirty`), `rebaselineExperience`,
      and the readers `activeExperienceId`/`experienceIsDirty`; the story id,
      snapshot and dirty flag are private module state; deps `state-bus.ts` only
    - `diag-log.ts` — zero-import ring buffer of runtime errors; `recordDiagEvent`
      is called from the existing catch blocks in `map.ts`, `basemap.ts`, `layers/layer-data.ts`,
      `live/live-staleness.ts`, `live/odin-outages.ts`, `live/weather-live.ts`
    - `diagnostics.ts` — check catalogue behind the Diagnostics panel (browser
      capabilities, host probes, live-feed freshness, report builder); no DOM

## Footguns

### Add a filter (legend chips or range/slider)

- a non-standard facet's hand applier goes in `FACET_APPLIERS`, which is what `applyAllFilters()` runs, and claim a unique URL code — see `docs/url-state.md`

### Undo/redo, what goes on the stack

- a control that writes the URL without `url:write` — calling `writeUrlState()` directly — updates the link but is not undoable

### URL hash / shareable links / add a URL param

- param-char collisions — check the reserved-char table in `docs/url-state.md`

### Add or edit a curated map view / story

- a legend filter needs its base layers in `layersOn`; and a new `MapExperience.state` field must be representable in `assets/url-state-codec.ts` or it never reaches a shared link — `assets/experiences.test.ts` § 1 fails when it isn't

### Anything that reacts to a click/tap/hover on the map

- a touch screen reaches `click`/`mousemove` only as compatibility mouse events, and the browser withholds those while the draw control is attached — mapbox/mapbox-gl-draw#1301; `npm run lint` fails the raw form, though it cannot see a non-literal event name or a direct `addEventListener` on the canvas

### Fetch from a new host / the Content Security Policy

- the CSP exists only in a build, so a host missing from `CSP_HOSTS` works in dev and is refused in production; add it there, to the allowlist and a Diagnostics probe (the analytics beacon has none: blocking it costs the visitor nothing), then run `drive.mjs --preview csp`

### "Things aren't loading" reports / add a diagnostics check

- host probes duplicate `docs/network-allowlist.md` — update both
