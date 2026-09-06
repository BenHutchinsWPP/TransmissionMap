# OSM Generators

OSM unit-level generator features, worldwide — one row per turbine / panel array.
For one-row-per-facility use [OSM Plants](osm-plants.md).

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | The eight continental extracts (`<region>-latest.osm.pbf`) from [Geofabrik](https://download.geofabrik.de/) |
| **Vintage** | Geofabrik daily extracts, as of the last pipeline run |
| **Coverage** | Worldwide (8 continental Geofabrik extracts) |
| **Served** | `data/layers/osm_generators.pmtiles` — PMTiles, zoom 7–13. z14 alone was 48% of the archive; capping at z13 keeps it under the host's 100 MiB per-file ceiling and MapLibre overzooms above it. |
| **Built by** | `extract_osm_generators.py` → `data/build/generator_osm.csv` → `tippecanoe -l osm_generators` |

## Download pack

`osm-generators-<code>.zip` — CSV only: `osm-generators-<code>.csv` · `osm-generators.txt` (this doc) · `disclaimer.txt`

Built once per Geofabrik continent — `<code>` is one of `na eu as sa af oc ca an`, and the download menu in the layer panel picks it.

> ODbL requires attribution and share-alike on redistributed derivative databases.

## Processing

- **Selected:** `power=generator` features — nodes plus non-solar polygon centroids
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
| `source` | 99% | wind (87,462), solar (58,715), gas (4,514), diesel (1,791), oil (1,143), hydro (978), coal (464), battery (464), biogas (348), nuclear (135) | Fuel type |
| `gen_method` | 98% | wind_turbine (87,122), photovoltaic (58,411), combustion (7,981), water-storage (366), run-of-the-river (219), fission (120), thermal (93) | |
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
