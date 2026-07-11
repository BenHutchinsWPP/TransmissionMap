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

## Download pack

Offered as **GeoJSON** and **SHP**:

- `boem-wind-leases.zip` (GeoJSON) / `boem-wind-leases-shp.zip` (SHP)

The GeoJSON zip holds `boem-wind-leases.geojson` + `boem-wind-leases.csv`; the
SHP zip holds the shapefile set (`.shp/.shx/.dbf/.prj/.cpg`) + the CSV. Both
include `boem-wind-leases.txt` (this doc) + `disclaimer.txt`.

## Fields

51 features (August 2025 vintage). Source columns from
`Offshore_Wind_Leases_outlines.shp`, renamed by the extract script
(`LEASE_NUMB→lease, COMPANY→company, PROJECT_NA→project, LEASE_TYPE→type,
STATE→state, ACRES→acres, LEASE_DATE→date, LEASE_TERM→term`).

| Field | % filled | Example values |
|---|---|---|
| `lease` | 100% | `OCS-A 0506` |
| `company` | 100% | `The Narragansett Electric Company` |
| `project` | 60% | `sea2shore: The Renewable Link` |
| `type` | 100% | `Commercial`, `Easement`, `Research` |
| `state` | 100% | `Rhode Island` |
| `acres` | 100% | `63338` (5 features are `0` — cable easements) |
| `date` | 98% | `12/01/2014` |
| `term` | 100% | `50 Years` |

## Processing

`extract_boem_wind.py` (`make boem-wind`):
1. Downloads the shapefile zip to `data/raw/boem_wind/` (skips if already present).
2. Extracts `Offshore_Wind_Leases_outlines.shp`.
3. Reprojects to EPSG:4326, renames fields (table above).
4. Writes `data/build/boem_wind_leases.geojson`; the tile manifest then gzips
   it to `data/layers/boem_wind_leases.geojson.gz`.

## Caveats

- **Leases only.** The zip also ships planning areas, marine-hydrokinetic
  leases, and lease outlines with cable routes; only
  `Offshore_Wind_Leases_outlines` is extracted. Planning/wind-energy areas
  that have not reached the lease stage do not appear.
- **Static snapshot.** BOEM revises the shapefiles as lease sales close;
  rerun `make boem-wind` (delete the cached zip in `data/raw/boem_wind/`
  first) to refresh.
- `project` is only ~60% filled — many leases have no named project yet; the
  popup falls back to company name.
- 5 features report `acres` of 0 (cable easements).
