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
  `data` — `LayerData` `{ kind, key, credit, id? }`: where the layer's map source gets
  its data, who it credits and which column is each feature's stable id
  (`FeatureIdDecl` `{ field, native? }`, mirroring `tile_manifest.yaml`'s
  `id_field` / `native_id`) — fields), `BucketedField` (the legend facet record) and `Selection` (`vx` `sel`). Single-owner types live beside their owner: `AppState` in
  `assets/state.ts`, `UserLayer` in `assets/user-data/user-data.ts`,
  `RasterMeta` in `assets/raster-probes.ts`
- `src/units.ts` — display-unit preferences (temp/speed/distance/area/elevation/pressure)
  as ambient module state; SI-in/display-string-out formatters + raw converters; imports nothing
- `src/i18n/` — `index.ts` engine (`t`, `loadDictionary`, `loadRouteStrings`); `locales/<code>.ts` the base dictionaries (boot-read `route.*` keys included); `route/<code>.ts` the route planner's strings, one lazy chunk per locale, loaded when the panel is asked for (`t()` falls back active base → active route → English base → English route → the key)
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
    - `dataset-query.ts` — a `dataset` layer's features as rows: `describe`, async
      `query`/`count`/`aggregate` (each an `Outcome`), `summarise` (the capped copy a model may
      see); filters are the map's, run through style-spec `featureFilter`; GeoJSON layers read
      the whole file (`loadSource`), vector layers the loaded tiles only (`complete: false`).
      `shapeRows` — the template data pass: `where` + area + the base filter of each map layer
      that draws the features (a symbol layer only when `clickPriority` names it), grouped by ≤ 2
      fields and a year (or a date field's month), count + a measure's sum, optional numeric `bins`
      (`binEdges`, rows `bin`/`lo`/`hi`, a bin's `where` matches exactly its rows), features on request
      (≤ 50,000, cuts reported; `complete: true` reads a second layer whole, GeoJSON only); `states`
      on a world layer is an alias of its US admin1 tags (`usOnly`);
      a tiled layer reads the current view only; `shapeSlots` — what each slot takes on a layer
    - `spatial-join.ts` — `joinPoints` (points per polygon) and `crossings` (polygons a line
      crosses) over `dataset-query.ts` rows; tile pieces of one feature merged; `complete` and
      tile precision stated; registry layers only
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
      `joinPoints`/`crossings`, `runAnalysis` (code shown in the chat first) and `planRoute` (dev server only: `toolSchemas(flag)` / `systemPrompt(flag)` list it only when `ROUTE_ENABLED`; solves through `route-panel-open.ts`'s `planRouteFromChat`); `runAnalysis`
      takes `chart` (bar/pie/line, drawn by `ui/ui-chart.ts`, or a Vega-Lite spec shown
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
    - `constants.ts` — shared constants, imports nothing: `DATA` paths, `RELEASES_ORIGIN`/`weatherLiveUrl`,
      the external hosts `diagnostics.ts` also probes (`OPENROUTER_ORIGIN` among them), `CSP_HOSTS`/`CSP_POLICY` (the build's CSP);
      `EMPTY_FC`, `COUNTY_SRC*`, `WEATHER_WASH_OPACITY`; a single-owner constant lives in its owner
      (`MW_SLIDER_MAX` → `filters.ts`, default viewport → `map.ts`, `BLANK_STYLE`/fog/atmosphere → `basemap.ts`, terrain tuning → `terrain.ts`)
    - `download-packs.ts` — `packLinks(downloads)`: a layer's download packs → the formats and links its
      Download menu offers (one link per continent for an OSM pack, Release URLs in prod); pure.
      `download-packs.test.ts` holds the continent codes and continental packs to `build_releases.py` /
      `release_manifest.yaml`
    - `session-snapshot.ts` — per-tab state that survives a reload of the tab (boot bundle, no deps):
      `saveSnapshot`/`readSnapshot`/`hasSnapshot`/`restampSnapshot`/`clearSnapshot` over versioned
      `{v, hash, at, data}` envelopes in `sessionStorage` (read only on a reload/back-forward of the same hash),
      `onHidden`; also the Diagnostics "Page load" line (`initPageLifecycle`, run first by `src/main.ts`;
      `tm-lifecycle`); `endSnapshots` (map.ts, before its reload for a pasted link). Keys: `tm-chat` (the conversation, owned by
      `ui-chat.ts`), `tm-drawer` (the drawer's layout and the table, owned by `ui-table.ts`; shape in `ui/drawer-snapshot.ts`)
    - `live-poll.ts` — `pollWhileVisible`: **the one refresh loop every live feed runs on**
      (interval while the layer is on, plus an instant refetch on return to the tab /
      bfcache restore, at most once per 60 s); zero deps
    - `live-staleness.ts` — **shared factory** for every live GeoJSON feed: auto-refresh
      (through `live-poll.ts`) + stale-data kill-switch modal. `wildfire-staleness.ts` /
      `nws-staleness.ts` are thin config shells over it that export their config (`WILDFIRE_LIVE`,
      `NWS_LIVE`), whose `maxAgeMs` the legend age chips and diagnostics read. Raster/feature-state feeds
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
    - `county-overlay.ts` — a template's per-county colours on the main map: `paintCountyOverlay` /
      `clearCountyOverlay` / `countyOverlayToken` / `onCountyOverlay`; feature-state key `tpl_v` on the shared
      county source, its own fill + outline above the county choropleths and a legend card; session only
    - `route-constraints.ts` — the Routing constraints layer's concern (dev server only): `setRouteConcern` (state, legend, the raster url via `layer-plan.ts`'s `setRasterUrl`), `routeConcernUrl`, `routeConcernLegendHtml`; link param `rc`
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
    - `ui-layer-rows.ts` — layer panel row HTML: `hasPanelRow` (the one row rule) and
      `panelRows(layers, {scope, visible})` → per group `{ids, html}`; reads no state, touches no DOM
      (the HTML follows the locale through `t`)
    - `panel-mirror.ts` — **the only writer of panel control values derived from state**:
      `renderPanel()` (writes the rows from `panelRows`, then syncs) and `syncPanel(layerId?)` (values only:
      checkboxes, heat ramps, mode/colour-by buttons, selects, chips, year/MW/smoke
      sliders, basemap radios + 3D toggles, region dropdown, the Area and Selection rows, each row's
      `where` chip — its conditions in a few words, × clears them);
      `commitArea()` / `commitSelection()` / `commitWhere()` — the one commit path for an Area / selection /
      layer `where` change (set + one `url:write` + `syncPanel`; map-api's `setWhere` wraps `commitWhere` in
      `asOwnStep`); `conditionLabel`/`whereLabel` name conditions for the chip and the table; subscribes to
      `layer:visibility` (one row) and `view:applied` (rows rebuilt only when region, locale or the set of switched-on
      out-of-scope layers — which keep a row — changed, so Undo keeps open sub-panels and focus)
    - `notice-gate.ts` — usage-notice acceptance for the route planner and the map chat: `noticeAccepted`/`acceptNotice` over `tm-notice-route` / `tm-notice-chat` (accepted version; memory when storage is blocked), `ROUTE_NOTICE_VERSION`/`CHAT_NOTICE_VERSION`; boot-bundle safe (zero deps); imported only by the lazy chunks
    - `notice-dialog.ts` — `showNotice(id)`: the notice as a modal `<dialog>` built from nodes (only the chat's two OpenRouter links are anchors); lazy chunks only (`ui-route.ts`'s `openRoutePanel`, `ui-chat.ts`'s `openChat`/`resumeChat`; `routeForChat` refuses until accepted)
    - `ui-menubar.ts` — top bar: File (Open ▸, Save ▸, Experiences, Settings), Tools (Ask, Visualize, Plan a route, Diagnostics, Hide legends), Undo/Redo buttons (in File at ≤ 640 px wide or ≤ 500 px tall), draw/edit/export
    - `ui-mydata.ts` — My Data tab wiring
    - `ui-services.ts` — File ▸ Add layer from a service…: library search and Paste URL; lazy chunk.
      `ui-linked-services.ts` — My Data's linked-service rows and the Load / Skip card for a link's
      unvetted services; `services-dom.ts` — `el()`, text-only DOM for both (lint-enforced), and `sourceLink()` (a library entry's source page, also in Data Credits)
    - `ui-search.ts` — feature search (finds only what the map draws); `ui-geocoder.ts` — place search
    - `ui-area.ts` — the Area picker; lazy chunk. `area-labels.ts` — the lazy region-label table
    - `ui-openwith.ts` — "open with" link builder
    - `ui-table.ts` — the table drawer: a layer's rows (`query()`) in a Tabulator grid (render only —
      virtual rows, columns that resize and move, a frozen check column, a dragged cell range that
      Ctrl/Cmd+C copies as TSV with a header line and raw values; the copy is its own, not Tabulator's
      clipboard module), group-by summary (`aggregate()`), sort, CSV, checked rows → `commitSelection`,
      a header ▾ per schema field whose filter sets the layer's `where` through map-api `setWhere`
      (map, table, CSV and link agree); also hosts the chat's Ask
      pane (`openAsk`/`closeAsk`), the Visualize pane (`openViz`/`closeViz`) and the Proximity pane (`openProx`/`closeProx`, own grid, never kept); lasts the tab (`tm-drawer`: panes, height, the table's state —
      `restoreDrawer` after a reload of the same link, from `ui-menubar.ts`'s boot hook through
      `table-open.ts`); lazy chunk, opened through `table-open.ts`. `drawer-snapshot.ts` —
      `parseDrawerSnapshot`, the pure shape check of `tm-drawer` (versioned, capped, the link's validators)
    - `grid-copy.ts` — what the three range grids (table drawer, Proximity, Method) share: `GRID_RANGE_DEFAULTS` (the common Tabulator options), `isCopyKey`, `keepFromGrid`, `clipValue` (raw values, formula-guarded text), `tsvOf` (a header line, then rows), `copyText` (a keypress clipboard write); no Tabulator import at runtime, pure of the DOM model
    - `ui-line.ts` — the drawer's Line tab (popup ▸ Line tools; lazy chunk): the line's chain, ends A/B (HIFLD `SUB_1`/`SUB_2`
      placed by the HIFLD substations of those names, with Swap; OSM chain-end substations named by `lines/osm-substation.ts`),
      the fault locator (pins walked along the true geometry, ±% span, relay-length scaling, Add pin to My Data); `lt-` map
      layers, added and removed; session only (no URL, no undo, not in `tm-drawer`). `line-open.ts` — `openLineTools`, the
      boot-bundle-safe opener (dynamic import; the only way in). `line-profile.ts` — the tab's Profile section: Show →
      `lines/profile.ts`, progress + Cancel, canvas chart (labels by `fillText`), crosshair → `lt-hover` marker, ←/→ keys,
      stats, PNG/CSV; the intro says points go to USGS only when the line reaches 3DEP coverage (`reaches3dep`)
    - `ui-chat.ts` — the map chat in the drawer's Ask tab (File ▸ Ask the map…): key form,
      model picker, one chip per tool call, a confirm card before an off-page call, a chart card
      after a call made with `chart`; bot replies render markdown via `chat-markdown.ts` (DOM nodes, text only); lazy chunk; the conversation lasts the tab (`tm-chat`, restored
      after a reload of the same link — `resumeChat`, called by `ui-table.ts`'s `restoreDrawer` when `tm-drawer` had Ask open).
      `ui-chart.ts` — that card: a canvas bar/pie/line
      drawn from a checked `chart-spec.ts` spec (text via `fillText`/`textContent` only), PNG and CSV
      downloads; in the chat chunk. `ui-canvas.ts` — the canvas card (`DispatchOpts.render`: a
      `showCanvas` page or a Vega-Lite chart): "Made by the model" border, Expand, ×, partial-data notes,
      error lines, page-owned Save buttons; imported by `ui-chat.ts` on first use
    - `ui-templates.ts` — the drawer's Visualize tab (File ▸ Visualize…, a layer row's ⋯ menu ▸
      Visualize): layer picker, the gallery of templates that fit (`templatesFor`), a form from
      `formChoices`, Show → `showTemplate` → a `canvasCard({template: true})`; works with no key; its
      layer and cards ({templateId, layer, params}) ride in `tm-drawer` (`resumeVisualize`); lazy chunk,
      opened only through `templates-open.ts` — `openVisualize`/`resumeVisualize`, boot-bundle safe (dynamic import)
    - `layer-menu.ts` — a layer row's ⋯ menu (`ui-layer-rows.ts` renders it): Filter / Filter by year
      (open the same sub-panels, `aria-checked` while shown), Show in table, Visualize, About this data,
      downloads; arrow keys, Home/End, Esc returns focus; placed by `positionColorMenu`; holds no view state
    - `ui-selection.ts` — the Selection row's menu (Isolate/Keep, Show in table, Zoom, Clear);
      boot bundle
    - `proximity-open.ts` — `openProximity`, the boot-bundle-safe opener for Tools ▸ Proximity (dynamic import of `ui-proximity.ts`)
    - `grid-ops-open.ts` — `openGridOps(nodeId)`, the boot-bundle-safe opener of the drawer's Grid Ops tab (`ui-grid-ops.ts`, lazy
      chunk): a node's load, generation, net, ties ranked by MW, a table of every shown node, "Inside the area"; text-only DOM;
      session only (not in `tm-drawer` or the link); a tap a tool owns (`popup.ts` `toolOwnsTap`) does not open it
    - `ui-proximity.ts` — the Proximity tab's panel (lazy chunk): CSV picker, threshold in ft/mi/m/km, Groups and Pairs grids, both CSVs; `docs/proximity.md`
    - `overlay-layers.ts` — `setGeojson` (add or update a GeoJSON source) and `removeOverlay` (layers, then sources) for the route, proximity and line panels' overlays; state.ts only
    - `proximity-map.ts` — the Proximity tool's map half (lazy chunk): `px-` sources and layers, fit once per file, row click selects (`onRow`), ↗ flies (`onFly`), tap → focus
    - `ui-experiences.ts` — Map Experiences gallery + floating story card; lazy chunk, opened from the File menu
    - `ui-diagnostics.ts` — Diagnostics dialog; lazy chunk, opened from the File menu
    - `ui-settings.ts` — Settings dialog (display units); lazy chunk, opened from the File menu
    - `ui-credits.ts` — Data Credits dialog; renders `renderDataCredits()` from
      `DATA.data_manifest` (`data/layers/manifest.json`, built by
      `scripts/build_data_manifest.py`) over the hand-written `<li>` fallback
      already shipped in `index.html`; lazy chunk, opened from the info button
    - `route-panel-open.ts` — the Route panel's entry points, boot bundle: `ROUTE_ENABLED` (`import.meta.env.DEV`),
      Tools ▸ Plan a route…, right-click Route from/to here; the panel and its strings (`src/i18n/route/`) load on use
    - `ui-route.ts` — the Route tab of the bottom drawer, lazy chunk: the `RouteSession`, solve/cancel/progress,
      the `rp-` map layers and legend, cell inspector, cell-weight overlay, header actions, `RouteTabContext`
    - `route-inputs.ts` — its input column: A/B search over substations, pick mode, draggable pins, line type, method
    - `route-report.ts` — the printable report (browser print), loaded on the Report button
    - `route-tabs/` — the six sub-tabs, each a `RouteTab` rendering from `ctx.session`: `summary`, `cost`, `profile`,
      `crossings`, `alternatives`, `method`; shared `types.ts` (the contract), `widgets.ts` (waterfall, range bar, pills),
      `colours.ts`, `weights-table.ts` (the stacked method editor on phones); `method-grid.ts` (the Method tab's Tabulator grid, renderer only, wider than 520 px) and `method-rows.ts` (its pure model: rows, filter, sort, edits through `validatePresetPatch`); the Method tab also renames and deletes saved methods; `fixture.ts` is test support
  - **`assets/layers/`** — MapLibre layer builders
    - `layer-plan.ts` — `LayerPlan` (a builder's sources + style layers, in paint order — plain
      data) and `applyLayerPlan(map, plan)`, the one step that puts a plan on the map: sources
      first, already-there guards, `beforeId`, each style layer's starting visibility from its
      registry layer's state (unless it pins its own), and each layer's `filter` registered as its base filter.
      A PMTiles source no starting layer draws is held without its url; `setMapLayerVisibility` (the way to
      show a style layer — `visibility.ts` and `nws-zone-join.ts` use it) reads the archive on first show;
      `npm run lint` rejects a raw `setLayoutProperty(id, "visibility", …)` outside the modules that own their sources
    - `layer-source.ts` — a registry layer's `data` declaration → its source: `layerSource(id)`
      (credited vector/raster/GeoJSON spec by `kind`; a non-native `data.id` becomes its `promoteId`), `layerDataUrl`, `layerSourceId` (layers
      declaring the same data share one source; `LAYER_SOURCE_ALIAS` for the rest), `SOURCE_DATA_URLS`
      (source-only GeoJSON), `pmtilesUrl` (non-registry join sources only)
    - `layer-init.ts` — shared plan helpers: `planPolygon`,
      `planRaster`, `planTransmissionLines`, `planSubstationPoints`,
      `countyBoundariesSource` (+ `ensureCountyBoundaries` for layers added after boot),
      `genPlantTextLayout`, `GEN_PLANT_TEXT_PAINT`
    - `layer-data.ts` — the lazy GeoJSON loader: `ensureLayerData` (with the `fromZoom` gate and
      zoom-settle retry), `loadSource` (the same without the gate, for a query), `fetchGeojson`;
      `liveFeed` — a live source's pull time and subfeed status (first feature, then FeatureCollection level); which file into which source comes from `layer-source.ts`;
      emits `layer:data` on the bus when a source's features land
    - `base-filters.ts` — zero-dependency `registerBaseFilter` + `BASE_LAYER_FILTERS`: each style
      layer's own inline filter (registered by `applyLayerPlan`), which `filters.ts`'s `effectiveFilter()` builds on
    - `add-all-layers.ts` — `addAllLayers()`: collects every builder's plan in z-order and applies
      them in one `applyLayerPlan` call, then runs the builders' non-layer side effects
    - `map-layers-{osm,hifld,eia,load,renewable,rail,conditions,mines,petroleum,wecc,westtec,admin,land}.ts` — per-source
      `plan*()` builders, each returning a `LayerPlan`
      (`conditions` = wildfire/seismic/NWS alerts/ODIN outages/FEMA NRI/NEXRAD radar — all the live + hazard layers;
      `admin` = administrative boundaries — US Counties/States/ZCTA, world Countries/Admin-1;
      `land` = PAD-US/Critical Habitat)
  - **`assets/proximity/`** — Proximity check core (pure, no DOM or map): `proximity.ts` (`proximityGroups` = m5, `proximityPairs`), `geodesic.ts` (WGS84 Karney), `oracle.ts` (m0), `methods/`, `types.ts`; `pairs-worker.ts` / `pairs-open.ts` (pairs in a Web Worker), `bubbles.ts` (points + circle-radius in metres), `clear.ts` (Reset hook, boot bundle); `docs/proximity.md`
  - **`assets/services/`** — linked GIS services (added by URL or from the library; view state, not My Data)
    - `service-spec.ts` — the contract: `parseServiceUrl`/normalise (https only, no keys or sign-in),
      kind detection, `validateServiceSpec`, the bounded style vocabulary and `styleToLayers`
      (MapLibre source + layers); pure
    - `service-hosts.ts` — `isVetted(url, kind?)` over `src/registry/service-hosts.json` (exact host,
      or a path prefix at a segment boundary)
    - `service-trust.ts` — the per-tab approved set (`isAllowed` = vetted or approved; mirrored to
      `sessionStorage` `tm-svc-approved`)
    - `service-load.ts` — fetch for a view: ArcGIS paging, error/sign-in replies, size and time caps,
      stale replies dropped, GeoJSON; `status`, `detectDrawKind`
    - `service-render.ts` — `renderServices()`: keeps the map in step with `state.services` (called
      from `repaintView`); the only fetcher, and it draws only vetted-or-approved services; a service
      travels in a link as the `sv` section of `vx`
  - **`assets/sandbox/`** — the analysis sandbox (model-written code, no network) and the canvas frame
    (model-written pages the visitor sees; CDNs and tile hosts only)
    - `geo-kit.ts` — pure geometry (point-in-polygon, bbox, length, intersection, area) inlined into the runner
    - `runner.js` — the sandbox's script; `scripts/build_sandbox.mjs` (`npm run build:sandbox`) inlines it
      with the kit into `public/sandbox.html` with its CSP hash (`default-src 'none'`; inert unless truly sandboxed)
    - `sandbox-host.ts` — `runInSandbox`: the `allow-scripts` frame, one run at a time, input/output caps,
      10 s stop, replies matched by frame and nonce
    - `canvas-runner.js` — the visible canvas frame's script (one IIFE): `showCanvas` pages (written into
      the same document, `TM_INPUT`, `TM.download`/`drawn`/`fail`/`action`/`lib`, memory-only storage shims)
      and Vega-Lite charts; libraries pinned with SRI in `src/registry/template-libs.json` (one table for
      Vega and `TM.lib`); `scripts/build_sandbox.mjs` inlines it into `public/canvas.html` (generated — never hand-edit)
      with its meta CSP: the three CDNs, Google Fonts and the tile hosts in `src/registry/canvas-hosts.json`
    - `canvas-host.ts` — `runCanvas`: the page side of a canvas frame — nonce and `event.source` matching,
      every post-render message validated, downloads checked, ≤ 3 live frames, 10 s watchdog, navigation guard;
      `template: true` frames resolve on `drawn` (15 s) and alone pass actions to `onAction` (≤ 50);
      a vega template frame alone is sent its `signals` (the selections the runner bridges to actions)
  - **`assets/templates/`** — page-owned visualization templates (File ▸ Visualize…, the chat's `showTemplate`)
    - `catalogue.ts` — the 15 archetypes as entries (`ready`, params, geometry, libraries, `source`: a Vega
      builder or an html script loaded `?raw`); `templatesFor(layerId)`, `templateById`, `queryableRoles`
    - `show-template.ts` — the one path onto the screen: `validateTemplateArgs` (params checked and
      defaulted from the layer's roles and the view), `showTemplate` (→ `shapeRows` → `TemplatePayload`,
      legend folds and colours, ≤ 8 MB via `capPayload` → `host.render`; the model gets only its
      ≤ 1 KB `summary`), `renderParams` (what a card keeps to re-run: area and the `where` used),
      `formChoices`, `fieldLabel`/`measureLabel`
    - `template-actions.ts` — a template frame's actions (select / fly / table / where), checked against
      what the page sent it and the link validators: `conditionForBin` (a chart group → its condition, built
      by the page), `mergeWhere`, `templateActions` (one handler per frame: one undo step per commit, ≤ 5
      commits per 10 s, an Undo toast)
    - `groups.ts` — `topGroups` (one field's rows as ranked, labelled, coloured groups + Other; shared by the
      Vega builders and the summary), `NEUTRAL`
    - `payload.ts` — `TemplatePayload`, the `TM_INPUT` a template frame reads (types only)
    - `vega/` — the Vega-Lite builders, payload → spec with inline rows: `composition.ts`, `ranking.ts`,
      `timeline.ts` (additions or net; months when recent), `compare-regions.ts` (a panel per region),
      `distribution.ts` (a histogram over the page's bins), `common.ts` (sizes, labels, config)
    - `per-region.ts` — points-per-polygon's page half: quantile classes and ramp, region outlines for the
      frame from the app's GeoJSON boundaries (states, NERC, BA, countries, admin-1); `regionCentre` (a
      region's pie centre, pies-per-region)
    - `nearest.ts` — nearest's page half: `nearest(points, targets)` (exact haversine km over a grid index of
      the targets, antimeridian-safe), `haversineKm`; pure
    - `html/` — repo scripts run in the canvas frame as `kit.js` + one template: `kit.js` (the shared frame
      kit: header, legend, table, download menu, `TM_INPUT` reader), `lines-by-class.js` (MapLibre + d3),
      `density.js` (MapLibre + deck.gl), `points-per-polygon.js` (ranked regions; MapLibre outlines unless
      by counties, which paint the main map), `pies-per-region.js` (a pie per state, country or admin-1 on a
      MapLibre map, SVG pies sized by sqrt of the total, ≤ 250 regions; split = the region, by = the slices), `flow.js` (d3 + d3-sankey; ≤ 40 nodes), `nearest.js` (MapLibre
      map + distance ECDF + threshold slider; model told numbers only), `buildout-map.js` (MapLibre, plays and
      scrubs by year or month; no autoplay under reduced motion); `template-fakes.ts` is test support
  - **`assets/lines/`** — transmission line GeoParquet tools (lazy chunks; hyparquet + fzstd live only here)
    - `line-read.ts` — range reads of `data/analysis/` (`DATA.line_index`; a layer names its dataset in
      `data.analysis`): `lookup` (fid → exact length, one IDX request), `lineGeometry`, `chainGeometry`,
      `selectionGeometry` (≤ 1,000 ids; > 20 by the GEO bbox page index); failures are `LineOutcome` reasons
    - `line-copy.ts` — `copyLines`: full geometry + tile properties + credit into My Data (`addCopiedFeatures`),
      tile geometry marked when the files cannot answer; its caps and the GeoJSON download beyond them live in
      `user-data/copy-fit.ts`; used by the popup (length row + Copy) and the table's copy of checked lines (`copy-rows.ts`)
    - `osm-substation.ts` — `osmSubstationName(fid, at)`: an OSM chain-end substation's name from the substation points
      archive at its max zoom (the 1–4 tiles within 1.5 km of the end; pmtiles + `@mapbox/vector-tile`), whether or not the
      map has drawn it; null → the Line tab links the OSM id
    - `along.ts` — walking the true geometry (pure): `assembleWays`, `pointAt`/`sliceAt`, `densify`, `faultPosition`, `orientEnds`
    - `profile.ts` — `lineProfile`: densify at max(30 m, L / 4,999), USGS 3DEP, Terrarium for what 3DEP left empty, a
      source per sample and null (a gap) where neither answered; `profileStats` (2 m hysteresis), `profileCsv`
    - `fixtures/make-fixtures.py` — the mini line files `line-read.test.ts` reads (runs `build_line_parquet.py --fixture`)
  - **`assets/elevation/`** — elevation samplers (main thread): `terrarium.ts` (Terrain Tiles, worldwide; the route
    profile and the line profile's fallback, `TERRAIN_CREDIT`), `usgs-3dep.ts` (`sample3dep`: ImageServer `getSamples`,
    ≤ 1,000 points per form POST, always `pixelSize`, ≤ 4 in flight, 30 s timeout, one retry on a 5xx/timeout, US boxes only)
  - **`assets/grid-ops/`** — the Grid Operations layer (EIA-930, `ba-interchange`): BA bubbles and interchange
    arrows for one hour, read live from PUDL's Parquet (`PUDL_BASE_URL`; nothing hosted here)
    - `eia930-read.ts` — lazy chunk (hyparquet): `readHour(at)` / `hourRange()`; the row groups whose time
      statistics hold the hour, decoded as columns and kept a few per table; every failure a `ReadOutcome`
    - `ba-graph.ts` — pure: `buildHour(hour, groupBy)` → bubble + arrow features (both sides of a tie averaged,
      groups summed, EIA-930 sources folded into `FUEL_LEGEND`); `GROUP_BYS`, `GRID_GLYPHS`; `OFF_AREA` (BAs drawn
      apart in the WECC area grouping: GRID off the Oregon coast); a BA with no EIA region stands alone; `numbersShown`
    - `grid-ops.ts` — controller: the hour bar (`#gridOpsTimebar`), playback, `setGridView` (the view setter for
      `gt`/`gg`/`gd`/`gn`), the per-hour fuel-disc and ring images (ring = generation ÷ load), `addGridOpsImages` (the
      arrowhead), `gridShown`/`onGridPaint` (what the drawer tab reads); a bubble tap opens the Grid Ops tab
    - `src/registry/eia930-bas.json` — generated by `scripts/build_eia930_bas.py` (`make eia930-bas`): each BA's
      name, EIA region, interconnection and bubble position
  - **`assets/user-data/`** — user-imported/drawn layers
    - `user-data.ts` — core (add/remove/render; `commitUserData` = save + render); `user-data-draw.ts` draw mode
    - `user-data-store.ts` — `createUserDataStore` over a `getItem`/`setItem` adapter: the `tm-user-data`
      payload (validated by `parsePayload`), saves held back until `load()`, then flushed once; drawn-feature cache
    - `user-data-import.ts` GeoJSON/KML/KMZ import; `user-data-export.ts` export
    - `user-data-csv.ts` CSV point import + column picker; `csv-parse.ts` pure CSV parser (unit-tested)
    - `view-file.ts` — `*.tmview.json` view files: Save view… / Open… of a view's hash through the link codec
    - `copy-fit.ts` — the one set of copy caps (1,000 features / 1.5 MB GeoJSON / 4 MB store), download fallback and credit text for every copy to My Data (popup, table, chat); a save the browser refuses rolls the copy back and offers the download
    - `copy-rows.ts` — **lazy chunk** (table drawer; `map-api.ts` later): `copyMode`/`copyAvailable`/`copyRows` for a layer's checked rows: a GeoJSON layer's own geometry (cloned, `__` keys dropped, licence and source URL from the data manifest) or a line layer's full geometry through `lines/line-copy.ts`
    - `user-data-geom.ts` geometry utils; `user-data-colors.ts` color picker
    - `draw-chunk.ts` — **lazy chunk boundary**: re-exports draw/import/export; loaded on first toolbar interaction (keeps MapboxDraw/toGeoJSON/jszip out of the initial bundle)
  - **`assets/utils/`** — pure utilities
    - `utils.ts` string helpers and `csvCell` (the one CSV cell: RFC 4180 quoting, formula guard; zero imports, worker-safe); `utils-dom.ts` DOM helpers, incl. the `h`/`ht` element builders; `utils-uid.ts` UID generation
  - **`assets/route/`** — the route optimizer (pure, runs in a worker and in Node; dev server only — see `docs/routing.md`)
    - `route.ts` — `route()`: grid.json check → search mask → band reads → surfaces → solve → proof →
      PI reduction → costing; `PD_BANDS`/`OSM_BANDS` (the band order); every failure an `Outcome`
    - `dijkstra.ts` 16-move Dijkstra (r.cost convention, barrier straddle, endpoint guard), `distances`, `traverse`;
      `pi-reduce.ts` angle points within a whole-route 0.5 % budget
    - `cost.ts` — preset → LUTs (`compile`), `buildSurfaces`, `presetBands`, `minRouteWeight`, `costPath` ($ line items)
    - `similar-cost.ts` similar-cost areas (`classify`) + penalty alternatives; `surface-image.ts` classed window → Web Mercator RGBA
    - `preset-patch.ts` — `validatePresetPatch` / `validateRouteOptions`: the trust boundary for preset edits and route options
    - `cog-read.ts` reader for our own COGs only; `grid.ts` the EPSG:5070 grid + Albers (mirrors `scripts/route_grid.py`)
    - `cause-colours.ts` — route category key → colour + label key for the cell-weight overlay's "What constrains" mode (land categories take the layer's colours, OSM and terrain greys); pure
    - `profile.ts` — what a route passes through (runs, crossings, samples) for the panel; `categories.ts` — preset row →
      display category (waterfall, driver colour); `inspect.ts` — one cell decoded and explained (cell inspector)
    - `snap.ts` — substation index, `snapAt` (kV floor by line type), `searchSubstations`; pure (the profile's elevation
      sampler is `assets/elevation/terrarium.ts`)
    - `custom-presets.ts` — saved methods (`tm-route-presets`); `route-prefs.ts` — defaults for new routes (`tm-route-prefs`);
      both re-validated on every read
    - `route-worker.ts` / `route-open.ts` — the worker and its main-bundle-safe opener (`routeLine`)
    - `*.validate.test.ts` — real-cube validation, excluded from `npm test` (`vitest.route.config.ts`); `fixtures/` mini cubes
- `src/colors/` — color/style logic (no MapLibre side effects, safe to import anywhere)
  - `voltage.ts` — `voltageColorExpr()`
  - `ramps.ts` — wind/solar/geo/pop/heat ramps + year-filter constants
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
    swatch); `facet(key)` looks one up and
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
    cannot hold — geometry, label field, roles of `dataset-query.ts` `DISPLAY_FIELDS`, field →
    legend facet, derived measures (count, length_km, area_km2) and `pending` fields (in the data,
    not yet readable); `describe()` returns them. `field-roles.test.ts` holds a new queryable layer
    to an entry and writes `docs/templates-coverage.md`
  - `template-signatures.ts` — `TEMPLATE_SIGNATURES`: the 15 visualization archetypes as role
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
- `scripts/build_global_tiles.py` — builds one planet-wide artifact per layer (what
  the map reads) from the 8 continental OSM intermediates: each layer is merged,
  deduped on its seam key and tiled in one tippecanoe pass (`RETILE`,
  `TILE_POLYGONS`; `CONCAT_GEOJSON` for the small point layers). Transmission is
  cut afterwards into six voltage-class archives — `TRANSMISSION_BANDS`, mirrored
  by `OSM_TL_BANDS` in `src/registry/transmission.ts`. Download packs stay
  per-continent.
  See `docs/hosting-plan.md` and `docs/pipeline.md`.
- `scripts/` — data pipeline: `extract_*.py` (per dataset — e.g.
  `extract_us_census_boundaries.py` for US states/ZCTA,
  `extract_cgaz_boundaries.py` for world countries/admin-1), `fetch_*.py`
  (live feeds), `build_*.{sh,py}` (rasters/tiles/releases), `osm_common.py` +
  `geo_common.py` shared
- `scripts/build_region_domains.py` — `make region-domains`; re-run after a boundary refresh and commit its output
- `scripts/stable_ids.py` — `make stable-ids`: decodes each served archive at its max zoom and
  fails on a missing or duplicate stable id; ids are built in the extracts (`docs/pipeline.md` § *Stable ids*)
- `scripts/region_join.py` — region tags (`|TX|NM|`, `|none|`): which states, counties,
  BAs, NERC regions and utility territories (worldwide: countries, admin-1) each asset
  falls in; run by `make region-tags` on the US intermediates and by
  `build_global_tiles.py` on the world layers. Assets are tagged, context layers are
  not — see `docs/pipeline.md` § *Region tags*. `scripts/admin1_codes.csv` — the
  committed admin-1 short codes; never renumber (links filter on them)
- `scripts/build_route_constraints.py` — `make route-constraints`: the Routing constraints layer's tiles, one paletted PNG PMTiles per concern from the cube's `pd_` files (and `osm_` files for the OpenStreetMap entries, credited ODbL), into `data/route/constraints/` (dev-only, never under `data/layers/`); rules and colours from `scripts/route_constraints.json`
- `scripts/route_grid.py` — the routing cube's grid and every band code table (band spec v8, 19 pd + 3 osm bands);
  `scripts/fetch_route_inputs.py` its raw inputs; `scripts/build_route_{bands,restrict,slope,flags,costbands,structures}.py`
  build the 250 m bands and `scripts/build_route_cube.py` stacks them into `data/route/250m/` (`make route-cube`,
  `make route-cube-assemble`); `scripts/build_route_report_data.py` the crossing-report GeoParquet
- `scripts/build_route_buildings.py` — bounded USA Structures fetch + observed all/nonresidential/unknown-class footprint shares; `make route-buildings ARGS="--fetch --bbox W S E N"`. The three bands share a coverage mask: 0 unobserved, 1 no matching footprint returned, 2–101 upward-rounded percent bounds. Homes is unchanged. Complete ID paging and stable service edit metadata precede cache activation; assembler verifies raster hashes and stages both cube and fixtures before promotion.
- `scripts/build_route_buildings_national.py` — the same footprint bands from all 49 CONUS state archives (`make route-buildings-national ARGS="--source-dir PATH --work-dir PATH"`); hash-bound resumable state shards, bounded per-cell unions across state files, national land coverage only after every source completes. Keep archives/work on an external disk. Regional report inputs stay separate; default observation weights remain neutral.
- `scripts/route_crossings.py` — crossing report for a routed line (dev tool; stdlib core tested by
  `scripts/test_route_crossings.py`); `scripts/route_validation_inputs.py` — PNAS corridors/spurs and WestTEC validation inputs
- `scripts/build_route_screening.py` — building and aviation observations for drawn-route reports, from verified caches (`make route-screening`); immutable generations under the local report directory. `assets/route/screening.ts` computes roof intervals and runway distances; `assets/ui/route-observations.ts` presents them. They do not change routing weights or establish occupancy.
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
- `docs/internal/chat-trust-model.md` — the chat's trust rules and their reasons; read before changing what the chat, a service or a frame may do
- `docs/adding-a-layer.md` — **read this before adding any map layer**
- `docs/map-experiences.md` — curated guided views (`File ▸ Experiences…`, `?exp=`)
- `docs/line-tools.md` — the transmission line tools (copy with full geometry, fault locator, elevation profile): data flow, limits, privacy
- `docs/proximity.md` — the Proximity check (Tools ▸ Proximity): groups and pairs, the WGS84 measure, limits, privacy; `docs/internal/proximity-notes.md` — its code layout, tests, benchmarks and change checklist
- `docs/pipeline.md` — how the data pipeline fits together
- `docs/data-sources.md` — where every dataset comes from
- `docs/layers/<layer>.md` — one doc per layer (source URL, columns, build)
- `docs/release-artifacts.md` — inventory of data files + download packs
- `docs/hosting-plan.md` — where each asset class is hosted and how the world
  transmission archive is split by voltage class
- `docs/routing.md` — the public line-routing method: what it does, data, pricing, weights beside
  the studies, methods, checks, limits. Plain facts only; no dates or run history (check results
  name the band-spec version they were measured on)
- `docs/internal/routing-notes.md` — contributor notes for the route optimizer: cube
  contracts, build commands, engine details, checks, decisions, panel and constraints-layer rules
- `docs/templates-coverage.md` — **generated** archetype × layer fit matrix
  (`UPDATE_TEMPLATES_COVERAGE=1 npm test` rewrites it; the test fails when it is stale)

## Task routing — read these, not the whole repo

| Task | Read |
|---|---|
| Add a dataset to the pipeline | `docs/adding-a-dataset.md` (data half), then `docs/adding-a-layer.md` for frontend |
| Add a map layer | `docs/adding-a-layer.md` ONLY, then `rg ">>> ADD-LAYER"` for insertion points |
| Add a **live** layer (auto-refreshing feed) | `docs/adding-a-live-layer.md` — the delta on top of `adding-a-layer.md` (silent footguns: the shared `data-branch` concurrency group, and `maxAgeMs` must exceed the worst-case cron gap) |
| Give a dataset a stable id / feature-id lookups | `docs/pipeline.md` § *Stable ids*, `assets/feature-id.ts`, `src/registry/osm-fid.ts` (silent footguns: an OSM layer's `data.id` must be `OSM_FID`/`OSM_NATIVE_FID` itself, never a copy; a GeoPackage reserves `fid`, so write it with `GPKG_FID_OPTIONS` or the column is lost; and tippecanoe `--use-attribute-for-id=fid` silently skips an attribute not typed `-T fid:int`; a native id is not a property, so read it with `featureId()`) |
| Add a filter (legend chips or range/slider) | `docs/adding-a-filter.md` (silent footguns: a non-standard facet's hand applier goes in `FACET_APPLIERS`, which is what `applyAllFilters()` runs, and claim a unique URL code — see `docs/url-state.md`) |
| Change a display unit / add a setting | `docs/settings.md` (silent footgun: a convertible ramp's legend label must use `RampDef.fmt`, not `unit`/`maxLabel` — those freeze at module-load time) |
| Undo/redo, what goes on the stack | `assets/undo.ts`, `docs/url-state.md` § *Undo* (silent footgun: a control that writes the URL without `url:write` — calling `writeUrlState()` directly — updates the link but is not undoable) |
| URL hash / shareable links / add a URL param | `docs/url-state.md` (silent footgun: param-char collisions — check the reserved-char table) |
| Add or edit a curated map view / story | `docs/map-experiences.md` (silent footguns: a legend filter needs its base layers in `layersOn`; and a new `MapExperience.state` field must be representable in `assets/url-state-codec.ts` or it never reaches a shared link — `assets/experiences.test.ts` § 1 fails when it isn't) |
| Anything that reacts to a click/tap/hover on the map | `assets/map-input.ts` — subscribe there, never `map.on("click"\|"mousemove"\|…)` (silent footgun: a touch screen reaches `click`/`mousemove` only as compatibility mouse events, and the browser withholds those while the draw control is attached — mapbox/mapbox-gl-draw#1301; `npm run lint` fails the raw form, though it cannot see a non-literal event name or a direct `addEventListener` on the canvas) |
| Check a change in the real app / verify by screenshots | `.claude/skills/drive-app/SKILL.md` — headless Chromium against the dev server, with scenarios for links, `vx`, Reset, view files, style overrides, the table and the chat (silent footgun: Reset's `window.confirm` is dismissed headless unless dialogs are accepted, and a screenshot taken before MapLibre's `idle` shows a half-drawn map while every check passes) |
| A panel control shows the wrong value after Reset/Undo/a story/a link | `assets/ui/panel-mirror.ts` (`syncPanel`) (silent footgun: `ui-layer-rows.ts` takes no state, so a control whose value is view state needs a line in `syncPanel` — nothing else repaints it, since a view that keeps region and language no longer re-renders the rows) |
| Table drawer / selection chip | `assets/ui/ui-table.ts`, `assets/ui/ui-selection.ts`, `assets/ui/panel-mirror.ts` (`commitSelection`, `commitWhere`) (silent footguns: open the drawer only through `table-open.ts`, or the chunk (and Tabulator) lands in the boot bundle; Tabulator is a renderer only — sorting, filtering and grouping stay with `dataset-query.ts`; never register Tabulator's Clipboard/Export modules (they write copied values through `innerHTML`) or return a string from a formatter (it is HTML) — cells are text nodes; grid fields are positional (`f0`…), since a dotted field name is a path to Tabulator; a column filter goes through map-api `setWhere`, never `filters.ts` directly, or Undo and the row chip miss it; jsdom draws grid rows only under `test-drawer-env.ts`'s size stubs; a selection change goes through `commitSelection`, or the link and Undo miss it; a display column goes in `dataset-query.ts` `DISPLAY_FIELDS`, which a model also reads; a copy of GeoJSON rows clones each row before it is stored, since rows are `state.sourcesData` objects that My Data would otherwise mutate) |
| Add a library service / vetted host | `src/registry/service-library.json`, `src/registry/service-hosts.json`, `assets/services/service-library.test.ts`, then `node scripts/check_service_library.mjs` (silent footguns: an entry must pass the library test — the same `validateServiceSpec` a pasted URL takes, with credit and licence filled; on a shared ArcGIS host (`services*.arcgis.com`) vet by exact service root, never an org prefix unless the org is the agency itself; a credit is shown escaped in the popup and Data Credits — never put one into a MapLibre `attribution`, which is HTML) |
| Linked services / add-service-by-URL | `assets/services/`, `assets/ui/ui-services.ts`, `docs/url-state.md` (`sv`), `docs/internal/chat-trust-model.md` (silent footguns: only `renderServices()` fetches, and only a vetted-or-approved service — a link, view file or Undo never approves; approval comes only from an explicit visitor click or the chat confirm, for that exact URL; the `sv` cap is UTF-8 bytes, not characters; remote strings are text-only — `npm run lint` covers `ui-services.ts`, `ui-linked-services.ts` and `services-dom.ts`, and a popup goes through `escapeHtml`; a service is draw-and-click only, never filtered or queried) |
| Analysis sandbox / `runAnalysis` | `assets/sandbox/runner.js`, `assets/sandbox/sandbox-host.ts`, `scripts/build_sandbox.mjs` (silent footguns: after editing `runner.js` or `geo-kit.ts` run `npm run build:sandbox` — the committed hash in `public/sandbox.html` must match (`node scripts/build_sandbox.mjs --check`); never add `allow-same-origin` or `unsafe-eval`; inputs are registry layers and allowlisted fields only, never My Data or services; the output is capped before the model reads it; check a change with the `sandbox` scenario of `drive-app` on a preview build) |
| Chat canvas / `showCanvas` | `docs/internal/chat-trust-model.md` (§ *Frames*), `assets/sandbox/canvas-runner.js`, `assets/sandbox/canvas-host.ts`, `assets/ui/ui-canvas.ts`, `showCanvas` in `assets/agent/tools.ts`, the library list in `assets/agent/loop.ts` `SYSTEM_PROMPT` (silent footguns: never add `allow-same-origin` or any other sandbox flag to the frame; the canvas CSP is generated — edit `scripts/build_sandbox.mjs`, `src/registry/canvas-hosts.json` or `src/registry/template-libs.json` (re-hash with `curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`; a package file, never jsDelivr's `+esm` or generated copies), run `npm run build:sandbox`, then `node scripts/build_sandbox.mjs --check`; never put a hash or nonce in its `script-src`, or `'unsafe-inline'` is ignored and every page goes blank; the runner must stay one IIFE with no top-level names — `document.open()` keeps the Window, so a runner global collides with the model's code; an `html` write fires one extra iframe `load`, which the host's load-count guard expects — a further load or a second `ready` is a navigation; nothing from the frame reaches the model — `showCanvas` returns `shown`/`partial` or an error category only, and `toolContent` strips the rest; downloads only through the card's page-owned Save buttons; `canvas-hosts.json` must stay the tile-host subset of `CSP_HOSTS` (a parity test fails otherwise); a library pin in the prompt must load inside the frame — check it in a sandboxed frame, not top-level (MapLibre needs the worker-origin shim the prompt gives)) |
| Transmission line tools (copy, fault locator, profile) | `docs/line-tools.md`, then `assets/lines/line-read.ts`, `assets/ui/ui-line.ts`, `assets/lines/profile.ts` (data: `docs/pipeline.md` § *Line geometry*) (silent footguns: `data/analysis/` is unpublished, so in production `index.json` is missing and every entry point must hide — the popup's length/Copy/Line tools appear only after `lookup` answers, the table's "Copy N checked lines" only after `lineDataset` does, and an edit-mode copy falls back to the "can't copy" note — never show a button that can only fail; ids are int64 for OSM (`fid`, compared as `BigInt`, statistics are bigint) and the publisher `ID` string for HIFLD (`fid_type` in the manifest), so never `Number()` a key before the lookup; HIFLD stores no direction — `SUB_1`/`SUB_2` are placed by the nearest HIFLD substations of those names (`orientEnds`), unknown order is said in words with a Swap; the fault locator and the profile never fall back to tile geometry (only a copy may, marked `geometry_source: "simplified from map tiles"`); `getSamples` without `pixelSize` reads the 1 m lidar and 504s at 30 s, and more than 1,000 points per request are silently cut to 1,000; a missing sample is null and goes to Terrarium, never 0; nothing goes to USGS before the visitor's Show click; a new elevation or data host goes in `CSP_HOSTS`, `docs/network-allowlist.md` and a Diagnostics probe; tests mock fetch — never call USGS from `npm test`; check a change with the `lines` scenario of `drive-app` (dev server)) |
| Spatial joins (`joinPoints`, `crossings`) | `assets/spatial-join.ts`, `assets/dataset-query.ts` (silent footguns: a vector-tile layer answers from the loaded tiles only, so `complete: false`; `crossings` counts are `null` on tiled layers, where a feature is cut into pieces) |
| Map API / agent tools (what the chat may call) | `assets/map-api.ts`, `assets/agent/tools.ts`, `docs/internal/chat-trust-model.md` (silent footguns: a tool's arguments take a link's validator, never a looser path; a committing call goes through `asOwnStep`, or quick calls merge into one undo step; model text sent off the page needs an `offPage` entry so `dispatch` asks first; the tool schemas have a byte budget in `tools.test.ts` (16,000; 15,982 used) — trim descriptions rather than raise it) |
| Local chat commands (answered without a model) | `assets/agent/local-commands.ts` (silent footguns: a name that fits several layers or areas comes back `ambiguous`, never a guess; rule order matters — the specific `show …` rules sit before `show <layer>`; a template phrase reaches flow / buildout-map / distribution only where the template's signature fits the layer (`fit`), and nearest stays the model's — its second layer and threshold are not in the phrase) |
| Chat panel (the drawer's Ask tab) | `assets/ui/ui-chat.ts`, the Ask pane half of `assets/ui/ui-table.ts` (silent footguns: model text goes in as text only; a string with params needs `data-chat-key` or `lang:changed` misses it; import `ui-chat.ts` only dynamically) |
| Session restore (Android discard / reload) | `assets/session-snapshot.ts`, the save/restore halves of `assets/ui/ui-chat.ts` (`tm-chat`, the conversation) and `assets/ui/ui-table.ts` (`tm-drawer`, the layout — Ask open or not — and the table; shape checks in `assets/ui/drawer-snapshot.ts`, field checks at restore against `describe()`), `docs/internal/chat-trust-model.md` (§ *Session restore*) (silent footguns: a snapshot restores only when its hash equals the hash the page loaded with and the navigation is a reload/back-forward — never on a fresh link, and map.ts's reload for a pasted link calls `endSnapshots()` first, or the reload's pagehide stamps the old drawer with the new hash; never store the key, and the save redacts anything key-shaped; validate on read as untrusted input, rebuilding entries with the text-only builders; save on hidden *and* re-save on every change while hidden, since a reply can land in the background; a restore sends no request, runs no model code, writes no URL and adds no undo step; one owner per fact — whether Ask is open is `tm-drawer`'s, never `tm-chat`'s; the boot hook in `ui-menubar.ts` imports the table chunk (through `table-open.ts`) only for a restorable `tm-drawer`, and the chat chunk only when it had Ask open; a vector-tile table restores after the map's `idle`, and the over-2 MiB size prompt is shown, never answered for the visitor; the Visualize pane's part of `tm-drawer` keeps card params only — each passes `validateTemplateArgs` again at restore, Vega cards (chat first, then Visualize, newest first) redraw only into free frame slots (`claimRestoreSlots`, ≤ 3 live, no eviction), the rest and html cards come back as Re-run) |
| Chat charts (bar/pie/line or Vega-Lite, PNG/CSV) | `assets/chart-spec.ts`, `assets/ui/ui-chart.ts`, `assets/vega-spec.ts` (a Vega-Lite `chart` object: page check, row injection, CSV), the `chart` argument of `runAnalysis` in `assets/agent/tools.ts` (`aggregate` takes none: its group charts are `showTemplate`'s) (silent footguns: a spec from a model reaches the card only through `validateChart` — never draw an unchecked value; a Vega-Lite spec passes `validateVegaLite` and runs only in `public/canvas.html` through `ui-canvas.ts` — never import Vega into the page; labels are drawn with `fillText`/`textContent`, never HTML (lint covers both files); the chart rides on the tool result as `chart` and `loop.ts` `toolContent` must keep it out of what the model is sent; a chart is session only — no `url:write`, no undo; import `ui-chart.ts`/`chart-spec.ts` only from the chat chunk; the schemas' 16,000-byte budget has ~18 bytes left (15,982 used)) |
| Templates (File ▸ Visualize…, `showTemplate`) | `assets/templates/show-template.ts`, `assets/templates/catalogue.ts`, `assets/ui/ui-templates.ts`, `src/registry/field-roles.ts`, `src/registry/template-signatures.ts`, `docs/templates-coverage.md`, `docs/internal/chat-trust-model.md` (silent footguns: template code comes only from repo files imported `?raw` — never model text, never a fetched script; params reach a template only as the validated `TM_INPUT` (`validateTemplateArgs`), set as text; roles drive which templates fit, so give a new field its role in `field-schema.ts` / `field-roles.ts` and regenerate `docs/templates-coverage.md` with `UPDATE_TEMPLATES_COVERAGE=1 npm test`; a tiled layer is read from the current view only and takes no area; a frame must be on screen to draw (no animation frames off screen — cards scroll into view, a restore redraws only into free frame slots, ≤ 3 live); a one-click download is allowed only for a template frame under the gesture rule (activation + frame focus, one per gesture, counted in the cap) — everything else gets the Save button; a symbol-only layer (`osm-generators`) is read only because `clickPriority` names its icon layer — a label symbol layer never counts; map actions (`template-actions.ts`) come only from template frames — canvas-host drops a model frame's `action`, and only a vega template frame is sent `signals`; a template sends a group (`{field, bin}`) or ids it was sent, never a condition — the page builds the condition (`conditionForBin`) and merges it with the layer's `where`; every commit goes through map-api (`asOwnStep`, one undo step) and counts toward the per-frame rate limit (5 per 10 s); `fly` is camera only — no undo step, no toast; a vega group arrives as its label, so a new vega template's data needs a `key` per datum and a `VEGA_PICK` entry (a list per template: the signal, which payload field it picks, the datum's label and key fields — a month is sent as its key); the county overlay (`county-overlay.ts`, points-per-polygon by counties) is session only — never in the link, no `url:write`, no undo step, not repainted on restore (html cards come back as Re-run) — one at a time (a new paint replaces it), cleared by Reset (both Reset paths call `clearCountyOverlay` after `applyView({})`), its card's × or Clear, and the legend's Clear; it writes only the `tpl_v` feature-state key on the shared county source, so never `removeFeatureState` a whole county there (NRI/ODIN/NWS share the bag); a region outline's id is a region code, so a points-per-polygon frame may fly to it but never select or table it (`regions` in the action context); nearest's `layer2` is a GeoJSON point layer only (a tiled one would measure to the loaded tiles) and its summary to the model is numbers only — count, median / p90 km, within / beyond — never a feature or group name (chat trust model), and its `second` features are never selected; the html templates are text-only: lint over `assets/templates/html/**` rejects `innerHTML` and its kin, `setHTMLUnsafe` and a library's `.html()` (use `.text()` / `textContent`); a new param needs all three validators — the tool schema, `validateTemplateArgs` and the snapshot checks (`VIZ_PARAMS` in `drawer-snapshot.ts`, the chat card check), or a restore drops the card silently; every ready template needs its `ask → id` line in `loop.ts` `SYSTEM_PROMPT` (`loop.test.ts` checks each id), and a refusal for a param a template does not take names the templates that take it; pies-per-region takes `by` = the slices and `split` = a region field named in its signature's `regions` (states, countries, admin1 — never counties, NERC, BA or retail), draws at most `MAX_PIES` regions, and its region ids are codes, so its card is `regions: true` like points-per-polygon's) |
| Agent loop / OpenRouter client / the key | `assets/agent/loop.ts`, `assets/agent/openrouter.ts`, `assets/agent/key-store.ts`, `docs/internal/chat-trust-model.md` (silent footguns: never call OpenRouter from a test; data reaches the model only through `summarise()` — the one exception is `showTemplate`'s page-computed summary (total, group count, top 3 groups or the template's own figures — `nearest` numbers only, no names; ≤ 1 KB, group labels ≤ 60 chars); the key goes in the `Authorization` header only — never a URL, error text, `recordDiagEvent` or the view; a confirm-free `dispatch` is only for the visitor's own local-command text; `planRoute`'s page-built summary — HIFLD substation names capped at 60 characters with control characters stripped, plus numbers — is a second exception to `summarise()`, recorded in the chat trust model) |
| Query a dataset (rows / count / group-by) | `assets/dataset-query.ts` (silent footguns: a field outside `allowedFields()` is refused; a vector-tile layer answers from the loaded tiles only, so check `complete`; a number test never matches a feature without the value) |
| Grid Operations layer (EIA-930 bubbles, interchange arrows, hour bar) | `docs/layers/ba-interchange.md`, `assets/grid-ops/` (silent footguns: PUDL's row groups are cut by time with every BA inside, so an hour reads whole row groups — never fetch per BA; the two sides of a tie disagree, so an arrow is their mean and both go in the popup; EIA-930 coarse fuels end 2024-06 and fine ones start 2024-07, never both in one hour, so they add — and storage is signed; keep PUDL path-style URLs pinned to `PUDL_VERSION`, which `scripts/build_eia930_bas.py` repeats (`scripts/test_eia930_bas.py` holds them equal); playback moves `state.gridHour` without `url:write` and commits once on stop, or one animation floods the undo stack) |
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
| Add a field to a dataset's filter schema (types, operators, closed value domains) | `src/registry/field-schema.ts` (`FIELD_SCHEMA`); compiled into filter expressions by `src/registry/condition-compile.ts` (silent footgun: every field needs a `role`, a measure its `unit`, a year its `time` — `field-roles.test.ts` fails otherwise — and a new field can change `docs/templates-coverage.md`, so regenerate it with `UPDATE_TEMPLATES_COVERAGE=1 npm test`) |
| Area filter / which layers a region choice reaches | `src/registry/area-filter.ts`, `assets/filters.ts` (`setArea`), `docs/url-state.md` (`af`) (silent footgun: a new region kind needs its `FIELD_SCHEMA` line, a mapping in `area-filter.ts` and an unused `af` kind char) |
| Legends | `assets/ui/ui-legends.ts` |
| Search behavior | `assets/ui/ui-search.ts` |
| Area picker UI (the AREA row, chips, row flags) | `assets/ui/ui-area.ts`, `assets/ui/panel-mirror.ts` (`commitArea`, `syncAreaControl`) (silent footguns: an Area change commits through `commitArea()` — a bare `setArea()` is not undoable; only `area-labels.ts` may import `region-labels.json`, dynamically) |
| Layer add order / lazy loading | `assets/layers/add-all-layers.ts` (order), `assets/layers/layer-data.ts` (lazy GeoJSON loading), `assets/layers/layer-source.ts` (which file / source / credit a layer gets, from `LayerDef.data`) |
| Live wildfire feed (update cadence, staleness, workflow) | `docs/layers/wildfire-live.md`, `.github/workflows/wildfire-data.yml`, `assets/wildfire-staleness.ts` |
| Data source facts (URL, license, columns) | `docs/data-sources.md`, `docs/layers/<layer>.md` |
| Add/fix a layer's provenance (publisher, landing page, licence) | `scripts/data_manifest.yaml` — sourced only from `docs/data-sources.md` and `docs/layers/<id>.md`; a field those docs don't settle is the literal string `UNKNOWN` |
| Change what the Data Credits dialog shows | `scripts/data_manifest.yaml` for the facts, `assets/ui/ui-credits.ts` for the rendering; `make data-manifest` rebuilds `data/layers/manifest.json` it fetches |
| IT/security asks what URLs to whitelist | `docs/network-allowlist.md` |
| Fetch from a new host / the Content Security Policy | `assets/constants.ts` (`CSP_HOSTS`, `CSP_POLICY`), `docs/network-allowlist.md`, `assets/diagnostics.ts` (silent footgun: the CSP exists only in a build, so a host missing from `CSP_HOSTS` works in dev and is refused in production; add it there, to the allowlist and a Diagnostics probe, then run `drive.mjs --preview csp`) |
| "Things aren't loading" reports / add a diagnostics check | `assets/diagnostics.ts` (`DIAG_CHECKS`), `assets/ui/ui-diagnostics.ts` (silent footgun: host probes duplicate `docs/network-allowlist.md` — update both) |
| Pipeline / tile build | `docs/pipeline.md`, then named script |
| Publishing a build / repo-size headroom | `docs/hosting-plan.md` § *Repository headroom* — read before running `make publish-data` (silent footgun: a force-push to `data-static` deletes nothing, so an overshoot of GitHub's 5 GB soft limit can only be undone by GitHub Support running GC — never set `SKIP_SIZE_CHECK=1` to get past the gate) |
| Where an asset is hosted / the world transmission kV split / tile precision | `docs/hosting-plan.md` — read before changing `DATA_ORIGIN` / `LIVE_ORIGIN`, the kV bands, or any tippecanoe simplification flag (silent footgun: `--simplify-only-low-zooms` is opt-in, and dropping it re-simplifies maxzoom, costing ~5 screen px of line accuracy at z15) |
| How "continent" is defined / rebuilding the OSM extracts without Geofabrik | `docs/pipeline.md` § *Canonical regional boundaries* — the eight `.poly` files are vendored at `scripts/geofabrik_bounds/`, with an `osmium extract` config that recuts all eight from `planet-latest.osm.pbf` |
| Moratorium layer data / twice-monthly refresh | `scripts/moratoriums/README.md` (silent footguns: the workflow YAML must be on `main` to run at all; scheduled runs commit straight to `data-moratoriums` (no review; undo a run with `git revert`) — reject a row with an `updates.csv` `DROP` line and a rebuild, never by editing the published CSVs; move the pin in one `data-moratoriums` PR changing `inputs/upstream.sha` and `inputs/upstream_as_of` together) |
| Global tilesets | `docs/hosting-plan.md` (silent footguns: `assets/constants.ts` must name layers in double-quoted `"data/layers/…"` literals or `validate_build.py` cannot see them (`assets/constants.test.ts` fails on any other form); each world layer's `select` in `build_global_tiles.py` must match its `tile_manifest.yaml` `select:` (`scripts/test_global_tiles.py` holds them together); and a re-tile spec must not carry `--extend-zooms-if-still-dropping`, or the archive advertises z14 past its `max_zoom`) |
| Route panel (UI) | `docs/internal/routing-notes.md` § *Route panel*, then `assets/ui/route-panel-open.ts`, `assets/ui/ui-route.ts`, `assets/ui/route-tabs/types.ts` (silent footguns: open the pane only through `route-panel-open.ts`'s dynamic import inside the `ROUTE_ENABLED` branch, or route code lands in the production bundle; every map layer and source id is `rp-`-prefixed and added or removed, never visibility-toggled; tabs talk to the shell only through `RouteTabContext` — no import of `ui-route.ts`, or the chunk cycles; every preset edit, stored custom method and pref reaches a solve only through `validatePresetPatch`; wording is "Similar-cost areas" / "Alternatives", never "corridor" except proper names such as "Section 368 corridor", and cost ranges read "rough early estimate (−30 % / +50 %)", never "exploratory"; AACE Class 5 is cited only on the Method tab, the report method page and docs/routing.md; a new string needs a key in every locale or the i18n parity test fails — a new route string goes in `src/i18n/route/*.ts` (loaded with the panel by `loadRouteStrings()`, which `route-panel-open.ts` awaits beside the chunk), a route key the boot bundle reads goes in `locales/*.ts` (the exact set is held by `src/i18n/i18n.test.ts`); a route is session only — no URL param, no `url:write`; the Method grid's map highlight is the `rows` overlay mode on `rp-weight`, repainted by the worker from the held window (`repaintRows`), and `assets/route/band-data.validate.test.ts` holds the "Map data from" labels to the cube's source text) |
| Routing constraints layer / concern picker | `docs/internal/routing-notes.md` § *Routing constraints layer*, then `src/colors/route-constraints.ts`, `assets/route-constraints.ts`, `scripts/build_route_constraints.py` (silent footguns: a categorical tile set is recoloured from index codes, so overviews must resample with `max` (`mode` for the land manager and land cover) and never average or use WEBP, or colours blend into ones outside the palette; a concern id is a share-link value (`rc`) — never rename one; `scripts/route_constraints.json` and `scripts/route_constraints_sets.json` are generated — edit the TS and regenerate with `UPDATE_ROUTE_CONSTRAINTS=1`; the tiles are dev-only: their DATA key is in `NOT_SCRAPED`, so `publish-data` skips them and publishing is a separate decision; switch concern only through `setRasterUrl`, which also rewrites the held url, or a link or undo before the first show loads the old concern; the cube's `pd_`/`osm_` split stays absolute, but a concern may read `osm_flags`/`adj` as its own picker entry, credited © OpenStreetMap contributors (ODbL) in its legend and tile attribution — never in What constrains or Land manager, which stay `pd_`-only (`route-constraints.test.ts` and the build refuse it); an existing concern id may change kind only if it still draws the same cells; the classes of one entry never share a value; an entry over 20 MiB at z8 is split into two entries, never drawn transparent or given a larger cap) |
| Route optimizer (cube, presets, solver) | `docs/internal/routing-notes.md`, then `assets/route/route.ts`, `assets/route/cost.ts`, `src/registry/route-presets.ts` (silent footguns: the band order is one contract across `scripts/route_grid.py` (`PD_BANDS`/`OSM_BANDS`), `scripts/build_route_cube.py`, `route.ts` `PD_BANDS`/`OSM_BANDS` and `assets/route/fixtures/make-cube.py` — `route.ts` refuses a cube whose band order differs (loud), but `make-cube.py` indexes bands by position (silent), so change all four together or fixture reads land on the wrong band; an OSM-derived band (including anything computed from OSM lines, like `adj`) goes only in the `osm_` files, never `pd_`, or the public-domain files take on ODbL; preset edits reach a solve only through `preset-patch.ts`'s `validatePresetPatch`, never a looser path; `presetBands()` must list every band a preset reads (rows, active `except` entries, mitigation, regions, ROW land), or the band is not loaded, reads as nodata and its $ silently drop out; method edits happen in the Route panel's Method tab (this session, and saved methods: save, rename, delete), through `validatePresetPatch`; the panel saves its last method, line type, colour mode and surface choice to `route-prefs.ts` (`tm-route-prefs`, re-validated on read)) |
| Proximity check (Tools ▸ Proximity) | `docs/proximity.md`, `docs/internal/proximity-notes.md` (tests, benchmarks, checklist), then `assets/proximity/proximity.ts`, `assets/proximity/types.ts`, `assets/ui/ui-proximity.ts`, `assets/ui/proximity-map.ts` (silent footguns: open the tab only through `assets/ui/proximity-open.ts`'s dynamic import, or the chunk lands in the boot bundle; table cells are text-node formatters (`textCell`) on `{_i}` rows, because Tabulator writes cell values by innerHTML otherwise; the grid's Sort, Filter, Clipboard and Export modules are never registered (`registerModule` is global), so sort and filter are the tab's own over the in-memory rows (`proximity-rows.ts`, pure), and copy is its own Ctrl/Cmd+C handler; a row click only selects and the camera moves only from ↗ (the px-fly button); columns and rows are rebuilt only when `colsKey`/`rowsKey` change, so typing keeps focus; the ResizeObserver forces a redraw only from 0 px to visible (a forced redraw clears the range); `px-` layers are added and removed, never visibility-toggled, and both Reset paths call `clearProximityMap()`; bubbles are a circle layer on `px-points` sized in metres by `bubbleRadiusExpr` and capped at `bubbleMaxZoom` (the 512 px tile buffer), never a polygon source (30k polygons took seconds to tile) (`assets/proximity/clear.ts`); a new `setFilter` call site needs its line in `assets/filters-where.test.ts`; nothing from the file goes into storage, the URL, undo, `tm-drawer`, `recordDiagEvent`, errors or logs, and a worker refusal carries no input value (`pairs-open.ts`); the threshold is converted to km once at the input and the core takes km only, range 0.01–1,000 km; m5's switch is written `!(sq > dense * n)` in `proximity.ts`, so the NaN from `Infinity * 0` takes the sparse branch: keep that form; `-1` in `ids` means no id and equal ids never pair; pairs stop at `MAX_PAIRS`, and the partial list (not the nearest pairs) is said in the view and the CSV) |

## Commands

- `make help` — list all targets
- `make check` — verify CLI deps (osmium, ogr2ogr, tippecanoe)
- `make install` — create venv + Python deps
- `make pipeline` — full data pipeline for one region (slow; needs `data/raw/` inputs)
- `make continental-all` — run the OSM pipeline for all 8 continents; must precede `make global-tiles`
- `make region-tags` — tag the US intermediates in `data/build/` with the regions they fall in (last step of `make pipeline`; needs the boundary files)
- `make tiles` — build PMTiles from extracted data; once `make global-tiles` has run, rebuild one layer with `build_tiles.py --only <id>` instead (the bare target replaces the world `osm_*` archives with one region's)
- `make global-tiles` — join the 8 continental OSM builds into one world tileset per layer, region-tagged;
  transmission is re-tiled globally instead and cut into six voltage-class archives
- `make route-constraints` — build the Routing constraints tiles into `data/route/constraints/` from the routing cube (`ARGS="--only <id> --force"`; capped at 16 GB, log in `tmp/logs/route-constraints.log`)
- `make region-domains` — rebuild the committed region code/label tables in `src/registry/` from the boundary files in `data/build/`
- `make stable-ids` — check every served layer's stable feature ids: 0 missing, 0 duplicate (`ARGS="--only <id> --max-tiles N"`); run after a tile or extract rebuild
- `make data-manifest` — build per-layer provenance → `data/layers/manifest.json` (Data Credits dialog); runs cleanly with no `data/` present, emitting null facts rather than failing
- `make publish-data` — force-push the layers `constants.ts` names + `data/releases` to the orphan `data-static` branch (the prod host)
- `make validate` — check tile_manifest output matches `assets/constants.ts` (run after wiring a new layer)
- `npm run dev` — serve site locally (Vite dev server, hot reload)
- `npm run build` — production bundle (output: `dist/`); **gates on `typecheck` + `lint` via `prebuild` — fails on any type or lint error**
- `npm run preview` — preview production build locally
- `npm run typecheck` — TypeScript check only (cheapest gate; run before claiming any code change done)
- `npm test` — run Vitest unit suite (`*.test.ts`); `npm run test:watch` to watch
- `make test-pipeline` — pipeline smoke tests (`scripts/test_*.py`, no `data/` or network needed), run twice: stdlib only (`python3 -S`, what the CI runners and the moratorium refresh see — a test that needs PyYAML imports it inside the test and skips without it), then with PyYAML for the manifest checks. CI runs them on any `scripts/**` push (`pipeline-tests.yml`, PyYAML pinned in `scripts/requirements-tests.txt`). Run it after touching any `scripts/*.py`.
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
