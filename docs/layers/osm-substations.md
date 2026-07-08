# OSM Substations

OSM substation points and polygon footprints (North America).

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | `north-america-latest.osm.pbf` from [Geofabrik](https://download.geofabrik.de/) |
| **Vintage** | May 2026 |
| **Coverage** | USA + Canada + Mexico |
| **Served** | `data/layers/osm_substations_points.geojson.gz` (points) · `data/layers/osm_substations_polygons.geojson.gz` (polygons) |
| **Built by** | `extract_osm_substations.py` → `data/build/substation_osm.csv` + `data/build/substation_polygons.gpkg` |

Both layers served as **gzipped GeoJSON**, not PMTiles — tens of thousands of tiny polygons tile poorly and *grow* as PMTiles. See [hosting & compression](../pipeline.md#hosting--compression).

## Download pack

Two separate packs (one per map layer):

- **Points** (`osm-substations-points.zip`) — CSV only: `osm-substations-points.csv`
- **Polygons** — `osm-substations-polygons.zip` (GeoJSON) / `osm-substations-polygons-shp.zip` (SHP): geometry + `osm-substations-polygons.csv`

Every zip also includes `osm-substations.txt` (this doc) + `disclaimer.txt`.

> ODbL requires attribution and share-alike on redistributed derivative databases.

## Processing

- **Selected:** all `power=substation` features → **~82,000** points (~1,500 node + ~80,600
  polygon-centroid + relation centroids). Polygon layer = the **~80,600** closed-way footprints.
- **Row filter:** none at extract time (see caveats for display-time filtering)
- **Computed:** `nominal_kv` parsed numeric from `voltage_raw`; `sub_type` carried through from OSM tags
- **Columns:** polygon layer drops `voltage_raw` / `ref` / `op_wikidata` vs. the point layer
- **Display:** polygons only useful at z≥9 (visible footprints) so the map keeps that layer off by default

## Fields — points

| Field | % filled | Example values | Notes |
|---|---:|---|---|
| `osm_id` | 100% | `624714430`, `1082725968` | OSM element ID |
| `name` | ~42% | "Marland Substation", "Kinnickinnic (New) Substation" | Half blank — common for distribution sites |
| `operator` | ~41% | "Bonneville Power Administration", "Amtrak", "Minnkota Power Cooperative" | |
| `op_wikidata` | ~28% | `Q109923505` | Wikidata QIDs for joins, not display |
| `nominal_kv` | ~74% | 69.0 (15k), 115.0 (13k), 138.0 (9.7k), 230.0 (5.0k), 345.0 (1.9k), 500.0 | Parsed numeric kV |
| `voltage_raw` | ~74% | "100;69", "33", "41;2" | Raw OSM text — multi-voltages semicolon-delimited |
| `sub_type` | ~61% | `distribution` (25k), `transmission` (8.6k), `industrial` (6.3k), `minor_distribution` (4.1k), `generation` (2.2k), `switching` (1.3k), `traction` | ~1,260 rows have junk (`yes`, place names) — filter these |
| `ref` | ~4% | "759129", "7X", "PP2" | Nearly empty |

## Fields — polygons

Same field set minus `voltage_raw` / `ref` / `op_wikidata`.

| Field | % filled | Example values |
|---|---:|---|
| `osm_id` | 100% | `4630372` |
| `name` | ~41% | "Ames Substation", "Lennox Transmission Station" |
| `nominal_kv` | ~75% | 115, 500, 230, 69, 138, 345 |
| `operator` | ~41% | "Pacific Gas and Electric Company", "Alabama Power", "Hydro One" |
| `sub_type` | ~62% | `distribution` (25k), `transmission` (8.6k), `industrial` (6.2k), `minor_distribution` (3.9k), `generation` (2.2k), `switching` (1.3k) |

## Caveats

- `sub_type` includes ~1,200 rows tagged `yes` (mappers left a bare boolean) — skip when grouping by type.
- ~50 rows carry the placeholder name `"FIXME Substation"`.
