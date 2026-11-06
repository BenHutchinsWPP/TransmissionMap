# Transmission line tools

Exact lengths, copies with full geometry, a fault locator and an elevation profile for
the OSM world and HIFLD transmission lines. They read the line GeoParquet that
`make line-parquet` builds ([pipeline.md](pipeline.md) § *Line
geometry*); on a host without `index.json` each entry point stays hidden.

## Entry points

| where | what | code |
|---|---|---|
| a transmission line's popup | a **Length** row (one IDX range read), **Copy to My Data** and **Line tools**, added once the lookup answers | `assets/popup.ts` → `assets/lines/line-read.ts` |
| edit mode, a click on a line | Copy to My Data with the full geometry (`resolveHits` → `copy-tiled`); no files → the "can't copy" note | `assets/click-resolve.ts`, `assets/lines/line-copy.ts` |
| the table drawer, any GeoJSON layer or a line layer | **Copy N checked to My Data** (lines: "Copy N checked lines") into one new My Data layer, shown once the layer's copy answers `copyAvailable`; a GeoJSON layer copies each row's own geometry, a line layer the full geometry above | `assets/ui/ui-table.ts` → `assets/user-data/copy-rows.ts` (caps and download: `assets/user-data/copy-fit.ts`) |
| popup ▸ Line tools | the drawer's **Line** tab: fault locator and elevation profile | `assets/ui/line-open.ts` → `assets/ui/ui-line.ts`, `assets/ui/line-profile.ts` |

## Copy

The file geometry replaces the tile's clipped, simplified one; the tile feature's
properties ride along with `source`, `attribution`, `licence` and, for OSM, an
openstreetmap.org link. A line the files cannot give keeps its tile geometry, marked
`geometry_source: "simplified from map tiles"`. Caps: 1,000 lines, 1.5 MB of GeoJSON,
and a projected `tm-user-data` store of at most 4 MB; beyond them the button offers a
GeoJSON download (attribution and licence as foreign members) instead. A copy is My
Data: no link change, no undo step. The table copies only the rows it lists, and on a
tiled layer those are the loaded tiles' rows.

A GeoJSON layer's checked rows copy their own geometry, with the same properties, credits and caps.

The map chat's `copyToMyData` tool runs the same copy on the rows its `where`, `area` or `ids`
pick (`assets/map-api.ts`, `assets/agent/tools.ts`). Above 50 features in one ask, the chat asks
first, on the rows that would be copied; the 50 is a running total over the ask's model calls.
The model is told only the counts and the outcome (`loop.ts` `toolContent`). A copy over the caps
or a refused save offers its GeoJSON download as a page-owned button on the chat chip; a restored
chat shows "Copy again to download" in its place, since the features are not stored.

## Fault locator

- **Scope:** the whole chain (the default when the way is part of one) or the clicked
  way. A chain joins ways end to end and follows conductors, not circuits; the tab
  says so, and names the circuit count when OSM maps more than one.
- **Ends:** HIFLD end A is `SUB_1` and end B `SUB_2`. HIFLD stores no direction, so the
  page places them by the HIFLD substations of those names nearest each end and says
  when it cannot (Swap A and B). OSM ends are the chain's end substations, named from
  the substation points archive (`assets/lines/osm-substation.ts`, 1–4 small tiles)
  and linked to openstreetmap.org; an end at no substation shows its coordinates and a
  note that the fault may lie beyond.
- **Input:** a distance from A, from B or both (display units), an optional line length
  from the relay settings (the distance is scaled by map length ÷ relay length) and
  ±% uncertainty (default 2 % of the line length).
- **Output:** a pin per distance, walked along the true geometry
  (`assets/lines/along.ts`, sphere R = 6371.0088 km, the same lengths as the files),
  its coordinates to 6 decimals, the span on the map, the gap between two pins, Copy
  coordinates, Zoom and Add pin to My Data.
- **Refusals in words:** the files could not be read (the locator never measures along
  tile geometry), pieces more than 5 m apart (drawn on the map), a distance past the
  far end.

## Elevation profile

Nothing leaves the page until **Show elevation profile**. The line is sampled every
max(30 m, L / 4,999) — at most 5,000 points. Points inside the 3DEP coverage boxes go
to the USGS 3DEP ImageServer (`getSamples`, ≤ 1,000 points per form POST, always with
`pixelSize`, ≤ 4 in flight, 30 s timeout, one retry); what 3DEP leaves empty comes from
Terrain Tiles; a point neither answers is a gap, never 0. The intro says points go to
USGS only when some of the line is inside that coverage. The chart colours each
source, follows the pointer or ←/→ with a marker on the map, and shows the fault pins;
min, max, climb and descent (2 m hysteresis). PNG and CSV
(`distance_<unit>,lon,lat,elev_<unit>,source`, BOM, formula-guarded, the datum note
and credits). The last 20 profiles are kept for the session.

## Hosts and privacy

The line files and the substation archive come from the data host. USGS
(`elevation.nationalmap.gov`) receives the sample coordinates of a public line after
the Show click, and nothing else; it is in `CSP_HOSTS`,
[network-allowlist.md](network-allowlist.md) (optional: Terrain Tiles fill in when it
is blocked) and a Diagnostics probe.
