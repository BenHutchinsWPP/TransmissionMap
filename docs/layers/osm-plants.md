# OSM Plants

OSM plant centroid points and boundary polygons, worldwide.
Plant-level features — one row per facility (vs. one row per turbine in [OSM Generators](osm-generators.md)).

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | The eight continental extracts (`<region>-latest.osm.pbf`) from [Geofabrik](https://download.geofabrik.de/) |
| **Vintage** | Geofabrik daily extracts, as of the last pipeline run |
| **Coverage** | Worldwide (8 continental Geofabrik extracts) |
| **Served** | `data/layers/osm_plants_points.geojson.gz` (points) · `data/layers/osm_plants_polygons.pmtiles` (polygons, vector tiles capped at z12) |
| **Built by** | `extract_osm_plants.py` → `data/build/plant_osm.csv` + `data/build/plant_polygons.gpkg` → `build_global_tiles.py` |

Point centroids are served as **gzipped GeoJSON**; plant polygon boundaries are served as **PMTiles** vector tiles.

## Download pack

Two separate packs (one per map layer):

- **Points** (`osm-plants-points-<code>.zip`) — CSV only: `osm-plants-points-<code>.csv`
- **Polygons** — `osm-plants-polygons-<code>.zip` (GeoJSON) / `osm-plants-polygons-<code>-shp.zip` (SHP): geometry + `osm-plants-polygons-<code>.csv`

Every zip also includes `osm-plants.txt` (this doc) + `disclaimer.txt`.

Built once per Geofabrik continent — `<code>` is one of `na eu as sa af oc ca an`, and the download menu in the layer panel picks it.

> ODbL requires attribution and share-alike on redistributed derivative databases.

## Processing

- **Selected:** `power=plant` relations/areas — one centroid point and one boundary
  polygon per facility
- **Row filter:** none
- **Computed:** `output_mw` = plant total MW from OSM tags; centroid lon/lat for the point layer
- **Columns kept:** `osm_id`, `name`, `source`, `output_mw`, `operator`, `start_date`

## Fields — points

| Field | % filled | Example values |
|---|---:|---|
| `osm_id` | 100% | `1384141483` |
| `name` | ~70% | "Planta Generadora La Caridad", "McIntosh Combined Cycle Facility" |
| `source` | 98% | solar (11,172), hydro (1,743), wind (1,655), gas (1,596), oil (478), battery (381), biomass (245), coal (218), biogas (99), nuclear (65) |
| `output_mw` | ~68% | 25.0, 199.6, 801.0 |
| `operator` | ~65% | "Idaho Power Co", "Duke Energy" |
| `start_date` | ~58% | "1994-03", "1925-08" |

## Fields — polygons

Same fields as points.

| Field | % filled | Example values |
|---|---:|---|
| `osm_id` | 100% | `14340604` |
| `name` | ~70% | "ZooShare Biogas Facility", "Wylie Dam", "Centrale de Chute-à-Caron" |
| `source` | 98% | solar (11,172), hydro (1,743), wind (1,655), gas (1,596) |
| `output_mw` | ~68% | 0.5, 60.0, 222.0 |
| `operator` | ~65% | "Duke Energy", "Rio Tinto Alcan", "Resolute Forest Products" |
| `start_date` | ~58% | "2021", "1925-08" |

## Caveats

- **OSM completeness varies by region**; smaller and residential plants are under-mapped,
  and `output_mw` is only ~68% filled — do not treat counts or capacity as exhaustive.
- Centroid points approximate location; for large multi-part facilities the centroid may
  fall off the actual footprint. Use the polygon layer for extent.
- One row per facility. For unit-level detail (individual turbines/arrays) see
  [OSM Generators](osm-generators.md).
- ODbL share-alike applies to any redistributed derivative database.
