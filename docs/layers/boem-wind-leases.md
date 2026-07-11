# Offshore Wind Leases (BOEM)

U.S. offshore wind lease outlines and planning areas.

## Source

| | |
|---|---|
| **Provider** | [Bureau of Ocean Energy Management (BOEM)](https://www.boem.gov/renewable-energy/mapping-and-data) |
| **Dataset** | BOEM Renewable Energy Shapefiles |
| **Download** | `https://www.boem.gov/renewable-energy/boem-renewable-energy-shapefiles` |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "Bureau of Ocean Energy Management" |
| **Served** | `data/layers/boem_wind_leases.geojson.gz` — gzipped GeoJSON |
| **Built by** | `scripts/extract_boem_wind.py` (`make boem-wind`) |
| **Raw input** | `data/raw/boem_wind/boem-renewable-energy-shapefiles.zip` |

## Processing

`extract_boem_wind.py`:
1. Downloads the shapefile zip to `data/raw/boem_wind/` (skips if already present).
2. Extracts the `Offshore_Wind_Leases_outlines.shp` file.
3. Reprojects to EPSG:4326.
4. Renames fields for frontend consumption.
5. Writes `data/build/boem_wind_leases.geojson`.

`make boem-wind` then runs the extract script and builds it via the manifest (which writes the output to `.geojson.gz`).

## Fields

| Field | Source Column | Notes |
|---|---|---|
| `lease` | `LEASE_NUMB` | Lease number. |
| `company` | `COMPANY` | Company name. |
| `project` | `PROJECT_NA` | Project name. |
| `type` | `LEASE_TYPE` | Lease type (e.g., Commercial, Easement, Research). |
| `state` | `STATE` | Associated state. |
| `acres` | `ACRES` | Area in acres. |
| `date` | `LEASE_DATE` | Lease date. |
| `term` | `LEASE_TERM` | Lease term. |
