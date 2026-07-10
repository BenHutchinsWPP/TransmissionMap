# Weather: Radar (live)

Live radar raster overlay, conditions group: US NEXRAD composite reflectivity (IEM)
plus Canadian rain/snow radar (ECCC GeoMet WMS), one toggle. Registry entry:
`nexrad-radar` in `src/registry/conditions.ts` (mapLayerIds: `geomet-radar-rain`,
`geomet-radar-snow`, `nexrad-radar`).

## Source — US

| | |
|---|---|
| **Provider** | [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) (Iowa State University) |
| **Dataset** | USCOMP N0Q — CONUS composite base reflectivity tile cache, sourced from NWS NEXRAD |
| **License** | Public NWS data (US Government work, public domain); IEM asks that heavy/production traffic avoid hammering the tile cache |
| **Served** | External live XYZ tiles — nothing in `data/layers/` |
| **Built by** | None — direct tile link, no pipeline |
| **Download origin** | <https://mesonet.agron.iastate.edu/GIS/ridge.phtml> |

## Source — Canada

| | |
|---|---|
| **Provider** | [Environment and Climate Change Canada — MSC GeoMet](https://eccc-msc.github.io/open-data/) |
| **Dataset** | `RADAR_1KM_RRAI` (rain rate, mm/h) + `RADAR_1KM_RSNO` (snow rate, cm/h) — 1 km Canadian radar composite, WMS GetMap in EPSG:3857 |
| **License** | [ECCC Data Servers End-use Licence](https://eccc-msc.github.io/open-data/licence/readme_en/) — free use with attribution |
| **Served** | External live WMS (`geo.weather.gc.ca/geomet`), tiled via MapLibre `{bbox-epsg-3857}`; no key, CORS `*` |
| **Built by** | None — direct WMS link, no pipeline |
| **Notes** | GeoMet rejects multi-layer GetMap, so rain and snow are two separate raster sources. Omitting `TIME` returns the latest frame (~6-min update cadence). |

## Download pack

No pack ships — this is a live external tile service, not a static dataset. See the
download origin above for IEM's own radar tools and archives.

## Raster values

Raster — no vector attributes. Pixel value = base reflectivity in dBZ, rendered as a
baked color ramp by the IEM tile server (no client-side ramp, no hover readout).

| Bin | dBZ range | Color |
|---|---|---|
| Light | ~20–35 | `#04e304` |
| Moderate | ~35–50 | `#fdf802` |
| Heavy | ~50–60 | `#fd9500` |
| Extreme | 60+ | `#d40000` |
| Hail possible | 60+ (high-reflectivity core) | `#f800fd` |

## Caveats

- **Coverage: CONUS (IEM) + Canada (GeoMet)** — no Alaska, Hawaii, or offshore.
- **Palette seam at the border** — IEM renders dBZ, GeoMet renders precipitation
  rate (different ramps); the word-based legend absorbs this, but colors don't
  match exactly where coverage overlaps. IEM draws on top of GeoMet.
- **Latency** ~5–10 minutes between radar volume scan and tile availability.
- **Clear-air artifacts** — low-dBZ returns can be birds, insects, or ground clutter
  rather than precipitation.
- **Radial velocity deliberately excluded** — this layer is reflectivity only.
- **Refresh**: the source starts on IEM's `-0` (latest-frame) alias, but that alias
  resolves per tile in IEM's cache, so adjacent tiles can mix volume scans during a
  frame rollover. A 60-second `setInterval` in `addNexradRadar()`
  (`assets/layers/map-layers-conditions.ts`) polls IEM's `tms.json` for the current
  timestamped layer name (`ridge::USCOMP-N0Q-YYYYMMDDHHMM`) and calls `setTiles()`
  when the frame changes, so every tile renders the same scan. The same frame
  change cache-busts the two GeoMet sources (an ignored `_=` param), refreshing
  Canada on the same cadence.
- Precip-type overlays and animation are tracked as future work — see roadmap notes.
