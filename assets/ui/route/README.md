Map of this folder; each file's header comment is the source of truth.

- `route-overlay.ts` — the Route pane's `rp-` sources and layers (`createRouteOverlay(getMap)`: add/remove in `ORDER`, the surface and weight canvases, hole and hover queries), the map as a parameter; imports no `state.ts`
- `ui-route.ts` — the Route tab of the bottom drawer, lazy chunk: the `RouteSession`, solve/cancel/progress,
  the legend, cell inspector, cell-weight overlay, header actions, `RouteTabContext`
- `route-inputs.ts` — its input column: A/B search over substations, pick mode, draggable pins, line type, method; each end snaps through `snapEnd` (a snap function it takes as an option) and offers the Auto / New station / Existing station / None picker with its reason line
- `route-report.ts` — the printable report (browser print), loaded on the Report button
- `route-request.ts` — the solve request builder the panel, batch and chat share (`resolveEnds`, `explainEnds` — each end's kind, reason code and kV, from its `RouteEnd.term`, `mergePatch`); `route-methods.ts` — the method lookup (`methodOf`, `solvedPresetOf`, `countEdits`, the saved-methods store), no DOM; `route-format.ts` — the panel's pure text and number logic (`waterfallLines`, `fmtMoneyHead`, `kpiTiles`, `rowLabel`, `crossingsCsv`, `shownExact`), shared by the tabs, the report and the batch export; `route-report-model.ts` — the printed report as plain data (`buildReportModel`, `reportText`), shared by `route-report.ts` and the batch PDF
- `route-batch.ts` — the Batch view (CSV → runs → ZIP); `route-batch-run.ts` — `runBatch`, one row at a time with injected solver and snap (`a_terminal`/`b_terminal` kinds, `summary.csv` `substation_source_*`, `CREDITS.txt` for OSM names), capture, PDF renderer and ZIP sink; `route-batch-pdf.ts` — jsPDF report page layout; `route-batch-zip.ts` — the ZIP sink; `route-batch-map.ts` — the hidden map capture; lazy chunks
- `tabs/` — the six sub-tabs, each a `RouteTab` rendering from `ctx.session`: `summary`, `cost`, `profile`,
  `crossings`, `alternatives`, `method`; shared `types.ts` (the contract), `widgets.ts` (waterfall, range bar, pills),
  `colours.ts`, `weights-table.ts` (the stacked method editor on phones); `method-grid.ts` (the Method tab's Tabulator grid, renderer only, wider than 520 px) and `method-rows.ts` (its pure model: rows, filter, sort, edits through `validatePresetPatch`); the Method tab also renames and deletes saved methods; `fixture.ts` is test support

