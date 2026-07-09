# Build Pipeline — Regenerating the Data

The full pipeline is reproducible end-to-end. You only need this if you want fresher
data than the May 2026 build shipped in `data/`. For the per-layer processing detail
(filters, column drops, computed fields) see [`layers/`](layers/).

---

## Regenerate

```bash
# 1. System tools + Python venv (one-time)
#    tippecanoe must be built from source — see https://github.com/felt/tippecanoe
make install

# 2. Place the North America PBF in data/raw/osm/
#    Download from https://download.geofabrik.de/north-america.html
cp ~/Downloads/north-america-latest.osm.pbf data/raw/osm/

# 3. Extract OSM/HIFLD/EIA layers → data/build/
make pipeline

# 4. Build PMTiles and GeoJSON for the app → data/layers/
make tiles

# 5. (deploying) Push data/layers/ + data/releases/ to the orphan 'data-static'
#    branch that prod fetches from — local dev reads data/layers/ directly
make publish-data

# 6. Bump DATA_VERSION in sw.js (commit to main) — the service worker caches
#    PMTiles byte ranges cache-first; ranges cached from the old file corrupt
#    reads against a rebuilt one
```

HIFLD and EIA reference data are auto-downloaded on first run to `data/raw/hifld/` and
`data/raw/eia/`. Some HIFLD inputs (SeerAI parquet for transmission lines, natural-gas,
and region layers) are **manually placed** — see the script headers and
[release-artifacts.md](release-artifacts.md) for the exact files and origins.

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

## OSM extraction toolchain

Run via `make pipeline`:

1. **Download** — Geofabrik publishes daily `.osm.pbf` extracts; this build uses
   `north-america-latest.osm.pbf` (~18 GB).
2. **Filter** — `osmium tags-filter` + `osmium extract` reduce the full continental PBF
   to a small subset, selecting only relevant tags and clipping to the target bounding
   box. This runs **once**, in `extract_osm_lines.py`: the filter is the union of every
   OSM extract script's tags (`SHARED_FILTER_TAGS` in `osm_common.py`), and the
   intermediate (`data/build/*_filtered.osm.pbf` + a `.filters` sidecar recording the
   tag set) is reused by the substation/generator/plant/datacenter scripts via
   `find_pbf(need_tags=…)` — they fall back to the full 18 GB pbf only when the
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
  pipeline lines, OSM generators, PAD-US, tribal lands, regions). Tiles load lazily via
  HTTP range requests and tippecanoe's simplification shrinks detailed geometry
  dramatically (e.g. PAD-US 806 MB SHP → 62 MB tiles).
- **Gzipped GeoJSON** (`.geojson.gz`) — for *many-small* geometries (substation / plant
  points & polygons, EIA generators, pipeline points). These tile *poorly* (tens of
  thousands of tiny polygons replicate across zoom levels and *grow* as PMTiles), but
  gzip crushes GeoJSON's repetitive structure ~8×. Files are shipped **pre-gzipped**;
  the app fetches the `.gz` and decompresses in-browser via `DecompressionStream`
  (`fetchGeojson` in `assets/layers/layer-init.ts`). `build_tiles.py` gzips all served
  GeoJSON as its final step.

Neither format lives in `main` — `data/layers/` and `data/releases/` are gitignored.
`make publish-data` (`scripts/publish_data.sh`) force-pushes them as a single orphan
commit to the **`data-static`** branch, and prod fetches from
`raw.githubusercontent.com/.../data-static/` (CORS-enabled; see the `DATA_ORIGIN` logic
in `assets/constants.ts`). The GitHub Pages deploy (`.github/workflows/deploy.yml`)
builds only the app bundle — it ships no data. The live wildfire feed uses a separate
orphan `data` branch on the same pattern (see `layers/wildfire-live.md`).

The per-layer docs in [`layers/`](layers/) record which format each layer uses and the
tippecanoe zoom range applied.
