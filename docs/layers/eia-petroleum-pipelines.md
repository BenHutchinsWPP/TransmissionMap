# EIA Petroleum Pipelines

Crude-oil and refined petroleum-product pipelines from the EIA U.S. Energy Atlas.
Panel group: **pipelines**. Two separate line layers (crude vs product) that
close the liquids-fuel side of the map alongside the natural-gas pipelines.

## Source

| | |
|---|---|
| Provider | U.S. Energy Information Administration (EIA) |
| Dataset | U.S. Energy Atlas — Crude Oil Pipelines · Petroleum Product Pipelines |
| License | Public domain (U.S. federal government work) |
| Attribution | EIA U.S. Energy Atlas |
| Served | `data/layers/eia_crude_pipelines.geojson.gz` · `data/layers/eia_product_pipelines.geojson.gz` |
| Built by | `scripts/extract_petroleum_pipelines.py` |
| Download | `https://www.eia.gov/maps/map_data/CrudeOil_Pipelines_US_EIA.zip` · `PetroleumProduct_Pipelines_US_EIA.zip` |
| Vintage | **Jan 2020** (the publicly downloadable shapefile release) |

Small enough for browser-direct GeoJSON — **no PMTiles bake** (same treatment as
the natgas points). 236 crude lines + 329 product lines.

## Download pack

`eia-petroleum.zip` — `eia-crude-pipelines.geojson` · `eia-crude-pipelines.csv` ·
`eia-product-pipelines.geojson` · `eia-product-pipelines.csv` · the layer doc ·
`disclaimer.txt`. Both layers also link out to their EIA Atlas dataset pages; the
upstream shapefiles are at `eia.gov/maps/map_data/`.

## Fields

| Field | % filled | Example values |
|---|---:|---|
| `name` | ~100% | `Lakehead`, `Buckeye`, `Chicap` (pipeline/system name) |
| `operator` | ~100% | `ENBRIDGE`, `BUCKEYE PARTNERS` (operating company) |

## Caveats

- **Vintage is Jan 2020.** EIA's newer (~2024) pipeline data lives on
  `atlas.eia.gov`, but its hosted feature services are **behind an auth token** —
  no public download endpoint resolves (all return 403 / "Token Required"). The
  `eia.gov/maps/map_data` shapefile is the latest *publicly* downloadable release.
  **Follow-up:** refresh from the Atlas if/when a public export or token becomes
  available (the roadmap pins the dataset item ids `eia::crude-oil-pipelines` /
  `eia::petroleum-product-pipelines`).
- Geometry is national-scale schematic routing, not survey-grade alignment.
- No diameter / throughput / commodity-detail fields in the public release.
