# Adding a Dataset to the Pipeline

> *Read this when you have a new public data source and need a served file in
> `data/layers/` out of it. This is the data-engineering half only — finding
> the source, writing the extract script, building tiles. Wiring it onto the
> map (registry, popup, legend…) is the separate, longer half in
> [adding-a-layer.md](adding-a-layer.md). Expect a copy-an-existing-script job,
> not greenfield. Worked example: the **wildfire** layer
> (`build_wildfire_hazard.sh`) is a clean end-to-end raster; **datacenters**
> (`extract_osm_datacenters.py`) a clean point layer.*

How to take a **new public data source** and turn it into a served tile/GeoJSON
file in `data/layers/`. This is the data-engineering half; once the file
exists, [adding-a-layer.md](adding-a-layer.md) covers wiring it into the
frontend.

The whole path, at a glance:

```
public source                                          (you find it, step 0)
   │  download / manual place
   ▼
data/raw/<source>/        raw upstream files           (gitignored)
   │  scripts/extract_*.py  or  build_*.sh             (you write it, step 1)
   ▼
data/build/<id>.{csv,shp,geojson}    cleaned, selected columns
   │  make tiles  →  tile_manifest.yaml block          (manifest layers)
   │  make <target>  →  build_*.sh                     (rasters)
   ▼
data/layers/<id>.{geojson.gz,pmtiles}    served to the app   (gitignored; published via make publish-data)
   │
   ▼
frontend wiring  →  adding-a-layer.md
```

> This is a procedure, not architecture. For *how the pipeline fits together*
> (toolchain, why PMTiles vs gzipped GeoJSON, hosting) read
> [pipeline.md](pipeline.md) first — it's the map; this is the steps.

The pipeline is **reproducible end-to-end** but slow and needs big raw inputs.
You do not need to re-run the whole thing to add one dataset — you run only
your new script plus `make tiles`.

---

## 0. Before writing any code

1. **Find the source** and record it — URL, license, vintage, format. License
   first: if it can't be redistributed, the layer can still be live-loaded but
   ships **no download pack** (`skip: true` in `release_manifest.yaml`). See
   [data-sources.md](data-sources.md) for how existing sources are documented.
2. **Decide the served format** (drives everything downstream):

   | Your data | Format | Built by |
   |---|---|---|
   | ≤ ~20k points/polygons | gzipped GeoJSON | `tile_manifest.yaml` block |
   | > ~20k features, or dense lines/polygons | PMTiles (vector) | `tile_manifest.yaml` block |
   | continuous field (wind, irradiance, heat flow, pop) | PMTiles (raster) | standalone `build_*.sh` |

   GeoJSON and vector PMTiles both go through the manifest driver — same
   extract script shape. Rasters are a separate track (own `build_*.sh`, own
   `make` target, no manifest). If you're adding a raster, the color-ramp
   section of [adding-a-layer.md](adding-a-layer.md) (§3R) is also required.

3. **Decide the field schema now.** The extract step drops everything you don't
   `select`. Dropped fields can't be recovered without a full rebuild, so keep
   exactly what the popup + filters will use, and nothing else (smaller tiles).

---

## 1. Write the extract / build script — `scripts/`

Copy the closest existing script; don't start blank. The shared helpers do the
heavy lifting.

| Source type | Model script | Shared helpers |
|---|---|---|
| OSM PBF, points | `extract_osm_datacenters.py` | `osm_common.py`, `geo_common.py` |
| OSM PBF, lines/polygons w/ enrichment | `extract_osm_lines.py` | same |
| HIFLD / EIA Excel or Shapefile | `extract_hifld_lines.py`, `extract_eia_generators.py` | `geo_common.py` |
| download → GeoTIFF raster | `build_population_density.sh`, `build_wind_resource.sh` | `raster_common.sh` |
| point grid → raster | `build_seismic_hazard.sh` (dense), `build_geothermal_resource.sh` (IDW) | `raster_common.sh` |
| categorical raster | `build_wildfire_hazard.sh` | `raster_common.sh` |

**Conventions to match:**

- Extract scripts read from `data/raw/<source>/` and write
  `data/build/<id>.{csv,geojson,shp}`. Manifest-built layers stop at
  `data/build/`; the manifest driver produces the final `data/layers/` file.
- Put a header comment at the top stating the source, the raw input path, and
  the output — copy the format from a sibling script.
- Auto-download upstream files to `data/raw/<source>/` when you reasonably can
  (HIFLD/EIA refs do). Files too big or behind a manual download get a header
  note + a [release-artifacts.md](release-artifacts.md) entry instead.
- Raster `build_*.sh` scripts source `raster_common.sh` and only own their
  fetch/clip/grid steps — `rc_cog`, `rc_bake_tiles`, `rc_write_lut` own the
  shared tail. Don't re-implement the bake.

> **Never open files under `data/` directly** (tens of GB of binaries). Inspect
> schemas by running the script and printing `df.head()` / `ogrinfo`, not by
> opening the data files.

---

## 2. Wire it into the build

### Manifest-built layers (GeoJSON + vector PMTiles)

Two edits, no driver code:

1. **`Makefile`** — add an extract step to the `pipeline` target so a full
   rebuild runs your script:
   ```makefile
   @echo "=== N/N  My dataset ==="
   @$(PY) $(SCRIPTS)/extract_my_dataset.py
   ```
2. **`scripts/tile_manifest.yaml`** — add one block (anchor
   `>>> ADD-LAYER: tile-build-calls`). The driver builds blocks in order;
   order = z-order, so put slow/dense layers last. A missing source is skipped,
   not an error.
   ```yaml
     - id: my_dataset
       src: data/build/my_dataset.csv     # .csv = lon/lat points automatically
       format: geojson                     # or pmtiles
       select: [name, operator, capacity]  # omit to keep all columns
       precision: 6                        # geojson: COORDINATE_PRECISION
       # pmtiles only: min_zoom, max_zoom, simplification, flags: [...]
   ```

### Region tags — asset or context layer?

Decide first: is this an **asset** (generators, substations, lines, pipelines,
mines, datacenters, resource sites) or a **context layer** (a backdrop such as
protected areas, critical habitat, tribal lands, offshore leases, railroads)?

- **Asset → tag it** with the fields people scope that kind of asset by.
  Points and footprints get `states, counties, ba, nerc, retail`; lines get the
  same without `retail` (the owner field says whose line it is).
- **Context layer → leave it untagged.** A region filter on a backdrop only
  repeats what panning the map does, and its county and utility lists repeat on
  every tile fragment of a large polygon (critical habitat grew 57% when tagged).

To tag a US asset:

1. Add its `data/build/` intermediate to `REGION_TAG_FILES` in the `Makefile`
   (`region-tags` target). For a line dataset, add it to the `case` that passes
   `--fields states,counties,ba,nerc`. If the extract writes straight to
   `data/layers/`, call `region_join.tag_features(features, "usa", "<id>")`
   before it writes instead (see `extract_mines.py`).
2. Add the fields to the block's `select:` in `tile_manifest.yaml` — tippecanoe
   drops any column `select:` leaves out.

A world OSM layer is tagged in `build_global_tiles.py`: give its spec
`"fields": GLOBAL_FIELDS` (points, footprints) or `LINE_FIELDS` (lines). See
[pipeline.md § Region tags](pipeline.md#region-tags-scriptsregion_joinpy) for
the values, the join rules and what each log line reports.

### Raster layers

No manifest block. Add a **standalone `make` target** that runs your build
script straight to `data/layers/` (model: the `popden`, `seismic`, `wind`
targets):
```makefile
mydataset:
	@bash $(SCRIPTS)/build_my_dataset.sh
```
Plus the color ramp + `ramps.ts` stops — that's frontend territory, see
[adding-a-layer.md](adding-a-layer.md) §3R.

---

## 3. Run it

```bash
# raw inputs must be in place first (auto-downloaded or manually placed)
make pipeline      # full extract — or just run your one script:
python scripts/extract_my_dataset.py

make region-tags   # an asset: tag the intermediates (make pipeline ends with this)
python scripts/build_tiles.py --only my_dataset   # builds one manifest block → data/layers/
# raster: make mydataset   (your standalone target instead)
```

`build_tiles.py` only rebuilds from `data/build/`, so iterate on a single
dataset by re-running its extract script (then `make region-tags` for an asset)
and `build_tiles.py --only` — no need for the full OSM PBF pass each time. Once
`make global-tiles` has run, use `--only` rather than a bare `make tiles`: the
bare target also rebuilds the world `osm_*` layers from one region's
intermediates.

`make validate` checks the manifest output matches `assets/constants.ts` — run
it after wiring the frontend.

---

## 4. Hand off to the frontend

The file now exists in `data/layers/`. Everything after this — `DATA` URL,
registry entry, MapLibre builder, popup, search, legend, credits, layer doc —
is in **[adding-a-layer.md](adding-a-layer.md)**, starting at §4. Don't
duplicate that here.

---

## Checklist (data half only)

```
[ ] Source recorded: URL, license, vintage, format  (→ data-sources.md)
[ ] scripts/extract_or_build.*    — copy nearest sibling; header comment; → data/build/<id>.*
[ ] data/raw/<source>/            — auto-download, or document manual placement
[ ] .gitignore                    — ignore data/raw/<source>/  (NOT ignored by default; see >>> ADD-LAYER: gitignore. data/layers/ and data/releases/ are gitignored too)
[ ] Makefile                      — pipeline step (manifest) OR standalone target (raster)
[ ] scripts/tile_manifest.yaml    — one block  (manifest layers only)
[ ] region tags                   — asset: REGION_TAG_FILES (+ --fields for lines) and the fields in select:; context layer: none
[ ] run: extract script → make region-tags (asset) → build_tiles.py --only <id> → file appears in data/layers/
[ ] release_manifest.yaml         — one pack per layer (point→csv_only; line/polygon→geojson+shp; raster→tif), or skip:true if non-redistributable
[ ] make publish-data             — push data/layers + data/releases → data-static branch (prod host)
[ ] → continue in adding-a-layer.md for all frontend wiring
```
