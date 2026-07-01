# OSM Generators

OSM unit-level generator features (one row per turbine / panel array, North America).
For one-row-per-facility use [OSM Plants](osm-plants.md).

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | `north-america-latest.osm.pbf` from [Geofabrik](https://download.geofabrik.de/) |
| **Vintage** | May 2026 |
| **Coverage** | USA + Canada + Mexico |
| **Served** | `data/layers/osm_generators.pmtiles` — PMTiles, zoom 7–14 |
| **Built by** | `extract_osm_generators.py` → `data/build/generator_osm.csv` → `tippecanoe -l osm_generators` |

## Download pack

`osm-generators.zip` — `osm-generators.geojson` · `osm-generators.csv` · `osm-generators.md` · `disclaimer.txt`

> ODbL requires attribution and share-alike on redistributed derivative databases.

## Processing

- **Selected:** `power=generator` features → **~153,000** (~150,000 nodes + ~2,800 non-solar
  polygon centroids)
- **Row filter / dedup:** ~1.7 M individual solar-panel polygons are **deduplicated against
  farm-level node generators** so a solar farm doesn't explode into thousands of points
- **Computed:** `output_mw` per-unit nameplate parsed from OSM tags
- **Columns kept:** `osm_id`, `name`, `source`, `gen_method`, `gen_type`, `output_mw`,
  `operator`, `start_date`, `manufactur`, `ref`

## Fields

| Field | % filled | Example values | Notes |
|---|---:|---|---|
| `osm_id` | 100% | `9982693538` | OSM element ID |
| `name` | ~98% | "Bonanza Power Plant", "W. A. Parish Unit 1", "Tower 144" | Often repeats site name across all turbines/panels |
| `source` | ~99% | wind (87k), solar (55k), gas (4.5k), oil (1.1k), hydro (973), diesel, coal, battery, biogas, nuclear | Fuel type |
| `gen_method` | ~98% | wind_turbine (87k), photovoltaic (55k), combustion (6.9k), water-storage, run-of-the-river, fission | |
| `gen_type` | ~88% | solar_photovoltaic_panel, V17, open_cycle | Vendor model where mapped |
| `output_mw` | ~49% | 0.8, 2.5, 556.2 | Per-unit nameplate. ~Half blank — use EIA join when needed |
| `operator` | ~13% | "City of Longmont", "BlueEarth Renewables" | Sparse — skip for coverage analysis |
| `start_date` | ~5% | "1969-07", "1998-04" | Nearly empty |
| `manufactur` | ~42% | "GE", "Vestas", "Siemens" | Useful for wind/solar |
| `ref` | <1% | — | Essentially absent |

## Caveats

- Multi-unit-site duplication: names like "Nellis Air Force Base Solar Array" appear ~5,200
  times (one row per panel). For site-level aggregation, use the EIA join or
  [OSM Plants](osm-plants.md).
