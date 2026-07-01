# WECC Paths

Point markers for each active WECC transmission **path**, labeled by path Number.
Panel group: **transmission**. Each marker's popup gives the path name, rating
type, revision date, transfer limits with directionality, any hand-added note,
the source catalog, and the list of transmission lines that define the path.

Some paths also carry a **digitized corridor** — a thick semi-transparent band
showing the interface cut-plane / approximate extent. These are LineString
features in the same source flagged `isCorridor: true`; for a path that has one,
its point marker sits at the corridor's midpoint. Corridors are hand-digitized
and maintained by hand (see [Caveats](#caveats)).

## Source

| | |
|---|---|
| Provider | Western Electricity Coordinating Council (WECC) |
| Dataset | 2026 Path Rating Catalog — Public Version (V3, March 2026) |
| License | Public Version, published by WECC for public use |
| Attribution | WECC Path Rating Catalog |
| Served | `data/layers/wecc_paths.geojson.gz` (markers) · `wecc_path_lines.geojson.gz` (matched lines) |
| Built by | `_private/wecc-paths/parse_paths.py` (data) · `match/match_lines.py` (line match) — private, see Caveats |
| Raw input | `2026 Path Rating Catalog Public_V3.pdf` + `Interface.csv` (both private) |

The catalog PDF is **authoritative** for path name, revision date, rating type,
direction labels, transfer-limit MW, and the path's line list. The companion
`Interface.csv` supplies only the **point coordinates** (lat/lon) and a numeric
rating pair used as a cross-check.

## Download pack

`data/releases/wecc-paths.zip` (built by `scripts/build_releases.py` from the
hosted `.gz` files, as-is — no modification). It contains:

- `wecc-paths.geojson` / `.csv` — path point markers **and** interface-highlight
  corridor lines together (corridors flagged `isCorridor:true`).
- `wecc-path-lines.geojson` / `.csv` — the highlighted transmission-line
  geometries (OSM/HIFLD lines matched to each path).
- `wecc-paths.txt` (this doc) + `disclaimer.txt`.

Each CSV carries the feature attributes plus a `lat`/`lon` representative point.
The upstream catalog is a PDF published at [wecc.org](https://www.wecc.org/);
the served GeoJSON is a derived extract.

## Fields

| Field | Notes | Example |
|---|---|---|
| `number` | WECC path number (the on-map label) | `66` |
| `name` | `number: catalog name`, prefixed so a copied feature keeps its number and it's keyboard-searchable; en-dashes normalized to plain `-` | `66: California-Oregon Intertie (COI)` |
| `status` | `Revised` / `Added` (active paths only) | `Revised` |
| `revised` | Status + catalog date, or null; shown as its own popup row (keyed by status) | `Revised January 2026` |
| `rating_category` | Catalog rating type | `Accepted Rating` |
| `dir_fwd` / `dir_rev` | Abbreviated direction (opposite of each other) | `N-S` / `S-N` |
| `mw_fwd` / `mw_rev` | Numeric MW (null when "Not Rated"/seasonal) | `4800` |
| `mw_fwd_raw` / `mw_rev_raw` | Verbatim limit string (keeps range/Not-Rated) | `2,725 to 3,100 MW` |
| `seasonal` | True when the catalog lists season/month-windowed limits | `true` (paths 14, 25, 45) |
| `rating_detail` | Hand-transcribed seasonal limit string (seasonal paths only) | `N-S: 100 MW (Winter), 80 MW (Summer) · S-N: 45 MW (both)` |
| `note` | Optional hand-added clarification, shown as a popup row (present on a few paths) | `E-W rating is Non-Simultaneous; W-E is Simultaneous with Path 27.` |
| `lines` | List of transmission lines defining the path | `["Malin to Round Mt. 500 kV", …]` |
| `n_lines` | Count of `lines` | `3` |
| `source` | Catalog citation | `2026 WECC Path Rating Catalog …` |
| `isCorridor` | On the digitized corridor LineStrings only (`true`); absent on point markers | `true` |

62 active paths, all displayed with coordinates derived from public sources
(HIFLD/OSM substations + hand-digitized public cut-plane corridors — no
`Interface.csv` coordinate ships).

**Numbering gaps are intentional.** The catalog runs to 90 but only 62 are active.
The rest are **retired paths** (deleted from the catalog) — 7, 9–13, 21–23, 43, 44,
50, 51, 53, 54, 56, 57, 63, 64, 67–70, 72, 73, 74 — plus **37** ("See Path 85", a
cross-reference, not a path) and **34** (unused). Retired paths are *not* shown:
the public catalog strips them to just a number + deletion date (no name, no
definition, no coordinates), so there is nothing public to place or label.

## Line highlighting

Clicking a path marker highlights the actual OSM/HIFLD transmission-line features
that make up that path (a separate `wecc-path-lines` GeoJSON source, filtered to
the clicked path number; highlight clears when the popup is dismissed).

The matches are produced offline by `match/match_lines.py` via a **substation-
anchored geometric match**: each WECC line definition (`"SubA–SubB kV"`) is
resolved to two substation coordinates (using the OSM + HIFLD substation layers,
nearest the path's lat/long), then the OSM/HIFLD line whose geometry passes near
both substations at the matching voltage is kept. It picks whichever layer
(OSM or HIFLD) matches better per line. Coverage is ~182 lines across the
located paths; the rest are left for manual fill-in. Hard cases (long DC
interties, odd voltages, point-defined paths like PDCI at NOB) are handled by
`LINE_OVERRIDES` / `COORD_OVERRIDES` — this is a manually-maintained layer.

Some highlights are **hand-added by OSM way id**, appended straight to the
committed `wecc_path_lines.geojson.gz` (not produced by the matcher): the way
geometry is pulled from Overpass and stored as a `source: "osm"` feature with
`key` = the OSM way id (`score: 3.0` flags these manual entries). Paths added
this way include 27 (Adelanto–Intermountain HVDC), 32, 38, 40, 71, 75, and 90
(Gateway South). Paths 27 and 75 had no matcher output and are covered only by
these manual lines. To add another: fetch `way(id:<id>);out geom;` from
Overpass, build a LineString, and append `{path, source:"osm", key:"<id>",
kv, wecc_line, score:3.0}` — no rebuild needed.

## Caveats

- **The committed `.gz` files are hand-maintained — do not blindly rebuild.**
  `wecc_paths.geojson.gz` and `wecc_path_lines.geojson.gz` carry manual edits the
  parser knows nothing about and would silently drop: digitized corridors, moved
  markers, `number:`-prefixed / hyphen-normalized names, notes, and hand-added
  OSM highlight lines. Edit them in place (decompress, change, `gzip` back).
  `parse_paths.py` refuses to run without `--force` for this reason; use it only
  to regenerate raw catalog points from the PDF, then re-merge the manual edits.
- **Source files are private.** The catalog PDF and `Interface.csv` live in the
  gitignored `_private/wecc-paths/` folder, not in repo history.
- **Catalog vs CSV ratings drift.** Where the PDF and CSV disagree, the PDF wins
  (e.g. EOR catalog 10,650 MW vs CSV 10,100; COI 4,800 vs 5,100). The CSV is an
  older operational snapshot. All mismatches are itemized in the private
  `validation_report.md`.
- **Seasonal ratings are hand-transcribed.** `mw_fwd`/`mw_rev` hold the headline
  figure per direction. The three paths with season-/month-windowed limits
  (14 Idaho-to-Northwest, 25 PacifiCorp/PG&E, 45 SDG&E–CFE) set `seasonal: true`
  and carry a cleaned string in `rating_detail` (the popup's "Seasonal limits"
  row). These are transcribed by hand in `SEASONAL_OVERRIDES` in `parse_paths.py`,
  verified against the catalog page images — the table layout can't be parsed
  reliably. If a future catalog adds a seasonal path, the parser prints a warning
  to add it.
- **Directions are abbreviated** (`E-W`, `W-E`, `N-S`, `S-N`, `NE-SW`, `SW-NE`).
- **Deleted paths excluded.** Catalog entries marked `[Deleted]` and pointer
  entries (`(See Path …)`) are not rendered.
- Coordinates are single representative points, not the path's geographic extent.
