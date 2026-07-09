# Power Outages (live)

A **live** county-level power-outage choropleth in the **Hazards** panel group.
Registry id `odin-outages`, `urlCode` `OUT`. The served data file carries **no
geometry** — only `FIPS → [customers_out, incident_count]`. It is joined onto the
shared `county_boundaries` PMTiles at runtime by **MapLibre `feature-state`**
(`promoteId: { county_boundaries: "GEOID" }` makes each county feature's id its
5-digit FIPS string), so nothing about the boundaries ships in this layer's data.

Counties with no reported outage carry no feature-state and render fully
transparent. This is a different thing from the wildfire layers — different
provider, different pipeline.

## Source

| | |
|---|---|
| **Provider** | [ORNL ODIN](https://ornl.opendatasoft.com/explore/dataset/odin-real-time-outages-county/) — Oak Ridge National Laboratory, Opendatasoft portal |
| **Dataset** | `odin-real-time-outages-county` — county-aggregated live outage records |
| **Coverage** | Partial — roughly **34–38 US states** at any moment (only utilities that self-report to ODIN, and only counties currently with outages). American Samoa / USVI are not reported. |
| **Vintage** | Live — a rolling snapshot; each pull stamps `generated_utc`. Upstream `source_modified` is usually `null` (the portal omits it), so freshness is judged from `generated_utc`. |
| **License** | **None declared** in the ODIN metadata. DOE/ORNL public program — attribute "ORNL ODIN". Utilities self-report; treat as best-effort, not authoritative. |
| **Attribution** | "ORNL ODIN" |
| **Served (prod)** | `odin_outages.json` on the orphan **`data`** branch, fetched via `raw.githubusercontent.com` (CORS ok). URL in `assets/constants.ts` → `DATA.odin_outages`. |
| **Served (dev)** | Local `data/layers/odin_outages.json` — **not in git** (`data/layers/` is gitignored). Produced by the fetch script below. |
| **Built by** | `scripts/fetch_odin_outages.py` — one server-side-aggregated Opendatasoft call (`group_by=communitydescriptor`, `sum(metersaffected)`, `count(*)`); no per-outage geometry is ever fetched. ~3.6 KB output. |
| **Boundaries** | Joined onto `data/layers/county_boundaries.pmtiles` (Census TIGER counties; source layer `county_boundaries`, attributes `GEOID`, `NAME`, `STUSPS`, `STATE_NAME`). Shared join infrastructure, not part of this layer's data. |

### Snapshot shape

```json
{"generated_utc":"2026-07-09T00:20:23Z","source_modified":null,
 "county_count":242,"total_customers_out":17707,
 "counties":{"48201":[3208,167],"41033":[2367,8]}}
```

`counties[fips] = [customers_out, incident_count]`. `customers_out` is ODIN's
`metersaffected` (customers-affected, summed per county); `incident_count` is the
number of outage records.

## Download pack

**No download pack ships.** This is a live, geometry-less feed — point users at
the upstream dataset:
<https://ornl.opendatasoft.com/explore/dataset/odin-real-time-outages-county/>.

## Fields

The snapshot is a flat `FIPS → [out, n]` map, not per-feature GeoJSON (`out`/`n`
are the Opendatasoft `group_by` aliases). The values surface as MapLibre
feature-state on the joined county features, under **namespaced** keys — the
`county_boundaries` source is shared infrastructure, and every county-keyed layer
writes into the same per-feature state bag:

| Feature-state key | Snapshot slot | Source | Example | Notes |
|---|---|---|---|---|
| `odin_out` | `[0]` | `metersaffected` summed | `3208` | Customers affected. Drives the choropleth buckets. |
| `odin_n` | `[1]` | `count(*)` | `167` | Number of outage incidents in the county. |

County identity/labels come from the `county_boundaries` tile properties
(`NAME`, `STATE_NAME`, `GEOID`), merged with the feature-state in the click popup.

### Choropleth ramp (customers out)

Static 4-bucket YlOrRd ramp (visually distinct from the wildfire fire-glow
palette), defined in `assets/layers/map-layers-hazards.ts` (`addOdinOutages`) and
mirrored by the legend in `index.html` (`#odinLegend`):

| Bucket | Color |
|---|---|
| `< 100` | `#fed976` |
| `100 – 1,000` | `#fd8d3c` |
| `1,000 – 5,000` | `#e31a1c` |
| `5,000+` | `#800026` |

## Refresh

| | |
|---|---|
| **Poll** | While the layer is visible, the frontend refetches the snapshot every **15 min** (`assets/odin-outages.ts`) and re-applies the join. |
| **Staleness** | If `generated_utc` is older than **6 h**, the snapshot is **not painted** and a console warning is logged — deliberately no kill-switch modal (simpler than the wildfire layer). If the feed dies while a tab is open, already-painted counties are **unpainted** on the first stale poll, so the map never shows hours-old outages. The legend age chip still shows the (stale) age. |
| **Tile re-apply** | Feature-state only sticks to features in currently-loaded tiles, so the parsed snapshot is held in module scope and re-applied on the source's `sourcedata` event (`isSourceLoaded`), so panning/zooming into new tiles paints. On refresh, counties that dropped out of the new snapshot have **only their `odin_*` keys** removed (never a bare `removeFeatureState(target)`, which would wipe a co-tenant layer's keys). |
| **Age chip** | The legend shows "updated N min ago", read from `generated_utc`. |

## Caveats

- **Coverage is partial and self-reported.** Only utilities that report to ODIN
  appear, and only counties currently experiencing outages. Expect ~34–38 states
  covered at any time; a blank county means "not reported", not "no outages".
- **No declared license.** ODIN metadata declares none; this is a DOE/ORNL public
  program. Attribute "ORNL ODIN" and treat as best-effort.
- **`metersaffected` is customers-affected**, summed per county — utilities report
  it inconsistently, so absolute counts are approximate.
- **Many upstream fields are sparse** (`cause`, `statuskind`, etc.), so the layer
  intentionally surfaces only the two robust aggregates (`out`, `n`).
- **Not for emergency use.** Live, unauthenticated, best-effort data — do not rely
  on it for operational or safety decisions.
- **FIPS are strings with leading zeros** (e.g. `"08123"`). The join keys on the
  string `GEOID`; never `parseInt` a FIPS or Colorado/Connecticut counties silently
  drop their leading zero and fail to match.
