# Power Outages (live)

A **live** county-level power-outage choropleth in the **Conditions** panel group.
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
| **Built by** | `scripts/fetch_odin_outages.py` — one Opendatasoft `/exports/json` call for the per-incident records (`select` = the card fields; no geometry). The county/utility aggregates that drive the choropleth are **derived from those same records** in Python, so the map and the popup cards come from one instant and can never disagree. ~300 records worst case; output ~80 KB (~6 KB gzipped over the wire). |
| **Boundaries** | Joined onto `data/layers/county_boundaries.pmtiles` (Census TIGER counties; source layer `county_boundaries`, attributes `GEOID`, `NAME`, `STUSPS`, `STATE_NAME`). Shared join infrastructure, not part of this layer's data. |

### Snapshot shape

```json
{"generated_utc":"2026-07-09T00:20:23Z","source_modified":null,
 "county_count":242,"total_customers_out":17707,"dropped":0,"legacy_fips":0,
 "counties":{"48201":[3208,167,[["CENTERPOINT ENERGY",3100,160],["FOO, BAR COOP",108,7]]],"41033":[2367,8]},
 "records":{"48201":[{"name":"CENTERPOINT ENERGY,8901","cause":"Storm","causekind":null,"metersaffected":3100,"customersrestored":null,"reportedstarttime":"2026-07-08T18:55:00+00:00","estimatedrestorationtime":"{\"ert\": \"2026-07-09T04:00:00Z\"}","statuskind":null}]}}
```

`records` (added 2026-07) maps each FIPS to its per-incident outage records
(the fields the popup cards render), in `metersaffected`-desc order. The
`counties` aggregates above are derived from exactly these records in the fetch
script, so a county's `counties[fips]` totals always equal the sum/count of its
`records[fips]` — the popup header and the incident cards can never disagree.
Rows whose `communitydescriptor` fails the FIPS regex carry no `records` entry.

`dropped` (always present, `0` when clean) counts rows whose `communitydescriptor`
failed the FIPS regex and were skipped entirely (not written anywhere). `legacy_fips`
(always present, `0` when clean) counts rows keyed to a known pre-Census-vintage FIPS
(legacy Connecticut counties or the old Alaska Valdez-Cordova code) — these rows
**are kept** in `counties` (still useful to consumers reading the raw snapshot) but
will not paint on the map because the `county_boundaries` tileset no longer has a
matching `GEOID`. In CI (`GITHUB_ACTIONS` set), a nonzero `dropped` or `legacy_fips`
also emits a `::warning::` annotation to stdout.

`counties[fips] = [customers_out, incident_count, utils]`. `customers_out` is ODIN's
`metersaffected` (customers-affected, summed per county); `incident_count` is the
number of outage records. `utils` (optional, slot `[2]`) is an array of per-utility
breakdowns: `[[utilityDisplayName, customers_out, incident_count, since], ...]`, sorted
by customers-out descending. `since` is the earliest `reportedstarttime` in the group
(ISO string, or `null` — ~31% of upstream records lack it). `utilityDisplayName` is
ODIN's `name` field with the
trailing `,<utility_id>` suffix stripped (the id is the EIA utility ID); missing
names default to `"Unknown utility"`; duplicate display names within a county are
merged. Older snapshots may lack slot `[2]`; the frontend tolerates that.

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
| `odin_utils` | `[2]` | per-utility group rows | `[["CENTERPOINT ENERGY",3100,160,"2026-07-08T18:55:00+00:00"],["FOO, BAR COOP",108,7,null]]` | Per-utility breakdown array (one entry per unique utility in the county), sorted by customers-out descending; 4th slot = earliest `reportedstarttime` or null. Null when absent. |

County identity/labels come from the `county_boundaries` tile properties
(`NAME`, `STATE_NAME`, `GEOID`), merged with the feature-state in the click popup.

### Popup behavior

On click, the popup shows the county name and active-incident count, then a per-utility table
(`odin_utils`) with columns Utility / Out / Since. The county total is the table's
bold final row; the Since cell is the utility's earliest reported start time ("–"
when unreported). Each utility name is a clickable link to a Google search for
`<utility name> power outage map`, opening in a new tab. (ODIN publishes no
outage-map URLs; a search link is the zero-maintenance way to route users to the
utility's own, de facto original, outage map.) Snapshots without `odin_utils` fall
back to a plain "Customers affected" row.

**"View incident reports" pager.** Expanding it shows the county's individual
outage records (`records[fips]`) as ‹ › paged cards — utility, customers out,
cause, status, start/ERT. These records ship in the snapshot (no live call to
ODIN from the browser), so their per-card `metersaffected` values sum to exactly
the county total shown above. Wired in `assets/odin-outages.ts`.

### Choropleth ramp (customers out)

Static 4-bucket YlOrRd ramp (visually distinct from the wildfire fire-glow
palette), defined in `assets/layers/map-layers-conditions.ts` (`addOdinOutages`) and
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
| **Workflow** | `.github/workflows/alerts-outages.yml` (shared with the NWS alerts feed; the two fetch scripts run in parallel, failure-isolated) — primary trigger `workflow_dispatch`, fired every 10 min by one cron-job.org job, plus an insurance `schedule:` cron every **2 h** (`2 */2` — tightened from ODIN's own 3 h to satisfy the co-located NWS feed's 3 h kill-switch; still well under ODIN's 6 h no-paint gate). |
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
  intentionally surfaces only the robust aggregates (`out`, `n`) plus the
  100%-filled utility `name`.
- **Per-utility search links are not verified URLs.** The utility-name link is a web
  search, not a guaranteed URL — the top result is almost always the utility's own
  outage map, but it is not guaranteed.
- **Not for emergency use.** Live, unauthenticated, best-effort data — do not rely
  on it for operational or safety decisions.
- **FIPS are strings with leading zeros** (e.g. `"08123"`). The join keys on the
  string `GEOID`; never `parseInt` a FIPS or Colorado/Connecticut counties silently
  drop their leading zero and fail to match.
- **Legacy CT/AK FIPS never paint.** If a utility reports the pre-2022 Connecticut
  county codes (`09001`-`09015` odd) and the pre-2019 Alaska Valdez-Cordova code
  (`02261`), but `county_boundaries.pmtiles` is Census GENZ2024 vintage (CT planning
  regions `09110`-`09190`; AK split into `02063`/`02066`), so those rows have no
  matching `GEOID` and silently fail to join — they're still kept in the snapshot's
  `counties` (see `legacy_fips` count) but won't render on the map.
