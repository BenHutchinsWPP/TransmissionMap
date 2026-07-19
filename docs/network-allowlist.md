# Network Allowlist (for IT/security review)

TransmissionMap is a static HTML/CSS/JS site — no backend, no login, no
confidential data. Everything shown comes from public sources (see
[data-sources.md](data-sources.md)). Visiting the page requires no download
of scripts, executables, or installers beyond what the browser loads to
render the page. Maintained by Ben Hutchins, Western Power Pool.

Live: **https://benhutchinswpp.github.io/TransmissionMap/**

**Traffic profile:** all requests are outbound HTTPS (port 443) GETs. No
cookies, no authentication, no WebSockets. The only user-entered data that
leaves the browser is text typed into the place-search box, sent to Esri's
geocoder.

## Required

The app fails to load or shows no data without these.

| Host | Why | If blocked |
|---|---|---|
| `benhutchinswpp.github.io` | The app itself (GitHub Pages) | Page doesn't load at all |
| `raw.githubusercontent.com` | All map data + live feeds (wildfire, NWS alerts, outages, weather) + GeoJSON/CSV download packs, served from the repo's `data-static` and `data` branches | Basemap renders but every data layer is empty; stale-data warnings appear |
| `tiles.openfreemap.org` | Default basemap: Light/Dark/Hydro vector tiles, map label fonts, icons | Gray/blank background on Light, Dark and Hydro; all map text missing |
| `geocode-api.arcgis.com` | Search box (place/address lookup) | Place search silently returns nothing |

## Optional

Only needed for specific basemap toggles or overlay layers — the app runs
without these, those features just won't load.

| Host | Feature |
|---|---|
| `tile.openstreetmap.org` | Street basemap |
| `ibasemaps-api.arcgis.com` | Aerial basemap above z15.5 (`server.arcgisonline.com` is the keyless dev fallback) |
| `basemap.nationalmap.gov` | Topo / Hydro basemaps + Aerial below z15.5 |
| `mesonet.agron.iastate.edu` | US radar overlay |
| `geo.weather.gc.ca` | Canadian radar overlay |
| `elevation-tiles-prod.s3.amazonaws.com` | 3D Terrain toggle (elevation tiles) |

## Click-through links (app works without them)

Some links open external sites in a new tab: the "Open with" menu
(`google.com`, `openstreetmap.org`, `openinframap.org`) and per-layer source
citations (various `.gov`/`.org` sites, listed in
[data-sources.md](data-sources.md)). If blocked, only that click fails —
nothing in the app breaks.

<!-- Maintainers: after adding a basemap, live feed, or layer with a new
source, re-derive the runtime host list and update the tables + date below:
    rg -o 'https?://[a-zA-Z0-9._-]+' assets/ src/ index.html | sort -u
Most hits are citation links; a host belongs here only if the app fetches
from it at runtime. -->

*Last verified: 2026-07-17*
