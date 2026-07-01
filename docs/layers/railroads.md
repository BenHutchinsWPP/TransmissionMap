# Railroads (BTS NARN)

BTS/FRA rail network lines (US + Canada + Mexico).

## Source

| | |
|---|---|
| **Provider** | [US DOT Bureau of Transportation Statistics](https://www.bts.gov/ntad) — National Transportation Atlas Database (NTAD); geometry from the Federal Railroad Administration (FRA) |
| **Dataset** | [North American Rail Network Lines](https://geodata.bts.gov/datasets/usdot::north-american-rail-network-lines/about) |
| **Coverage** | All 50 states + DC, Mexico, Canada |
| **Vintage** | Created 2016; this build used the 2026-05-05 update |
| **Resolution** | 1:24,000 or better within the US |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | "US DOT BTS / FRA North American Rail Network" |
| **Served** | `data/layers/railroads.pmtiles` — PMTiles, z4–13 |
| **Built by** | `scripts/tile_manifest.yaml` (`railroads` block) → `build_tiles.py` — `ogr2ogr` field subset + `tippecanoe` |
| **Raw input** | `data/raw/railroads/narn_rail_lines.geojson` (~345 MB, **not committed**) |

> **Download origin:** Direct GeoJSON from the BTS Geodata portal (ArcGIS Hub):
> `https://geodata.bts.gov/api/download/v1/items/f0651adc56f5467eb9402ccca045f213/geojson?layers=0`
> No extract script — the build selects a field subset and tiles it straight to PMTiles.

## Download pack

`railroads.zip` — `railroads.geojson` · `railroads.csv` · `railroads.md` · `disclaimer.txt`

> 345 MB raw GeoJSON is large. Consider downloading directly from BTS for the complete original.

## Processing

`build_railroads()` runs `ogr2ogr` to drop all but the kept fields, then `tippecanoe`
(z4–z13, `--drop-densest-as-needed --coalesce-densest-as-needed`, layer name `railroads`).
No field renaming — original BTS column names are preserved.

**Kept fields:** `RROWNER1`, `NET`, `PASSNGR`, `TRACKS`, `DIVISION`, `SUBDIV`, `BRANCH`, `STATEAB`

**Dropped:** OBJECTID, FRA arc/node IDs, `RROWNER2/3`, `TRKRGHTS1–9`, FIPS codes, `MILES`/`KM`, `TIMEZONE`, etc. — not used by popup or search.

## Fields

| Column | Type | Fill | Notes |
|--------|------|------|-------|
| RROWNER1 | str | high | Primary rail owner (reporting mark, e.g. `DMVW`, `BNSF`, `UP`). Popup title + search. |
| NET | str | 100% | Network class. M=Main (95,934), O=Other (88,556), Y=Yard (79,014), I=Industrial (16,134), S=Siding (10,193), X=Out of service (6,534), A=Abandoned (4,267), T=Transit (1,473), R=Removed/rail-trail (623), F=Ferry (15) |
| PASSNGR | str | ~7% | Passenger service code (A/V/C/B/T/…); null = freight-only. Popup shows "Yes" when set. |
| TRACKS | int | 100% | Number of tracks |
| DIVISION | str | partial | Operating division |
| SUBDIV | str | partial | Subdivision name — secondary search field |
| BRANCH | str | partial | Branch/line name — search field |
| STATEAB | str | 100% | 2-letter state/province abbreviation |

## Use

Demonstrates **coal rail delivery**: enable Railroads + filter Generators to coal —
plants cluster on `NET=M` main lines. Rail access is a fuel-security signal.

## Caveats

- **Geometry only.** No traffic, tonnage, or commodity flow. Owner ≠ current operator
  where trackage rights apply (`TRKRGHTS*` fields dropped).
- Covers Canada/Mexico too, not just the US.
- `NET` includes abandoned/removed/out-of-service segments — all rendered the same;
  filter on `NET` if only active main lines are wanted.
