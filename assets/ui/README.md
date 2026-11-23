Map of this folder; each file's header comment is the source of truth.

# assets/ui

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
  - `notice-gate.ts` — usage-notice acceptance for the route planner and the map chat: `noticeAccepted`/`acceptNotice`/`forgetNotice`: the chat's over `tm-notice-chat` (accepted version; memory when storage is blocked), the route's in memory only, asked on every open of the Route pane (forgotten when it closes), `ROUTE_NOTICE_VERSION`/`CHAT_NOTICE_VERSION`; boot-bundle safe (zero deps); imported only by the lazy chunks
  - `notice-dialog.ts` — `showNotice(id)`: the notice as a modal `<dialog>` built from nodes (only the chat's two OpenRouter links are anchors); lazy chunks only (`ui-route.ts`'s `openRoutePanel`, `ui-chat.ts`'s `openChat`/`resumeChat`; `ui-route.ts`'s `routeForChat` when the pane is not open, refusing on Cancel)
  - `ui-menubar.ts` — top bar: File (Open ▸, Save ▸, Experiences, Settings), Tools (Chat, Charts, Proximity, Diagnostics, Plan a route, Hide legends), Undo/Redo buttons (in File at ≤ 640 px wide or ≤ 500 px tall), draw/edit/export
  - `ui-mydata.ts` — My Data tab wiring
  - `ui-services.ts` — File ▸ Open ▸ GIS server: library search and Paste URL; lazy chunk.
    `ui-linked-services.ts` — My Data's linked-service rows and the Load / Skip card for a link's
    unvetted services; `services-dom.ts` — `el()` (utils-dom's `hx`), text-only DOM for both (lint-enforced), and `sourceLink()` (a library entry's source page, also in Data Credits)
  - `ui-search.ts` — feature search (finds only what the map draws); `ui-geocoder.ts` — place search
  - `ui-area.ts` — the Area picker; lazy chunk
  - `ui-openwith.ts` — "open with" link builder
  - `drawer.ts` — the bottom drawer's shell, lazy chunk without Tabulator: tabs, the pane in view, open/close with focus return, Esc, collapse, height (grip, defaults, the Route floor), `tm-drawer` (the tab's layout and the table's part — `restoreDrawer` after a reload of the same link; the Route, Line, Proximity and Grid Ops tabs are never kept). Every pane imports it directly. `drawer-open.ts` — the boot-bundle-safe `restoreDrawer` (dynamic import of `drawer.ts`), called through `table-open.ts` from `ui-menubar.ts`'s boot hook, which loads the table chunk only when the snapshot holds a table and the chat chunk only when Ask was open. `drawer-snapshot.ts` —
    `parseDrawerSnapshot`, the pure shape check of `tm-drawer` (versioned, capped, the link's validators). `drawer-test-names.ts` — test support: the per-pane names tests use, mapped onto `drawer.ts`
  - `ui-table.ts` — the table pane: a layer's rows (`query()`) in a Tabulator grid (render only —
    virtual rows, columns that resize and move, a frozen check column, a dragged cell range that
    Ctrl/Cmd+C copies as TSV with a header line and raw values; the copy is its own, not Tabulator's
    clipboard module), group-by summary (`aggregate()`), sort, CSV, checked rows → `commitSelection`,
    a header ▾ per schema field whose filter sets the layer's `where` through map-api `setWhere`
    (map, table, CSV and link agree); binds itself to the shell with `bindTable` and registers its own Tabulator modules;
    lazy chunk, opened through `table-open.ts` (`showTable`, `zoomToSelection`)
  - `grid-copy.ts` — what the three range grids (table drawer, Proximity, Method) share: `GRID_RANGE_DEFAULTS` (the common Tabulator options), `isCopyKey`, `keepFromGrid`, `clipValue` (raw values, formula-guarded text), `tsvOf` (a header line, then rows), `copyText` (a keypress clipboard write); no Tabulator import at runtime, pure of the DOM model
  - `ui-line.ts` — the drawer's Line tab (popup ▸ Line tools; lazy chunk): the line's chain, ends A/B (HIFLD `SUB_1`/`SUB_2`
    placed by the HIFLD substations of those names, with Swap; OSM chain-end substations named by `lines/osm-substation.ts`),
    the fault locator (pins walked along the true geometry, ±% span, relay-length scaling, Add pin to My Data); `lt-` map
    layers, added and removed; session only (no URL, no undo, not in `tm-drawer`). `line-open.ts` — `openLineTools`, the
    boot-bundle-safe opener (dynamic import; the only way in). `line-profile.ts` — the tab's Profile section: Show →
    `lines/profile.ts`, progress + Cancel, canvas chart (labels by `fillText`), crosshair → `lt-hover` marker, ←/→ keys,
    stats, PNG/CSV; the intro says points go to USGS only when the line reaches 3DEP coverage (`reaches3dep`)
  - `chat/` — the map chat, its chart and canvas cards: `chat/README.md`
  - `ui-templates.ts` — the drawer's Visualize tab (Tools ▸ Charts, a layer row's ⋯ menu ▸
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
  - `overlay-layers.ts` — `setGeojson` (add or update a GeoJSON source) and `removeOverlay` (layers, then sources) for the proximity and line panels' overlays; state.ts only
  - `proximity/` — the Proximity tab and its map half: `proximity/README.md`
  - `ui-experiences.ts` — Map Experiences gallery + floating story card; lazy chunk, opened from the File menu
  - `ui-diagnostics.ts` — Diagnostics dialog; lazy chunk, opened from the Tools menu
  - `ui-settings.ts` — Settings dialog (display units); lazy chunk, opened from the File menu
  - `ui-credits.ts` — Data Credits dialog; renders `renderDataCredits()` from
    `DATA.data_manifest` (`data/layers/manifest.json`, built by
    `scripts/build_data_manifest.py`) over the hand-written `<li>` fallback
    already shipped in `index.html`; lazy chunk, opened from the info button
  - `route-panel-open.ts` — the Route panel's entry points, boot bundle: Tools ▸ Plan a route…, right-click Route from/to here; the panel and its strings (`src/i18n/route/`) load on use
  - `route/` — the route panel's modules and its tabs: `route/README.md`

## Footguns

### A panel control shows the wrong value after Reset/Undo/a story/a link

- `ui-layer-rows.ts` takes no state, so a control whose value is view state needs a line in `syncPanel` — nothing else repaints it, since a view that keeps region and language no longer re-renders the rows

### Table drawer / selection chip

- a pane imports `drawer.ts` directly, the table only through `table-open.ts`, and the boot bundle reaches either only through `drawer-open.ts` / `table-open.ts`, or the chunk (and Tabulator) lands in it (`ui-table.ts` registers its own Tabulator modules); Tabulator is a renderer only — sorting, filtering and grouping stay with `dataset-query.ts`; never register Tabulator's Clipboard/Export modules (they write copied values through `innerHTML`) or return a string from a formatter (it is HTML) — cells are text nodes; grid fields are positional (`f0`…), since a dotted field name is a path to Tabulator; a column filter goes through map-api `setWhere`, never `filters.ts` directly, or Undo and the row chip miss it; jsdom draws grid rows only under `test-drawer-env.ts`'s size stubs; a selection change goes through `commitSelection`, or the link and Undo miss it; a display column goes in `dataset-core.ts` `DISPLAY_FIELDS`, which a model also reads; a copy of GeoJSON rows clones each row before it is stored, since rows are `state.sourcesData` objects that My Data would otherwise mutate

### Area picker UI (the AREA row, chips, row flags)

- an Area change commits through `commitArea()` — a bare `setArea()` is not undoable; only `area-labels.ts` may import `region-labels.json`, dynamically
