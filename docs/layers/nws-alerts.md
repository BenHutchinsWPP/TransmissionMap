# NWS Weather Alerts (live)

A **live** layer of curated NOAA/NWS active weather alerts (tornado,
severe thunderstorm, flash flood, fire weather, heat, high wind, winter storm, tropical,
and a small "other" bucket), refreshed on a short cycle. Panel group: **🌡 Conditions**.

Coverage as of phase 2: (1) US storm-based alerts with real polygon geometry
(tornado/severe-tstorm/flash-flood warnings, etc.), rendered directly; (2)
US long-duration alerts issued against forecast/fire zones or counties with
**no** polygon geometry (heat, red flag, winter storm watches, ...), joined
client-side onto NWS zone or county polygons — see "Zone/county join
(phase 2)" below; (3) Canadian alerts from Environment and Climate Change
Canada (ECCC), which carry real polygon geometry and need no join — see
"Canada (ECCC)" below. No curated alert is dropped regardless of geometry.

## Source

| | |
|---|---|
| **Provider** | NOAA / National Weather Service — [api.weather.gov](https://api.weather.gov) `/alerts/active?status=actual`; Environment and Climate Change Canada — [MSC GeoMet](https://api.weather.gc.ca) `collections/weather-alerts/items` (phase 2) |
| **License** | Public domain — US Government work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) (NWS); ECCC data is under Canada's Open Government Licence — attribution required, see [data-sources.md](../data-sources.md) |
| **Coverage** | US (all NWS forecast offices, including territories where alerts are issued) + Canada (ECCC, phase 2) |
| **Vintage** | Rolling — whatever is `active` (NWS) / not `status_en: ended` (ECCC) at pull time |
| **Served (prod)** | `nws_alerts.geojson` on the orphan **`data`** branch, fetched via `raw.githubusercontent.com` (same hosting pattern as [live wildfire](wildfire-live.md) — GitHub Release assets have no CORS, which breaks live-map fetches). Zone-join tileset `nws_zones.pmtiles` is separately published to `data-static` (see "Zone/county join" below). |
| **Served (dev)** | Local `data/layers/nws_alerts.geojson` — **not in git** (`data/layers/` is gitignored). `make nws-alerts-dev` builds it, fetching live from api.weather.gov + api.weather.gc.ca (no manual downloads). Offline: pass pre-downloaded responses to `fetch_nws_alerts.py --input` (NWS) and `--input-eccc` (ECCC). |
| **Built by** | `scripts/fetch_nws_alerts.py` |
| **Refresh** | `.github/workflows/nws-alerts.yml` — **`workflow_dispatch` only** for now (no `schedule:` trigger yet); intended to be fired by cron-job.org at roughly a 10-minute cadence once wired up (not yet configured as of this writing). Joins the shared `data-branch` concurrency group (also used by `wildfire-data.yml` and `odin-outages.yml`) so force-pushes to the orphan `data` branch don't collide. Failed runs surface only as a stale/aging snapshot on the map (no automatic issue). |

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
| `winter` | Ice Storm Warning, Blizzard Warning, Extreme Cold Warning, Extreme Cold Watch, Freeze Warning, Snow Squall Warning, Winter Storm Warning, Winter Storm Watch |
| `tropical` | Hurricane Warning, Hurricane Watch, Tropical Storm Warning, Tropical Storm Watch, Storm Surge Warning, Storm Surge Watch |
| `other` | Nuclear Power Plant Warning, Radiological Hazard Warning, Ashfall Warning |

Within the allowlist, alerts with real polygon geometry render directly in `features`.
NWS issues many alerts — notably all heat and fire-weather alerts — against forecast
zones with no geometry attached to the API response (`geometry: null`); as of phase 2
those are **no longer dropped**: they're emitted into a top-level `zone_alerts` sidecar
and joined client-side onto zone/county polygons (see "Zone/county join (phase 2)" below).

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
| `country` | `"US"` or `"CA"` (phase 2) — set on every polygon feature | `"US"` |
| `feed_status` | Present on `features[0]`'s properties for back-compat (phase 2), **and** mirrored at the FeatureCollection top level (see "Feed metadata & stats" below). `{"eccc": "ok"|"failed"}` — mirrors `fetch_wildfire_live.py`'s dict-of-subkey pattern, read by `assets/ui/ui-legends.ts` for the amber degraded-feed chip | `{"eccc": "ok"}` |

## Feed metadata & stats

In addition to the per-feature `generated_utc`/`feed_status` properties above (and the
`features[0]`-only `feed_status` kept for back-compat with older frontends), the
FeatureCollection itself now always carries three top-level keys, written even when
`features` is empty:

| Key | Description |
|---|---|
| `generated_utc` | Same pull timestamp as every feature's `generated_utc` property |
| `feed_status` | Same `{"eccc": "ok"|"failed"}` dict as `features[0]`'s copy |
| `stats` | `{"fetched", "kept", "zone_joined", "eccc_kept", "dropped", "same_statewide_skipped", "malformed_same", "marine_zones_skipped", "county_ugc_fallback"}` — `fetched` is total US alerts fetched before curation; `kept` is US polygon alerts kept; `zone_joined` is the length of `zone_alerts`; `eccc_kept` is Canadian alerts kept; `dropped` is curated-but-unjoinable alerts (no zones/fips) truly dropped; `same_statewide_skipped` is statewide (county part `000`) SAME codes skipped; `malformed_same` is non-6-digit SAME codes skipped; `marine_zones_skipped` is marine UGCs skipped (land-only zone tileset); `county_ugc_fallback` is alerts whose FIPS came from county UGCs because SAME was absent |

When run under GitHub Actions (`GITHUB_ACTIONS` env var set) and `stats.dropped > 0`,
`fetch_nws_alerts.py` prints a `::warning::` workflow command to stdout so the dropped
count surfaces as a CI annotation on the workflow run.

## Zone/county join (phase 2)

Curated US alerts issued against forecast zones, fire weather zones, or counties (no
polygon geometry in the NWS API) are parsed from each alert's `affectedZones` (zone type
+ UGC) and `geocode.SAME` (county FIPS) into a top-level
**`zone_alerts`** sidecar array on the FeatureCollection — a key old frontends ignore, so
the file stays backward compatible:

```jsonc
{
  "type": "FeatureCollection",
  "features": [ /* polygon alerts, unchanged from phase 1 */ ],
  "zone_alerts": [
    {
      "zones": [["forecast", "TXZ103"], ["fire", "TXZ203"]], // [type, ugc] pairs
      "fips": ["48113"],
      "event": "Heat Advisory",
      "severity": "Moderate", "certainty": "Likely", "urgency": "Expected",
      "headline": "Heat Advisory issued ... by NWS",
      "onset": "2026-07-09T14:00:00-05:00",
      "ends": "2026-07-09T20:00:00-05:00",
      "expires": "2026-07-09T20:00:00-05:00",
      "areaDesc": "Dallas, TX; Tarrant, TX",
      "senderName": "NWS Fort Worth TX",
      "id": "https://api.weather.gov/alerts/urn:oid:...",
      "_group": "heat"
    }
  ]
}
```

SAME codes follow the format `PSSCCC` — a leading portion digit `P` (1-9 for partial-county
coverage, e.g. Puerto Rico, `0` for full coverage) followed by 5-digit state+county FIPS.
`fetch_nws_alerts.py` strips the portion digit for any 6-digit SAME code, but **skips**
(does not emit into `fips`) any whose county part is `"000"` — a statewide code with no
county polygon to join — counting the skips into `stats.same_statewide_skipped` (see
"Feed metadata & stats" above). Non-6-digit SAME codes are skipped, logged as suspect to
stderr, and counted into `stats.malformed_same`.

`geocode.SAME` is not a required CAP field: when it's absent, county FIPS are derived
from the alert's `/zones/county/<UGC>` URLs instead (`SSC###` → state FIPS + `###`,
via a static state-abbrev→FIPS map), counted into `stats.county_ugc_fallback`.

Marine UGCs (prefixes `AM/AN/GM/PZ/PK/PH/PM/PS/LE/LH/LM/LO/LC/LS/SL`) share the
`/zones/forecast/` API path but have no polygons in the land-only `nws_zones` tileset —
they are skipped and counted into `stats.marine_zones_skipped`. Curated alerts with mixed
land+marine zones still paint their land zones; a marine-zone tileset is a separate
decision.

A zone or county can carry several alerts at once; the frontend picks a display winner by
severity rank (Extreme > Severe > Moderate > Minor > unknown), tie-broken by earliest
`ends`, but the popup lists every alert on that zone/county.

**Zone polygons** are built by `scripts/extract_nws_zones.py` (`make nws-zones`) from the
NWS WSOM shapefiles listed at
[weather.gov/gis/PublicZones](https://www.weather.gov/gis/PublicZones) (public forecast
zones, current `z_16ap26.zip`) and
[weather.gov/gis/FireZones](https://www.weather.gov/gis/FireZones) (fire weather zones,
current `fz16ap26.zip`), both hosted under
`https://www.weather.gov/source/gis/Shapefiles/WSOM/`, EPSG:4269, public domain. The two
zone sets share the UGC string format (`STATE` + `"Z"` + 3-digit `ZONE`) but are
**different polygon sets** — 3016 UGC codes exist in both with materially different
geometry (one sampled zone, `NCZ051`, differs 62% in area between the two) — so every join
uses `(type, ugc)`, never bare UGC. The script dissolves multipart duplicate rows by
`(ugc, type)` and writes `data/build/nws_zones.geojson` with fields `ugc`, `type`
(`"forecast"|"fire"`), `name`, and `key` (`"z"+ugc` for `type=forecast`, `"f"+ugc` for
`type=fire` — the single string used as the pmtiles `promoteId`, since MapLibre
`promoteId` needs one scalar per feature and bare `ugc` collides). `tile_manifest.yaml`
builds this into **`nws_zones.pmtiles`** (source layer `nws_zones`, 7683 features, 5.06
MB). Like `county_boundaries` (see [boundaries.md](boundaries.md)), this is shared
join infra with no `release_manifest.yaml` download-pack entry and no legend of its own.
`/zones/county/`-issued alerts need no new tileset — they fall back to the existing
`county_boundaries.pmtiles` join via FIPS (see [boundaries.md](boundaries.md); NWS
county-coded alerts join the same shared tileset ODIN outages uses).

Zone shapefiles change only a few times a year (NWS reissues zones periodically for
CWA/zone boundary changes), so rebuilding `nws_zones.pmtiles` is a **manual** pipeline
step (`make nws-zones` then `make publish-data`) — it is not part of the 10-minute feed
cadence and not triggered automatically.

**Vintage drift detection:** `extract_nws_zones.py` also writes the sorted tile-key list
to `scripts/nws_zone_keys.txt` (committed; `data-feed.yml` copies it next to the fetch
script). `fetch_nws_alerts.py` checks every alert's zone key against it — unknown keys
(an alert naming a UGC created after the tileset build, which would silently no-paint)
are counted into `stats.unknown_zone_keys`, logged, and surfaced as a CI `::warning::`
annotation. That warning is the rebuild reminder: run `make nws-zones`, `make
publish-data`, and commit the refreshed key list. Current vintage is valid to Apr 2026;
expect the next NWS revision ~spring 2027. If the key file is missing the check is
skipped (fail-open), never a feed failure.

**Frontend join module:** `assets/nws-zone-join.ts` (model: `assets/odin-outages.ts`).
On every alerts refresh it lazy-adds the `nws_zones` vector source (`promoteId: {nws_zones:
"key"}`) plus `nws-zone-fill`/`nws-zone-line` layers, and joins county-FIPS entries onto
the shared `county_boundaries` source (via `ensureCountyBoundaries()`) with
`nws-county-fill`/`nws-county-line` layers. Joined values are written as **feature-state**
under the namespaced keys `nws_group` (drives fill/line color, reusing
`NWS_GROUP_BUCKETS` from `src/colors/buckets.ts` — the same palette the storm-polygon
layer paints with) and `nws_sev` (used only for severity-rank precedence, not rendered).
Feature-state is cleared via targeted `removeFeatureState` calls on exactly the keys/FIPS
this module last painted — never a bare `removeFeatureState` call, which would also wipe
ODIN outages' feature-state on the shared county source (see the ODIN traps note in the
archived HANDOFF). Zone/county fills render at **lower opacity (0.12)** than the
storm-polygon layer's 0.25 fill — these are approximate zone-area fills, not
storm-drawn polygons — but use the same `_group` color palette. The existing legend
`_group` chips (groupCode `q`) gate the joined layers too: since MapLibre property
filters can't see feature-state, `setZoneGroupFilter()` drives fill-/line-opacity paint
expressions on all four joined layers instead of `setFilter` (wired from
`assets/filters.ts`'s `applyNwsGroupFilter`). Clicking a joined zone/county lists **every**
alert on it in the popup (via `lookupByZone(type, ugc)` / `lookupByFips(fips)`, sorted
severity-desc then earliest-ends); fire-zone alerts are headed "(fire weather zone)" and
ECCC-sourced entries are suffixed "(ECCC)".

## Canada (ECCC)

`fetch_nws_alerts.py` also fetches active alerts from Environment and Climate Change
Canada via MSC GeoMet's OGC API Features (`collections/weather-alerts`, **not**
`collections/alerts`) — all features there already carry real `Polygon` geometry (one
feature per zone-polygon per alert; `status_en: "ended"` rows are filtered out), so they
merge straight into `features` with `country: "CA"` and need no zone join. Payload is
reduced from an ~11 MB raw pull to ~220 KB via `shapely.simplify(0.01,
preserve_topology=True)` + 4-decimal-place coordinate rounding, applied only to the
active, allowlisted subset.

ECCC events are mapped to the same `_group` buckets as US events, matched on lowercase
`alert_name_en` (`scripts/fetch_nws_alerts.py`'s `ECCC_EVENT_GROUPS`):

| `_group` | ECCC `alert_name_en` values |
|---|---|
| `convective` | tornado warning, tornado watch, severe thunderstorm warning, severe thunderstorm watch |
| `flood` | rainfall warning, flood warning |
| `heat` | heat warning |
| `wind` | wind warning, arctic outflow warning, dust storm warning |
| `winter` | blizzard warning/watch, winter storm warning/watch, snowfall warning/watch, snow squall warning/watch, freezing rain warning, extreme cold warning, flash freeze warning |
| `tropical` | hurricane warning/watch, tropical storm warning/watch, storm surge warning/watch |

Unmatched `alert_name_en` values are excluded and logged. **Excluded by design, for
parity with the US curation:** special weather statement, air quality warning (both were
present in significant volume — 431 and 74 respectively in the 2026-07-09 verification
pull — a possible future widening if the user wants it).

ECCC has no severity/urgency/headline fields comparable to NWS CAP, so
`fetch_nws_alerts.py` maps: `severity` ← `{warning: "Severe", watch: "Moderate"}` from
`alert_type`; `urgency` ← `null`; `headline` ← `alert_name_en` (title-cased) + ", " +
`feature_name_en`; `onset`/`ends`/`expires` ← `validity_datetime` /
`event_end_datetime` / `expiration_datetime`; `areaDesc` ← `feature_name_en`;
`senderName` ← `"Environment and Climate Change Canada"`. Popups suffix ECCC-sourced
alerts "(ECCC)" (matched on `senderName`); attribution is in
`src/registry/sources.ts` (`eccc-msc`) and the credits dialog in `index.html`.

An ECCC fetch/parse failure **degrades to US-only**, never a hard failure of the whole
pull: `feed_status: {"eccc": "failed"}` is set on `features[0]`'s properties (`"ok"` on
success), read by `assets/ui/ui-legends.ts` for the amber degraded-feed chip — the same
pattern `fetch_wildfire_live.py` uses for its live sub-feeds.

## Caveats

- **Live & best-effort, no SLA.** The frontend force-disables the layer via a kill-switch
  modal when the last successful pull is more than 3 hours old (mirrors the wildfire
  staleness pattern in `wildfire-staleness.ts` / `live-staleness.ts`, but with its own
  shorter 3 h threshold). When the kill-switch fires, `assets/nws-zone-join.ts` also
  clears its joined zone/county feature-state (watched via a MutationObserver on the
  stale-dialog's `open` attribute, since the shared staleness factory exposes no
  stale-fired callback). Independently of that, the client prunes any alert (polygon
  **or** zone/county-joined) whose `ends`/`expires` time has passed on every refresh —
  `assets/nws-staleness.ts`'s `pruneExpiredAlerts()` calls `nws-zone-join.ts`'s
  `pruneExpiredZoneAlerts()` at the same points (post-refetch, initial load, 60 s tick) —
  so a missed workflow cycle doesn't leave dead warnings on the map between pulls.
- **Situational awareness only, not an alerting system.** These are official NWS/ECCC
  products, but this map has no delivery guarantee, no push notification, and can lag or
  silently fail. For authoritative, timely alerts use
  [weather.gov/alerts](https://www.weather.gov/alerts) (US) directly, not this map.
- **Marine, administrative, and AMBER-style products are deliberately excluded** — the
  allowlist only covers the convective/flood/fire/heat/wind/winter/tropical/other event
  types listed above; anything else (e.g. Small Craft Advisory, Civil Emergency Message,
  Child Abduction Emergency, ECCC special weather statement/air quality warning) is
  dropped regardless of geometry. Widening the allowlist is a separate user decision.
- **Zone/county fills are approximate area, not storm-drawn shapes** — a joined
  zone/county alert paints the whole NWS forecast/fire zone or county polygon, which can
  be much larger than the actual affected area a storm-based polygon alert would draw;
  rendered at lower opacity than real-polygon alerts specifically to signal this.
- **Bare UGC collides across zone sets.** 3016 UGC codes appear in both the public
  forecast and fire weather zone shapefiles with materially different geometry — every
  join and lookup in this layer uses `(type, ugc)`, never UGC alone; see "Zone/county
  join" above.
- **Zone shapefiles are rebuilt manually**, not on the 10-minute feed cadence — see
  "Zone/county join" above.
