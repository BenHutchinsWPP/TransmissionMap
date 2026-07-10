# NWS Weather Alerts (live)

A **live** layer of curated, polygon-bearing NOAA/NWS active weather alerts (tornado,
severe thunderstorm, flash flood, fire weather, heat, high wind, winter storm, tropical,
and a small "other" bucket), refreshed on a short cycle. Panel group: **🔥 Hazards**.

## Source

| | |
|---|---|
| **Provider** | NOAA / National Weather Service — [api.weather.gov](https://api.weather.gov) `/alerts/active?status=actual` |
| **License** | Public domain — US Government work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Coverage** | US (all NWS forecast offices, including territories where alerts are issued) |
| **Vintage** | Rolling — whatever is `active` at pull time |
| **Served (prod)** | `nws_alerts.geojson` on the orphan **`data`** branch, fetched via `raw.githubusercontent.com` (same hosting pattern as [live wildfire](wildfire-live.md) — GitHub Release assets have no CORS, which breaks live-map fetches) |
| **Served (dev)** | Local `data/layers/nws_alerts.geojson` — **not in git** (`data/layers/` is gitignored). `make nws-alerts-dev` builds it, fetching live from api.weather.gov (no manual downloads). Offline: pass a pre-downloaded `alerts/active` response to `fetch_nws_alerts.py --input`. |
| **Built by** | `scripts/fetch_nws_alerts.py` |
| **Refresh** | `.github/workflows/nws-alerts.yml` — **`workflow_dispatch` only** for now (no `schedule:` trigger yet); intended to be fired by cron-job.org at roughly a 10-minute cadence once wired up (not yet configured as of this writing). Joins the shared `data-branch` concurrency group (also used by `wildfire-data.yml` and `odin-outages.yml`) so force-pushes to the orphan `data` branch don't collide. A failed run opens/bumps an `nws-alerts-feed-down` issue. |

### Curated event allowlist

Only a fixed allowlist of alert `event` types is kept, grouped server-side into a `_group`
prop (drives layer color and the legend filter). Anything not in this list is dropped
entirely, regardless of geometry:

| `_group` | Events |
|---|---|
| `convective` | Tornado Warning, Tornado Watch, Severe Thunderstorm Warning, Severe Thunderstorm Watch |
| `flood` | Flash Flood Warning, Flash Flood Watch, Flood Warning, Flood Watch |
| `fire` | Red Flag Warning, Fire Weather Watch, Extreme Fire Danger |
| `heat` | Extreme Heat Warning, Extreme Heat Watch, Heat Advisory |
| `wind` | High Wind Warning, High Wind Watch, Extreme Wind Warning, Dust Storm Warning, Blowing Dust Warning |
| `winter` | Ice Storm Warning, Blizzard Warning, Extreme Cold Warning, Extreme Cold Watch, Freeze Warning, Snow Squall Warning |
| `tropical` | Hurricane Warning, Hurricane Watch, Tropical Storm Warning, Tropical Storm Watch, Storm Surge Warning, Storm Surge Watch |
| `other` | Nuclear Power Plant Warning, Radiological Hazard Warning, Ashfall Warning |

Within the allowlist, **only polygon-bearing alerts are kept** (phase 1). NWS issues many
alerts — notably all heat and fire-weather alerts — against forecast zones with no
geometry attached to the API response (`geometry: null`); those are dropped, not
approximated. See Caveats.

## Download pack

None — this is live data, not a static release pack. Point users at the upstream feed:
[weather.gov/alerts](https://www.weather.gov/alerts) (or [api.weather.gov](https://api.weather.gov)
for the raw JSON), same as [live wildfire](wildfire-live.md).

## Fields

Every kept feature carries exactly these 13 properties (all other API fields are stripped
by `fetch_nws_alerts.py`). Example counts below are from the 2026-07-09 verification pull:
46 alerts kept out of 325 active fetched; every heat and red-flag alert in that pull was
dropped as null-geometry (0 kept for those two groups that pull).

| Field | Description | Example |
|---|---|---|
| `event` | NWS alert type — the string used to look up `_group` via the allowlist | `"Tornado Warning"` |
| `severity` | NWS severity code | `Extreme` \| `Severe` \| `Moderate` \| `Minor` \| `Unknown` |
| `certainty` | NWS certainty code | `Observed` \| `Likely` \| `Possible` \| `Unlikely` \| `Unknown` |
| `urgency` | NWS urgency code | `Immediate` \| `Expected` \| `Future` \| `Past` \| `Unknown` |
| `headline` | Human-readable one-line summary as issued by the forecast office | `"Flash Flood Warning issued ... by NWS"` |
| `onset` | ISO 8601 alert onset timestamp | `"2026-07-09T14:00:00-05:00"` |
| `ends` | ISO 8601 alert end timestamp; can be `null` (some products only carry `expires`) | `"2026-07-09T15:30:00-05:00"` \| `null` |
| `expires` | ISO 8601 expiration timestamp — always present, used as the `ends` fallback for expiry pruning | `"2026-07-09T15:30:00-05:00"` |
| `areaDesc` | Human-readable affected-area list (counties/zones), semicolon-separated | `"Dallas, TX; Tarrant, TX"` |
| `senderName` | Issuing NWS office | `"NWS Fort Worth TX"` |
| `id` | NWS alert unique identifier (the API's `properties.id` URI) | `"https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0...."` |
| `_group` | Curated bucket computed by `fetch_nws_alerts.py` from `event` (see allowlist table above) | `"convective"` |
| `generated_utc` | Pull timestamp (UTC) — identical across every feature in the file, read by the staleness kill-switch | `"2026-07-09T18:05:00Z"` |

## Caveats

- **Polygon-bearing storm-based warnings only (phase 1).** Long-duration alerts issued on
  forecast zones — heat, red-flag/fire-weather, winter storm watches, and similar — carry
  `geometry: null` in the NWS API and are **excluded**, not approximated. They do carry a
  county-FIPS `geocode.SAME` code, so a phase-2 join onto the shared county-boundary tiles
  (`docs/layers/boundaries.md`) is planned to bring them in without needing zone-polygon
  geometry; not implemented yet.
- **Live & best-effort, no SLA.** The frontend force-disables the layer via a kill-switch
  modal when the last successful pull is more than 3 hours old (mirrors the wildfire
  staleness pattern in `wildfire-staleness.ts` / `live-staleness.ts`, but with its own
  shorter 3 h threshold). Independently of that, the client prunes any alert whose
  `ends`/`expires` time has passed on every refresh, so a missed workflow cycle doesn't
  leave dead warnings on the map between pulls.
- **Situational awareness only, not an alerting system.** These are official NWS products,
  but this map has no delivery guarantee, no push notification, and can lag or silently
  fail. For authoritative, timely alerts use [weather.gov/alerts](https://www.weather.gov/alerts)
  directly, not this map.
- **Marine, administrative, and AMBER-style products are deliberately excluded** — the
  allowlist only covers the convective/flood/fire/heat/wind/winter/tropical/other event
  types listed above; anything else (e.g. Small Craft Advisory, Civil Emergency Message,
  Child Abduction Emergency) is dropped regardless of geometry.
