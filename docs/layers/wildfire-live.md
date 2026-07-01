# Live Wildfire (hotspots, perimeters, incidents, smoke)

Four **live** feature types refreshed hourly, sharing one GeoJSON file. Three registry
layers consume it:

| Layer id | Label | `urlCode` | Feature (`_type`) | Source |
|---|---|---|---|---|
| `wildfire-live` | Active Wildfire (live) | `WFL` | `perimeter` (Polygon) + `hotspot` (Point) | NIFC WFIGS + CWFIS (CA) perimeters · NASA FIRMS VIIRS |
| `wildfire-incidents` | Named Incidents (live) | `WFI` | `incident` (Point) | NIFC WFIGS incident locations |
| `wildfire-smoke` | Smoke Detection (live) | `SMK` | `smoke` (Polygon) | NOAA HMS smoke polygons |

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
| **Served (dev)** | Local `data/layers/wildfire_live.geojson` — a snapshot **is committed to `main`** (offline-dev seed; no automation refreshes it, so it's frozen at whenever it was last committed). Run `make wildfire-dev` to pull fresh fire data. |
| **Built by** | `scripts/firms_csv_to_geojson.py` (merges all feeds: VIIRS hotspots, NIFC + CWFIS perimeters, NIFC incidents, HMS smoke) |
| **Refresh** | `.github/workflows/wildfire-data.yml` — hourly cron, force-pushes an amended commit to the `data` branch (no history growth). `main` is never touched. |

> **Hosting.** Lives on a one-commit orphan `data` branch rather than a Release asset —
> GitHub Release assets have no CORS, which breaks live-map fetches. R2 is the deferred
> upgrade if traffic grows. No download pack is built (live data — point users upstream).

## Live endpoints (upstream)

Pulled by `firms_csv_to_geojson.py` / the workflow:

- **FIRMS VIIRS 24 h** (S-NPP + NOAA-20 CSVs), three feed regions each:
  - USA: `.../{suomi-npp,noaa-20}-viirs-c2/USA_contiguous_and_Hawaii/...24h.csv`
  - Canada: `.../{suomi-npp,noaa-20}-viirs-c2/csv/{SUOMI,J1}_VIIRS_C2_Canada_24h.csv`
  - Mexico/Central America: `.../csv/{SUOMI,J1}_VIIRS_C2_Central_America_24h.csv` (Mexico has no standalone country file; it lives in the Central_America region)
- **WFIGS perimeters (US):** `services3.arcgis.com/.../WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query`
- **CWFIS perimeter estimates (CA):** `cwfis.cfs.nrcan.gc.ca/geoserver/public/ows` WFS 2.0, `typeNames=public:m3_polygons_current`, GeoJSON (CORS `*`)
- **WFIGS incidents:** `services3.arcgis.com/.../WFIGS_Incident_Locations_Current/FeatureServer/0/query`
- **NOAA HMS smoke:** `satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/Shapefile/{year}/{month}/hms_smoke{date}.zip`

## Feature attributes

All features carry a `_type` discriminator (`hotspot` | `perimeter` | `incident` | `smoke`).

| `_type` | Geometry | Key fields |
|---|---|---|
| `hotspot` | Point | VIIRS pixel: brightness, FRP, acq date/time, confidence, day/night |
| `perimeter` | Polygon | `country` (`US`/`CA`); US (NIFC): name, cause, state, discovery, contained %, acres, IRWIN id. CA (CWFIS): `hotspot_count`, discovery/updated dates, acres — **name/cause/contained are null** (estimated extent) |
| `incident` | Point | `UniqueFireIdentifier`, `IncidentName`, `IncidentTypeCategory`, `FireDiscoveryDateTime`, `PercentContained`, `IncidentSize`, `POOState` |
| `smoke` | Polygon | HMS density class + observation date |

## Caveats

- **Live & best-effort.** Upstream feeds go down; the workflow tolerates a missing day
  (HMS falls back up to 2 days). A stale file means the map shows the last good pull.
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
- `scripts/hms_smoke_to_geojson.py` is a standalone smoke-only helper; the live pipeline
  uses `firms_csv_to_geojson.py`, which merges smoke too.
- `data/layers/smoke_live.geojson` is a **dead artifact** from the old standalone smoke
  pipeline — no code reads it (smoke comes from `wildfire_live.geojson`). Kept in `main`
  for now; safe to delete post-release.
