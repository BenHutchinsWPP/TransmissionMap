# Line routing — contributor notes

For people working on the route optimizer. The method is in [`../routing.md`](../routing.md); the
rules that must not break (band order, the `osm_` split, `presetBands()`, the route data's
hosting) are in § Footguns at the end of this file. This file holds what neither says.

## The cube

- EPSG:5070, 250 m cells. The origin sits on the NLCD 30 m lattice, so 30 m inputs aggregate
  without fractional seams (every window is a multiple of 750 m).
- 4096 × 4096-cell super-tiles. Each is a COG with exactly the layout `assets/route/cog-read.ts`
  reads: classic little-endian TIFF, uint8, DEFLATE, no predictor, no overviews, nodata 0.
  `scripts/build_route_cube.py` asserts every tag.
- Band codes and bits are defined in `scripts/route_grid.py`. Each band's source, licence, vintage
  and processing rule are written by the build into `data/route/250m/grid.json`
  (`pd_band_sources`, `osm_band_sources`).
- `flags`, `flags2` and `desig` have no free bits. A new public-domain fact needs a new band.
- Value 0 is nodata in every band and neutral in every method, except the `state` band, where 0
  (outside contiguous US land) is a barrier.
- **Existing lines:** OSM power lines and cables plus HIFLD lines, merged (a line in both counts
  once); in service only (HIFLD inactive and under-construction lines dropped); 100 kV and up;
  over 800 kV treated as unknown and dropped; HIFLD DC voltages halved to match OSM's
  pole-to-ground tagging (our convention; HIFLD does not document its basis).

## Building it

All commands run under a 16 GB memory cap and log to `tmp/logs/`. Inputs and outputs stay out of git.

| step | command |
|---|---|
| fetch inputs | `venv/bin/python scripts/fetch_route_inputs.py` (default steps), then `… grsg wsr trails npl nass easement`, then `… structures` with `STRUCTURES_DIR` set (49 state archives, resumable) |
| all bands, then the cube | `make route-cube` (needs the structures archives in `STRUCTURES_DIR`) |
| re-stack built bands only | `make route-cube-assemble` |
| one band | the band's builder with `--only <name>`, then `make route-cube-assemble` |
| crossing-report data | `venv/bin/python scripts/build_route_report_data.py` → `data/route/report/` |
| constraints layer tiles | `make route-constraints` (`ARGS="--only <id> --force"`) |
| validation inputs | `venv/bin/python scripts/route_validation_inputs.py` |

Assembly stages the cube and the test fixtures side by side, checks tags, source hashes and
metadata, then swaps both in; a failed swap restores the previous ones. Keep the previous cube
for decoded-band comparisons.

**Fixed at build vs editable per solve.** Changing anything in the left column means rebuilding
the band; the values are in `routing.md` § Data and the build scripts.

| fixed in the cube | editable in a method |
|---|---|
| slope classes, the land-cover rule, wildfire scaling | every row's routing weight and cost multiplier |
| buffer widths (airports, rivers and trails, sites, tall structures) | group rules (largest / smallest / multiply) |
| thresholds (population, floodplain share, structure height, NRHP polygon size) | exemptions on or off |
| kV classes, adjacency distances | contingency, short-line factors |
| status filters, sage-grouse class mapping | line type |
| region assignment, land-value encoding, the homes count | search area, cell cap, alternatives, similar-cost areas |

## Engine details worth knowing

- **Move cost** follows GRASS `r.cost`: straight moves average the two cells, diagonal ×√2, knight
  moves average the two end cells and the two cells they pass between, ×√5. A diagonal or knight
  move is skipped if a cell it passes is blocked, so a one-cell barrier never leaks.
- **Endpoint guard:** the start, the goal and their 16 neighbours ignore barriers, so an endpoint
  just inside a blocked area still solves.
- **Proof:** the lower bound (`minRouteWeight`) uses the lowest weight the method can produce
  anywhere (the product of each group's smallest factor, capped at 1). It is 0.8 for `tm-default`,
  its existing-line discount; a lower discount lowers it, so long routes prove less often. What is
  proven is the lowest routing score.
- **Memory:** about 37 bytes per cell of the search box for the default method (one per band read
  plus working arrays). The default cap is 30 M cells; past it the solve is refused, naming the
  cap. Similar-cost areas and alternatives need more per cell and are skipped, with a reason,
  when they would not fit.
- **Angle points** consider segments up to 512 cells ahead and choose them by Lagrangian
  relaxation to stay within 0.5 % of the cell path's routing score.
- **Alternatives** penalise × 1.5 within 8 cells of each route found, then are re-costed on the
  original weights.

## Checks

Unit tests (`npm test`) cover the engine on mini cubes in `assets/route/fixtures/`. The checks
against published routes need the local cube and inputs, are excluded from `npm test`, and skip
when the data is absent:

```
ROUTE_VALIDATION_OUT=tmp/v.json npx vitest run --config vitest.route.config.ts assets/route/route.validate.test.ts
npx vitest run --config vitest.route.config.ts assets/route/spurs.validate.test.ts
NODE_OPTIONS=--expose-gc npx vitest run --config vitest.route.config.ts assets/route/surface.validate.test.ts
npx vitest run --config vitest.route.config.ts assets/route/cube.validate.test.ts
ASBUILT_SET=e ASBUILT_CONFIGS=baseline ASBUILT_OUT=tmp/asbuilt.jsonl npx vitest run --config vitest.route.config.ts assets/route/asbuilt.validate.test.ts --maxWorkers=1
```

| check | method | gate |
|---|---|---|
| PNAS cost | PNAS's 27 corridor geometries costed on our data with `pnas-wu2023` | `routing.md` § How it was checked |
| PNAS corridors | the same 27 solved by us | `routing.md` § How it was checked |
| PNAS spurs | 200 sampled 230 kV spurs | report only |
| WestTEC | 19 WestTEC new lines with `tm-default` | report only (harness kept outside the repository) |
| WestTEC fit | the same 19 with `westtec-es`, whose barrier rule (barriers off on or beside an existing ≥ 230 kV line) and voltage match (×0.9 beside an existing line of at least the new line's voltage, adj bits 2–3) are fitted to them | report only (fitted; harness kept outside the repository) |
| As-built lines | `tm-default` routes of 13 built lines and 300 holdout lines, each line's own existing-line discount cancelled (below) | report only |

The as-built check (`assets/route/asbuilt.validate.test.ts`) routes `tm-default` between the ends of
as-built lines and compares each route with the HIFLD line. The inputs are
`assets/route/fixtures/asbuilt-lines.json` (tracked, with checksums) and the geometry and
neutraliser files `scripts/route_asbuilt_lines.py` writes under `data/build/route/validate/`. The
target line's own existing-line discount is cancelled by uploaded polygon layers over its `adj` cells
(the exemption configs also cover GAP 3), passed through the same upload path as the Method
tab. Environment:

| variable | meaning |
|---|---|
| `ASBUILT_SET` | `e` (built lines present in HIFLD), `cal` or `hold` (the 300 holdout lines, split into calibration and guard) |
| `ASBUILT_CONFIGS` | comma list of method patches to solve (`baseline`, `baseline2`, `noneutral`, candidate ids, `combined:<id>+<id>`) |
| `ASBUILT_OUT` | JSONL file the rows are appended to; a rerun resumes from the rows already solved |
| `ASBUILT_LIMIT` | solve the first N lines only |
| `ASBUILT_TOUCH` | with a config id: print how many lines it touches, without solving |
| `ASBUILT_REFCOST` | cost each reference geometry on the line's own line type and end kinds (and the saved baseline route, for routing and pricing apart) |
| `ASBUILT_MUTATE` | `noneutral` sets every neutraliser weight to 1; the check that the neutraliser matters must then fail |

Gates move only for a sourced difference in inputs.

## Study methods

- Every preset with rows reads the `aviation` and `nfhl` bands (`cost.test` requires `presetBands()` to include both); the study presets carry them as report-only rows of weight 1.
- `bv-2014` and `tm-default` bake × 1.175 into the terminals' and line positions' `usd_each` (and `arithmetic`), because engine markups apply to line $ + ROW land only. A visitor-entered station or position figure is taken as entered.
- `westtec-es` keeps its own line types (`WESTTEC_LINES`): double-circuit types only, unmarked terminals, Wu's $87.9 M 500 kV station, no position figures. `straight-line-quick` shares `tm-default`'s line types.
- `nrel-revx` regional base $ is a per-line-type row on `isoreg`, with `cost_by_region` = the ISO's base ÷ the TEPPC base, rounded to 4 decimals.
- `assets/route/study-presets.test.ts` holds hand calculations typed from the sources, independent of the preset code.

## Route panel

- **Strings:** see § Footguns › Route panel (UI); the boot-read `route.*` keys are the Routing constraints layer's concerns, the Tools item, the context menu and the drawer tab.
- **Snapping:** `snapEnd` (`assets/ui/route/substation-index.ts`) returns, within the snap radius and at or
  above the line type's kV floor, the first of: a HIFLD hit of known kV (`snapAt`), an OSM hit of
  known kV (`snapAmong` over `substationPointsNear`; US points on the 250 m grid, `traction` and
  `industrial` dropped, kV by `osmKv`), a HIFLD hit of unknown kV, else null (the raw point).
  `SnapHit.source` is `hifld` or `osm`; an OSM id is `osm:<fid>`, its name may be null. A snapped
  end carries the substation's highest voltage (`hit.maxKv`). `opts.osm: false` skips OSM; the
  chat passes it, and `chatEnd` drops an OSM end's name. The OSM read is its own lazy chunk, raced
  against a 4 s timeout (`OSM_SNAP_TIMEOUT_MS`; on timeout the HIFLD unknown-kV hit or the raw
  point stands) and never rejects. `route-inputs.ts` takes the snap function as an option
  (default `snapEnd`) and keeps one generation counter per end, bumped by every write to that
  end, so a late snap reply for a replaced end is dropped.
- **Terminal kinds:** each end is `new`, `position` or `none` (`EndKind`, `RoutePreset` line type
  `terminals.position`); a request without kinds is `['new', 'new']`. The visitor's choice is
  `RouteEnd.term` (`TermChoice`: `auto` or a kind; absent is Auto); a choice replaces the
  `RouteEnd`, never mutates it, and survives a drag or re-snap of the same end. The panel, batch and chat
  set the kinds at request time through `resolveEnds` (`assets/ui/route/route-request.ts`), which maps
  over `explainEnds` (kind, reason code, kV per end): Auto gives `position` only for a snapped end
  with `maxKv` ≥ the line type's kV and a position figure on the patched line type, else `new`;
  an explicit `position` without a figure is `positionUnavailable`, which `requestFor` refuses
  (`route.err.termPosition`). `setEnd`/`setEndHit` take `resetTerm`; only the chat passes it, so its
  ends start at Auto. Batch: `a_terminal`/`b_terminal` give `BatchRow.terminals`; the runner's
  pre-check refuses a `position` row without a figure with the code `no position figure`, before
  any snap, and snaps each end (`osm: true`) inside the batch lock. `validateTerminals` checks the kinds a request carries. `cost.ts` costs
  mid-line stations of the 500 kV rule as `new`; the waterfall reads `terminalsUsd`, never the sum
  of `terminalItems`.
- **Line-only $/mi** is the KPI tile beside the all-in $/mi: (total − terminals × (1 + contingency pct)) ÷
  miles (`kpiTiles`). A `cost_inputs` key in a saved method or method file is dropped on read
  (`custom-presets.ts` `dropCostInputs`); `validatePresetPatch` refuses it.
- **Cost waterfall:** in each cell, the line cost above base is split over the rows that set the
  cell's factor, in proportion to ln(factor), so a factor below 1 is a negative bar. Bars and line
  items sum exactly to the total.
- **Sensitivity:** the 7 rows with the most cost attribution, each re-solved at × 0.5 and × 1.5 of
  its premium over 1 (14 solves), ranked by the change in total.
- **Cell-weight overlay:** the worker keeps the last solve's band window (≤ 400 MB) and repaints from
  it with no new read; the Method tab's Map highlight uses the same window, so it covers only the
  search area.

- **Uploaded layers:** a layer's band is `upl_<hash>` (not its position), so removing one never shifts
  another; a method takes any number. One attempt holds 1 B per search-area cell per layer, at most
  512 MiB (`UPLOAD_BYTES_BUDGET`); above that the solve is refused before any read, with the numbers.
  The Method tab holds at most 2,000,000 positions across its layers (`UPLOAD_TOTAL_VERTICES`). Saved methods carry
  layer hashes only, never geometry.

- **Aviation and flood bands:** `aviation` (band 18, `aviation.tif`): FAA NTAD facilities/runways/runway ends (+ ADDS IAPEXISTS),
  public domain; Part 77 surfaces rasterised on the 3DEP 1 arc-second DEM at 30 m, class = lowest
  surface AGL, 250 m cell = worst class of its 30 m pixels. Codes: 0 nodata, 1 evaluated (outside the notice extent, no surface below 61 m), 2 inside the 77.9(b) notice extent (lowest surface >= 61 m
  or none; outside the extent such a cell is 1), 3 [46, 61) m, 4 [30, 46) m, 5 < 30 m, 6 primary surface. Class labels state the lowest surface height only; "exceed"
  appears only in the method note with the assumed height (`aviationNote`, `route.obs.av.note`); FAA Form 7460-1 / OE/AAA decides.
  `nfhl` (band 19, `nfhl.tif`): FEMA NFHL Key Layers, US federal work with
  FEMA acknowledgement requested. Area shares of the 250 m cell: panels >= 0.5 observed, then SFHA >= 0.5 -> 2 else 1; panels < 0.5 -> 3.
  Provenance lives in `grid.json` `pd_band_sources`.

## Routing constraints layer

**What constrains** draws one class per cell by a fixed draw order (see [`../layers/route-constraints.md`](../layers/route-constraints.md) § Raster values). That order is a rendering rule,
not a ranking of the land; no visitor-facing text should present it as one. Its other rules are
in § Footguns at the end of this file.
- **Concern switch:** a pick sets `state.routeConcern` through `setRouteConcern()` (`assets/route-constraints.ts`), which swaps the one raster source's url with `setRasterUrl()` (`assets/layers/layer-plan.ts`).
- **Zoom range and hosting:** the tiles are z3–z9, and z3–z8 for land cover and slope, which exceed 20 MiB at z9 (see `manifest.json`). `DATA.route_constraints` is in `NOT_SCRAPED` (`assets/constants.test.ts`), so `make validate` never sees them; they ship in the route set (*Hosting* below).

## Hosting

The route data is read from the data host under `data/route/<ROUTE_ID>/` (`ROUTE_ORIGIN` in
`assets/constants.ts`; a dev server reads the local `data/route/`): `250m/` (the cube), `report/`
(the report parquets and `screening/`: the aviation file, its generation record and the pointer), `constraints/`, and `LICENSE.txt` (from
`scripts/route_data_LICENSE.txt`). The prefix is immutable. `ROUTE_ID` is a hash of `grid.json`, the screening pointer and each selected file's key and size
(`python3 scripts/route_publish_plan.py --print-id`); a change to any of those gives a new id, which is pinned in `constants.ts` and deployed with the app.
`bash scripts/publish_r2.sh --only route` (`--dry-run` first) uploads the set, refuses stray files
and an existing id whose content changed, verifies every object afterwards, and writes `grid.json`,
the screening pointer `manifest.json` and `LICENSE.txt` last. Old ids stay for deployed bundles.
`node scripts/check_route_bundle.mjs` (after `npm run build`) fails when route-panel code reaches
the boot bundle.

## Crossing report

`venv/bin/python scripts/route_crossings.py <route.geojson>` writes the crossings, nearby
airports, rivers and trails, and miles by land manager, beside the input; the panel's **Read
crossings and observations** reads the same files in the worker. `make route-screening` builds
the national aviation observations from the saved NTAD layers; they never change routing
weights or the cube.

## How it compares (internal)

✓ included · ◐ partly · — not included · ? not described in the tool's public documents.
Columns are the studies and tools in *Studies cited* in `routing.md`.

| | TransmissionMap | Wu 2023 | NREL reV | EPRI-GTC | MISO | CAISO 2025 | B&V 2014 |
|---|---|---|---|---|---|---|---|
| lowest-score routing | ✓ 250 m | ✓ 250 m | ✓ 90 m | ✓ suitability grid | — straight line | — | — |
| land cover and slope | ✓ | ✓ | ✓ by region | ✓ | ◐ terrain mix | ◐ terrain | ✓ |
| protected land by GAP status | ✓ | ◐ conservation categories | ✓ GAP 1 barrier | ✓ | — | — | ◐ via SWCA |
| designations and easements | ✓ | ◐ inside its categories | ? | ◐ wilderness, parks | — | — | — |
| tribal land | ✓ avoided, miles reported | — outside study | ? | ? | — | — | — |
| military land and airports | ✓ | ◐ airports | ? | ✓ avoided | — | — | — |
| critical habitat | ✓ areas and streams | ◐ in a category | ◐ risk class | ✓ avoided | — | — | ◐ SWCA class |
| sage-grouse habitat | ✓ 2025 RODs | ◐ priority habitat | ? | ? | — | — | — |
| Wild & Scenic Rivers, national trails | ✓ corridors | ◐ in a category | ? | ◐ rivers avoided | — | — | — |
| wetlands | ✓ NWI and NLCD | ◐ NLCD | ◐ NLCD | ✓ | ✓ matting and credits | — | ◐ wetland class |
| schools, hospitals, historic sites | ✓ | ? | ? | ✓ avoided | — | — | — |
| homes and population | ✓ homes per cell | ◐ population | ◐ urban classes | ✓ building proximity | ◐ urban land cost | ✓ urban classes | ◐ structure type |
| wildfire | ✓ hazard classes | ✓ continuous | — | ? | — | — | — |
| other siting layers (Superfund, floodplain, coastal barriers, munitions sites, tall structures) | ✓ | ? | ? | ◐ Superfund, floodplain | — | — | — |
| following existing lines | ✓ preferred | ◐ kept out of existing ROW | ? | ✓ strongest factor | — | — | — |
| Section 368 corridors | ✓ | ? | ◐ risk class | ? | — | — | ◐ SWCA class |
| road, rail and river crossings | ◐ counted, not weighted | ◐ trail crossings exempt | ◐ water weighted | ◐ paralleling scored | ◐ named | — | — |
| regional costs | ✓ four sets | — West only | ✓ by region | — | ✓ by state | ✓ by utility | ◐ utility columns |
| right-of-way land | ✓ county land value | ✓ BLM layer | ◐ in base cost | — | ✓ by land type | ◐ actual or lump sum | ✓ BLM rent zones |
| mitigation | ✓ by risk class | ◐ as cost multipliers | ✓ | — | ◐ | — | ◐ companion study |
| contingency | ✓ | — | ? | — | ✓ | ✓ | — |
| short-line factor | ✓ | — | ✓ | — | ? | ✓ | ✓ |
| terminals and HVDC | ◐ station count rule, line positions at existing stations | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| alternatives and similar-cost areas | ✓ | — | — | ✓ alternative routes | — | — | — |
| proof of the lowest routing score | ✓ | — | — | — | — | — | — |
| editable weights | ✓ | — fixed | ✓ config files | ✓ per project | ◐ workbook | ◐ spreadsheet | ✓ calculator |

## Footguns

### Route panel (UI)

- open the pane only through `route-panel-open.ts`'s dynamic import, or route code lands in the boot bundle (`node scripts/check_route_bundle.mjs` checks a build); every map layer and source id is `rp-`-prefixed and added or removed, never visibility-toggled; tabs talk to the shell only through `RouteTabContext` — no import of `ui-route.ts`, or the chunk cycles; every preset edit, stored custom method and pref reaches a solve only through `validatePresetPatch`; wording is "Similar-cost areas" / "Alternatives", never "corridor" except proper names such as "Section 368 corridor", and cost ranges read "rough early estimate (−30 % / +50 %)", never "exploratory"; AACE Class 5 is cited only on the Method tab, the report method page and docs/routing.md; a new string needs a key in every locale or the i18n parity test fails — a new route string goes in `src/i18n/route/*.ts` (loaded with the panel by `loadRouteStrings()`, which `route-panel-open.ts` awaits beside the chunk), a route key the boot bundle reads goes in `locales/*.ts` (the exact set is held by `src/i18n/i18n.test.ts`); a route is session only — no URL param, no `url:write`; the Method grid's map highlight is the `rows` overlay mode on `rp-weight`, repainted by the worker from the held window (`repaintRows`), and `assets/route/band-data.validate.test.ts` holds the "Map data from" labels to the cube's source text; visitor text calls a proven route the "lowest routing score", never "optimal" or "least-cost"; a terminal choice replaces the `RouteEnd` (`{ ...end, term }`), never mutates it, and never bumps the end's snap generation; the chat snaps to HIFLD only (`osm: false`) and its ends start at Auto (`resetTerm`), and an OSM end's name never goes to the model; an OSM-named end carries "© OpenStreetMap contributors" everywhere its name is shown or exported

### Routing constraints layer / concern picker

- a categorical tile set is recoloured from index codes, so overviews must resample with `max` (`mode` for the land manager and land cover) and never average or use WEBP, or colours blend into ones outside the palette; a concern id is a share-link value (`rc`) — never rename one; `scripts/route_constraints.json` and `scripts/route_constraints_sets.json` are generated — edit the TS and regenerate with `UPDATE_ROUTE_CONSTRAINTS=1`; the tiles are served from the route set on the data host (`ROUTE_ORIGIN` in `assets/constants.ts`, immutable `data/route/<ROUTE_ID>/`); their DATA key is in `NOT_SCRAPED`, so only `publish_r2.sh --only route` uploads them; switch concern only through `setRasterUrl`, which also rewrites the held url, or a link or undo before the first show loads the old concern; the cube's `pd_`/`osm_` split stays absolute, but a concern may read `osm_flags`/`adj` as its own picker entry, credited © OpenStreetMap contributors (ODbL) in its legend and tile attribution — never in What constrains or Land manager, which stay `pd_`-only (`route-constraints.test.ts` and the build refuse it); an existing concern id may change kind only if it still draws the same cells; the classes of one entry never share a value; an entry over 20 MiB at z8 is split into two entries, never drawn transparent or given a larger cap

### Route optimizer (cube, presets, solver)

- the band order is one contract across `scripts/route_grid.py` (`PD_BANDS`/`OSM_BANDS`), `scripts/build_route_cube.py`, `route.ts` `PD_BANDS`/`OSM_BANDS` and `assets/route/fixtures/make-cube.py` — `route.ts` refuses a cube whose band order differs (loud), but `make-cube.py` indexes bands by position (silent), so change all four together or fixture reads land on the wrong band; an OSM-derived band (including anything computed from OSM lines, like `adj`) goes only in the `osm_` files, never `pd_`, or the public-domain files take on ODbL; preset edits reach a solve only through `preset-patch.ts`'s `validatePresetPatch`, never a looser path; `presetBands()` must list every band a preset reads (rows, active `except` entries, mitigation, regions, ROW land), or the band is not loaded, reads as nodata and its $ silently drop out; method edits happen in the Route panel's Method tab (this session, and saved methods: save, rename, delete), through `validatePresetPatch`; the panel saves its last method, line type, colour mode and surface choice to `route-prefs.ts` (`tm-route-prefs`, re-validated on read); terminal kinds reach a solve only through `validateTerminals`
