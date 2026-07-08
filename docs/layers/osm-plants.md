# OSM Plants

OSM plant centroid points and boundary polygons (North America).
Plant-level features — one row per facility (vs. one row per turbine in [OSM Generators](osm-generators.md)).

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | `north-america-latest.osm.pbf` from [Geofabrik](https://download.geofabrik.de/) |
| **Vintage** | May 2026 |
| **Coverage** | USA + Canada + Mexico |
| **Served** | `data/layers/osm_plants_points.geojson.gz` (points) · `data/layers/osm_plants_polygons.geojson.gz` (polygons) |
| **Built by** | `extract_osm_plants.py` → `data/build/plant_osm.csv` + `data/build/plant_polygons.gpkg` |

Both layers served as **gzipped GeoJSON** (many small geometries).

## Download pack

Two separate packs (one per map layer):

- **Points** (`osm-plants-points.zip`) — CSV only: `osm-plants-points.csv`
- **Polygons** — `osm-plants-polygons.zip` (GeoJSON) / `osm-plants-polygons-shp.zip` (SHP): geometry + `osm-plants-polygons.csv`

Every zip also includes `osm-plants.txt` (this doc) + `disclaimer.txt`.

> ODbL requires attribution and share-alike on redistributed derivative databases.

## Processing

- **Selected:** `power=plant` relations/areas → **~17,600** centroid points, **~17,600**
  boundary polygons
- **Row filter:** none
- **Computed:** `output_mw` = plant total MW from OSM tags; centroid lon/lat for the point layer
- **Columns kept:** `osm_id`, `name`, `source`, `output_mw`, `operator`, `start_date`

## Fields — points

| Field | % filled | Example values |
|---|---:|---|
| `osm_id` | 100% | `1384141483` |
| `name` | ~70% | "Planta Generadora La Caridad", "McIntosh Combined Cycle Facility" |
| `source` | ~98% | solar (10.8k), hydro (1.7k), wind (1.7k), gas (1.6k), oil, battery, biomass, coal, biogas, nuclear |
| `output_mw` | ~68% | 25.0, 199.6, 801.0 |
| `operator` | ~65% | "Idaho Power Co", "Duke Energy" |
| `start_date` | ~58% | "1994-03", "1925-08" |

## Fields — polygons

Same fields as points.

| Field | % filled | Example values |
|---|---:|---|
| `osm_id` | 100% | `14340604` |
| `name` | ~70% | "ZooShare Biogas Facility", "Wylie Dam", "Centrale de Chute-à-Caron" |
| `source` | ~98% | solar (10.8k), hydro (1.7k), wind (1.7k), gas (1.6k) |
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
