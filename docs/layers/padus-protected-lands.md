# PAD-US Protected & Managed Lands

USGS protected and managed land polygons.

## Source

| | |
|---|---|
| **Provider** | [USGS Gap Analysis Project](https://www.usgs.gov/programs/gap-analysis-project) |
| **Dataset** | [PAD-US 4.1 Full Inventory](https://www.sciencebase.gov/catalog/item/652d4fc5d34e44db0e2ee45e) — `PADUS4_1Geodatabase.gdb`, `PADUS4_1Fee` layer |
| **Coverage** | US protected & managed lands (federal/state/local/private/NGO) |
| **Version** | PAD-US 4.1 |
| **Acquired** | 2026-06-02 |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Served** | `data/layers/padus.pmtiles` — PMTiles (806 MB SHP → 62 MB tiles) |
| **Built by** | `extract_padus.py` → `data/build/padus.{shp,csv}` |
| **Raw input** | `PADUS4_1Geodatabase.gdb` — **not committed** (~596 MB) |

> **Do not use the source.coop HIFLD copy** — it is missing onshore federal land
> (BLM/USFS/NPS verified near-absent). The authoritative USGS File Geodatabase is the source.

## Download pack

**No download pack is provided** — the processed GeoJSON is too large to redistribute.
Users download the complete original from the [USGS ScienceBase item](https://www.sciencebase.gov/catalog/item/652d4fc5d34e44db0e2ee45e)
(the `url` link on the layer's panel row). This layer is marked `skip: true` in
`scripts/release_manifest.yaml`.

## Processing

- **Selected:** the `PADUS4_1Fee` class
- **Row filter (transmission-siting focus):**
  - **GAP status 1–3 only** — drops GAP 4 (no protection mandate, ~173k city
    parks/ballfields)
  - **offshore marine national monuments excluded**
- **Columns trimmed 29 → 12:** dropped provenance/metadata and local-verbatim duplicates
- **Decoded:** agency / designation / GAP / access codes → labels via the GDB's own domain tables

## Fields

| Field | % filled | Example values |
|---|---:|---|
| `name` | 100% | "Jornada Experimental Range", "Pike National Forest" |
| `desig` | 100% | National Forest, Wilderness Area, State Park, Conservation Area, … (decoded `Des_Tp`) |
| `mng_agency` | 100% | Bureau of Land Management, Forest Service, National Park Service, … |
| `mng_type` | 100% | State (44.7k), Unknown (39.8k), Local Government (19.1k), Non-Governmental Organization (12.9k), Federal (3.4k), Regional/Special District (2.0k), Private (1.2k) |
| `own_agency` | 100% | owning agency (decoded, same vocabulary as `mng_agency`) |
| `own_type` | 100% | Federal, State, Local Government, Private, … |
| `gap` | 100% | `3` (72.9k — multiple-use), `2` (43.4k — managed), `1` (6.9k — strict). 4 = no mandate (excluded) |
| `access` | 100% | Open Access (74.1k), Unknown (25.1k), Restricted Access (14.4k), Closed (9.5k) — physical visitor access to the land, not data access |
| `iucn` | 100% | Other Conservation Area, V, III, IV, VI, II, Ib, Ia |
| `state` | 100% | CO, NM, AZ, … (2-letter) |
| `acres` | 100% | 14,674; 109,258 (GIS acres) |
| `yr_est` | ~39% | 1939, 1987 (year established — blank when unknown) |

## Caveats

- **Not a complete land-ownership map.** Filtered to GAP status 1–3; GAP 4 (multiple-use
  working lands with no protection mandate) and offshore marine monuments are excluded.
- **Do not use the source.coop HIFLD copy** — it is missing onshore federal land
  (BLM/USFS/NPS verified near-absent). Use the authoritative USGS File Geodatabase.
- Polygons overlap by design (fee, easement, and designation layers); this layer serves
  only the `PADUS4_1Fee` class, so some managed areas in other PAD-US classes are absent.
- Large dataset (~596 MB at source) — no download pack is shipped; link out to USGS.
