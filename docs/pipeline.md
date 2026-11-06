# Build Pipeline — Regenerating the Data

The full pipeline is reproducible end-to-end. You only need it to rebuild the data
in `data/` against fresher upstream sources. For the per-layer processing detail
(filters, column drops, computed fields) see [`layers/`](layers/).

---

## Regenerate

```bash
# 1. System tools + Python venv (one-time)
#    tippecanoe ≥ 2.55.0 must be built from source — see https://github.com/felt/tippecanoe
#    (`make check` prints the version on PATH)
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

# 6. (deploying) Upload data/layers/, data/analysis/ and data/releases/ to the
#    R2 bucket behind data.wpptx.org, which prod fetches from — local dev reads
#    data/layers/ directly. Run `make data-manifest` first so
#    data/layers/manifest.json ships current.
make publish-r2
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

`data/layers/manifest.json` is picked up by `make publish-r2` automatically:
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

**The frontend side.** `src/registry/field-schema.ts` (`FIELD_SCHEMA`) lists each
dataset's region fields, and `scripts/test_field_schema.py` checks them both ways
against what the pipeline writes. `make region-domains`
(`scripts/build_region_domains.py`) rebuilds the two generated files the Area
filter reads, `src/registry/region-codes.ts` (the closed code lists) and
`src/registry/region-labels.json` (names for the picker); both are committed, so
the frontend build never needs `data/`. Run it after a boundary refresh.

**World `osm_*` layers carry region columns only from `make global-tiles`.** A
single-region `osm_*` build from `build_tiles.py` has none, so an Area filter
shows nothing for those layers in that dev build.

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
  --archive tmp/<build>/transmission.pmtiles=data/layers/osm_transmission_lines.pmtiles
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
  bytes, per-zoom tile p50/p95/max for PMTiles, and the size
  delta against the file at `PUBLISHED` (default: `PATH`) on the local
  `origin/data-static` ref — `git fetch` first for a current comparison.
  `PATH` is split at the last `=` unless the whole argument is an existing file.

The script exits 2 — before printing any table — when a path is missing or a `.gpkg` is not a GeoPackage.

---

### Stable ids

An asset layer's features carry a **stable id**: the same value for the same
real-world feature across rebuilds, so the app can address a feature (feature-state,
links, id-based calls) and a later analysis copy can join to it. It is the
publisher's key, never a row number or an `OBJECTID`. Each layer's column is
declared once as `id_field` in `scripts/tile_manifest.yaml` (plus `native_id: true`
for an integer id served as the vector-tile feature id), and the frontend registry
declares the same column (`LayerData.id`); `assets/feature-id.test.ts` holds the two
together.

| Dataset | Id field | Form | Mechanism |
|---|---|---|---|
| OSM substations, generators, plants, pipelines, transmission lines | `fid` | integer, `osm_id * 10 + t` (t = 1 node, 2 way, 3 relation) | native tile id on the large vector archives (`native_id`); `promoteId` on the GeoJSON ones (plants points, pipelines points) |
| OSM data centers | `fid` | same integer | `promoteId` (GeoJSON) |
| EIA generators | `fid` | `"<plant_code>:<generator_id>"` | `promoteId` |
| HIFLD substations | `hifld_id` | the publisher `ID` | `promoteId` |
| HIFLD transmission lines | `ID` | publisher ID | `promoteId` |
| HIFLD natgas points | `fid` | `"<fac_type>:<publisher key>"` | `promoteId` |
| HIFLD natgas lines | `fid` | `"ng:<FID>"` / `"hgl:<FID>"`, one feature per record | `promoteId` |
| OGF planned transmission | `RecordID` | `R-0329` | `promoteId` |
| WestTEC 10 Yr | `fid` | 12-hex content id (sha1 of attributes + part endpoints on a 0.01° grid; `scripts/westtec_ogf.py`) — the publisher has no key, so a content edit yields a new id | `promoteId` |
| Mines / NREL hydrothermal | `mine_id` / `UID` | MSHA mine ID / publisher UID | `promoteId` (`built_elsewhere` in the manifest) |
| Retail territories, NERC regions | `id` / `sub_nm` | HIFLD ID / region name | `promoteId` |
| HIFLD control areas (balancing authorities) | `id` | HIFLD `ID` (the EIA utility number), one polygon each | `promoteId` |
| PAD-US | `fid` | integer content id: 13 hex digits of a sha1 over the source attributes, source-CRS bounds (1 m grid) and vertex count (`scripts/extract_padus.py`) — no key is set on every record, so an edited record yields a new id | native tile id (`native_id`) |
| Critical habitat | `entity_id` | FWS ECOS listing-entity id, one polygon each | `promoteId` |
| Data center moratoriums | `fid` | the jurisdiction: `state:TX`, `county:48201`, `utility:<EIA-861 no.>`, `ba:ERCO`, `place:<state>:<place GEOID>`, `point:<state>:<hash>` (`scripts/moratoriums/build_layer.py`) | `promoteId` (`built_elsewhere`; served from the `data-moratoriums` branch, so `make stable-ids ARGS="--only dc_moratoriums --layers-dir <checkout>"`) |
| Railroads (BTS NARN) | `FRAARCID` | the publisher's FRA arc id, one line each, unique | native tile id (`native_id`) |
| BIA tribal lands (AIAN-LAR) | `LARID` | the publisher key (`LAR0001`), one polygon each; the extract stops on a null or duplicate | `promoteId` |
| BOEM offshore wind leases | `fid` | 12-hex content id (sha1 of lease number, type, date, bounds on a 1e-6° grid and vertex count; `scripts/extract_boem_wind.py`); an identical duplicate takes `-<n>` — easements repeat the lease number | `promoteId` |
| US counties | `GEOID` | the 5-digit county code, one polygon each | `promoteId` (the shared county source) |
| WECC paths | `id` | string: `"66"` for a catalog marker, `"66c"` for its corridor line; hand-maintained, never read as a number (`built_elsewhere`) | `promoteId` |
| US states, ZCTA, tribal lands, EIA BAs, countries, admin-1 | `stusps`, `zcta5`, `geoid`, `abbrev`, `iso_a3`, `code` | the region-tag code | `promoteId` |

**Where ids are built.** In the extract scripts, so the `data/build/` intermediates
(continental OSM CSV/GeoPackages and the US CSVs) and the merged world inputs already
carry the id column. Later copies of the data, such as the line geometry files
(§ *Line geometry*), read it from there instead of recomputing. `osm_common.osm_fid()` builds the OSM id
and keeps `osm_type` beside it; the last digit makes the type readable
(`4535892832` is way `453589283`), and `src/registry/osm-fid.ts` `osmRef()` decodes it
for popup links.

**World merge.** `build_global_tiles.py` dedupes the seam copies of each OSM layer on
`fid`; the first continent in `REGION_CODES` keeps its copy. Transmission is tiled once
with ids assigned beforehand; `tile-join` carries the ids through to
`osm_transmission_lines.pmtiles`.
The merge applies the same `output_mw` caps as the parser (`osm_common.py`), so world layers are capped whatever the age of the continental intermediates.

**Footguns.**
- A GeoPackage reserves `fid` for its own primary key. Write intermediates that carry
  a `fid` column with `layer_options=GPKG_FID_OPTIONS` (`{"FID": "ogc_fid"}`) so `fid`
  stays an ordinary column. `geo_common.write_shp_csv` does this whenever the
  frame has a `fid` column.
- `tippecanoe --use-attribute-for-id=fid` needs the attribute typed as a number:
  pass `-T fid:int`. A string `fid` is skipped silently and the archive ships with no
  ids. `region_join.tag_file` must keep `fid` numeric for the same reason.
- `native_id` consumes the attribute, so the tiles carry no `fid` property; read it
  through `featureId(layerId, feature)`, not `properties.fid`.

**Checking.** `make stable-ids` (`scripts/stable_ids.py`; `ARGS="--only <id>
--max-tiles N"`) decodes each served archive at its max zoom and exits non-zero on any
missing id or true duplicate. A duplicate is the same id twice within one tile, or
shared between the archives of a split layer (the transmission bands). A line cut
across tiles repeats its id in several tiles and counts once. Run it after every tile
or extract rebuild.

**Attributes.** `make stable-ids ARGS="--attrs"` holds what the tiles say about each
feature to the row it was built from. It decodes every pmtiles archive at every zoom,
keeps a uniform sample of 500 tiles per zoom (`--max-tiles N`, `--all-tiles`,
`--zooms 9,10,11`), and looks each sampled feature up by its stable id in the build
input, read as the build reads it: the manifest `src` through ogr2ogr with its
`select`/`where`, or for a world layer the continental intermediates in
`build_global_tiles.py`'s dedupe order (transmission: the kept merged input). Every
tile attribute must equal the row's value, compared by value (`345.0` = `345`); an id
no input row has, or an attribute the row lacks, is a mismatch too. The region fields
a world build adds after the merge are not compared, and an input field the tiles
leave out (a null, `minz`) is not counted. It exits non-zero on any mismatch; memory
grows with the sample, not the input. `--only <id>` checks one layer; a layer with no
`id_field` is not checked.

The tile builds need tippecanoe ≥ 2.55.0, the release from which every feature keeps
its own attribute strings at every zoom; `make check` prints the version on PATH, and
`build_tiles.py`, `build_global_tiles.py` and `process_continental_osm.py` refuse an
older one (`scripts/toolchain.py`). Every build calls `tippecanoe` by name, so the copy
first on PATH is the one that runs.

### Line geometry (`make line-parquet`)

The copy, fault-locator and elevation-profile tools need each transmission line's
full geometry and exact length, which the tiles cannot give: a tile carries a line cut
into pieces and snapped to its grid. `scripts/build_line_parquet.py` writes them as
GeoParquet into `data/analysis/`, one directory per dataset. `make publish-r2`
uploads them to `data.wpptx.org`.

| dataset | input |
|---|---|
| `osm_transmission_lines` | `data/build/world/transmission_world.geojsonl.gz` — the merged, deduped, untagged world input `build_global_tiles.py` keeps (`keep_merged`) |
| `hifld_transmission_lines` | `data/build/transmission_hifld.gpkg`, through the tile build's own `ogr2ogr -lco COORDINATE_PRECISION=6` |
| `osm_substations_polygons` | the world OSM substation polygons, from the same kept merge (`geometry: polygon`) |
| `osm_plants_polygons` | the world OSM plant polygons, from the same kept merge (`geometry: polygon`) |
| `osm_pipelines_lines` | the world OSM pipelines, from the same kept merge (`geometry: line`, IDX and GEO, no CHAINS) |
| `hifld_natgas_lines` | `data/build/hifld_natgas_lines.gpkg`; the ids and 1e-6° coordinates are the tile build's (`ogr2ogr`, precision 6); string fids (`ng:<FID>`, `hgl:<FID>`), no CHAINS |
| `retail_territories` | `data/build/retail_territories.gpkg`, read as stored (source precision, not the tiles' precision 5); string fids (`id`) (`geometry: polygon`) |
| `eia_ba` | `data/build/eia_ba.gpkg`, read as stored; string fids (`abbrev`) (`geometry: polygon`) |
| `nerc_regions` | `data/build/nerc_regions.gpkg`, read as stored; string fids (`sub_nm`) (`geometry: polygon`) |
| `control_areas` | `data/build/control_areas.gpkg`, read as stored; string fids (`id`) (`geometry: polygon`) |
| `crithab` | `data/build/crithab.gpkg`, read as stored; integer fids (`entity_id`) (`geometry: polygon`) |
| `padus` | `data/build/padus.gpkg`, read as stored; integer fids (the content id column `fid`) (`geometry: polygon`) |
| `railroads` | `data/raw/railroads/narn_rail_lines.geojson`, read as stored; integer fids (`FRAARCID`), IDX with `length_km` and GEO, no CHAINS (`geometry: line`) |
| `bia_tribal_lands` | `data/build/bia_tribal_lands.geojson`, read as stored; string fids (`LARID`) (`geometry: polygon`) |
| `boem_wind_leases` | `data/build/boem_wind_leases.geojson`, read as stored; string fids (content id `fid`) (`geometry: polygon`) |
| `us_states` | `data/build/us_states.gpkg`, read as stored; string fids (`stusps`) (`geometry: polygon`) |
| `countries` | `data/build/countries.gpkg`, read as stored; string fids (`iso_a3`) (`geometry: polygon`) |
| `admin1_boundaries` | `data/build/admin1_boundaries.gpkg`, read as stored; string fids (`code`) (`geometry: polygon`) |
| `tribal_lands` | `data/build/tribal_lands.gpkg`, read as stored; string fids (`geoid`) (`geometry: polygon`) |
| `us_zcta` | `data/build/us_zcta.gpkg`, read as stored; string fids (`zcta5`) (`geometry: polygon`) |
| `county_boundaries` | `data/build/county_boundaries.geojson`, read as stored; string fids (`GEOID`) (`geometry: polygon`) |

Reading the kept merge, not the continental GeoPackages, is what makes the ids and the
1e-6° coordinates exactly the ones the tiles were built from. So run
`make global-tiles LAYER=osm_transmission_lines` before `make line-parquet` whenever the
continental inputs change; the builder warns when one is newer than the kept file.

Files per dataset (`<ds>/`; the layout rules live in `scripts/geoparquet_common.py`):

| file | sort | columns |
|---|---|---|
| `<ds>.idx.<sha8>.parquet` | `fid` | `fid`, `row` (the line's global row in GEO), `length_km` (sphere, R = 6371.0088 km, haversine per part); OSM also `chain` (−1 none) and `circuits` (−1 unknown) |
| `<ds>.geo.p<N>.<sha8>.parquet` | Hilbert on the centroid | `fid`, `bbox` (float32, rounded outward; the GeoParquet 1.1 bbox covering), `geometry` (WKB) |
| `<ds>.chains.<sha8>.parquet` (OSM) | `chain`, `seq` | `chain`, `seq`, `fid`, `row`, `rev`, `length_km`, `start_sub`, `end_sub` |
| `_manifest.json` | | per file: bytes, sha256, footer length, rows (GEO: part and row offset); `build_id`, snapshot date, provenance from `data_manifest.yaml` |

A polygon dataset has IDX and GEO only (no CHAINS, no length). Its `index.json` entry
carries `geometry: "polygon"`; an entry without it is `"line"`.

`data/analysis/index.json` holds every dataset's manifest, so a reader learns each
file's length and footer length without a `HEAD`. Every file carries the run's
`build_id` in its key-value metadata; a file is named by its content hash, so each
build writes new names and removes the old files.

- **Layout.** IDX and CHAINS: 4k-row groups, statistics on the sort key only. GEO:
  groups of up to 64k rows, closed before 16 MiB of WKB (a larger row is its own
  group); pages of up to 256 rows and about 1 MiB; page index on, statistics on `fid` and `bbox`. ZSTD 9. GEO is cut on row-group boundaries
  into parts of about 64 MiB (95 MiB is a hard stop). No dictionary on `fid`, `row`,
  measures, `bbox` or `geometry`: `write_parquet` asserts it.
- **HIFLD `fid`** is the publisher `ID` as a string, the type the tiles carry.
- **Chains (OSM).** Ways joined end to end where exactly two way ends meet on the same
  1e-6° coordinate, both ways carry the same `nominal_kv` and no substation is there.
  A substation is an OSM substation polygon containing the node, else a substation
  point within 150 m. `start_sub`/`end_sub` name the substation at a way's start/end
  in chain order (null mid-chain), so a chain's ends are the first row's `start_sub`
  and the last row's `end_sub`. CHAINS holds multi-way chains and single ways that end
  at a substation; every other way has `chain = −1`. Ways that meet at an interior
  vertex (a tee onto the middle of another way) are not joined.

Run `make line-parquet` (`ARGS="--only <ds>"`; memory-capped at 14 GB; log in
`tmp/logs/line-parquet.log`), then check:

- `make stable-ids ARGS="--lines"` — every id the served archives carry at max zoom
  is in IDX (0 missing), IDX has no duplicate, IDX `row` and CHAINS `row` point at
  their fid's GEO row on a 1,000-row sample, and 1,000 sampled tile pieces lie on their GEO line: vertices more than one
  grid unit inside the tile within 0.8 grid units, vertices on its edge or in its buffer within 2.5. IDX ids no max-zoom tile carries are counted, not
  failed: tippecanoe drops ways shorter than about one grid unit. A layer served as GeoJSON (simplified at build) is also held to its geometry-file polygon by area (symmetric difference at most 5 % of the polygon's area): `eia_ba`, `nerc_regions`, `tribal_lands`, `bia_tribal_lands` and `boem_wind_leases` at 5 %, `control_areas` at 10 %; `us_states`, `countries` and `admin1_boundaries` are checked for ids only, their area difference reported but not judged. Tiled polygon layers have a placement ceiling in grid units: `retail_territories` 400, `us_zcta` 2,500, `county_boundaries` 3,100. `railroads` is held to the line rule above. The builder and `make geometry-check` refuse a GeoPackage or GeoJSON input that is not EPSG:4326 or has Z coordinates.
- `make geometry-check` (`ARGS="--only <ds>"` or `"--mutate"`; log in `tmp/logs/geometry-check.log`)
  — `scripts/check_geometry_parquet.py`, which shares no code with the builder. Against the
  kept input: every input fid is in IDX once and no other, each IDX `row` holds its fid's GEO
  row, each GEO geometry equals its input geometry exactly, and each `bbox` covers it.
  Against the served archive (`stable_ids.py --lines`): a polygon tile piece and its GEO
  polygon, both clipped to the tile and each opened by one z12 grid unit, have their vertices
  within 2.5 grid units of the other's area (pieces both of whose opened sides are empty are
  counted, not compared); lines as above. `--mutate` plants errors in scratch copies and passes only when both checks catch them.
- `make validate` — each manifest matches its files (bytes, sha256, footer length,
  `build_id`, ≤ 95 MiB, no orphans).

### Columns files (`make columns-parquet`)

The table, `count`/`aggregate`/`query` and the templates answer for a whole tiled dataset,
not just the loaded tiles, from one Parquet file of every feature's attributes.
`scripts/build_columns_parquet.py` writes one per dataset into `data/analysis/columns/`
(`<ds>.<sha8>.parquet`); `data/analysis/index.json` has a `columns` section naming each
file, its bytes and footer length, and the `archive_sha256` of the archive it describes.
`make publish-r2` uploads them with the line files.
The datasets are listed in `src/registry/columns.ts` (`COLUMNS_DATASETS`).

- **Input.** The rows tippecanoe read, not the tiles (`scripts/tile_inputs.py`): a world
  layer reads its kept, region-tagged merged file in `data/build/world/`, a US layer the
  manifest `src`. Ids and region tags are therefore the tiles' own.
- **Columns.** The stable id (a native id as int64 `fid`), every attribute in the archive's
  `vector_layers` fields, `length_km` (lines) or `area_km2` (polygons) on the sphere
  (R = 6371.0088 km), and `px`/`py`: the point, a line's midpoint along it, a polygon's
  point on surface. `px`/`py` are stored as int32 micro-degrees (round(x·1e6)); the reader
  divides by 1e6.
- **Layout.** Hilbert order on `px`/`py`, 64k-row groups, no page index, ZSTD 9. The footer
  carries `build_id`, the dataset, geometry, id field and, per row group, the region codes
  present, so a call with an Area or region condition reads only the groups that can match.
- **Rows without geometry** are left out and counted in the log, as the tiles leave them
  out. Rows the tiles drop for drawing stay in the file, so the dataset scope counts them.
- **In the file, not in the max-zoom tiles:** each dataset's share is in `index.json` as `columns.<ds>.tiles_missing`.
- **Read budgets** (cold cache, MB = 10^6 bytes):

  | call | budget |
  |---|---|
  | world aggregate, OSM transmission by `nominal_kv` + sum `length_km` | ≤ 8 MB, ≤ 96 requests |
  | the same with Area TX | ≤ 1.5 MB |
  | table open, world, as drawn, unsorted | ≤ 4 MB |
  | table open, `af=s.TX` | ≤ 2 MB |
  | each footer | ≤ 256 KiB |

  Above 2 MiB of planned bytes the table asks first; a call planning more than 32 MiB
  (`COLUMNS_MAX_BYTES`) reads the view instead.
- **Reading.** `assets/columns/columns-read.ts` over `assets/parquet/range-io.ts`, loaded only
  by dynamic import from `dataset-query.ts`. A call with `scope: 'view'`, `fragments`, `ids`
  or `geometry: 'full'`, or whose file is missing, stale or timed out, reads the loaded
  tiles (`complete: false`).
- **Publishing.** An archive and its columns file publish together: an entry whose
  `archive_sha256` differs from the archive being uploaded is refused.

Run `make columns-parquet` (`ARGS="--only <ds>"`; memory-capped at 14 GB; log in
`tmp/logs/columns-parquet.log`), after the tiles it describes, then check:

- `make columns-check` (`tmp/logs/columns-check.log`) — decodes each archive at its max
  zoom with `tippecanoe-decode` and holds the file to it: every id a tile carries is in the
  file, and every tile attribute equals the file's value (numbers to 12 significant
  digits); the transmission sets' `length_km` also equals the line files' IDX. File-only ids
  are counted, not failed. A point dataset's `px`/`py` equal its build input's coordinate
  exactly, and a tile point lies within one max-zoom tile unit of them. It imports neither the
  builder nor `tile_inputs.py`.
  `ARGS="--emit-reference DIR"` writes totals over the whole file with region lists split in
  Python (the reference the data test reads); `ARGS="--only <ds> --mutate"` plants a change
  to one region code and one value in a scratch copy and passes only when the check catches both.
- `TM_COLUMNS_DATA=1 npx vitest run assets/columns/columns-data.test.ts` — the built files,
  served by range from disk, answer the dataset-scope calls with the reference totals and
  within the budgets above (skipped without the env var). `TM_COLUMNS_MUTATE=1` drops a row
  group and the run must fail.
- `make validate` — each manifest entry matches its file, and each `archive_sha256` the archive in `data/layers/`.

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
  HTTP range requests and tippecanoe's simplification shrinks detailed geometry.
- **Gzipped GeoJSON** (`.geojson.gz`) — for *many-small* geometries (plant
  points, EIA generators, pipeline points). Files are shipped **pre-gzipped**;
  the app fetches the `.gz` and decompresses in-browser via `DecompressionStream`
  (`fetchGeojson` in `assets/layers/layer-data.ts`). `build_tiles.py` gzips all served
  GeoJSON as its final step.

Neither format lives in `main` — `data/layers/` and `data/releases/` are gitignored.
`make publish-r2` uploads the layers `assets/constants.ts` names to the `data-wpptx-org`
bucket (`data.wpptx.org`); the per-continent join inputs stay local. Where each asset class
is hosted is
[hosting-plan.md](hosting-plan.md). The GitHub Pages deploy
(`.github/workflows/deploy.yml`) builds only the app bundle — it ships no data. The
live feeds are served from `live.wpptx.org` (see `layers/wildfire-live.md`).

The per-layer docs in [`layers/`](layers/) record which format each layer uses and the
tippecanoe zoom range applied.
