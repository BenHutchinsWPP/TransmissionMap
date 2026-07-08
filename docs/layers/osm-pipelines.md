# OSM Pipelines

OSM pipeline route segments and facility points (global, North America focus).
For the US-federal natural-gas / petroleum dataset see [HIFLD natural gas](hifld-natgas.md).

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | `north-america-latest.osm.pbf` from [Geofabrik](https://download.geofabrik.de/) |
| **Vintage** | May 2026 |
| **Coverage** | USA + Canada + Mexico |
| **Served** | `data/layers/osm_pipelines_lines.pmtiles` (routes, PMTiles z5–12) · `data/layers/osm_pipelines_points.geojson.gz` (points) |
| **Built by** | `extract_osm_lines.py` + `enrich_osm_tags.py` → `data/build/pipeline_routes.gpkg` + `data/build/pipeline_points.csv` → `tippecanoe -l osm_pipelines_lines` |

## Download pack

Two separate packs (one per map layer):

- **Lines** — `osm-pipelines-lines.zip` (GeoJSON) / `osm-pipelines-lines-shp.zip` (SHP): geometry + `osm-pipelines-lines.csv`
- **Points** (`osm-pipelines-points.zip`) — CSV only: `osm-pipelines-points.csv`

Every zip also includes `osm-pipelines.txt` (this doc) + `disclaimer.txt`.

> ODbL requires attribution and share-alike on redistributed derivative databases.

## Processing

- **Routes:** `man_made=pipeline` line features → **~100,700**
- **Points:** `pipeline=*` point features (valves, pig launchers, meter stations) → **~14,300**
- **Row filter:** non-fuel routes dropped (`scripts/enrich_osm_tags.py`, `_FUEL_SUBSTANCES` allowlist) — only pipelines carrying a generator fuel (natural gas, oil/crude, refined products & NGL, hydrogen, coal) or untagged are kept. Water, sewage, industrial gases, petrochemical feedstock, etc. removed (~13,300 rows).
- **Columns kept (routes):** `osm_id`, `name`, `substance`, `operator`, `pipeline`, `op_wikidat`
- **Map styling:** routes colored by `substance`, bucketed to generator-fuel type

## Fields — routes

| Field | % filled | Example values | Notes |
|---|---:|---|---|
| `osm_id` | 100% | `4766946` | |
| `name` | ~50% | "Laurel Pipeline", "Gas Transmission Northwest Main Line #1" | |
| `substance` | ~72% | gas (56k), oil (11k), fuel (1.9k), ngl, lpg, hydrogen, coal | Drives the **fuel filter** (Fuel Delivery group): chips for Natural gas / Oil / Products-NGL / Hydrogen / Coal / Unknown. Non-fuel values are stripped upstream. |
| `operator` | ~64% | "Buckeye Partners", "Williams", "Gas Transmission Northwest LLC" | |
| `pipeline` | <1% | — | The `pipeline=*` tag is almost never on the line itself; it lives on the point features |
| `op_wikidat` | ~5% | — | Wikidata QIDs |

## Fields — points

| Field | % filled | Example values | Notes |
|---|---:|---|---|
| `osm_id` | 100% | `12788104552` | |
| `pipeline` | 100% | valve (11.5k), pig_launcher (2.3k), substation (244), delivery (104), interconnect, milepost, vent, surge_tank, end | Feature sub-type |
| `operator` | ~39% | "Shell Pipeline Company, L.P.", "LOOP LLC", "Atmos Energy" | |

## Caveats

- `substation` in the points `pipeline` field means a *pipeline pressure substation*, not electrical.
