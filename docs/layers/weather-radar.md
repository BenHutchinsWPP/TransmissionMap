# Weather: Radar (live)

Live NEXRAD composite reflectivity raster overlay, conditions group. Registry entry:
`nexrad-radar` in `src/registry/conditions.ts`.

## Source

| | |
|---|---|
| **Provider** | [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) (Iowa State University) |
| **Dataset** | USCOMP N0Q — CONUS composite base reflectivity tile cache, sourced from NWS NEXRAD |
| **License** | Public NWS data (US Government work, public domain); IEM asks that heavy/production traffic avoid hammering the tile cache |
| **Served** | External live XYZ tiles — nothing in `data/layers/` |
| **Built by** | None — direct tile link, no pipeline |
| **Download origin** | <https://mesonet.agron.iastate.edu/GIS/ridge.phtml> |

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

- **CONUS only** — no Alaska, Hawaii, Canada, or offshore coverage.
- **Latency** ~5–10 minutes between radar volume scan and tile availability.
- **Clear-air artifacts** — low-dBZ returns can be birds, insects, or ground clutter
  rather than precipitation.
- **Radial velocity deliberately excluded** — this layer is reflectivity only.
- **Refresh**: the source starts on IEM's `-0` (latest-frame) alias, but that alias
  resolves per tile in IEM's cache, so adjacent tiles can mix volume scans during a
  frame rollover. A 60-second `setInterval` in `addNexradRadar()`
  (`assets/layers/map-layers-conditions.ts`) polls IEM's `tms.json` for the current
  timestamped layer name (`ridge::USCOMP-N0Q-YYYYMMDDHHMM`) and calls `setTiles()`
  when the frame changes, so every tile renders the same scan.
- Precip-type overlays and animation are tracked as future work — see roadmap notes.
