# OSM Substations

OSM substation points and polygon footprints, worldwide.

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | The eight continental extracts (`<region>-latest.osm.pbf`) from [Geofabrik](https://download.geofabrik.de/) |
| **Vintage** | Geofabrik daily extracts, as of the last pipeline run |
| **Coverage** | Worldwide (8 continental Geofabrik extracts) |
| **Served** | `data/layers/osm_substations_points.pmtiles` (points, zoom 4–13) · `data/layers/osm_substations_polygons.pmtiles` (polygons). Points are capped at z13 to clear the host's 100 MiB per-file ceiling; no substation is dropped at any zoom and MapLibre overzooms above it. |
| **Built by** | `extract_osm_substations.py` → `data/build/substation_osm.csv` + `data/build/substation_polygons.gpkg` → `build_global_tiles.py` |

Both layers are served as **PMTiles** vector tiles, joined from the 8 continental extracts. See [hosting & compression](../pipeline.md#hosting--compression).

## Download pack

Two separate packs (one per map layer):

- **Points** (`osm-substations-points-<code>.zip`) — CSV only: `osm-substations-points-<code>.csv`
- **Polygons** — `osm-substations-polygons-<code>.zip` (GeoJSON) / `osm-substations-polygons-<code>-shp.zip` (SHP): geometry + `osm-substations-polygons-<code>.csv`

Every zip also includes `osm-substations.txt` (this doc) + `disclaimer.txt`.

Built once per Geofabrik continent — `<code>` is one of `na eu as sa af oc ca an`, and the download menu in the layer panel picks it.

> ODbL requires attribution and share-alike on redistributed derivative databases.

## Processing

- **Selected:** all `power=substation` features — node, polygon-centroid and relation
  centroids. The polygon layer carries the closed-way footprints.
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
| `nominal_kv` | 75% | 69 (15,355), 115 (12,792), 138 (9,965), 230 (5,040), 46 (3,359), 161 (2,638), 34 (2,457), 345 (1,969) | Parsed numeric kV |
| `voltage_raw` | 75% | "100;69", "33", "41;2" | Raw OSM text — multi-voltages semicolon-delimited |
| `sub_type` | 62% | `distribution` (25,211), `transmission` (8,713), `industrial` (6,467), `minor_distribution` (4,179), `generation` (2,307), `switching` (1,330), `traction` (664) | 1,292 rows have junk (`yes`, place names) — filter these |
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

- `sub_type` includes 1,292 rows tagged `yes` (mappers left a bare boolean) — skip when grouping by type.
- ~50 rows carry the placeholder name `"FIXME Substation"`.
