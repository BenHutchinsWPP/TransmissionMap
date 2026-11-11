# Network Allowlist (for IT/security review)

TransmissionMap is a static HTML/CSS/JS site — no backend, no login, no
confidential data. Everything shown comes from public sources (see
[data-sources.md](data-sources.md)). Visiting the page requires no download
of scripts, executables, or installers beyond what the browser loads to
render the page. Maintained by Ben Hutchins, Western Power Pool.

Live: **https://www.wpptx.org/**

**Traffic profile:** all requests are outbound HTTPS (port 443); they are GETs except the
map chat (OpenRouter) and the line elevation profile (USGS 3DEP `getSamples`), which send
POSTs. No
cookies, no authentication, no WebSockets. The only user-entered data that
leaves the browser is text typed into the place-search box, sent to Esri's
geocoder, and — only for a visitor who opens the map chat and enters their own
OpenRouter key — the chat messages, sent to OpenRouter (HTTPS POST). A visitor
who adds a map service also sends that service's map requests to its host (see
[User-selected layers](#user-selected-layers)).

**Content Security Policy:** the published page carries a CSP (a `<meta
http-equiv>` tag, since GitHub Pages sets no response headers). Its
`connect-src` and `img-src` name the hosts in the two tables below and also
admit any other HTTPS host, for the map services a visitor adds; plain HTTP is
refused. Scripts load only from the page's own host.

## Required

The app fails to load or shows no data without these.

| Host | Why | If blocked |
|---|---|---|
| `www.wpptx.org` | The app itself (GitHub Pages) | Page doesn't load at all |
| `data.wpptx.org` | The project's built map layers, analysis files, download packs and the route planner's data (`data/route/<id>/`, read with `Range` GETs) | Basemap renders but every data layer is empty; the Route panel and Routing constraints layer report their data unavailable |
| `live.wpptx.org` | The project's live feeds (wildfire, NWS alerts, outages, weather) | Live layers stay empty and stale-data warnings appear |
| `tiles.openfreemap.org` | Default basemap: Light/Dark/Hydro vector tiles, map label fonts, icons; also the road/place/boundary overlay drawn over Aerial | Gray/blank background on Light, Dark and Hydro; all map text missing; Aerial shows imagery with no roads or place names |
| `geocode-api.arcgis.com` | Search box (place/address lookup) | Place search silently returns nothing |

## Optional

Only needed for specific basemap toggles, overlay layers, or older shared
links — the app runs without these, those features just won't load.

| Host | Feature |
|---|---|
| `tile.openstreetmap.org` | Street basemap |
| `ibasemaps-api.arcgis.com` | Aerial basemap above z15.5 (`server.arcgisonline.com` is the keyless dev fallback) |
| `basemap.nationalmap.gov` | Topo / Hydro basemaps + Aerial below z15.5 |
| `mesonet.agron.iastate.edu` | US radar overlay |
| `geo.weather.gc.ca` | Canadian radar overlay |
| `elevation-tiles-prod.s3.amazonaws.com` | 3D Terrain and Hillshade toggles (elevation tiles) |
| `elevation.nationalmap.gov` | Line elevation profile (USGS 3DEP elevation samples), only after a visitor opens a line's profile; if blocked, the profile uses the elevation tiles above |
| `moratoriums.wpptx.org` | Data center moratoriums layer |
| `s3.us-west-2.amazonaws.com` | Grid Operations layer (EIA-930 hourly data read from the PUDL Project's published tables, path `/pudl.catalyst.coop/`), only while that layer is on |
| `openrouter.ai` | Map chat, only after a visitor enters their own OpenRouter key; nothing is sent otherwise |
| `benhutchinswpp.github.io` | Opening a link shared before the move to `www.wpptx.org` — GitHub Pages redirects it, keeping the path and map state |

## Click-through links (app works without them)

Some links open external sites in a new tab: the "Open with" menu
(`google.com`, `openstreetmap.org`, `openinframap.org`), the per-layer download
packs (from `data.wpptx.org`, above) and
per-layer source
citations (various `.gov`/`.org` sites, listed in
[data-sources.md](data-sources.md)). If blocked, only that click fails —
nothing in the app breaks.

## User-selected layers

A visitor can add a map service to the map — from the built-in library or by
pasting its URL — and the map chat can add one after the visitor confirms it.
The browser then contacts that service's host directly over HTTPS (port 443),
with no request passing through TransmissionMap. These hosts depend on what
each visitor chooses, so an IT allowlist cannot enumerate them in advance. The
curated list of library hosts ships with the library. If a host is blocked, only
the layer from that service stays empty.

## Map chat charts and canvases

Only for a visitor who uses the map chat: the charts and pages the chat draws
run in their own sandboxed frame (`/canvas.html`), which loads chart and
drawing libraries and web fonts from these hosts. The frame has its own
Content Security Policy, which admits these hosts and the basemap tile hosts
in the Optional table above, and nothing else: it cannot reach the project's
data host, the geocoder or OpenRouter, and it holds no key.

| Host | Feature |
|---|---|
| `cdn.jsdelivr.net` | Chat charts (Vega and Vega-Lite, pinned versions with integrity hashes) and the libraries a chat canvas loads |
| `cdnjs.cloudflare.com` | Libraries a chat canvas loads |
| `unpkg.com` | Libraries a chat canvas loads |
| `fonts.googleapis.com` | Web-font stylesheets a chat canvas loads |
| `fonts.gstatic.com` | The font files those stylesheets name |

If blocked, chat charts and canvases show an error in their card; the rest of
the app, the chat included, is unaffected.

## Checking it from a browser

The app can test these hosts itself: **Tools ▸ Diagnostics** probes every
host in the Required and Optional tables, and the chart and canvas hosts
except `fonts.gstatic.com`, and reports what the browser observed. Note that a
browser cannot distinguish a blocked request from a host being down from a
CORS rejection, so the panel reports observations, not causes.

<!-- Maintainers: after adding a basemap, live feed, or layer with a new
source, re-derive the runtime host list and update the tables + date below:
    rg -o 'https?://[a-zA-Z0-9._-]+' assets/ src/ index.html | sort -u
Most hits are citation links; a host belongs here only if the app fetches
from it at runtime.
The same hosts are enumerated a second time in DIAG_CHECKS
(assets/diagnostics.ts) as probe targets — update both together. The CSP is
built from CSP_HOSTS (assets/constants.ts), and assets/csp.test.ts fails until
these two tables and that list name the same hosts. The chat canvas's own
policy is built by scripts/build_sandbox.mjs from src/registry/canvas-hosts.json,
which assets/sandbox/canvas.test.ts holds to CSP_HOSTS minus the data host,
the geocoder and OpenRouter. -->
