# Build Pipeline — Regenerating the Data

The full pipeline is reproducible end-to-end. You only need it to rebuild the data
in `data/` against fresher upstream sources. For the per-layer processing detail
(filters, column drops, computed fields) see [`layers/`](layers/).

---

## Regenerate

```bash
# 1. System tools + Python venv (one-time)
#    tippecanoe must be built from source — see https://github.com/felt/tippecanoe
make install

# 2. Fetch the eight continental PBFs into data/raw/osm/
python3 scripts/fetch_geofabrik_osm.py --region europe --filter-tags   # repeat per region

# 3. Extract OSM/HIFLD/EIA layers → data/build/
#    make continental-all builds all eight; make pipeline builds one region
make continental-all

# 4. Build PMTiles and GeoJSON for the app → data/layers/
make tiles

# 5. Join the 8 continental OSM builds into one world tileset per layer
make global-tiles

# 6. (deploying) Push data/layers/ + data/releases/ to the data-static branch
#    prod fetches from — local dev reads data/layers/ directly. Rebuilds the
#    per-layer provenance manifest first (make data-manifest, chained via
#    `publish-data: data-manifest`) so data/layers/manifest.json ships current.
make publish-data
```

### The data manifest (`make data-manifest`)

`scripts/build_data_manifest.py` reads `scripts/data_manifest.yaml` (hand-written
provenance — publisher, landing page, licence) and, for each `id` in
`scripts/tile_manifest.yaml`, measures facts off that layer's `src` — the file
`ogr2ogr`/`tippecanoe` actually consume — writing the merge to
`data/layers/manifest.json`. That file is what `assets/ui/ui-credits.ts` fetches
to render the Data Credits dialog.

**`source_rows` counts rows in the layer's tile-build *input*, not features in
the tiled output.** Tippecanoe dedupes, clips, and drops features per zoom, so a
count decoded from the built PMTiles/GeoJSON is that zoom's surviving feature
count, not the dataset's — the two differ by design, and the manifest's own
`note` field says so for anyone reading the JSON without this doc.

**`data_as_of` is when the upstream data was captured, not when we processed
it.** For OSM layers (`source_id: osm`) it is the snapshot timestamp in the raw
extracts' headers (`osmium fileinfo`), taking the oldest of the continental
`data/raw/osm/*-latest.osm.pbf` files, since a joined world layer is only as
fresh as its stalest continent. For other layers it is the newest mtime of the
files matched by that entry's optional `raw:` path or glob in
`scripts/data_manifest.yaml` — the download the extract script reads. With no
`raw:`, no `osmium`, or a PBF without the header, it is null; the Credits dialog
then omits the date rather than show a processing date in its place. The
top-level `generated_utc` records when the manifest itself was built.

The script runs cleanly with no `data/` present — a fresh clone or CI, where the
pipeline has never run — emitting null facts for artifacts it can't see rather
than failing, so `make data-manifest` is always safe to run.

`make data-manifest` is chained into the normal flow rather than a step you run
by hand: `validate` depends on it (so `data/layers/manifest.json` — one of the
`assets/constants.ts`-declared outputs `make validate` checks for — is always
current instead of reported absent) and `publish-data` depends on it too (so the
manifest that ships is freshly built, built-artifact sizes included once `make
tiles`/`make global-tiles` have run, rather than stale or missing). Run it
directly only to inspect `data/layers/manifest.json` on its own.

`data/layers/manifest.json` is picked up by `make publish-data` automatically:
it's named as a double-quoted `"data/layers/…"` literal in `assets/constants.ts`
(`DATA.data_manifest`), the same mechanism every other published layer uses.

HIFLD and EIA reference data are auto-downloaded on first run to `data/raw/hifld/` and
`data/raw/eia/`. Some HIFLD inputs (SeerAI parquet for transmission lines, natural-gas,
and region layers) are **manually placed** — see the script headers and
[release-artifacts.md](release-artifacts.md) for the exact files and origins.

### Region tags (`scripts/region_join.py`)

Each asset carries the regions it falls in, so a map filter or a shared link can
scope it to a work area: "lines ≥345 kV in Texas", "plants in ERCOT".

**What gets tagged.** Assets get the fields people scope that kind of asset by.
Context layers are backdrops and get none.

| kind | US datasets (`--scope usa`) | world OSM layers (`--scope global`) |
|---|---|---|
| points and footprints | `states, counties, ba, nerc, retail` | `countries, admin1`, plus `counties, ba, nerc, retail` inside the US |
| lines | `states, counties, ba, nerc` | `countries, admin1`, plus `counties, ba, nerc` inside the US |
| context layers (PAD-US, critical habitat, tribal lands, BOEM leases, railroads) | none | — |

Lines carry no `retail`: the owner field already says whose line it is. On a
world layer the US-only keys are present only when `countries` holds `USA`;
elsewhere the key is absent.

**Values.** Every value is wrapped, points included: `|TX|`, `|TX|NM|`, and
`|none|` for a feature in no region (offshore, or outside every boundary).
Wrapping lets one `contains` test match any field without `USA1` also matching
`USA10`. The codes: `countries` ISO3; `admin1` a short code from
`scripts/admin1_codes.csv`; `states` USPS; `counties` the 5-digit GEOID; `ba`
the EIA abbreviation; `nerc` the region code; `retail` the HIFLD `ID`. Points
take every region they intersect, so a point on a border gets both. Lines and
polygons drop a region they only touch, unless every region they meet is
touch-only. EIA generators keep their reported `state`, `ba_code` and
`nerc_region` when non-blank (`--prefer`) and fall back to the spatial join.

**`scripts/admin1_codes.csv` is committed and never renumbered.** A link that
filters on `admin1` names these codes, so a code, once given, stays with its
geoBoundaries `shapeID`; a unit that disappears keeps its row with `current=0`
and its code is never reused. `make world-boundaries` stops when CGAZ brings a
`shapeID` the table lacks; rerun `extract_cgaz_boundaries.py
--assign-new-admin1` to give it the next free code, and commit the table.

**Where the join runs.** Each dataset is joined once:

- **US datasets — `make region-tags`**, the last step of `make pipeline`. It
  checks that the seven boundary files exist (naming the `make` target for any
  missing one), then tags each `data/build/` intermediate in place
  (`REGION_TAG_FILES` in the `Makefile`; lines pass `--fields
  states,counties,ba,nerc`). A re-run gives the same result. `make mines` tags in
  `extract_mines.py`, since it writes straight to `data/layers/`. After it, rebuild
  the tagged layers one id at a time with `build_tiles.py --only <id>`.
- **World OSM layers — `make global-tiles`**, on each layer's merged, deduped
  input before tippecanoe (`GLOBAL_FIELDS` / `LINE_FIELDS` in
  `build_global_tiles.py`).

**Never run a bare `make tiles` after `make global-tiles`.** It also rebuilds the
world `osm_*` ids from one region's intermediates, replacing the world archives
with untagged regional ones. Use `build_tiles.py --only <id>` for US layers.

**What stays untagged.** The per-continent OSM download packs (built from the
continental intermediates, which are not joined); the sibling `.csv` that
`geo_common.write_shp_csv` writes beside each `.gpkg` (nothing reads it); and
the `.dbf` of every `-shp.zip` pack. A DBF string holds 254 characters and a
long pipeline crosses up to 86 counties, so `build_releases.py` leaves the
region columns out of the shapefile. The CSV in the same zip keeps them, as do
the GeoJSON packs and the map tiles.

**`REGION_STATS`.** Every tag call logs one line per field —
`REGION_STATS <label> <field> n=… absent=… none=… multi=… maxlen=…` — so a build
log shows coverage without a separate pass: `rg REGION_STATS <log>`.

**Tile budget.** Tags make features less alike, so `--coalesce-densest-as-needed`
merges fewer of them and low-zoom tiles grow. HIFLD transmission lines tile with
`max_tile_bytes: 1000000` (as the OSM voltage bands do) so every line still
draws at z2–z5. After a tag change, check the build log for `Going to try
keeping` and compare drawn line length per zoom against the published archive.

### Region tag report (`scripts/region_report.py`)

The report measures the region fields over paths you pass in:

```bash
python3 scripts/region_report.py \
  --input data/build/<layer>.geojsonl data/layers/eia_generators.geojson.gz \
  --archive tmp/<build>/kv50.pmtiles=data/layers/osm_transmission_lines_kv50.pmtiles
```

- **`--input`** (`.geojsonl`, `.gpkg`, `.csv` (region columns only), or a
  `.geojson[.gz]` that ships as is): per region field, shares of *all* features
  that lack the key, are blank, are `none` (the bare string or `|none|`), are
  malformed (`|`, `||`, `TX|NM`, `none` inside a longer list), or carry more
  than one value; list length max and p99; distinct codes and strings; maxlen,
  the longest value (a DBF string tops out at 254 characters).
- **`--sample-pmtiles PATH[:Z]`**: the same table over the features
  `tippecanoe-decode` writes for one zoom, so what the tiles carry is measured.
  Z defaults to the archive's maxzoom; the decode is streamed.
- **`--archive PATH[=PUBLISHED]`** (`.pmtiles` or a shipped `.geojson.gz`):
  bytes and headroom to the 100 MiB per-file cap (`CEILING_BYTES` in
  `build_global_tiles.py`), per-zoom tile p50/p95/max for PMTiles, and the size
  delta against the file at `PUBLISHED` (default: `PATH`) on the local
  `origin/data-static` ref — `git fetch` first for a current comparison.
  `PATH` is split at the last `=` unless the whole argument is an existing file.
- **Repository headroom:** the estimate `publish_data.sh` runs before a publish
  (see [hosting-plan.md](hosting-plan.md) § *Repository headroom*), over the
  set it would push — every path `validate_build.py --list-expected` names, with
  each archive standing in for its `PUBLISHED` path. Files over the per-file cap
  are left out, blobs are deduped by hash, and only blobs not already in the
  `data-static` tree count. The sum plus the repository size (from `gh`, or
  `--repo-kb`) is checked against `SIZE_CEILING_KB`.

The script exits 1 when any archive is over the per-file cap, and 2 — before
printing any table — when a path is missing or a `.gpkg` is not a GeoPackage.

---

## Windows

**Viewing the map** needs nothing special — it's a static site, so native Windows
`python -m http.server 8000` just works.

**Regenerating the data on Windows requires WSL2.** The tile builder depends on
[`tippecanoe`](https://github.com/felt/tippecanoe), which has no native Windows build,
so the pipeline runs inside a Linux environment:

```powershell
wsl --install        # one-time: installs WSL2 + Ubuntu, then reboot
```

Then, **inside the Ubuntu shell**, work from the WSL filesystem (e.g.
`~/TransmissionMap`, not `/mnt/c/...` — native paths are much faster), and run the same
commands as above:

```bash
make install   # apt-installs osmium-tool + gdal-bin; build tippecanoe from source
make pipeline
make tiles
```

---

## Continental OSM boundaries & extraction toolchain

The OSM pipeline builds once per Geofabrik continent (`na eu as sa af oc ca an`).

### Canonical regional boundaries

Geofabrik publishes each extract's boundary as a `.poly` file (the osmium/osmosis
polygon-filter format). The eight continental polygons are vendored at
[`scripts/geofabrik_bounds/`](../scripts/geofabrik_bounds/):

| Pack code | Region | Geofabrik extract |
|---|---|---|
| `na` | North America | `north-america-latest.osm.pbf` |
| `eu` | Europe | `europe-latest.osm.pbf` |
| `as` | Asia | `asia-latest.osm.pbf` |
| `sa` | South America | `south-america-latest.osm.pbf` |
| `af` | Africa | `africa-latest.osm.pbf` |
| `oc` | Oceania | `australia-oceania-latest.osm.pbf` |
| `ca` | Central America | `central-america-latest.osm.pbf` |
| `an` | Antarctica | `antarctica-latest.osm.pbf` |

The polygons overlap rather than meeting on a shared edge, so features near boundaries
(e.g., Türkiye, Caucasus, western Russia) exist in both extracts. Every world layer
is deduplicated when `scripts/build_global_tiles.py` merges the continental
intermediates, on `osm_id` for transmission, `(osm_type, osm_id)` for data centers
and `(osm_id, geometry)` elsewhere (see [hosting-plan.md](hosting-plan.md)). The
per-continent download packs keep their overlap.

### Reproducing extracts from the OSM planet file

`scripts/geofabrik_bounds/extract-continents.json` is an `osmium extract` config that
cuts all eight continents out of the planet file in one pass, producing the filenames
the pipeline expects (`data/raw/osm/<region>-latest.osm.pbf`):

```bash
curl -O https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf

osmium extract -c scripts/geofabrik_bounds/extract-continents.json \
  --overwrite planet-latest.osm.pbf
```

Tag-filtering the planet first with `osmium tags-filter` (using the tags from
`scripts/fetch_geofabrik_osm.py`) and cutting the continents out of the result is
much cheaper when only energy infrastructure layers are needed.

### Extraction workflow

Run via `make pipeline`:

1. **Download** — `scripts/fetch_geofabrik_osm.py` fetches continental extracts (or
   download directly from Geofabrik).
2. **Filter** — `osmium tags-filter` + `osmium extract` reduce the full continental PBF
   to a small subset, selecting only relevant tags and clipping to the target bounding
   box. This runs **once**, in `extract_osm_lines.py`: the filter is the union of every
   OSM extract script's tags (`SHARED_FILTER_TAGS` in `osm_common.py`), and the
   intermediate (`data/build/*_filtered.osm.pbf` + a `.filters` sidecar recording the
   tag set) is reused by the substation/generator/plant/datacenter scripts via
   `find_pbf(need_tags=…)` — they fall back to the full continental pbf only when the
   intermediate is missing, stale, or was built without their tags.
3. **Convert** — `ogr2ogr` reads the filtered PBF via the GDAL OSM driver (with a
   project-local `osmconf.ini` that promotes `power` to the closed-way polygon list) and
   writes GeoJSON. Shapefile is avoided here: it truncates field names to 10 chars, hits
   a 2 GB per-file limit, and has UTF-8 issues. Dedicated Python scripts handle the
   polygon-substation, polygon-generator, and plant-relation paths `ogr2ogr` misses.
4. **Tile** — `tippecanoe` reads GeoJSON and writes PMTiles directly, one archive per
   layer, with per-layer zoom ranges tuned to feature density.
5. **Render** — MapLibre GL JS loads PMTiles via the `pmtiles://` protocol (Protomaps JS),
   fetching only the tiles visible in the current viewport.

---

## Hosting & compression

Two on-disk formats are served to the app, picked per layer by geometry profile:

- **PMTiles** — vector tiles for *few-large* or *very dense* geometries (transmission /
  pipeline lines, OSM generators, OSM substations & plant polygons, PAD-US, tribal lands, regions). Tiles load lazily via
  HTTP range requests and tippecanoe's simplification shrinks detailed geometry
  dramatically (e.g. PAD-US 806 MB SHP → 62 MB tiles).
- **Gzipped GeoJSON** (`.geojson.gz`) — for *many-small* geometries (plant
  points, EIA generators, pipeline points). Files are shipped **pre-gzipped**;
  the app fetches the `.gz` and decompresses in-browser via `DecompressionStream`
  (`fetchGeojson` in `assets/layers/layer-data.ts`). `build_tiles.py` gzips all served
  GeoJSON as its final step.

Neither format lives in `main` — `data/layers/` and `data/releases/` are gitignored.
`make publish-data` force-pushes the layers `assets/constants.ts` names to the orphan
`data-static` branch; the per-continent join inputs stay local. Where each asset class
is hosted, and the 100 MiB ceiling that shapes the archives, is
[hosting-plan.md](hosting-plan.md). The GitHub Pages deploy
(`.github/workflows/deploy.yml`) builds only the app bundle — it ships no data. The
live wildfire feed uses a separate orphan `data` branch (see `layers/wildfire-live.md`).

The per-layer docs in [`layers/`](layers/) record which format each layer uses and the
tippecanoe zoom range applied.
