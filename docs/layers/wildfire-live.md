# Live Wildfire (hotspots, perimeters, incidents, smoke)

Four **live** feature types refreshed hourly, sharing one GeoJSON file. Three registry
layers consume it:

| Layer id | Label | `urlCode` | Feature (`_type`) | Source |
|---|---|---|---|---|
| `wildfire-live` | Active Wildfire (~24h) | `WFL` | `perimeter` (Polygon) + `hotspot` (Point) | NIFC WFIGS + CWFIS (CA) perimeters · NASA FIRMS VIIRS |
| `wildfire-incidents` | Named Incidents (~24h) | `WFI` | `incident` (Point) | NIFC WFIGS incident locations |
| `wildfire-smoke` | Smoke Detection (~24h) | `SMK` | `smoke` (Polygon) | NOAA HMS smoke polygons |

All four `_type`s are merged into a **single** `wildfire_live.geojson`; the frontend
splits them into the map layers above by filtering on `_type`. These are **not** the
static [Wildfire Hazard Potential](wildfire-hazard.md) raster — that is a different
provider, layer, and pipeline.

## Source

| | |
|---|---|
| **Providers** | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) (VIIRS active fire) · [NIFC WFIGS](https://data-nifc.opendata.arcgis.com/) (US perimeters + incidents) · [CWFIS](https://cwfis.cfs.nrcan.gc.ca/) (Canada perimeter estimates) · [NOAA HMS](https://www.ospo.noaa.gov/Products/land/hms.html) (smoke) |
| **Coverage** | Hotspots: CONUS + Hawaii + Canada + Mexico/Central America (FIRMS country feeds). Perimeters: US (NIFC, surveyed) **+ Canada (CWFIS Fire M3, hotspot-derived estimates)**. Incidents + smoke are **US-only** (NIFC/NOAA are US agencies) |
| **Vintage** | Rolling — VIIRS last 24 h; US perimeters/incidents = WFIGS *Current*; CA perimeters = CWFIS M3 *current* (daily); smoke = latest available HMS day |
| **License** | Public domain (US Government work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105)); CWFIS under [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) (attribution) |
| **Served (prod)** | `wildfire_live.geojson` on the orphan **`data`** branch, fetched via `raw.githubusercontent.com` (CORS ok; ~5 min CDN lag). URL in `assets/constants.ts` → `DATA.wildfire_live`. |
| **Served (dev)** | Local `data/layers/wildfire_live.geojson` — **not in git** (`data/layers/` is gitignored). `make wildfire-dev` builds it, fetching all feeds live (no manual downloads). Offline: pass pre-downloaded VIIRS CSVs to `fetch_wildfire_live.py` as positional args. |
| **Built by** | `scripts/fetch_wildfire_live.py` (merges all feeds: VIIRS hotspots, NIFC + CWFIS perimeters, NIFC incidents, HMS smoke) |
| **Refresh** | `.github/workflows/wildfire-data.yml` — `workflow_dispatch` fired on a schedule by cron-job.org (sole trigger; GitHub's own cron dropped fires under load and was removed). Force-pushes an amended commit to the `data` branch (no history growth). `main` is never touched. A failed run opens/bumps a `wildfire-feed-down` issue. The cron-job.org job authenticates with a fine-grained PAT (Actions R/W, this repo only) that expires yearly. |

> **Hosting.** Lives on a one-commit orphan `data` branch rather than a Release asset —
> GitHub Release assets have no CORS, which breaks live-map fetches. R2 is the deferred
> upgrade if traffic grows. No download pack is built (live data — point users upstream).

## Live endpoints (upstream)

All pulled by `fetch_wildfire_live.py` (the workflow just runs it):

- **FIRMS VIIRS 24 h** (S-NPP + NOAA-20 CSVs), three feed regions each:
  - USA: `.../{suomi-npp,noaa-20}-viirs-c2/USA_contiguous_and_Hawaii/...24h.csv`
  - Canada: `.../{suomi-npp,noaa-20}-viirs-c2/csv/{SUOMI,J1}_VIIRS_C2_Canada_24h.csv`
  - Mexico/Central America: `.../csv/{SUOMI,J1}_VIIRS_C2_Central_America_24h.csv` (Mexico has no standalone country file; it lives in the Central_America region)
- **WFIGS perimeters (US):** `services3.arcgis.com/.../WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query`
- **CWFIS perimeter estimates (CA):** `cwfis.cfs.nrcan.gc.ca/geoserver/public/ows` WFS 2.0, `typeNames=public:m3_polygons_current`, GeoJSON (CORS `*`)
- **WFIGS incidents:** `services3.arcgis.com/.../WFIGS_Incident_Locations_Current/FeatureServer/0/query`
- **NOAA HMS smoke:** `satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/Shapefile/{year}/{month}/hms_smoke{date}.zip`

## Feature attributes

All features carry a `_type` discriminator (`hotspot` | `perimeter` | `incident` | `smoke`)
and `generated_utc` (pull time). The **first feature additionally carries `feed_status`**
(`{perimeters_us, perimeters_ca, incidents, smoke}` → `ok` | `failed` | smoke-only
`fallback-1d`/`fallback-2d`) — the frontend legend chips read it to flag a feed that
silently degraded to empty/old data despite a fresh pull (`assets/ui/ui-legends.ts`).
Hotspots never appear in it: a VIIRS failure fails the whole run instead (see Caveats).

| `_type` | Geometry | Key fields |
|---|---|---|
| `hotspot` | Point | VIIRS pixel: brightness, FRP, acq date/time, confidence, day/night |
| `perimeter` | Polygon | `country` (`US`/`CA`); US (NIFC): name, cause, state, discovery, contained %, acres, IRWIN id. CA (CWFIS): `hotspot_count`, discovery/updated dates, acres — **name/cause/contained are null** (estimated extent) |
| `incident` | Point | `UniqueFireIdentifier`, `IncidentName`, `IncidentTypeCategory`, `FireDiscoveryDateTime`, `PercentContained`, `IncidentSize`, `POOState` |
| `smoke` | Polygon | HMS density class + observation date |

## Caveats

- **Live & best-effort.** Upstream feeds go down; failure handling differs by feed:
  - **VIIRS hotspots (core):** fetch is retried 3× per URL; if still failing the run
    exits nonzero and nothing is published — the map keeps the last good pull, whose
    growing age the legend chips show and the 6-hour kill-switch modal
    (`assets/wildfire-staleness.ts`) enforces.
  - **Perimeters / incidents / smoke (secondary):** each degrades independently to
    empty (HMS smoke first falls back up to 2 days) so one flaky source doesn't block
    the rest. The pull still publishes with a fresh `generated_utc`, so the gap is
    flagged via `feed_status` (above) as an amber legend chip instead.
- **Production method varies by feed — not all are machine-generated:**
  - `hotspot` (VIIRS/FIRMS): fully automated satellite pixel detection, no human step.
  - `smoke` (NOAA HMS): **manually analyzed** — NOAA satellite analysts hand-draw the
    smoke polygons once per day (not a continuous automated feed), which is why a
    single stale/missing day is expected and tolerated (2-day fallback above). Exact
    daily publish time in ET is not confirmed — check
    https://www.ospo.noaa.gov/Products/land/hms.html before relying on freshness SLAs.
  - `perimeter`/`incident` (NIFC WFIGS, US): human-reported by fire agencies/incident
    command, not NASA/NOAA — updates as agencies file reports, can lag the actual
    fire by hours.
  - `perimeter` (CWFIS, CA): the one machine-derived exception — estimated from
    hotspot clustering, not human-surveyed (see below).
- **VIIRS hotspots are heat detections, not fires** — clouds, flares, and hot industrial
  sites produce false positives. Confidence field is the filter.
- Hotspots cover CONUS + Hawaii + Canada + Mexico/Central America; **Alaska is
  still excluded** (not in any pulled FIRMS region file). Incidents and smoke
  remain US-only — NIFC and NOAA are US agencies.
- **Canadian perimeters are estimates, not surveyed boundaries.** CWFIS Fire M3
  polygons are generated from clustered hotspots, so they carry no incident name,
  cause, or containment %, and the extent is approximate. US (NIFC) perimeters are
  the real thing. The popup labels CA ones "Fire Perimeter Estimate (CWFIS)".
  No national Canadian *named-incident* feed exists (provincial + fragmented), so
  there's no Canadian analog to the `incident` layer.
