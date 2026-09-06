# Hosting & the world transmission tileset

Where each asset class is hosted, and how the world transmission archive is cut.

## Where each asset class lives

| asset class | host |
|---|---|
| `data/layers` — every built layer | orphan `data-static` branch, via `raw.githubusercontent.com` |
| `data/releases` — download packs | rolling GitHub Release `data-latest`, via `github.com/.../releases/download/` |
| live feeds | orphan `data` branch, same host ([layers/wildfire-live.md](layers/wildfire-live.md)) |

`raw.githubusercontent.com` answers ranged `GET`s with `HTTP 206` and
`access-control-allow-origin: *`, which is what PMTiles needs, and caps responses
at `max-age=300`. Its one hard constraint is git's: **no file over 100 MiB.**

Probe it with a ranged `GET`, not `curl -I`: raw ignores `Range` on `HEAD` and
answers `200` either way. The `pmtiles-range` check in `assets/diagnostics.ts`
does this correctly.

GitHub Release assets send **no CORS header**, so they can back a download link
(a plain navigation) but never a PMTiles source or any `fetch()`. That is why the
two asset classes are split: layers must stay on raw, packs must not. Release
assets take **2 GB per file** against the branch's 100 MiB, and they live outside
the git object store, so publishing one never grows the repository.

The tag rolls in place — `gh release upload --clobber` replaces assets under the
same `data-latest` tag — because `RELEASES_ORIGIN` in `assets/constants.ts` bakes
those URLs into the deployed bundle. Changing the tag orphans every download link
in every already-deployed page.

## The voltage split

Transmission ships as six planet-wide archives, one per voltage class.
`scripts/build_global_tiles.py` (`TRANSMISSION_BANDS`) is the single definition;
`src/registry/transmission.ts` (`OSM_TL_BANDS`) mirrors it on the frontend and
derives the style-layer ids. Change one and you must change the other.

| file | filter |
|---|---|
| `osm_transmission_lines_kv0` | `kv < 50` |
| `osm_transmission_lines_kv50` | `50 ≤ kv < 100` |
| `osm_transmission_lines_kv100` | `100 ≤ kv < 125` |
| `osm_transmission_lines_kv125` | `125 ≤ kv < 200` |
| `osm_transmission_lines_kv200` | `200 ≤ kv < 300` |
| `osm_transmission_lines_kv300` | `kv ≥ 300` |

As one world file the layer is past the ceiling, and six is the fewest bands
that fit under it — at four or five, a middle band still exceeds it.

**`nominal_kv = -1` encodes unknown** — not NULL, not 0. Because -1 sorts below
everything, `kv < 50` captures unknown for free. Unknown is ~18% of the layer, so
a bottom band starting at 0 would silently drop it.

Each cut point sits in a gap between real voltage classes (50, 100, 125, 200,
300 kV), so no dense class is split across two archives. Re-derive the
distribution before moving one.

**Split on an attribute, never on geography.** The continental extracts overlap,
so a geographic split serves the same line from two sources — drawn and labelled
twice, because MapLibre's symbol collision detection is per-source. Voltage
classes are disjoint: a line is in exactly one archive.

## Simplification and maxzoom

Vector tiles quantize onto a 4096-unit grid per tile (tippecanoe `detail=12`),
which equals screen pixels four zooms up: a z11 transmission line is
grid-limited to one screen pixel at z15.

Transmission carries `--simplification=5 --simplify-only-low-zooms`. It is set
wherever transmission is tiled — `rg simplify-only-low-zooms` lists them — and
every copy must stay in step.

> [!WARNING]
> `--simplify-only-low-zooms` is opt-in. Without it the Douglas-Peucker pass
> also runs at maxzoom, putting ~5 tile units of tolerance on a z11 line — ~5
> screen pixels at z15, visible where a line meets a substation bus. Lowering
> `--simplification` instead is not equivalent: it also rewrites z2–z10, where 5
> is the tuned value.

Reducing maxzoom shrinks the archive but degrades every reader's view; the
voltage split is the lever to use instead.

## What the re-tile does

Transmission is re-tiled from the continental GeoPackages rather than joined
tile-for-tile. That is required for the voltage split, and it also:

- **Dedupes the seams.** Geofabrik's extracts overlap (Russia, Türkiye, the
  Caucasus), nothing clips them to continent polygons, and `tile-join`
  concatenates a shared tile's features rather than picking a winner. Keeping
  the first feature per `osm_id` before tippecanoe runs removes ~1.7% redundant
  ways. The other joined world archives still carry their duplicates.
- **Strips `minz`.** `minz` is the per-feature zoom floor the tippecanoe `-j`
  ladder selects on, so tiling needs it, but nothing in `assets/` or `src/`
  reads it. `tile-join -x minz` drops it afterwards.

> [!IMPORTANT]
> A PMTiles archive carries **one** `maxzoom`. Joining continents built to
> different depths makes the archive advertise the deepest one, and regions that
> never built that deep then draw **blank** above their own ceiling instead of
> overzooming. Tiling once globally makes that impossible by construction; any
> layer still joined must be built to the same maxzoom on every continent.

## Substation zoom floor

Points are never dropped or coalesced: the builds carry `-r1
--no-tile-size-limit --no-feature-limit --preserve-input-order`, and the global
join preserves that with `tile-join -pk`. The archive starts at **z4** — below
that a single tile holds most of the substations on Earth — and every point is
present from z4 up.

## Six sources on the frontend

`addTransmissionLines()` in `assets/layers/layer-init.ts` takes a `sources` list
and adds every style layer across all sources before starting the next, so paint
order is tier-major and ascending kV puts EHV on top.

A source declares its class as `kv: [min, max)`, and a style tier only gets a
layer on a source whose range it overlaps. The cuts at 50, 100 and 200 kV
coincide with existing tier boundaries, so most archives carry one kV tier.

The cost is six PMTiles headers at map init instead of one, fetched in parallel.

## Publishing

`scripts/publish_data.sh` publishes **only the layers `assets/constants.ts`
names**, via `validate_build.py --list-expected`; the per-continent join inputs
stay local. Layers go to the branch as one orphan commit (~1.2 GB, inside
GitHub's ~2 GB per-push ceiling); download packs go to the `data-latest` Release
in the same run.

> [!WARNING]
> `trim_pmtiles()` rewrites through a temp file whose name **must** end in
> `.pmtiles`. `tile-join` picks its output format from the suffix and silently
> writes mbtiles for anything else — which looks like a successful trim that
> makes the file bigger.

> [!WARNING]
> Tile attributes are not free to drop. `operator` is a **search** field —
> `assets/ui/ui-search.ts` matches on it via `querySourceFeatures`, which reads
> tile properties — so dropping it silently empties those searches. `DROP_ATTRS`
> in `build_global_tiles.py` lists what is genuinely unread.

### Repository headroom — check before every publish

`data-static` is force-pushed as a fresh orphan each publish, which deletes
nothing: the previous tree's blobs become unreachable and keep counting against
the repository. GitHub reclaims them with its own maintenance, on a schedule you
do not control and cannot trigger — **only GitHub Support can run GC on demand.**
GitHub's guidance is 1 GB recommended / 5 GB soft.

That makes an overshoot one-way. Past the limit GitHub can restrict pushes, so
you lose the ability to ship the fix; serving is unaffected (raw does not check
repo size), but you would be stuck until Support prunes.

`publish_data.sh` therefore **refuses to publish** when the result would cross
`SIZE_CEILING_KB` (4.5 GiB by default). Its estimate counts only blobs whose
content is not already on the branch — git stores by content hash, so
republishing an unchanged file costs nothing, and a rebuild that changes every
tile costs the full tree.

> [!IMPORTANT]
> Never bypass the check with `SKIP_SIZE_CHECK=1` to "just get this one out".
> Publishing again cannot undo it. If headroom is short, move data off the branch
> or open a GitHub Support ticket asking them to garbage-collect the repository —
> and note that GC only frees objects nothing references, so the content has to
> leave the branch *before* the ticket, not after.
