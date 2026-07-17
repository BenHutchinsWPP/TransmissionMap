# OSM Transmission Lines

OSM transmission line and cable features (North America).

## Source

| | |
|---|---|
| **Provider** | [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) |
| **License** | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike required |
| **Attribution** | © OpenStreetMap contributors |
| **Source file** | `north-america-latest.osm.pbf` from [Geofabrik](https://download.geofabrik.de/) (19.2 GB) |
| **Vintage** | July 2026 (Geofabrik daily extract, downloaded 2026-07-13) |
| **Coverage** | USA + Canada + Mexico |
| **Served** | `data/layers/osm_transmission_lines.pmtiles` — PMTiles, zoom 2–11 |
| **Built by** | `extract_osm_lines.py` + `enrich_osm_tags.py` → `data/build/transmission_lines.gpkg` → `tippecanoe -l osm_transmission_lines` |

## Download pack

`osm-transmission-lines.zip` — `osm-transmission-lines.geojson` · `osm-transmission-lines.csv` · `osm-transmission-lines.md` · `disclaimer.txt`

> ODbL requires attribution and share-alike on redistributed derivative databases.
> The GeoJSON in this pack is an ODbL derivative — downstream redistribution must also carry ODbL.

## Processing

- **Selected:** `power=line` and `power=cable` ways → **335,568 features**
- **Row filter:** none
- **Computed:** `nominal_kv` parsed to integer kV from raw OSM voltage text; `-1` sentinel = unknown; `is_undergrnd` flag derived from `power=cable` / `location` tags; `is_dc` from `frequency=0`
- **Columns kept:** `nominal_kv`, `operator`, `name`
- **Simplification:** tippecanoe per-zoom default (z2–11)

## Fields

| Field | % filled | Example values | Notes |
|---|---:|---|---|
| `osm_id` | 100% | `12345678` | OSM way ID; popup links to openstreetmap.org/way/{id} |
| `nominal_kv` | 88.1% | 138 (55,747), 69 (52,677), 115 (50,312), 230 (38,534), 345 (18,190), 46 (11,466), 161 (10,777), 34 (7,937), 500 (6,085), 765 (437), 735 (338) | Parsed integer kV. `-1` sentinel = unknown |
| `cables` | ~40% | `3`, `6`, `12` | Number of individual conductors |
| `circuits` | ~55% | `1`, `2`, `4` | Number of circuits; not rendered in popup |
| `operator` | ~35% | BC Hydro, Bonneville Power Administration, Hydro One | Operating utility |
| `name` | ~11% | "Big Eddy–DeMoss No 1", "Bonneville PH 1–Hood River No 1" | Most OSM lines unnamed |
| `is_undergrnd` | 100% | `0`, `1` | `1` when `power=cable` or `location=underground\|underwater`; drives dashed rendering + Line placement filter |
| `is_dc` | 100% | `0`, `1` | `1` for HVDC (206 ways). Drives the light centre stripe |

## Caveats

- OSM line `name` is often the line's official identifier when present, but most lines
  outside the BPA / Hydro-Québec areas have no name. Use `operator` + `nominal_kv` for filtering.

### Voltage and HVDC tagging are messy — how we cope

- **Shapefile truncation (fixed 2026-07-13, this build).** OSM lines are written via
  `ogr2ogr → ESRI Shapefile`. Any tag not named in `osmconf.ini`'s `[lines]
  attributes=` is packed into one `other_tags` hstore string, and DBF caps
  string fields at **254 chars**, silently cutting whatever sorts last. On
  tag-heavy ways that meant `voltage` — in the previous (May 2026) build ~740
  lines lost their voltage this way, the Pacific DC Intertie (way 56392650)
  among them, showing as `-1` / unknown kV. Fix, live as of this build:
  `voltage`, `cables`, `circuits`, `frequency`, `location`, `wires` are now
  promoted to real columns. Truncated rows dropped from 6,781 (old build) to
  1 (this build). The Pacific DC Intertie now correctly reads
  `nominal_kv=500`, `kv_range=500-600`, `is_dc=1`. Never move `power`,
  `operator` or `ref` there — the `power_line` WHERE clause and the pipeline
  layers read them out of `other_tags`.
- **Voltage values are free text.** Seen in the wild: `500000`, `115000;12000`
  (one value per circuit), `14400-24900` (a range), `138000;?`,
  `115000;unknown`, `low`, `?`, `0_(unused)`. `_best_kv()` pulls every integer
  out and keeps the largest. The single highest value in the dataset is way
  5194902 "Experimental HVDC Powerline", tagged `voltage=1333000` → 1333 kV —
  an upstream OSM tag, not a parse error.
- **Sub-kV values are volts, not kV.** Ways carry `voltage=480 | 240 | 120 |
  690` (LV service drops). These floor to 0 kV and report as unknown — the
  old parser read them as 480/240 **kV** and painted them as EHV transmission.
  Verified in this build: 0 rows leak sub-kV volts into `nominal_kv`.
- **11.9% of lines have no usable voltage** (39,779 of 335,568 rows), mostly
  unnamed rural `power=line`. `_fill_kv_from_name()` backfills the ones whose
  name embeds a kV number ("… 500kV"); the rest stay `-1` and render in the
  unknown tier (`kv_range=unknown`). This is upstream data absence, not a
  parsing failure. `nominal_kv` fill is 88.1% overall. `kv_range` buckets:
  100-200 (126,742), 50-100 (60,838), 200-300 (40,912), 0-50 (40,615), unknown
  (39,779), 300-400 (19,004), 500-600 (6,086), 400-500 (810).
- **HVDC:** `frequency=0` is the canonical marker (200 ways, this build) but is
  not universally tagged, so `_add_is_dc()` falls back to a narrow name match
  (`HVDC`/`DC Intertie`/`bipole`) **only when frequency is absent**; a stated
  non-zero frequency is authoritative AC. Total: 206 ways (200 by `frequency=0`
  + 6 by name fallback). Mixed towers tagged `frequency=60;0` carry both and
  count as DC.
- **A name saying "HVDC" does not make a line DC.** 151 ways match the HVDC name
  regex, but 81 declare a non-zero AC frequency and are correctly *not* flagged.
  Two traps this avoids:
  - `"230 kV + Electrode Line of HVDC Pacific DC Intertie"` — a 230 kV **AC**
    circuit that merely shares towers with the intertie's electrode line. (The
    standalone electrode lines — HVDC CU, Maritime Link, Nelson River Bipole 1/2
    — do carry `frequency=0` and are flagged DC.)
  - `"Finney to Lamar HVDC"` — 345 kV **AC**, `frequency=60`. Lamar is a
    back-to-back DC tie, so the lines reaching it are AC on both sides; only the
    converter itself is DC.
- **Why the DC count fell from ~280 (May 2026 build) to 206.** Not a regression —
  the truncation fix restored the `frequency` tag on tag-heavy ways, which
  previously lost it and so fell through to the name fallback. Those ways now
  report 60 Hz and classify as AC. 206 is the more accurate number. (Conversely,
  ways like Highgate carry neither a frequency tag nor an `HVDC` name, so neither
  rule reaches them — they stay AC/unknown. Under-detection here is upstream tag
  absence, not a parser limit.)
