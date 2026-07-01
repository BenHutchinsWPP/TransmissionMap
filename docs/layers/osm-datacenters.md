# OSM Data Centers

Data center facilities mapped in OpenStreetMap across North America. One point per facility,
positioned at the node location or the centroid of the building/campus polygon.

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | `north-america-latest.osm.pbf` from [Geofabrik](https://download.geofabrik.de/) |
| **Vintage** | May 2026 |
| **Coverage** | USA + Canada + Mexico |
| **Served** | `data/layers/osm_datacenters.geojson.gz` — gzipped GeoJSON points, lazy-loaded on first enable |
| **Built by** | `scripts/extract_osm_datacenters.py` → `data/build/datacenter_osm.csv` → `scripts/build_tiles.py` |

## Download pack

`osm-datacenters.zip` — `osm-datacenters.geojson` · `osm-datacenters.csv` · `osm-datacenters.md` · `disclaimer.txt`

> ODbL requires attribution and share-alike on redistributed derivative databases.

## OSM tags matched

Any feature carrying one of:

| Tag | Meaning |
|---|---|
| `telecom=data_center` | Primary recommended OSM tag for data centers |
| `building=data_center` | Building typed as a data center (US spelling) |
| `building=data_centre` | Building typed as a data center (UK spelling) |

## Processing

- **Filter:** `osmium tags-filter` with the three patterns above → intermediate PBF
- **Export:** `osmium export` (all geometry types — point, polygon, multipolygon)
- **Nodes:** coordinates used directly
- **Polygons / multipolygons:** centroid computed from first exterior ring; closed-way and relation features both handled
- **Deduplication:** polygon centroid within 100 m of a node → polygon dropped (deliberately-placed node preferred over computed centroid)
- **Fields dropped:** `addr:street`, `addr:housenumber`, `addr:postcode`, `phone`, `ref`, `floors`, `building`, `telecom`, and all other OSM tags not in the schema below
- **Output:** CSV → gzipped GeoJSON via `ogr2ogr`

## Fields

| Field | % filled (est.) | Example values |
|---|---:|---|
| `osm_id` | 100% | `3712945821`, `12345678` |
| `name` | ~75% | "Google Data Center", "Equinix DC5", "QTS Richmond" |
| `operator` | ~60% | "Google", "Amazon", "Microsoft", "Equinix", "Digital Realty" |
| `website` | ~30% | "https://www.equinix.com/locations/americas-colocation/united-states-colocation/..." |
| `addr_city` | ~50% | "Ashburn", "San Jose", "Dallas" |
| `addr_state` | ~50% | "Virginia", "California", "TX" |
| `start_date` | ~15% | "2015", "2009-03" |

Fill rates are estimates — OSM coverage and tag completeness vary by region.
Northern Virginia (Ashburn) and Silicon Valley have the densest and best-tagged coverage.

## Caveats

- **Coverage is incomplete.** OSM data centers represent facilities that volunteers have mapped. Many real data centers are not in OSM, particularly smaller colocation facilities and enterprise-owned sites.
- **No MW / power draw data.** OSM does not have a widely-used tag for data center power capacity. The `capacity` tag exists but typically refers to rack count or IT load in non-standard units when present — it is not extracted.
- **No construction / planned status.** OSM primarily reflects existing built facilities. Under-construction sites may be tagged but are indistinguishable from operational ones without manual review.
- **ODbL license.** Derived data must also be shared under ODbL if redistributed. Attribution to OpenStreetMap contributors is required on any public display.
- **Currency.** Data reflects the OSM PBF snapshot date (see `data/raw/osm/`). Run `make pipeline` after refreshing the PBF to update.
