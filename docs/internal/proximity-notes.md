# Proximity check: contributor notes

The public description is [`../proximity.md`](../proximity.md). This page holds the code
layout, tests, benchmarks and the checklist for changing the tool.

## Layout

- Entry points: Tools ▸ Proximity opens the drawer's **Proximity** tab through
`assets/ui/proximity-open.ts`, which loads the lazy chunk `assets/ui/ui-proximity.ts`
(the tab, its grids and the CSV downloads) and `assets/ui/proximity-map.ts` (the map
layers). The pure core is `assets/proximity/`.

Core contract: `assets/proximity/types.ts` (ProximityResult, PairsResult), `MAX_PAIRS` in `proximity.ts`, and
`assets/proximity/proximity.ts` (`proximityGroups`, `proximityPairs`).

Bubbles are a circle layer on the points themselves, so there is no polygon source to tile
(`assets/proximity/bubbles.ts`). The radius in pixels is threshold/2 over the Web Mercator
metres per pixel at the point's latitude, read from the point's `s` = sec(latitude) property in a
zoom-exponential `circle-radius` expression. Mercator's change of scale across a bubble grows
with the bubble's size. With `circle-pitch-alignment: map` the same circle lies on the globe.

## Where it runs

- **Grouping** (`proximityGroups`, method m5) runs on the main thread. Its memory is
  O(n) typed arrays and its time near-linear.
- **Pairs** (`proximityPairs`) runs in a Web Worker, `assets/proximity/pairs-worker.ts`,
  started only by `assets/proximity/pairs-open.ts`. It posts progress about every 50,000
  pairs found, and the tab offers **Cancel**, which terminates the worker and resolves the
  call as cancelled. A new pairs call cancels the one running. A worker error drops the
  worker, and the next call starts a fresh one. Input arrays are copied before they are
  sent, so the page keeps its own.
- **Pairs CSV** is built in a second Web Worker, `assets/proximity/csv-worker.ts`, started only by
  `csv-open.ts`: the pure `pairs-csv.ts` makes chunks of ≤ 10,000 rows, a progress line and Cancel
  show in either view, and a second click while it runs is ignored. The Groups CSV (≤ 100,000 rows)
  is built on the main thread.
- **Sample** (see Try a sample) downloads and cuts in `sample-worker.ts`.
- **Map** draws points and bubbles only (O(n)). Pairs are never drawn as lines.
- **Table** is a Tabulator grid, with virtual rows, so only visible rows are in the DOM.
  Sorting and grouping are done by the tool, not by Tabulator. `assets/ui/proximity-rows.ts` (pure)
  builds the view order (filter, then a stable sort) over typed arrays; its unit test holds the
  ordering step of 1,000,000 pairs to a time limit. Handing the result to the grid (`replaceData`)
  is not measured at that size.

## Table pane internals

Cells are text nodes made by formatters (`textCell`), not HTML strings. The grid registers no Sort,
Filter, Clipboard or Export module: Tabulator's `registerModule` is global, and the Clipboard and Export
modules write through innerHTML.

**Reset** clears the layers on both paths (`assets/ui/ui.ts` and `assets/map-api.ts`,
after `applyView({})`) by calling `clearProximityMap()` from `assets/proximity/clear.ts`.
Reset leaves the tab and its file open until the visitor closes the tab.

The worker and its code are in the `ui-proximity` chunk only, never the boot bundle.

## Tests, benchmarks and the oracle

The unit tests run in `npm test` (`vitest.config.ts` includes `assets/**/*.test.ts`):

- `assets/proximity/proximity.test.ts`: the parity harness. Every method in the registry
  (`methods.ts`) is held to the brute-force oracle (m0) on seeded sets D1–D5 at 0.1–500 km,
  each plain and with ids. Results must match exactly, with nearest distances within 1e-9 km.
  Pairs are checked against the brute-force list (n ≤ 3,000), against the cap, and for early
  stopping.
- `assets/proximity/geodesic.test.ts`: holds the geodesic to GeographicLib's published
  vectors and to the sphere-ratio bounds.
- `assets/proximity/bubbles.test.ts`, `pairs-open.test.ts`, `pairs-worker.test.ts`,
  `assets/ui/ui-proximity.test.ts`, `assets/ui/proximity-map.test.ts`.

Run them alone with:

    npx vitest run assets/proximity

The 30,000-point oracle check is not in `npm test`. It runs m0 once at n = 30,000 on D1
and D2 at 25 km, plain and with ids, and holds each method named in `PX_CHECK` (default
`m5`) to it:

    npx vitest run --config assets/proximity/vitest.oracle30k.config.ts

Benchmarks are `assets/proximity/proximity.bench.ts`. They are never part of `npm test`,
and they time the methods named in `PX_METHODS` (default `m5`) plus `proximityPairs`:

    npx vitest bench --run assets/proximity --outputJson <file>

The fixtures (`assets/proximity/fixtures.ts`) are seeded and generated; they never read
`data/`. The fixture generators are documented in that file's header.

`assets/filters-where.test.ts` allowlists every `setFilter` call site. The `px-focus` /
`px-focus-pt` call in `proximity-map.ts` has its line there.

## Checklist for changing the tool

- [ ] Contract changes start in `assets/proximity/types.ts` and `proximity.ts`; the parity
      harness (`proximity.test.ts`) and the oracle are updated with them.
- [ ] A new method is added to `methods.ts` (registry) and held to m0 by the harness.
- [ ] Changes to m5 or its switch (`DENSE`) rerun the harness and the 30k oracle check.
- [ ] Changes to the pairs path rerun `pairs-worker.test.ts` and `pairs-open.test.ts`; the
      cap and the truncation note stay in both the view and the CSV. The pairs CSV is
      `pairs-csv.ts` (pure; held equal to `toCsv`) run by `csv-worker.ts`; its size limit counts bytes.
- [ ] The sample (`sample.ts`, `sample-worker.ts`) keeps the cap, the view's box and the HIFLD credit.
- [ ] A new `px-` layer or source is added and removed with the others, and `clear.ts`
      still removes it on Reset.
- [ ] A new `setFilter` call has its line in `assets/filters-where.test.ts`.
- [ ] New strings: a `px.*` key in every locale, or the i18n parity test fails.
- [ ] Nothing from the file reaches storage, the URL, undo, logs or errors.
- [ ] Tabulator cells stay text-node formatters; the chunk is still reached only through
      `proximity-open.ts`.
- [ ] Sort, Filter, Clipboard and Export stay unregistered; a row click still selects only, and
      only ↗ flies (`onRow` / `onFly` in `proximity-map.ts`, tested in `ui-proximity.test.ts`).
