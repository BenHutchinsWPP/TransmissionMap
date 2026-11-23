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
> how the two drift apart. Edit this file or a file it routes to.
>
> One exception, for facts rather than rules: a gitignored `AGENTS.local.md`
> may sit beside this file, carrying what is true of one machine — local-only
> directories, personal tooling. Read it when it exists. Conventions still
> belong here or in a file this one routes to, where everyone gets them.

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

## Where things are

Each listed folder's README.md is its map; each file's header comment is the source of truth.

- `index.html` — single page; Vite entry via `<script type="module" src="/src/main.ts">`
- `sw.js` — service worker (network-first app shell with offline fallback; detail in `src/README.md`)
- `CLAUDE.md` and `.vscode/settings.json` — the two shims above; no rules in them
- `src/README.md` — entry point, shared types, units, i18n, colors, registry (layer definitions and their JSON data)
- `assets/README.md` — frontend root modules: map, state, filters, url-state, view-state, undo, map-api, popup, agent
- `assets/live/README.md` — live feeds
- `assets/query/README.md` — dataset queries
- `assets/ui/README.md` — UI wiring, panels; the route panel, Proximity and chat in `route/`, `proximity/` and `chat/` READMEs
- `assets/route/README.md` — the route optimizer
- `assets/layers/README.md` — MapLibre layer builders and lazy data loading
- `assets/templates/README.md` — visualization templates
- `assets/sandbox/README.md` — analysis sandbox and canvas frame
- `assets/services/README.md` — linked GIS services
- `assets/lines/README.md` — transmission line tools
- `assets/proximity/README.md` — Proximity check core
- `assets/grid-ops/README.md` — Grid Operations layer (EIA-930)
- `assets/user-data/README.md` — user-imported and drawn layers
- `assets/parquet/README.md` — shared Parquet range reader
- `assets/columns/README.md` — columns files reader
- `assets/elevation/README.md` — elevation samplers
- `assets/utils/README.md` — pure utilities
- `scripts/README.md` — data pipeline scripts
- `docs/README.md` — the docs list

## Task routing — read these, not the whole repo

A row's footguns are in the `## Footguns` section of the file after `footguns:`, under the row's own heading.

| Task | Read |
|---|---|
| Add a dataset to the pipeline | `docs/adding-a-dataset.md` (data half), then `docs/adding-a-layer.md` for frontend |
| Add a map layer | `docs/adding-a-layer.md` ONLY, then `rg ">>> ADD-LAYER"` for insertion points |
| Add a **live** layer (auto-refreshing feed) | `docs/adding-a-live-layer.md` — the delta on top of `adding-a-layer.md` (footguns: `assets/live/README.md`) |
| Give a dataset a stable id / feature-id lookups | `docs/pipeline.md` § *Stable ids*, `assets/feature-id.ts`, `src/registry/osm-fid.ts` (footguns: `scripts/README.md`) |
| Add a filter (legend chips or range/slider) | `docs/adding-a-filter.md` (footguns: `assets/README.md`) |
| Change a display unit / add a setting | `docs/settings.md` (footguns: `src/README.md`) |
| Undo/redo, what goes on the stack | `assets/undo.ts`, `docs/url-state.md` § *Undo* (footguns: `assets/README.md`) |
| URL hash / shareable links / add a URL param | `docs/url-state.md` (footguns: `assets/README.md`) |
| Add or edit a curated map view / story | `docs/map-experiences.md` (footguns: `assets/README.md`) |
| Anything that reacts to a click/tap/hover on the map | `assets/map-input.ts` — subscribe there, never `map.on("click"\|"mousemove"\|…)` (footguns: `assets/README.md`) |
| Check a change in the real app / verify by screenshots | `.claude/skills/drive-app/SKILL.md` — headless Chromium against the dev server, with scenarios for links, `vx`, Reset, view files, style overrides, the table and the chat (footguns: `.claude/skills/drive-app/SKILL.md`) |
| A panel control shows the wrong value after Reset/Undo/a story/a link | `assets/ui/panel-mirror.ts` (`syncPanel`) (footguns: `assets/ui/README.md`) |
| Table drawer / selection chip | `assets/ui/drawer.ts` (the shell), `assets/ui/ui-table.ts` (the table pane), `assets/ui/ui-selection.ts`, `assets/ui/panel-mirror.ts` (`commitSelection`, `commitWhere`) (footguns: `assets/ui/README.md`) |
| Add a library service / vetted host | `src/registry/service-library.json`, `src/registry/service-hosts.json`, `assets/services/service-library.test.ts`, then `node scripts/check_service_library.mjs` (footguns: `assets/services/README.md`) |
| Linked services / add-service-by-URL | `assets/services/`, `assets/ui/ui-services.ts`, `docs/url-state.md` (`sv`), `docs/internal/chat-trust-model.md` (footguns: `assets/services/README.md`) |
| Analysis sandbox / `runAnalysis` | `assets/sandbox/runner.js`, `assets/sandbox/sandbox-host.ts`, `scripts/build_sandbox.mjs` (footguns: `assets/sandbox/README.md`) |
| Chat canvas / `showCanvas` | `docs/internal/chat-trust-model.md` (§ *Frames*), `assets/sandbox/canvas-runner.js`, `assets/sandbox/canvas-host.ts`, `assets/ui/chat/ui-canvas.ts`, `showCanvas` in `assets/agent/tools.ts`, the library list in `assets/agent/loop.ts` `SYSTEM_PROMPT` (footguns: `assets/sandbox/README.md`) |
| Transmission line tools (copy, fault locator, profile) | `docs/line-tools.md`, then `assets/lines/line-read.ts`, `assets/ui/ui-line.ts`, `assets/lines/profile.ts` (data: `docs/pipeline.md` § *Line geometry*) (footguns: `docs/internal/line-tools-notes.md`) |
| Spatial joins (`joinPoints`, `crossings`) | `assets/query/spatial-join.ts`, `assets/query/dataset-query.ts` (footguns: `assets/query/README.md`) |
| Map API / agent tools (what the chat may call) | `assets/map-api.ts`, `assets/agent/tools.ts`, `docs/internal/chat-trust-model.md` (footguns: `docs/internal/chat-trust-model.md`) |
| Local chat commands (answered without a model) | `assets/agent/local-commands.ts` (footguns: `docs/internal/chat-trust-model.md`) |
| Chat panel (the drawer's Ask tab) | `assets/ui/chat/ui-chat.ts`, the Ask pane's shell, `assets/ui/drawer.ts` (footguns: `assets/ui/chat/README.md`) |
| Session restore (Android discard / reload) | `assets/session-snapshot.ts`, the save/restore halves of `assets/ui/chat/ui-chat.ts` (`tm-chat`, the conversation) and `assets/ui/drawer.ts` (`tm-drawer`, the layout — Ask open or not — and the table, whose part `ui-table.ts` registers; shape checks in `assets/ui/drawer-snapshot.ts`, field checks at restore against `describe()`), `docs/internal/chat-trust-model.md` (§ *Session restore*) (footguns: `docs/internal/chat-trust-model.md`) |
| Chat charts (bar/pie/line or Vega-Lite, PNG/CSV) | `assets/chart-spec.ts`, `assets/ui/chat/ui-chart.ts`, `assets/vega-spec.ts` (a Vega-Lite `chart` object: page check, row injection, CSV), the `chart` argument of `runAnalysis` in `assets/agent/tools.ts` (`aggregate` takes none: its group charts are `showTemplate`'s) (footguns: `assets/ui/chat/README.md`) |
| Templates (Tools ▸ Charts, `showTemplate`) | `assets/templates/show-template.ts`, `assets/templates/catalogue.ts`, `assets/ui/ui-templates.ts`, `src/registry/field-roles.ts`, `src/registry/template-signatures.ts`, `docs/templates-coverage.md`, `docs/internal/chat-trust-model.md` (footguns: `assets/templates/README.md`) |
| Agent loop / OpenRouter client / the key | `assets/agent/loop.ts`, `assets/agent/openrouter.ts`, `assets/agent/key-store.ts`, `docs/internal/chat-trust-model.md` (footguns: `docs/internal/chat-trust-model.md`) |
| Query a dataset (rows / count / group-by) | `assets/query/dataset-query.ts`, `assets/query/dataset-core.ts` (the state-free core), `assets/query/dataset-view.ts` (the map reads) (footguns: `assets/query/README.md`) |
| Grid Operations layer (EIA-930 bubbles, interchange arrows, hour bar) | `docs/layers/ba-interchange.md`, `assets/grid-ops/` (footguns: `assets/grid-ops/README.md`) |
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
| Add a field to a dataset's filter schema (types, operators, closed value domains) | `src/registry/field-schema.ts` (`FIELD_SCHEMA`); compiled into filter expressions by `src/registry/condition-compile.ts` (footguns: `src/README.md`) |
| Area filter / which layers a region choice reaches | `src/registry/area-filter.ts`, `assets/filters.ts` (`setArea`), `docs/url-state.md` (`af`) (footguns: `src/README.md`) |
| Legends | `assets/ui/ui-legends.ts` |
| Search behavior | `assets/ui/ui-search.ts` |
| Area picker UI (the AREA row, chips, row flags) | `assets/ui/ui-area.ts`, `assets/ui/panel-mirror.ts` (`commitArea`, `syncAreaControl`) (footguns: `assets/ui/README.md`) |
| Layer add order / lazy loading | `assets/layers/add-all-layers.ts` (order), `assets/layers/layer-data.ts` (lazy GeoJSON loading), `assets/layers/layer-source.ts` (which file / source / credit a layer gets, from `LayerDef.data`) |
| Live wildfire feed (update cadence, staleness, workflow) | `docs/layers/wildfire-live.md`, `.github/workflows/wildfire-data.yml`, `assets/live/wildfire-staleness.ts` |
| Data source facts (URL, license, columns) | `docs/data-sources.md`, `docs/layers/<layer>.md` |
| Add/fix a layer's provenance (publisher, landing page, licence) | `scripts/data_manifest.yaml` — sourced only from `docs/data-sources.md` and `docs/layers/<id>.md`; a field those docs don't settle is the literal string `UNKNOWN` |
| Change what the Data Credits dialog shows | `scripts/data_manifest.yaml` for the facts, `assets/ui/ui-credits.ts` for the rendering; `make data-manifest` rebuilds `data/layers/manifest.json` it fetches |
| IT/security asks what URLs to whitelist | `docs/network-allowlist.md` |
| Fetch from a new host / the Content Security Policy | `assets/constants.ts` (`CSP_HOSTS`, `CSP_POLICY`), `docs/network-allowlist.md`, `assets/diagnostics.ts` (footguns: `assets/README.md`) |
| "Things aren't loading" reports / add a diagnostics check | `assets/diagnostics.ts` (`DIAG_CHECKS`), `assets/ui/ui-diagnostics.ts` (footguns: `assets/README.md`) |
| Pipeline / tile build | `docs/pipeline.md`, then named script |
| Publishing a build | `docs/hosting-plan.md` § *Publishing* — read before running `make publish-r2` (footguns: `scripts/README.md`) |
| Where an asset is hosted / tile precision | `docs/hosting-plan.md` — read before changing `DATA_ORIGIN` / `LIVE_ORIGIN` or any tippecanoe simplification flag (footguns: `scripts/README.md`) |
| How "continent" is defined / rebuilding the OSM extracts without Geofabrik | `docs/pipeline.md` § *Canonical regional boundaries* — the eight `.poly` files are vendored at `scripts/geofabrik_bounds/`, with an `osmium extract` config that recuts all eight from `planet-latest.osm.pbf` |
| Moratorium layer data / twice-monthly refresh | `scripts/moratoriums/README.md` (footguns: `scripts/moratoriums/README.md`) |
| Global tilesets | `docs/hosting-plan.md` (footguns: `scripts/README.md`) |
| Route panel (UI) | `docs/internal/routing-notes.md` § *Route panel*, then `assets/ui/route-panel-open.ts`, `assets/ui/route/ui-route.ts`, `assets/ui/route/tabs/types.ts` (footguns: `docs/internal/routing-notes.md`) |
| Routing constraints layer / concern picker | `docs/internal/routing-notes.md` § *Routing constraints layer*, then `src/colors/route-constraints.ts`, `assets/route-constraints.ts`, `scripts/build_route_constraints.py` (footguns: `docs/internal/routing-notes.md`) |
| Route optimizer (cube, presets, solver) | `docs/internal/routing-notes.md`, then `assets/route/route.ts`, `assets/route/cost.ts`, `src/registry/route-presets.ts` (footguns: `docs/internal/routing-notes.md`) |
| Proximity check (Tools ▸ Proximity) | `docs/proximity.md`, `docs/internal/proximity-notes.md` (tests, benchmarks, checklist), then `assets/proximity/proximity.ts`, `assets/proximity/types.ts`, `assets/ui/proximity/ui-proximity.ts`, `assets/ui/proximity/proximity-map.ts` (footguns: `docs/internal/proximity-notes.md`) |

## Commands

- `make help` — list all targets
- `make check` — verify CLI deps (osmium, ogr2ogr, tippecanoe)
- `make install` — create venv + Python deps
- `make pipeline` — full data pipeline for one region (slow; needs `data/raw/` inputs)
- `make continental-all` — run the OSM pipeline for all 8 continents; must precede `make global-tiles`
- `make tiles` — build PMTiles from extracted data; once `make global-tiles` has run, rebuild one layer with `build_tiles.py --only <id>` instead (the bare target replaces the world `osm_*` archives with one region's)
- `make global-tiles` — join the 8 continental OSM builds into one world tileset per layer, region-tagged;
  transmission is re-tiled globally into one archive
- Data build and check targets (`make region-tags`, `make columns-parquet`, `make stable-ids`, `make data-manifest`, …): `scripts/README.md` § Make targets
- `make publish-r2` — upload the layers `constants.ts` names, `data/analysis/` and `data/releases` to the R2 bucket behind `data.wpptx.org` (the prod host; `ARGS=--dry-run` first; `ARGS="--only route"` for the route set)
- `node scripts/check_chunks.mjs` — what each drawer pane loads on open, after `npx vite build --manifest` (`--json`, `--assert-has-tabulator a,b`, `--assert-no-tabulator a,b`)
- `make validate` — check tile_manifest output matches `assets/constants.ts` (run after wiring a new layer)
- `npm run dev` — serve site locally (Vite dev server, hot reload)
- `npm run build` — production bundle (output: `dist/`); **gates on `typecheck` + `lint` via `prebuild` — fails on any type or lint error**
- `npm run preview` — preview production build locally
- `npm run typecheck` — TypeScript check only (cheapest gate; run before claiming any code change done)
- `npm test` — run Vitest unit suite (`*.test.ts`); `npm run test:watch` to watch
- `make test-pipeline` — pipeline smoke tests (`scripts/test_*.py`, no `data/` or network needed), run twice: stdlib only (`python3 -S`, what the CI runners and the moratorium refresh see — a test that needs PyYAML imports it inside the test and skips without it), then with PyYAML for the manifest checks, then `test_dedup_points.py` under `venv/` when it exists. CI runs them on any `scripts/**` push (`pipeline-tests.yml`, PyYAML pinned in `scripts/requirements-tests.txt`). Run it after touching any `scripts/*.py`.
- Per-dataset build targets exist too (e.g. `make wind`, `make seismic`) — run `make help` for the current list

## Working style

- Before editing in a folder, read its `README.md`.
- **Orient with `git log --oneline -15` *and* `git branch -r` before the first
  edit.** `main` is a rewritten history that shares no ancestor with the older
  topic branches, so `git log main..origin/<branch>` has no merge base and
  reports the branch's whole history as "ahead" — that count means nothing
  here. Check by content instead — `grep` the symbol on `main` — rather than
  trusting a commit count. `origin/data` and
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
- **Built sizes and counts live in the manifests, not the docs.** Each built file's
  size is in `data/layers/manifest.json` (`make data-manifest`) or
  `data/analysis/index.json`. A doc names a cap and its constant, never a measured
  size, feature count or row count of a build output, which goes stale on rebuild.
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
