# TransmissionMap

Static web map (MapLibre GL, vanilla JS, Vite-bundled) of US energy
infrastructure: transmission lines, substations, generators, pipelines,
renewable-resource rasters, land constraints. A Python/shell pipeline
turns public datasets into PMTiles consumed by the frontend.

## Hard rules

- **NEVER read, list, or grep `data/` (tens of GB), `venv/`, `tmp/`,
  `node_modules/`.** Large binaries; nothing useful for code work.
  To inspect a dataset's schema/values, *run* the relevant script and print
  (`df.head()`, `ogrinfo -so`, `head` on a built `.csv`) — never open files in
  `data/`.
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

## Repo map

- `index.html` — single page; Vite entry via `<script type="module" src="/src/main.ts">`
- `src/main.ts` — top-level import orchestrator; imports `assets/ui/ui.ts`
- `src/types.ts` — shared `LayerDef` interface and other types
- `sw.js` — service worker (tile caching)
- `assets/` — frontend modules (all TypeScript), split into subfolders:
  - **Root** (`assets/`): cross-cutting modules used by multiple subfolders
    - `map.ts` MapLibre init + basemap switching
    - `state.ts` mutable global singleton (`AppState`); re-exports constants
    - `state-bus.ts` typed pub/sub (events: `filter:*`, `gen:mode`, `url:write`; see `EventMap`); no deps
    - `visibility.ts` — `setLayerVisibility`, `applyGenMode`, `applyAllGenModes`
    - `filters.ts` — all `applyXFilter()` functions + bus subscriptions; `MW_SLIDER_MAX`
    - `url-state.ts` — `readUrlState`, `writeUrlState` + bus subscription
    - `hover.ts` — polygon hover + line click-highlight
    - `raster-probes.ts` — `RASTER_PROBES`, `ensureRasterLut`, `updateRasterArrow`
    - `popup.ts` click popups; `popup-format.ts` HTML builder
    - `highlights.ts` search highlights; `measure.ts` distance tool
    - `url-state-codec.ts` — URL parse/format (no side effects)
    - `icons.ts` SVG icon loading; `tool-mode.ts` draw/measure mutex
    - `constants.ts` tile URLs, DATA paths, palette constants
    - `wildfire-staleness.ts` — live-wildfire auto-refresh poll + stale-data kill-switch modal
  - **`assets/ui/`** — UI wiring and panels
    - `ui.ts` bootstrap + `init()`; wires all UI subsystems
    - `ui-filters.ts` — layer/legend/MW/year filter event wiring (emits bus events)
    - `ui-legends.ts` — legend HTML + `LEGEND_FILTERS` config
    - `ui-layer-rows.ts` — layer panel row HTML
    - `ui-menubar.ts` — toolbar (draw/edit/export)
    - `ui-mydata.ts` — My Data tab wiring
    - `ui-search.ts` — feature search; `ui-geocoder.ts` — place search
    - `ui-openwith.ts` — "open with" link builder
  - **`assets/layers/`** — MapLibre layer builders
    - `layer-init.ts` — `ensureLayerData`, `LAZY_GEOJSON`, `initialVisibility`, `registerBaseFilter`, helpers
    - `add-all-layers.ts` — `addAllLayers()`: calls every layer-builder in z-order
    - `map-layers-{osm,hifld,eia,load,renewable,rail,hazards,petroleum,wecc}.ts` — per-source builders
  - **`assets/user-data/`** — user-imported/drawn layers
    - `user-data.ts` — core (add/remove/save/render); `user-data-draw.ts` draw mode
    - `user-data-import.ts` GeoJSON/KML/KMZ import; `user-data-export.ts` export
    - `user-data-csv.ts` CSV point import + column picker; `csv-parse.ts` pure CSV parser (unit-tested)
    - `user-data-geom.ts` geometry utils; `user-data-colors.ts` color picker
    - `draw-chunk.ts` — **lazy chunk boundary**: re-exports draw/import/export; loaded on first toolbar interaction (keeps MapboxDraw/toGeoJSON/jszip out of the initial bundle)
  - **`assets/utils/`** — pure utilities
    - `utils.ts` string helpers; `utils-dom.ts` DOM helpers; `utils-uid.ts` UID generation
- `src/colors/` — color/style logic (no MapLibre side effects, safe to import anywhere)
  - `voltage.ts` — `voltageColorExpr()`
  - `ramps.ts` — wind/solar/geo/pop/heat ramps + year-filter constants
  - `fuel.ts` — gen icons, pipeline colors, voltage/fuel legends
  - `buckets.ts` — `bucketColorExpr`, line widths, KV/fuel/region bucket arrays
- `src/registry/` — layer definitions (pure data, no side effects)
  - `sources.ts` — `LAYER_SOURCES`; `index.ts` — `LAYERS[]`, `layerById`
  - `generators.ts` EIA+OSM; `transmission.ts` lines+substations; `pipelines.ts` natgas
  - `renewable.ts` wind/solar/geo/hydro; `land.ts` PAD-US/tribal/crithab; `regions.ts` NERC/BA/retail
  - `hazards.ts` wildfire (static WHP + 3 live: perimeters/incidents/smoke) + seismic; `rail.ts` railroads
- `scripts/` — data pipeline: `extract_*.py` (per dataset),
  `build_*.sh` (rasters/tiles), `osm_common.py` + `geo_common.py` shared
- `docs/adding-a-layer.md` — **read this before adding any map layer**
- `docs/pipeline.md` — how the data pipeline fits together
- `docs/data-sources.md` — where every dataset comes from
- `docs/layers/<layer>.md` — one doc per layer (source URL, columns, build)
- `docs/release-artifacts.md` — inventory of data files + download packs

## Task routing — read these, not the whole repo

| Task | Read |
|---|---|
| Add a dataset to the pipeline | `docs/adding-a-dataset.md` (data half), then `docs/adding-a-layer.md` for frontend |
| Add a map layer | `docs/adding-a-layer.md` ONLY, then `rg ">>> ADD-LAYER"` for insertion points |
| Add a filter (legend chips or range/slider) | `docs/adding-a-filter.md` (silent footguns: wire `filter:all` too, and claim a unique URL code — see `docs/url-state.md`) |
| URL hash / shareable links / add a URL param | `docs/url-state.md` (silent footgun: param-char collisions — check the reserved-char table) |
| Popup content/format | `assets/popup.ts`, `assets/popup-format.ts` |
| Filter UI / value maps | `assets/filters.ts`, `assets/ui/ui-filters.ts` |
| Fix voltage colors | `src/colors/voltage.ts` |
| Edit ramp stops (wind/solar/geo/pop/heat) | `src/colors/ramps.ts` |
| Edit fuel colors / icons / legends | `src/colors/fuel.ts` |
| Edit bucket arrays (PAD-US, Tribal, NERC, etc.) | `src/colors/buckets.ts` |
| Add/edit a layer registry entry | `src/registry/<group>.ts` — imports in `src/registry/index.ts` list every group file |
| Add hover highlight to a polygon layer | set `hoverField` on the `LayerDef` in `src/registry/<group>.ts` |
| Add line click-highlight to a line layer | set `lineHighlightKeys` on the `LayerDef` in `src/registry/<group>.ts` |
| Legends | `assets/ui/ui-legends.ts` |
| Search behavior | `assets/ui/ui-search.ts` |
| Layer add order / lazy loading | `assets/layers/layer-init.ts` |
| Live wildfire feed (update cadence, staleness, workflow) | `docs/layers/wildfire-live.md`, `.github/workflows/wildfire-data.yml`, `assets/wildfire-staleness.ts` |
| Data source facts (URL, license, columns) | `docs/data-sources.md`, `docs/layers/<layer>.md` |
| Pipeline / tile build | `docs/pipeline.md`, then named script |

## Commands

- `make help` — list all targets
- `make check` — verify CLI deps (osmium, ogr2ogr, tippecanoe)
- `make install` — create venv + Python deps
- `make pipeline` — full data pipeline (slow; needs `data/raw/` inputs)
- `make tiles` — build PMTiles from extracted data
- `make validate` — check tile_manifest output matches `assets/constants.ts` (run after wiring a new layer)
- `npm run dev` — serve site locally (Vite dev server, hot reload)
- `npm run build` — production bundle (output: `dist/`); **gates on `typecheck` + `lint` via `prebuild` — fails on any type or lint error**
- `npm run preview` — preview production build locally
- `npm run typecheck` — TypeScript check only (cheapest gate; run before claiming any code change done)
- `npm test` — run Vitest unit suite (`*.test.ts`); `npm run test:watch` to watch
- Per-dataset build targets exist too (e.g. `make wind`, `make seismic`) — run `make help` for the current list

## Working style

- Cite/edit exact files; layer questions → check `docs/layers/` first
  instead of grepping code.
- Prefer greppable anchors over reading whole files. Insertion points are
  marked in-code with `>>> ADD-LAYER: <name>` comments — `rg ">>> ADD-LAYER"`
  lists them; jump to one and read ~30 lines around it. Don't read an entire
  module to find where something goes.
- Data questions (URLs, columns, licenses) are answered in
  `docs/data-sources.md` and `docs/layers/` — don't re-derive from scripts.
- **Definition of done:** when a task has a doc in the routing table, its
  end-of-doc checklist IS the contract — close out every box, don't stop
  partway. Before claiming a code change is complete, run `npm run typecheck`
  (the cheapest gate; `npm run build` also runs lint). If you touched logic
  with a sibling `*.test.ts` (filters, popup-format, url-state, visibility,
  colors, registry, user-data, utils), run `npm test` (Vitest) too. A change
  that hasn't passed typecheck is not done.
