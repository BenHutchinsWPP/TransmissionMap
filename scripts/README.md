Map of this folder; each file's header comment is the source of truth.

# scripts

- `scripts/tile_inputs.py` — the rows tippecanoe read for a layer (kept world file or manifest `src`); shared by `stable_ids.py` and the columns builder
- `scripts/build_columns_parquet.py` — `make columns-parquet`: one attribute-only Parquet per tiled dataset in `data/analysis/columns/`, listed in `index.json` `columns` (dev-only; `docs/pipeline.md` § *Columns files*)
- `scripts/check_columns_parquet.py` — `make columns-check`: holds each file to its archive's max-zoom tiles; `--emit-reference DIR`, `--mutate`
- `scripts/check_geometry_parquet.py` — `make geometry-check`: holds the geometry files to the kept build input and the served tiles; `--only`, `--mutate`
- `scripts/build_global_tiles.py` — builds one planet-wide artifact per layer (what
  the map reads) from the 8 continental OSM intermediates: each layer is merged,
  deduped on its seam key and tiled in one tippecanoe pass (`RETILE`,
  `TILE_POLYGONS`; `CONCAT_GEOJSON` for the small point layers). Transmission is
  one archive, `osm_transmission_lines.pmtiles`. Download packs stay
  per-continent.
  See `docs/hosting-plan.md` and `docs/pipeline.md`.
- `scripts/` — data pipeline: `extract_*.py` (per dataset — e.g.
  `extract_us_census_boundaries.py` for US states/ZCTA,
  `extract_cgaz_boundaries.py` for world countries/admin-1), `fetch_*.py`
  (live feeds), `build_*.{sh,py}` (rasters/tiles/releases), `osm_common.py`
  (incl. `dedup_points`, the node-vs-polygon dedup of the plant, generator and
  data center extracts) + `geo_common.py` (incl. `sha256_file`) shared
- `scripts/build_region_domains.py` — `make region-domains`; re-run after a boundary refresh and commit its output
- `scripts/stable_ids.py` — `make stable-ids`: decodes each served archive at its max zoom and
  fails on a missing or duplicate stable id; ids are built in the extracts (`docs/pipeline.md` § *Stable ids*)
- `scripts/region_join.py` — region tags (`|TX|NM|`, `|none|`): which states, counties,
  BAs, NERC regions and utility territories (worldwide: countries, admin-1) each asset
  falls in; run by `make region-tags` on the US intermediates and by
  `build_global_tiles.py` on the world layers. Assets are tagged, context layers are
  not — see `docs/pipeline.md` § *Region tags*. `scripts/admin1_codes.csv` — the
  committed admin-1 short codes; never renumber (links filter on them)
- `scripts/build_route_constraints.py` — `make route-constraints`: the Routing constraints layer's tiles, one paletted PNG PMTiles per concern from the cube's `pd_` files (and `osm_` files for the OpenStreetMap entries, credited ODbL), into `data/route/constraints/` (never under `data/layers/`; published by `publish_r2.sh --only route`); rules and colours from `scripts/route_constraints.json`
- `scripts/route_grid.py` — the routing cube's grid and every band code table;
  `scripts/fetch_route_inputs.py` its raw inputs; `scripts/build_route_{bands,restrict,slope,flags,costbands,structures}.py`
  build the 250 m bands and `scripts/build_route_cube.py` stacks them into `data/route/250m/` (`make route-cube`,
  `make route-cube-assemble`); `scripts/build_route_report_data.py` the crossing-report GeoParquet
- `scripts/build_route_buildings.py` — bounded USA Structures fetch + observed all/nonresidential/unknown-class footprint shares; `make route-buildings ARGS="--fetch --bbox W S E N"`. The three bands share a coverage mask: 0 unobserved, 1 no matching footprint returned, 2–101 upward-rounded percent bounds.
- `scripts/build_route_buildings_national.py` — the same footprint bands from all 49 CONUS state archives (`make route-buildings-national ARGS="--source-dir PATH --work-dir PATH"`); hash-bound resumable state shards, bounded per-cell unions across state files, national land coverage only after every source completes. Keep archives/work on an external disk. Regional report inputs stay separate; default observation weights are neutral.
- `scripts/route_crossings.py` — crossing report for a routed line (dev tool; stdlib core tested by
  `scripts/test_route_crossings.py`); `scripts/route_validation_inputs.py` — PNAS corridors/spurs and WestTEC validation inputs
- `scripts/build_route_screening.py` — aviation observations for drawn-route reports, from the saved NTAD layers (`make route-screening`); immutable generations under the local report directory. `assets/route/screening.ts` computes finite runway and facility distances; `assets/ui/route-observations.ts` presents them. They do not change routing weights or establish clearance.
- `scripts/moratoriums/` — data center moratorium pipeline (`rebuild.sh` over `build*.py` + `sync.py`) and the
  twice-monthly refresh (`refresh/`: search, fetch, extract, quote-verify, review, publish; `moratorium-refresh.yml`); inputs live on
  the `data-moratoriums` branch. See its `README.md` and `docs/layers/dc-moratoriums.md`.
- `scripts/publish_r2.sh` — `make publish-r2` (after `data-manifest`): `rclone copy --checksum` of the data/layers files `validate_build.py --list-expected` names, the `data/releases/*.zip` packs and the `data/analysis/` files `index.json` names (any other file there aborts) to the R2 bucket `data-wpptx-org` (keys = repo paths), one run per header set (Content-Type, Cache-Control; never Content-Encoding), manifests last, after `check_analysis`; never deletes (`--prune-list` is a read-only report against the manifests, prev/ indexes included); changing fixed names are saved to `prev/<stamp>/` (aborts if the comparison cannot finish) and, once every upload succeeded, `src/registry/data-versions.json` is rebuilt in full (token = first 10 hex of the file's sha256) and the changed names printed; `--rollback STAMP` saves the current names, restores files before manifests, then gives them tokens `r<new stamp>`; `--dry-run` needs no rclone or keys (`.env.r2`) and prints the entries that would change, writing nothing; `--only route [--no-final] [--verify-sha]` uploads the route set alone (see `route_publish_plan.py`) under `data/route/<ROUTE_ID>/`: immutable, no `prev/`, every object verified after the copy, the cube's `grid.json`, the screening pointer and `LICENSE.txt` last
- `scripts/r2_upload.sh` — the one R2 uploader (`--bucket --cache-control --root PATH...`, keys from the environment): Content-Type by extension (an unknown one refuses the run), `.gz`/`.i16`/`.webp`/`.png`, then `.geojson`, then `.json` last, `rclone copy --checksum`; `--dry-run` needs no rclone or keys; `scripts/test_r2_upload.py`. `scripts/install_rclone.sh` — the pinned, SHA-256-checked rclone CI installs
- `scripts/route_publish_plan.py` — the route set's selection for `publish_r2.sh --only route`: the cube, the report files `report-read.ts` names, the constraints archives, the live screening generation's aviation file, `scripts/route_data_LICENSE.txt` (published as `LICENSE.txt`); `ROUTE_ID` (a hash of the selection, pinned in `assets/constants.ts`; `--print-id`, `--pinned`); refuses stray files; `scripts/check_route_live.sh` is the read-only pre-push check that the pinned id answers on the data host
- `scripts/check_route_bundle.mjs` — after `npm run build`: fails when route-panel code reaches the entry chunk or its modulepreloads
- `scripts/seed_r2.sh` — `live|moratoriums [--dry-run]`: copies the current `origin/data` live feeds or `origin/data-moratoriums` layer to their R2 bucket through `r2_upload.sh` (keys from `.env.r2.live` / `.env.r2.moratoriums` only)
- `scripts/data_manifest.yaml` — hand-written per-layer provenance (label,
  source, url, licence, `source_id`), one entry per `tile_manifest.yaml` `id`;
  a field the linked docs don't settle with confidence is the literal string
  `UNKNOWN` rather than a guess. `scripts/build_data_manifest.py` (`make
  data-manifest`) merges this with facts measured off each layer's tile-build
  input into `data/layers/manifest.json`, which `assets/ui/ui-credits.ts`
  renders as the Data Credits dialog. See `docs/pipeline.md`.

## Make targets

- `make region-tags` — tag the US intermediates in `data/build/` with the regions they fall in (last step of `make pipeline`; needs the boundary files)
- `make route-constraints` — build the Routing constraints tiles into `data/route/constraints/` from the routing cube (`ARGS="--only <id> --force"`; capped at 16 GB, log in `tmp/logs/route-constraints.log`)
- `make region-domains` — rebuild the committed region code/label tables in `src/registry/` from the boundary files in `data/build/`
- `make columns-parquet` — columns files for the tiled datasets into `data/analysis/columns/` (`ARGS="--only <ds>"`; capped at 14 GB, log in `tmp/logs/columns-parquet.log`); run after the tiles
- `make columns-check` — hold the columns files to the tiles (`ARGS="--emit-reference DIR"` or `"--only <ds> --mutate"`; log in `tmp/logs/columns-check.log`)
- `make geometry-check` — hold the geometry files to the kept input and the tiles (`ARGS="--only <ds>"` or `"--mutate"`; log in `tmp/logs/geometry-check.log`)
- `make stable-ids` — check every served layer's stable feature ids: 0 missing, 0 duplicate (`ARGS="--only <id> --max-tiles N"`); run after a tile or extract rebuild
- `make data-manifest` — build per-layer provenance → `data/layers/manifest.json` (Data Credits dialog); runs cleanly with no `data/` present, emitting null facts rather than failing

## Footguns

### Give a dataset a stable id / feature-id lookups

- an OSM layer's `data.id` must be `OSM_FID`/`OSM_NATIVE_FID` itself, never a copy; a GeoPackage reserves `fid`, so write it with `GPKG_FID_OPTIONS` or the column is lost; and tippecanoe `--use-attribute-for-id=fid` silently skips an attribute not typed `-T fid:int`; a native id is not a property, so read it with `featureId()`

### Publishing a build

- `make publish-r2` never deletes, since deployed bundles keep reading superseded objects; `ARGS=--dry-run` needs no rclone or keys; a publish or rollback reaches visitors only when the rewritten `src/registry/data-versions.json` is committed and main deployed, and the deploy ships whatever else is on main; a new data-host URL builder goes through `DATA`/`versioned`, and code that inspects a data URL's extension uses `isGzipUrl`, since the URL carries a query

### Where an asset is hosted / tile precision

- `--simplify-only-low-zooms` is opt-in, and dropping it re-simplifies maxzoom, costing ~5 screen px of line accuracy at z16

### Global tilesets

- `assets/constants.ts` must name layers in double-quoted `"data/layers/…"` literals or `validate_build.py` cannot see them (`assets/constants.test.ts` fails on any other form); each world layer's `select` in `build_global_tiles.py` must match its `tile_manifest.yaml` `select:` (`scripts/test_global_tiles.py` holds them together); and a re-tile spec must not carry `--extend-zooms-if-still-dropping`, or the archive advertises z14 past its `max_zoom`
