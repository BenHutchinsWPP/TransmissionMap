# Hosting & the world transmission tileset

Where each asset class is hosted, and how the world transmission archive is cut.

## Where each asset class lives

| asset class | host |
|---|---|
| `data/layers` — every built layer | `data.wpptx.org`, R2 bucket `data-wpptx-org` (`DATA_ORIGIN` in `assets/constants.ts`) |
| `data/analysis` — geometry and columns Parquet, `index.json` ([pipeline.md](pipeline.md) § *Line geometry*, § *Columns files*) | `data.wpptx.org`, same bucket |
| `data/releases` — download packs | `data.wpptx.org/data/releases/<name>.zip` |
| live feeds | `live.wpptx.org`, R2 bucket `live-wpptx-org` (`LIVE_ORIGIN`; [layers/wildfire-live.md](layers/wildfire-live.md)) |
| data center moratoriums | `moratoriums.wpptx.org`, R2 bucket `moratoriums-wpptx-org` (`MORATORIUM_ORIGIN`), `dc_moratoriums.geojson` at the bucket root ([layers/dc-moratoriums.md](layers/dc-moratoriums.md)) |
| the app | GitHub Pages (`www.wpptx.org`) |

Object keys are repo paths with no prefix. Every host answers ranged `GET`s with
`HTTP 206` and `access-control-allow-origin: *`, which is what PMTiles and the
Parquet readers need.
Cloudflare's edge cache holds objects up to 512 MB; a larger object is read from
R2 on every request.

The `pmtiles-range` check in `assets/diagnostics.ts` probes a host with a ranged
`GET`.

### Cache rules

Each host's Cloudflare Cache Rule follows the object's `Cache-Control` and bypasses the cache when it is absent.

| objects | `Cache-Control` |
|---|---|
| content-hashed `*.<sha8>.parquet` | `public, max-age=31536000, immutable` |
| other `data.wpptx.org` names | `public, max-age=3600, s-maxage=2592000` |
| live feeds | `public, max-age=0, s-maxage=60` |
| `dc_moratoriums.geojson` | `public, max-age=300` |

`.pmtiles`, `.parquet` and `.gz` are served as `application/octet-stream`, never
with a `Content-Encoding`.

### Live feeds and moratoriums

CI jobs commit the live feeds to the orphan `data` branch (one rolling commit),
then upload each feed's output path (a file, or the whole `weather_live/`
directory) to the bucket at the same key, after every push; unchanged objects
are skipped. The `data-moratoriums` branch is the change record of the
moratorium layer; its publish job uploads `dc_moratoriums.geojson` from the
branch tip after each run, so a merged refresh PR or a revert is published by a
`rebuild_only` dispatch.

## The transmission archive

OSM transmission ships as one planet-wide archive,
`data/layers/osm_transmission_lines.pmtiles` (zoom 2–11), tiled in one tippecanoe
pass. The frontend reads it as one source, `osm_transmission_lines`, and the
style-layer ids carry no suffix.

**`nominal_kv = -1` encodes unknown** — not NULL, not 0.

**Disjoint by construction.** The continental extracts overlap, so the merge
keeps one copy of each line (below); the layer is then a single source, and
MapLibre's per-source symbol collision detection sees every label.

## Simplification and maxzoom

Vector tiles quantize onto a 4096-unit grid per tile (tippecanoe `detail=12`),
which equals screen pixels four zooms up: a z12 transmission line (2.4 m grid) is
grid-limited to one screen pixel at z16.

Transmission carries `--simplification=5 --simplify-only-low-zooms`. It is set
wherever transmission is tiled — `rg simplify-only-low-zooms` lists them — and
every copy must stay in step.

> [!WARNING]
> `--simplify-only-low-zooms` is opt-in. Without it the Douglas-Peucker pass
> also runs at maxzoom, putting ~5 tile units of tolerance on a z12 line — ~5
> screen pixels at z16, visible where a line meets a substation bus. Lowering
> `--simplification` instead is not equivalent: it also rewrites z2–z11, where 5
> is the tuned value.

Reducing maxzoom shrinks the archive but degrades every reader's view.

Pipeline lines and transmission both tile with `--maximum-tile-bytes=1000000`.
tippecanoe thins any tile over the ceiling, and the densest tiles are filled by
per-line ids and fields, not vertices, so simplification cannot bring them under
500 KB (pipelines' Gulf Coast 4/3/6 is 507,607 bytes). At 1 MB both archives are
byte-identical to a 20 MB build: nothing is dropped at any zoom.

## What the re-tile does

Every world layer is built from one merged input: `build_global_tiles.py` reads
the eight continental intermediates (`data/build/*_{code}.csv` / `.gpkg`), drops
the seam copies, and runs tippecanoe once. Transmission, the `RETILE` table
(substation points, generators, pipeline lines) and `TILE_POLYGONS` (substation
and plant footprints) all follow this pattern; `CONCAT_GEOJSON` applies the same
dedupe to the three small point layers it concatenates.

- **Dedupes the seams.** Geofabrik's extracts overlap (Russia, Türkiye, the
  Caucasus) and nothing clips them to continent polygons, so the same OSM
  element arrives from two extracts. The merge keeps the first copy, on a key
  that identifies one element:
  - transmission: `osm_id` (ways only) — removes ~1.7% redundant ways;
  - data centers: `(osm_type, osm_id)`;
  - every other layer: `(osm_id, geometry as written)`, because those sources
    carry no `osm_type`. A seam copy has the same id and the same coordinates;
    a node and a way sharing a number differ in geometry.

  Each merge logs features read and kept. The key columns are read for the
  merge only, and the merged file carries just the layer's `select` columns,
  so pipeline lines (which do not tile `osm_id`) coalesce on the same
  attributes as before.
- **One maxzoom by construction.** A PMTiles archive carries **one** `maxzoom`,
  and a single tippecanoe pass gives every continent the same depth. The
  re-tiled layers do not use `--extend-zooms-if-still-dropping`, so each
  archive advertises exactly its spec's `max_zoom`: generators 13, substation
  points 13, pipeline lines 12, substation and plant polygons 12, transmission 11.
- **Strips `minz`.** `minz` is the per-feature zoom floor the tippecanoe `-j`
  ladder selects on, so tiling needs it, but nothing in `assets/` or `src/`
  reads it. `tile-join -pk -x minz` drops it from the transmission archive.
- **Logs drop warnings.** tippecanoe's stderr lines about thinning (`Going to
  try`, `too many features`, `with detail`, `dropping`) are logged even when
  the command succeeds, so a build that thinned a layer shows it.

## Archive sizes with region tags

Region tags ([pipeline.md § Region tags](pipeline.md#region-tags-scriptsregion_joinpy))
keep each tagged archive within about 20% of the untagged build (hifld_natgas_lines, a small archive, is the outlier).

Stable feature ids ride in the tile's native id slot on the large OSM archives. The
largest archives are the ones to watch: a new tagged field, or a year of OSM
growth, grows what each publish uploads. `scripts/region_report.py --archive`
prints each archive's size against the untagged build.

## Substation zoom floor

Points are never dropped or coalesced: the substation spec carries `-r1
--no-tile-size-limit --no-feature-limit --preserve-input-order`. The archive
starts at **z4** — below that a single tile holds most of the substations on
Earth — and every point is present from z4 up.

## One source on the frontend

`planTransmissionLines()` in `assets/layers/layer-init.ts` plans the style layers
of the one `osm_transmission_lines` source in tier order; `line-sort-key` from kV
puts EHV on top, and the labels carry a `symbol-sort-key` (higher kV first).

## Publishing

`make publish-r2` (`scripts/publish_r2.sh`) publishes **only the layers
`assets/constants.ts` names**, via `validate_build.py --list-expected`, the
`data/releases/*.zip` packs and the `data/analysis/` files `index.json` names, to
the `data-wpptx-org` bucket from the owner's machine. The per-continent archives
`make continental-all` leaves in `data/layers/` stay local.

It uploads with `rclone copy --checksum`, one run per header set, objects first
and manifests last, and never deletes: deployed bundles keep reading superseded
objects. A fixed-name object that is about to change is first copied to
`prev/<stamp>/`; `--rollback STAMP` restores it. The run prints the changed
fixed-name URLs as the Cloudflare purge list. `--dry-run` needs no rclone or keys;
`--prune-list` reports unreferenced objects.

> [!WARNING]
> Tile attributes are not free to drop. `operator` is a **search** field —
> `assets/ui/ui-search.ts` matches on it via `querySourceFeatures`, which reads
> tile properties — so dropping it silently empties those searches. Each world
> layer's columns are its `select` list in `build_global_tiles.py`, held equal
> to the `tile_manifest.yaml` `select:` of the same id by
> `scripts/test_global_tiles.py`.
