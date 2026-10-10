# TransmissionMap

Static web map (MapLibre GL, vanilla JS, Vite-bundled) of global energy
infrastructure: transmission lines, substations, generators, pipelines,
renewable-resource rasters, land constraints. A Python/shell pipeline
turns public datasets into PMTiles consumed by the frontend.

> **This file is the single source of truth for every AI coding agent.**
> Codex, the Copilot coding agent, and Antigravity read `AGENTS.md` natively.
> Two shims exist so the rest do too — keep them, but never put rules in them:
>
> | Tool | How it reaches this file |
> |---|---|
> | Codex, Copilot coding agent, Antigravity | native `AGENTS.md` support |
> | Claude Code | [`CLAUDE.md`](CLAUDE.md) — a one-line `@AGENTS.md` import (Claude Code reads `CLAUDE.md`, *not* `AGENTS.md`) |
> | Copilot in VS Code | [`.vscode/settings.json`](.vscode/settings.json) — `"chat.useAgentsMdFile": true` |
>
> Do not create `GEMINI.md` or `.github/copilot-instructions.md`. They are
> *additional* sources those tools would read, and a second place for rules is
> how the two drift apart. Edit this file.
>
> One exception, for facts rather than rules: a gitignored `AGENTS.local.md`
> may sit beside this file, carrying what is true of one machine — local-only
> directories, personal tooling. Read it when it exists. Conventions still
> belong here, where everyone gets them.

## Hard rules

- **NEVER read, list, or grep `data/` (tens of GB), `venv/`, `tmp/`,
  `node_modules/`, `dist/`, `coverage/`.** Large binaries; nothing useful for
  code work. To inspect a dataset's schema/values, *run* the relevant script
  and print (`df.head()`, `ogrinfo -so`, `head` on a built `.csv`) — never open
  files in `data/`.
  `dist/` and `coverage/` are the quiet ones: they are *generated twins of live
  files* — `dist/assets/` is a bundled copy of every `assets/**/*.ts` symbol —
  so after a `npm run build` a root-level `grep -r` or `find` cites a file
  nobody ships. `rg` honours `.gitignore` and skips them; `grep -r`, `find` and
  `ls` do not. Open one only when the user names its path. The one thing worth
  reading under `tmp/` is a build log you tee'd there yourself (see *Working
  style*).
- Vite bundles the frontend. `src/main.ts` is the entry point; `assets/**/*.ts`
  modules use ES `import`/`export`. Run `npm run dev` for local dev; Vite
  handles module order automatically.
- **Imports use a `.js` extension even though the source is `.ts`** (e.g.
  `import { state } from './state.js'`) — required by `moduleResolution:
  bundler`. This is correct; do NOT "fix" it to `.ts` or strip the extension —
  that breaks the build. New imports must follow the same `.js` convention.
- Every `assets/**/*.ts` file starts with a header comment stating its role and
  cross-file dependencies. Read the header before editing; keep headers
  accurate when refactoring.
- **No AI authorship in commits.** Never add a `Co-Authored-By:` trailer naming
  an AI (Claude, Copilot, etc.), a "Generated with …" line, or any similar
  attribution to a commit message, PR title, or PR body. AI assistance is
  already disclosed once, at the project level, at the bottom of
  [`README.md`](README.md) — repeating it per commit is noise. Commits are
  authored by the human who owns the change. Write the message as a plain
  description of *what changed and why*.

## Repo map

- `index.html` — single page; Vite entry via `<script type="module" src="/src/main.ts">`
- `src/main.ts` — top-level import orchestrator; imports `assets/ui/ui.ts` (and, in dev only, `assets/dev-console.ts`)
- `src/types.ts` — shared `LayerDef` interface and the registry/view types it
  carries (includes the optional `clickPriority` — map-layer id → click
  hit-test priority — `fromZoom` — minimum zoom to fetch the layer's data — and
  `geojson` — the `DATA` key the lazy loader fetches for a GeoJSON layer —
  fields), and `BucketedField` (the legend facet record). Single-owner types live beside their owner: `AppState` in
  `assets/state.ts`, `UserLayer` in `assets/user-data/user-data.ts`,
  `RasterMeta` in `assets/raster-probes.ts`
- `src/units.ts` — display-unit preferences (temp/speed/distance/area/elevation/pressure)
  as ambient module state; SI-in/display-string-out formatters + raw converters; imports nothing
- `sw.js` — service worker (network-first app shell with offline fallback; map data is cross-origin and bypasses it)
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
      `applyAllFilters()`, which runs each applier once and is called by `repaintView`; `MW_SLIDER_MAX`;
      `effectiveFilter()` (base ∧ legend/range part ∧ the view's `where`) is the one
      filter each map layer carries, and `setWhere()` sets a layer's field conditions
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
      emits `undo:changed`; camera and `lang` stay off the stack (ADR-0004)
    - `dev-console.ts` — dev-only `window.tm` (view API for the console); loaded by
      `src/main.ts` behind `import.meta.env.DEV`, never in the production bundle
    - `hover.ts` — polygon hover + line click-highlight
    - `map-input.ts` — **the only module allowed to subscribe to MapLibre pointer
      events**; normalises mouse and touch into `onMapTap` / `onMapDoubleTap` /
      `onMapPoint` / `onMapHover` / `onMapContextMenu` (ESLint enforces the seam)
    - `raster-probes.ts` — `RASTER_PROBES`, `ensureRasterLut`, `updateRasterArrow`
    - `popup.ts` click popups; `popup-format.ts` HTML builder
    - `click-resolve.ts` — `resolveHits`: the pure click decision (painted-feature
      filter via each choropleth owner's `*FeatureLit` predicate, tile-duplicate
      dedupe, single vs picker, edit-mode copy rules); `popup.ts` renders its result
    - `highlights.ts` search highlights; `measure.ts` distance tool
    - `terrain.ts` — 3D Terrain (raster-dem) + 3D Buildings (OFM fill-extrusion) + Hillshade toggles
    - `url-state-codec.ts` — URL parse/format (no side effects), including the
      `#zoom/lat/lng[/bearing/pitch]` camera segment and `splitHash` (the one hash splitter)
    - `icons.ts` SVG icon loading; `tool-mode.ts` draw/measure mutex
    - `units-store.ts` — load/save display-unit preferences (`localStorage` key
      `tm-units`, validated against `UNIT_OPTIONS` — a trust boundary, see
      `units-store.test.ts`)
    - `constants.ts` — shared constants, imports nothing: `DATA` paths, `releaseUrl`/`weatherLiveUrl`,
      `SOURCE_ATTRIB` (keyed by map source id), the external hosts `diagnostics.ts` also probes,
      `EMPTY_FC`, default viewport, `COUNTY_SRC*`; a single-owner constant lives in its owner
      (`MW_SLIDER_MAX` → `filters.ts`, `BLANK_STYLE`/fog/atmosphere → `basemap.ts`, terrain tuning → `terrain.ts`)
    - `live-poll.ts` — `pollWhileVisible`: **the one refresh loop every live feed runs on**
      (interval while the layer is on, plus an instant refetch on return to the tab /
      bfcache restore, at most once per 60 s); zero deps
    - `live-staleness.ts` — **shared factory** for every live GeoJSON feed: auto-refresh
      (through `live-poll.ts`) + stale-data kill-switch modal. `wildfire-staleness.ts` /
      `nws-staleness.ts` are thin config shells over it. Raster/feature-state feeds
      wire their own fetch and staleness on the same poll loop (see `odin-outages.ts`,
      `weather-live.ts`).
    - `weather-live.ts` — live GFS weather raster: image swap + hover-LUT
      reload + age chip + timebar (own fetch on `live-poll.ts`; the factory only does
      GeoJSON sources; a stale feed warns in the console, no modal)
    - `nexrad-radar.ts` — NEXRAD/GeoMet radar frame poll (`startNexradRadar`, called from
      `add-all-layers.ts`): keeps every tile on one scan, refreshes on switch-on and on
      return to the tab; owns the GeoMet source table the builder reads
    - `weather-particles.ts` — wind particle animation over the weather wash (lazy-loaded canvas layer)
    - `odin-outages.ts` — ODIN county outage feature-state join (own fetch on `live-poll.ts`;
      stale-data modal `#odinStaleDialog`, like the factory's)
    - `fema-nri.ts` — FEMA National Risk Index county feature-state join (static table; the hazard picker's `setNriHazard`)
    - `nws-zone-join.ts` — NWS zone/county alert feature-state join; key contract with `extract_nws_zones.py`
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
      `live-staleness.ts`, `odin-outages.ts`, `weather-live.ts`
    - `diagnostics.ts` — check catalogue behind the Diagnostics panel (browser
      capabilities, host probes, live-feed freshness, report builder); no DOM
  - **`assets/ui/`** — UI wiring and panels
    - `ui.ts` bootstrap + `init()`; wires all UI subsystems
    - `ui-filters.ts` — layer/legend/MW/year filter event wiring (emits bus events)
    - `ui-legends.ts` — legend HTML + `LEGEND_FILTERS` (each `FACETS` record + its `FACET_APPLIERS` entry)
    - `ui-layer-rows.ts` — layer panel row HTML (structure only — no template reads state for a value)
    - `panel-mirror.ts` — **the only writer of panel control values derived from state**:
      `renderPanel()` (rebuild rows, then sync) and `syncPanel(layerId?)` (values only:
      checkboxes, heat ramps, mode/colour-by buttons, selects, chips, year/MW/smoke
      sliders, basemap radios + 3D toggles, region dropdown); subscribes to
      `layer:visibility` (one row) and `view:applied` (rows rebuilt only when region, locale or the set of switched-on
      out-of-scope layers — which keep a row — changed, so Undo keeps open sub-panels and focus)
    - `ui-menubar.ts` — toolbar (draw/edit/export)
    - `ui-mydata.ts` — My Data tab wiring
    - `ui-search.ts` — feature search; `ui-geocoder.ts` — place search
    - `ui-openwith.ts` — "open with" link builder
    - `ui-experiences.ts` — Map Experiences gallery + floating story card; lazy chunk, opened from the File menu
    - `ui-diagnostics.ts` — Diagnostics dialog; lazy chunk, opened from the File menu
    - `ui-settings.ts` — Settings dialog (display units); lazy chunk, opened from the File menu
    - `ui-credits.ts` — Data Credits dialog; renders `renderDataCredits()` from
      `DATA.data_manifest` (`data/layers/manifest.json`, built by
      `scripts/build_data_manifest.py`) over the hand-written `<li>` fallback
      already shipped in `index.html`; lazy chunk, opened from the info button
  - **`assets/layers/`** — MapLibre layer builders
    - `layer-plan.ts` — `LayerPlan` (a builder's sources + style layers, in paint order — plain
      data) and `applyLayerPlan(map, plan)`, the one step that puts a plan on the map: sources
      first, already-there guards, `beforeId`, `SOURCE_ATTRIB` attribution, and each layer's
      `filter` registered as its base filter
    - `layer-init.ts` — shared plan helpers: `initialVisibility`, `pmtilesUrl`, `planPolygon`,
      `planRaster`, `planTransmissionLines`, `planSubstationPoints`, `planPadus`, `planCritHab`,
      `countyBoundariesSource` (+ `ensureCountyBoundaries` for layers added after boot),
      `genPlantTextLayout`, `GEN_PLANT_TEXT_PAINT`
    - `layer-data.ts` — the lazy GeoJSON loader: `ensureLayerData` (with the `fromZoom` gate and
      zoom-settle retry), `fetchGeojson`, `layerDataUrl` (a registry layer's `geojson` DATA key,
      else the two-row `SOURCE_DATA_URLS` for source-only ids) and `LAYER_SOURCE_ALIAS`; emits
      `layer:data` on the bus when a source's features land
    - `base-filters.ts` — zero-dependency `registerBaseFilter` + `BASE_LAYER_FILTERS`: each style
      layer's own inline filter (registered by `applyLayerPlan`), which `filters.ts`'s `effectiveFilter()` builds on
    - `add-all-layers.ts` — `addAllLayers()`: collects every builder's plan in z-order and applies
      them in one `applyLayerPlan` call, then runs the builders' non-layer side effects
    - `map-layers-{osm,hifld,eia,load,renewable,rail,conditions,mines,petroleum,wecc,westtec,admin}.ts` — per-source
      `plan*()` builders, each returning a `LayerPlan`
      (`conditions` = wildfire/seismic/NWS alerts/ODIN outages/FEMA NRI/NEXRAD radar — all the live + hazard layers;
      `admin` = administrative boundaries — US Counties/States/ZCTA, world Countries/Admin-1)
  - **`assets/user-data/`** — user-imported/drawn layers
    - `user-data.ts` — core (add/remove/render; `commitUserData` = save + render); `user-data-draw.ts` draw mode
    - `user-data-store.ts` — `createUserDataStore` over a `getItem`/`setItem` adapter: the `tm-user-data`
      payload (validated by `parsePayload`), saves held back until `load()`, then flushed once; drawn-feature cache
    - `user-data-import.ts` GeoJSON/KML/KMZ import; `user-data-export.ts` export
    - `user-data-csv.ts` CSV point import + column picker; `csv-parse.ts` pure CSV parser (unit-tested)
    - `view-file.ts` — `*.tmview.json` view files: Save view… / Open… of a view's hash through the link codec
    - `user-data-geom.ts` geometry utils; `user-data-colors.ts` color picker
    - `draw-chunk.ts` — **lazy chunk boundary**: re-exports draw/import/export; loaded on first toolbar interaction (keeps MapboxDraw/toGeoJSON/jszip out of the initial bundle)
  - **`assets/utils/`** — pure utilities
    - `utils.ts` string helpers; `utils-dom.ts` DOM helpers; `utils-uid.ts` UID generation
- `src/colors/` — color/style logic (no MapLibre side effects, safe to import anywhere)
  - `voltage.ts` — `voltageColorExpr()`
  - `ramps.ts` — wind/solar/geo/pop/heat ramps + year-filter constants
  - `fuel.ts` — `FUEL_LEGEND`, the one fuel table (legend row + OSM `source` values +
    EIA codes + per-value icon/colour overrides); the gen icon/colour expressions and
    `OSM_FUEL_MAP`/`EIA_FUEL_MAP` filter maps are derived from it
  - `buckets.ts` — `bucketColorExpr`, `bucketValueMap`, line widths, KV/fuel/region
    bucket arrays, each bucket with its `values` (feature values it matches)
  - `facets.ts` — `FACETS`: one `BucketedField` record per legend filter (group code,
    buckets, field, map layers, defaults, title, swatch); `facet(key)` looks one up and
    `facetValueMap()` is its bucket id → values map (no `*_MAP` exports); `assets/filters.ts`
    derives its applier and `assets/ui/ui-legends.ts` pairs the two into `LEGEND_FILTERS`.
    Also the OGF/WestTEC colour-by (`ogfColorExpr`/`westtecColorExpr`: mode → facet key)
- `src/registry/` — layer definitions (pure data, no side effects)
  - `sources.ts` — `LAYER_SOURCES`; `index.ts` — `LAYERS[]`, `layerById`
  - `generators.ts` EIA+OSM; `transmission.ts` lines+substations; `pipelines.ts` natgas
  - `renewable.ts` wind/solar/geo/hydro; `land.ts` PAD-US/tribal/crithab; `regions.ts` NERC/BA/retail
  - `conditions.ts` — hazards + everything live: static WHP & seismic PGA, live wildfire
    (perimeters/incidents/smoke), NWS alerts, ODIN outages, NEXRAD radar; `rail.ts` railroads
  - `experiences.ts` — Map Experiences catalogue (curated camera/layer/filter presets + narratives)
  - `field-schema.ts` — `FIELD_SCHEMA`: per-dataset field types, operators, and
    (where closed) value domains, keyed by `tile_manifest.yaml` `id` and
    `select:` field names; pure data, no runtime logic
  - `condition-compile.ts` — `validateConditions`/`toMapLibreFilter`:
    compiles a `{field, op, value}` condition array checked against
    `field-schema.ts` into a MapLibre filter expression;
    consumed by `assets/filters.ts`'s `compileBucketExpr()`
  - `view-validate.ts` — map-free `validateWhere`/`validateStyleOverride`: the
    trust-boundary checks for a view's `where`/`style` (share-link decode,
    `setWhere`, `setStyle`)
- `scripts/build_global_tiles.py` — joins the 8 continental OSM builds into one
  planet-wide artifact per layer (what the map reads), capping any archive over the
  host's 100 MiB per-file ceiling. Transmission is re-tiled from the GeoPackages in
  one global pass (deduping the seam overlaps) and cut into six voltage-class
  archives — `TRANSMISSION_BANDS`, mirrored by `OSM_TL_BANDS` in
  `src/registry/transmission.ts`. Download packs stay per-continent.
  See `docs/hosting-plan.md` and `docs/pipeline.md`.
- `scripts/` — data pipeline: `extract_*.py` (per dataset — e.g.
  `extract_us_census_boundaries.py` for US states/ZCTA,
  `extract_cgaz_boundaries.py` for world countries/admin-1), `fetch_*.py`
  (live feeds), `build_*.{sh,py}` (rasters/tiles/releases), `osm_common.py` +
  `geo_common.py` shared
- `scripts/moratoriums/` — data center moratorium pipeline (`rebuild.sh` over `build*.py` + `sync.py`) and the
  twice-monthly refresh (`refresh/`: search, fetch, extract, quote-verify, review, publish; `moratorium-refresh.yml`); inputs live on
  the `data-moratoriums` branch. See its `README.md` and `docs/layers/dc-moratoriums.md`.
- `scripts/data_manifest.yaml` — hand-written per-layer provenance (label,
  source, url, licence, `source_id`), one entry per `tile_manifest.yaml` `id`;
  a field the linked docs don't settle with confidence is the literal string
  `UNKNOWN` rather than a guess. `scripts/build_data_manifest.py` (`make
  data-manifest`) merges this with facts measured off each layer's tile-build
  input into `data/layers/manifest.json`, which `assets/ui/ui-credits.ts`
  renders as the Data Credits dialog. See `docs/pipeline.md`.
- `docs/adr/` — architecture decisions; read before proposing a refactor of the modules an ADR names
- `docs/adding-a-layer.md` — **read this before adding any map layer**
- `docs/map-experiences.md` — curated guided views (`File ▸ Experiences…`, `?exp=`)
- `docs/pipeline.md` — how the data pipeline fits together
- `docs/data-sources.md` — where every dataset comes from
- `docs/layers/<layer>.md` — one doc per layer (source URL, columns, build)
- `docs/release-artifacts.md` — inventory of data files + download packs
- `docs/hosting-plan.md` — where each asset class is hosted and how the world
  transmission archive is split by voltage class

## Task routing — read these, not the whole repo

| Task | Read |
|---|---|
| Add a dataset to the pipeline | `docs/adding-a-dataset.md` (data half), then `docs/adding-a-layer.md` for frontend |
| Add a map layer | `docs/adding-a-layer.md` ONLY, then `rg ">>> ADD-LAYER"` for insertion points |
| Add a **live** layer (auto-refreshing feed) | `docs/adding-a-live-layer.md` — the delta on top of `adding-a-layer.md` (silent footguns: the shared `data-branch` concurrency group, and `maxAgeMs` must exceed the worst-case cron gap) |
| Add a filter (legend chips or range/slider) | `docs/adding-a-filter.md` (silent footguns: a non-standard facet's hand applier goes in `FACET_APPLIERS`, which is what `applyAllFilters()` runs, and claim a unique URL code — see `docs/url-state.md`) |
| Change a display unit / add a setting | `docs/settings.md` (silent footgun: a convertible ramp's legend label must use `RampDef.fmt`, not `unit`/`maxLabel` — those freeze at module-load time) |
| Undo/redo, what goes on the stack | `assets/undo.ts`, `docs/adr/0004-undo-replays-url-write-snapshots.md` (silent footgun: a control that writes the URL without `url:write` — calling `writeUrlState()` directly — updates the link but is not undoable) |
| URL hash / shareable links / add a URL param | `docs/url-state.md` (silent footgun: param-char collisions — check the reserved-char table) |
| Add or edit a curated map view / story | `docs/map-experiences.md` (silent footguns: a legend filter needs its base layers in `layersOn`; and a new `MapExperience.state` field must be representable in `assets/url-state-codec.ts` or it never reaches a shared link — `assets/experiences.test.ts` § 1 fails when it isn't) |
| Anything that reacts to a click/tap/hover on the map | `assets/map-input.ts` — subscribe there, never `map.on("click"\|"mousemove"\|…)` (silent footgun: a touch screen reaches `click`/`mousemove` only as compatibility mouse events, and the browser withholds those while the draw control is attached — mapbox/mapbox-gl-draw#1301; `npm run lint` fails the raw form, though it cannot see a non-literal event name or a direct `addEventListener` on the canvas) |
| Check a change in the real app / verify by screenshots | `.claude/skills/drive-app/SKILL.md` — headless Chromium against the dev server, with scenarios for links, `vx`, Reset, view files and style overrides (silent footgun: Reset's `window.confirm` is dismissed headless unless dialogs are accepted, and a screenshot taken before MapLibre's `idle` shows a half-drawn map while every check passes) |
| A panel control shows the wrong value after Reset/Undo/a story/a link | `assets/ui/panel-mirror.ts` (`syncPanel`) (silent footgun: templates in `ui-layer-rows.ts` must not read state, and a control whose value is view state needs a line in `syncPanel` — nothing else repaints it, since a view that keeps region and language no longer re-renders the rows) |
| Popup content/format | `assets/popup.ts`, `assets/popup-format.ts` |
| Filter UI / value maps | `assets/filters.ts`, `assets/ui/ui-filters.ts` |
| Fix voltage colors | `src/colors/voltage.ts` |
| Edit ramp stops (wind/solar/geo/pop/heat) | `src/colors/ramps.ts` |
| Edit fuel colors / icons / legends | `src/colors/fuel.ts` — edit the `FUEL_LEGEND` row; icons, colours and filter maps follow |
| Edit bucket arrays (PAD-US, Tribal, NERC, etc.) | `src/colors/buckets.ts`; the legend facet record is in `src/colors/facets.ts` |
| Add/edit a layer registry entry | `src/registry/<group>.ts` — imports in `src/registry/index.ts` list every group file |
| Add hover highlight to a polygon layer | set `hoverField` on the `LayerDef` in `src/registry/<group>.ts` |
| Add line click-highlight to a line layer | set `lineHighlightKeys` on the `LayerDef` in `src/registry/<group>.ts` |
| Change which feature a click resolves to / add a clickable layer | set `clickPriority` on the `LayerDef` in `src/registry/<group>.ts` (higher number wins); a style layer built outside the registry goes in `UNOWNED_CLICKABLE` in `assets/popup.ts` instead |
| Gate a layer's fetch on zoom (large point datasets) | set `fromZoom` on the `LayerDef` in `src/registry/<group>.ts` — `assets/layers/layer-data.ts`'s `ensureLayerData()` withholds the fetch below it (for any layer sharing that source too) and retries it on zoom settle |
| Add a field to a dataset's filter schema (types, operators, closed value domains) | `src/registry/field-schema.ts` (`FIELD_SCHEMA`); compiled into filter expressions by `src/registry/condition-compile.ts` |
| Legends | `assets/ui/ui-legends.ts` |
| Search behavior | `assets/ui/ui-search.ts` |
| Layer add order / lazy loading | `assets/layers/add-all-layers.ts` (order), `assets/layers/layer-data.ts` (lazy GeoJSON loading) |
| Live wildfire feed (update cadence, staleness, workflow) | `docs/layers/wildfire-live.md`, `.github/workflows/wildfire-data.yml`, `assets/wildfire-staleness.ts` |
| Data source facts (URL, license, columns) | `docs/data-sources.md`, `docs/layers/<layer>.md` |
| Add/fix a layer's provenance (publisher, landing page, licence) | `scripts/data_manifest.yaml` — sourced only from `docs/data-sources.md` and `docs/layers/<id>.md`; a field those docs don't settle is the literal string `UNKNOWN` |
| Change what the Data Credits dialog shows | `scripts/data_manifest.yaml` for the facts, `assets/ui/ui-credits.ts` for the rendering; `make data-manifest` rebuilds `data/layers/manifest.json` it fetches |
| IT/security asks what URLs to whitelist | `docs/network-allowlist.md` |
| "Things aren't loading" reports / add a diagnostics check | `assets/diagnostics.ts` (`DIAG_CHECKS`), `assets/ui/ui-diagnostics.ts` (silent footgun: host probes duplicate `docs/network-allowlist.md` — update both) |
| Pipeline / tile build | `docs/pipeline.md`, then named script |
| Publishing a build / repo-size headroom | `docs/hosting-plan.md` § *Repository headroom* — read before running `make publish-data` (silent footgun: a force-push to `data-static` deletes nothing, so an overshoot of GitHub's 5 GB soft limit can only be undone by GitHub Support running GC — never set `SKIP_SIZE_CHECK=1` to get past the gate) |
| Where an asset is hosted / the world transmission kV split / tile precision | `docs/hosting-plan.md` — read before changing `DATA_ORIGIN` / `LIVE_ORIGIN`, the kV bands, or any tippecanoe simplification flag (silent footgun: `--simplify-only-low-zooms` is opt-in, and dropping it re-simplifies maxzoom, costing ~5 screen px of line accuracy at z15) |
| How "continent" is defined / rebuilding the OSM extracts without Geofabrik | `docs/pipeline.md` § *Canonical regional boundaries* — the eight `.poly` files are vendored at `scripts/geofabrik_bounds/`, with an `osmium extract` config that recuts all eight from `planet-latest.osm.pbf` |
| Moratorium layer data / twice-monthly refresh | `scripts/moratoriums/README.md` (silent footguns: the workflow YAML must be on `main` to run at all; scheduled runs commit straight to `data-moratoriums` (no review; undo a run with `git revert`) — reject a row with an `updates.csv` `DROP` line and a rebuild, never by editing the published CSVs; move the pin in one `data-moratoriums` PR changing `inputs/upstream.sha` and `inputs/upstream_as_of` together) |
| Global tilesets | `docs/hosting-plan.md` (silent footguns: `assets/constants.ts` must name layers in double-quoted `"data/layers/…"` literals or `validate_build.py` cannot see them (`assets/constants.test.ts` fails on any other form); a joined layer must carry the same maxzoom on every continent, or the capped one draws blank instead of overzooming; and `tile-join` concatenates rather than dedupes, so the overlapping Geofabrik extracts are still doubled in every world archive except transmission, which is re-tiled with a dedupe) |

## Commands

- `make help` — list all targets
- `make check` — verify CLI deps (osmium, ogr2ogr, tippecanoe)
- `make install` — create venv + Python deps
- `make pipeline` — full data pipeline for one region (slow; needs `data/raw/` inputs)
- `make continental-all` — run the OSM pipeline for all 8 continents; must precede `make global-tiles`
- `make tiles` — build PMTiles from extracted data
- `make global-tiles` — join the 8 continental OSM builds into one world tileset per layer;
  transmission is re-tiled globally instead and cut into six voltage-class archives
- `make data-manifest` — build per-layer provenance → `data/layers/manifest.json` (Data Credits dialog); runs cleanly with no `data/` present, emitting null facts rather than failing
- `make publish-data` — force-push the layers `constants.ts` names + `data/releases` to the orphan `data-static` branch (the prod host)
- `make validate` — check tile_manifest output matches `assets/constants.ts` (run after wiring a new layer)
- `npm run dev` — serve site locally (Vite dev server, hot reload)
- `npm run build` — production bundle (output: `dist/`); **gates on `typecheck` + `lint` via `prebuild` — fails on any type or lint error**
- `npm run preview` — preview production build locally
- `npm run typecheck` — TypeScript check only (cheapest gate; run before claiming any code change done)
- `npm test` — run Vitest unit suite (`*.test.ts`); `npm run test:watch` to watch
- `make test-pipeline` — pipeline smoke tests (`scripts/test_*.py`, stdlib unittest, no `data/` or network needed); CI runs the same on any `scripts/**` push (`pipeline-tests.yml`). Run it after touching any `scripts/*.py`.
- Per-dataset build targets exist too (e.g. `make wind`, `make seismic`) — run `make help` for the current list

## Working style

- **Orient with `git log --oneline -15` *and* `git branch -r` before the first
  edit.** `main` is a rewritten history that shares no ancestor with the older
  topic branches, so `git log main..origin/<branch>` has no merge base and
  reports the branch's whole history as "ahead" — that count means nothing
  here. Check by content instead — `grep` the symbol on `main` — rather than
  trusting a commit count. `origin/data`, `origin/data-static` and
  `origin/data-moratoriums` are orphan data branches; never diff them against
  code. Before saying anything is or isn't published, check the remote
  (`git fetch` then `git branch -r --contains <sha>`), not the docs.
- Cite/edit exact files; layer questions → check `docs/layers/` first
  instead of grepping code.
- Prefer greppable anchors over reading whole files. Insertion points are
  marked in-code with `>>> ADD-LAYER: <name>` comments — `rg ">>> ADD-LAYER"`
  lists them; jump to one and read ~30 lines around it. Don't read an entire
  module to find where something goes.
- Data questions (URLs, columns, licenses) are answered in
  `docs/data-sources.md` and `docs/layers/` — don't re-derive from scripts.
- **Simplest thing that works.** Before adding code, ask whether it needs to
  exist at all. Then: stdlib or an already-installed dep before a new one; a
  native platform feature before a library; one line before fifty. Shortest
  working diff wins. No abstraction with a single implementation, no config for
  a value that never changes. Do NOT annotate these choices in code comments —
  a comment defending a simplification is exactly the editorial content the
  comment-hygiene rule above forbids.
- **Never simplify away** input validation at trust boundaries, error handling
  that prevents data loss, or anything explicitly requested.
- **Measure before you claim a root cause.** Pipeline bugs hide in the data, not
  the code. Run a script over the *built* artifact and count the affected rows
  before proposing a fix — a plausible-looking parser bug and a silent 254-char
  DBF truncation look identical when you only read the source.
- **Tee the long builds to a log; never let one stream into context.**
  `make pipeline`, `make continental-all` and `make global-tiles` run for hours
  and emit tens of thousands of osmium/tippecanoe lines. Run
  `mkdir -p tmp/logs && make global-tiles 2>&1 | tee tmp/logs/global-tiles.log`,
  then quote the head *and* the tail (`head -40`, `tail -40`) along with the
  log path — the first error is the cause and the rest is cascade, and a slice
  quoted without its path is a silent drop. Grep the log for the layer or error
  you care about when you need more; don't `cat` it.
- **Visual checks are the user's call.** By default, run the gates below,
  then say what you changed and what the user should look at. When the user
  asks for screenshot verification, drive the real app with
  [`.claude/skills/drive-app`](.claude/skills/drive-app/SKILL.md) and report
  what the screenshots show. A rendering change is never shown to work by
  tests alone.
- **Definition of done:** when a task has a doc in the routing table, its
  end-of-doc checklist IS the contract — close out every box, don't stop
  partway. Before claiming a code change is complete, run `npm run typecheck`
  (the cheapest gate; `npm run build` also runs lint). If you touched logic
  with a sibling `*.test.ts` (filters, popup-format, url-state, visibility,
  colors, registry, user-data, utils), run `npm test` (Vitest) too. A change
  that hasn't passed typecheck is not done.

## Tone: improvements, not grievances

Commit messages, PR text, docs, and code comments describe what the service
gained — never what was wrong, who caused it, or what we escaped.

- Lead with the user-facing benefit ("crisper vector rendering", "togglable
  labels"), then the mechanics.
- Frame replacements as upgrades to the new thing, not exits from the old:
  "upgrade place search to the new geocoder", not "replace the old geocoder
  because it was slow". Never disparage a vendor, dataset, or earlier
  implementation.
- Don't narrate avoided problems or hypothetical failures ("this was
  broken", "their terms forced us to..."). The improvement stands on its
  own; the motivating grievance stays out of the record.
- Accuracy is not tone: operational constraints that affect behavior
  (quotas, fallbacks, staleness windows, zoom ceilings) are still stated
  plainly wherever the next maintainer needs them. State them as neutral
  facts, not complaints.
