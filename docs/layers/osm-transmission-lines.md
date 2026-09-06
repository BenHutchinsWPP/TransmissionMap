# OSM Transmission Lines

OSM transmission line and cable features, worldwide.

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | The eight continental extracts (`<region>-latest.osm.pbf`) from [Geofabrik](https://download.geofabrik.de/) |
| **Vintage** | Geofabrik daily extracts, as of the last pipeline run |
| **Coverage** | Worldwide (8 continental Geofabrik extracts) |
| **Served** | `data/layers/osm_transmission_lines_kv{0,50,100,125,200,300}.pmtiles` — six planet-wide PMTiles archives, zoom 2–11, one per voltage class. `make global-tiles` re-tiles the layer from the eight continental GeoPackages in one pass (deduping the seam overlaps) and cuts the classes out of the result. See [hosting-plan.md](../hosting-plan.md). |
| **Built by** | `extract_osm_lines.py` + `enrich_osm_tags.py` → `data/build/transmission_lines.gpkg` → `tippecanoe -l osm_transmission_lines` |

## Download pack

- **GeoJSON** (`osm-transmission-lines-<code>.zip`) — `.geojson` + `.csv`
- **SHP** (`osm-transmission-lines-<code>-shp.zip`) — `.shp/.shx/.dbf/.prj/.cpg` + `.csv`

Every zip also includes `osm-transmission-lines.txt` (this doc) + `disclaimer.txt`.

Built once per Geofabrik continent — `<code>` is one of `na eu as sa af oc ca an`, and the download menu in the layer panel picks it.

> ODbL requires attribution and share-alike on redistributed derivative databases.
> The GeoJSON in this pack is an ODbL derivative — downstream redistribution must also carry ODbL.

## Processing

- **Selected:** `power=line` and `power=cable` ways
- **Row filter:** none
- **Computed:** `nominal_kv` parsed to integer kV from raw OSM voltage text; `-1` sentinel = unknown; `is_undergrnd` flag derived from `power=cable` / `location` tags; `is_dc` from `frequency=0`
- **Columns kept:** `nominal_kv`, `operator`, `name`, `minz`
- **Simplification:** `--simplification=5 --simplify-only-low-zooms` — the
  Douglas-Peucker pass runs on z2–z10 only, so maxzoom carries every vertex the
  tile grid holds. Dropping the flag re-simplifies maxzoom; see
  [hosting-plan.md](../hosting-plan.md).

### Which lines a tile carries, by zoom

`enrich_osm_tags.py::_add_minzoom` writes `minz`, the lowest zoom at which a way
is worth drawing, and `tippecanoe -j` selects on it (the ladder string is
`TRANSMISSION_ZOOM_LADDER`, mirrored verbatim in `tile_manifest.yaml`).
Both rules come from [OpenInfraMap](https://github.com/openinframap/openinframap)
— `tegola/layers.yml` and `imposm/power.py` — and `minz` is the higher of the two:

| floor | rule |
|---|---|
| voltage | ≥200 kV from z2, ≥100 kV from z4, ≥25 kV from z6, everything else from z8 |
| length | the first zoom at which the way covers a quarter pixel (Web Mercator, so 1/cos(lat) of its ground length) |
| substation internals | `line=bay\|busbar\|substation\|internal\|transformer` never below z6 — a whole substation is sub-pixel until then, and these cluster where tiles are densest. `line=electrode` is excluded: an HVDC electrode line runs *between* substations. |

Selecting per feature is deterministic, so the same ways appear at the same zooms
on every rebuild, and a way held back by the length floor leaves a gap under one
pixel wide. `--drop-densest-as-needed` is not used: it discards whole ways, which
breaks corridors of many short consecutive ones.

> [!IMPORTANT]
> `--maximum-tile-bytes` is raised to 1 MB. tippecanoe thins any tile that
> reaches that ceiling even with no `--drop-*` flag, so it must sit clear of the
> densest tile (central Europe at z4, ~540 KiB) or the ladder stops being the
> only thing selecting features. At tippecanoe's 500 KB default that tile
> silently loses ways.

## Fields

Measured over the world build: **1,342,239 ways**, deduped from 1,366,072 across the
eight continental extracts (23,833 seam duplicates removed). Fill rates count the
`-1` sentinel as unknown, so re-derive them after a rebuild rather than trusting
these to the decimal.

| Field | % filled | Example values | Notes |
|---|---:|---|---|
| `osm_id` | 100% | `12345678` | OSM way ID; popup links to openstreetmap.org/way/{id} |
| `nominal_kv` | 82.1% | 110 (197,743), 220 (108,255), 138 (62,876), 132 (61,746), 69 (60,056), 115 (54,990), 230 (47,996), 66 (45,872), 35 (43,783), 400 (38,447), 500 (37,075) | Parsed integer kV. `-1` sentinel = unknown |
| `cables` | 60.4% | `3`, `6`, `12` | Number of individual conductors. `-1` = unknown — **not** a count |
| `circuits` | 31.7% | `1`, `2`, `4` | Number of circuits; not rendered in popup. `-1` = unknown |
| `operator` | 28.3% | RTE, Enedis, National Grid Electricity Distribution Plc, Tauron | Operating utility. Unset is an empty string, not NULL |
| `name` | 10.4% | "Straumsmo - Bardufoss", "Cottle-Melones", "Арматурная - Лёвинка" | Most OSM lines unnamed |
| `is_undergrnd` | 100% | `0`, `1` | `1` when `power=cable` or `location=underground\|underwater` (177,743 ways); drives dashed rendering + Line placement filter |
| `is_dc` | 100% | `0`, `1` | `1` for HVDC (2,558 ways). Drives the light centre stripe |
| `minz` | 100% | `2`–`8` | Zoom floor; read by the tippecanoe `-j` filter, not by the map. Stripped from the published archives after tiling (`tile-join -x minz`) |

## Caveats

- OSM line `name` is often the line's official identifier when present, but most lines
  outside the BPA / Hydro-Québec areas have no name. Use `operator` + `nominal_kv` for filtering.

### Voltage and HVDC tagging are messy — how we cope

- **DBF truncates at 254 chars.** OSM lines are written via `ogr2ogr → ESRI
  Shapefile`. Any tag not named in `osmconf.ini`'s `[lines] attributes=` is packed
  into one `other_tags` hstore string, and DBF caps string fields at **254 chars**,
  silently cutting whatever sorts last — on tag-heavy ways that takes `voltage`
  with it. So `voltage`, `cables`, `circuits`, `frequency`, `location` and `wires`
  are promoted to real columns. Never move `power`, `operator` or `ref` there — the
  `power_line` WHERE clause and the pipeline layers read them out of `other_tags`.
- **Voltage values are free text.** Seen in the wild: `500000`, `115000;12000`
  (one value per circuit), `14400-24900` (a range), `138000;?`,
  `115000;unknown`, `low`, `?`, `0_(unused)`. `_best_kv()` pulls every integer
  out and keeps the largest. The single highest value in the dataset is way
  5194902 "Experimental HVDC Powerline", tagged `voltage=1333000` → 1333 kV —
  an upstream OSM tag, not a parse error.
- **Sub-kV values are volts, not kV.** Ways carry `voltage=480 | 240 | 120 |
  690` (LV service drops). These floor to 0 kV and report as unknown, so no LV
  service drop reaches `nominal_kv` and paints as EHV transmission.
- **Some lines have no usable voltage**, mostly unnamed rural `power=line`.
  `_fill_kv_from_name()` backfills the ones whose
  name embeds a kV number ("… 500kV"); the rest stay `-1` and render in the
  unknown tier (`kv_range=unknown`). This is upstream data absence, not a
  parsing failure.
- **HVDC:** `frequency=0` is the canonical marker but is not universally tagged,
  so `_add_is_dc()` falls back to a narrow name match
  (`HVDC`/`DC Intertie`/`bipole`) **only when frequency is absent**; a stated
  non-zero frequency is authoritative AC. Mixed towers tagged `frequency=60;0`
  carry both and count as DC.
- **A name saying "HVDC" does not make a line DC.** Many ways match the HVDC name
  regex while declaring a non-zero AC frequency, and are correctly *not* flagged.
  Two traps this avoids:
  - `"230 kV + Electrode Line of HVDC Pacific DC Intertie"` — a 230 kV **AC**
    circuit that merely shares towers with the intertie's electrode line. (The
    standalone electrode lines — HVDC CU, Maritime Link, Nelson River Bipole 1/2
    — do carry `frequency=0` and are flagged DC.)
  - `"Finney to Lamar HVDC"` — 345 kV **AC**, `frequency=60`. Lamar is a
    back-to-back DC tie, so the lines reaching it are AC on both sides; only the
    converter itself is DC.
- **Why the DC count fell from ~280 (May 2026 build) to 206.** Not a regression —
  the truncation fix restored the `frequency` tag on tag-heavy ways, which
  previously lost it and so fell through to the name fallback. Those ways now
  report 60 Hz and classify as AC. 206 is the more accurate number. (Conversely,
  ways like Highgate carry neither a frequency tag nor an `HVDC` name, so neither
  rule reaches them — they stay AC/unknown. Under-detection here is upstream tag
  absence, not a parser limit.)
