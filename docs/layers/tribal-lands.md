# Tribal Lands (AIANNH)

American Indian / Alaska Native / Native Hawaiian areas from Census TIGER/Line.

## Source

| | |
|---|---|
| **Provider** | [U.S. Census Bureau](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html) |
| **Dataset** | TIGER/Line 2025 — American Indian / Alaska Native / Native Hawaiian Areas (AIANNH) |
| **Download** | `https://www2.census.gov/geo/tiger/TIGER2025/AIANNH/tl_2025_us_aiannh.zip` (bump year for newer vintages) |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "U.S. Census Bureau, TIGER/Line" |
| **Served** | `data/layers/tribal_lands.geojson.gz` — lazy GeoJSON (full geometry; features copyable in the UI) |
| **Built by** | `extract_tribal_lands.py` → `data/build/tribal_lands.{shp,csv}` |
| **Raw input** | `data/raw/aiannh/tl_2025_us_aiannh.zip` |

> Was previously sourced from HIFLD (`seerai/hifld`), which only re-hosts this same
> Census geography at a frozen vintage. TIGER is the upstream source, refreshed annually.

## Download pack

`tribal-lands.zip` — `tribal-lands.geojson` · `tribal-lands.csv` · `tribal-lands.md` · `disclaimer.txt`

## Processing

- **Selected:** all ~870 AIANNH areas
- **Row filter:** none
- **Reprojected:** TIGER NAD83 (EPSG:4269) → EPSG:4326
- **Columns trimmed:** kept `NAME`, `MTFCC`, `ALAND`, `AWATER`, `GEOID`
- **Decoded:** Census `MTFCC` → `area_type` label; `recognized` derived from MTFCC
  (`G2150`/`G2170` = State, else Federal)

## Fields

| Field | % filled | Example values |
|---|---:|---|
| `name` | 100% | "Sycuan Reservation and Off-Reservation Trust Land", "Navajo Nation Reservation" |
| `area_type` | 100% | American Indian Reservation (322), Alaska Native Village Statistical Area (221), Off-Reservation Trust Land (176), Hawaiian Home Land (74), State-Designated Tribal Statistical Area (35), Oklahoma Tribal Statistical Area (25), Tribal-Designated Statistical Area (7), State American Indian Reservation (7) |
| `recognized` | 100% | Federal (825), State (42) |
| `acres_land` | 100% | 220, 16,200,000 (land area, acres) |
| `acres_wtr` | 100% | 0, 13,039 (water area, acres) |
| `geoid` | 100% | `5111T` (Census AIANNH GEOID) |

## Caveats

- **Statistical/administrative geography, not a legal boundary.** 
  > "The boundary information in the TIGER/Line Shapefiles is for statistical data collection and tabulation purposes only; their depiction and designation for statistical purposes do not constitute a determination of jurisdictional authority or rights of ownership or entitlement and they are not legal land descriptions."
  Do not use for land-tenure, jurisdiction, or sovereignty determinations.
- Includes statistical areas that are **not** reservations (State-/Tribal-Designated
  Statistical Areas, Oklahoma Tribal Statistical Areas) — see `area_type`.
- TIGER/Line 2025 vintage; Census refreshes annually. Bump the download year for newer data.
