Map of this folder; each file's header comment is the source of truth.

# assets/route

- **`assets/route/`** — the route optimizer (pure, runs in a worker and in Node; see `docs/routing.md`)
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
  - `snap.ts` — substation index, `snapAt` (kV floor by line type), `snapAmong` (OSM points, `osmKv`, `OsmPoint`), `SnapHit.source`, `searchSubstations`; pure (the profile's elevation
    sampler is `assets/elevation/terrarium.ts`)
  - `custom-presets.ts` — saved methods (`tm-route-presets`); `route-prefs.ts` — defaults for new routes (`tm-route-prefs`);
    both re-validated on every read
  - `route-worker.ts` / `route-open.ts` — the worker and its main-bundle-safe opener (`routeLine`)
  - `upload-layer.ts` — `validateUpload`/`uploadLayer`: a visitor's polygon file as a route-method row's band (trust boundary and rasteriser); `crossings-exact.ts` — road / river / rail / pipeline / line crossings of a route by true vector intersection (EPSG:5070, pure); `batch-csv.ts` — parse and validate the batch CSV (optional `a_terminal`/`b_terminal`)
  - `*.validate.test.ts` — real-cube validation, excluded from `npm test` (`vitest.route.config.ts`); `fixtures/` mini cubes
