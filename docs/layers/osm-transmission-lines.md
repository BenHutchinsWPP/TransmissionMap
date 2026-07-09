# OSM Transmission Lines

OSM transmission line and cable features (North America).

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | `north-america-latest.osm.pbf` from [Geofabrik](https://download.geofabrik.de/) (~18 GB) |
| **Vintage** | May 2026 (Geofabrik daily extract) |
| **Coverage** | USA + Canada + Mexico |
| **Served** | `data/layers/osm_transmission_lines.pmtiles` — PMTiles, zoom 2–11 |
| **Built by** | `extract_osm_lines.py` + `enrich_osm_tags.py` → `data/build/transmission_lines.gpkg` → `tippecanoe -l osm_transmission_lines` |

## Download pack

`osm-transmission-lines.zip` — `osm-transmission-lines.geojson` · `osm-transmission-lines.csv` · `osm-transmission-lines.md` · `disclaimer.txt`

> ODbL requires attribution and share-alike on redistributed derivative databases.
> The GeoJSON in this pack is an ODbL derivative — downstream redistribution must also carry ODbL.

## Processing

- **Selected:** `power=line` and `power=cable` ways → **~327,000 features**
- **Row filter:** none
- **Computed:** `nominal_kv` parsed to integer kV from raw OSM voltage text; `-1` sentinel = unknown; `is_undergrnd` flag derived from `power=cable` / `location` tags
- **Columns kept:** `nominal_kv`, `operator`, `name`
- **Simplification:** tippecanoe per-zoom default (z2–11)

## Fields

| Field | % filled | Example values | Notes |
|---|---:|---|---|
| `osm_id` | 100% | `12345678` | OSM way ID; popup links to openstreetmap.org/way/{id} |
| `nominal_kv` | ~86% | 138 (54k), 69 (51k), 115 (48k), 230 (37k), 345 (18k), 500 (5.8k), 765 | Parsed integer kV. `-1` sentinel = unknown |
| `cables` | ~40% | `3`, `6`, `12` | Number of individual conductors |
| `circuits` | ~55% | `1`, `2`, `4` | Number of circuits; not rendered in popup |
| `operator` | ~35% | BC Hydro, Bonneville Power Administration, Hydro One | Operating utility |
| `name` | ~11% | "Big Eddy–DeMoss No 1", "Bonneville PH 1–Hood River No 1" | Most OSM lines unnamed |
| `is_undergrnd` | 100% | `0`, `1` | `1` when `power=cable` or `location=underground\|underwater`; drives dashed rendering + Line placement filter |

## Caveats

- OSM line `name` is often the line's official identifier when present, but most lines
  outside the BPA / Hydro-Québec areas have no name. Use `operator` + `nominal_kv` for filtering.
