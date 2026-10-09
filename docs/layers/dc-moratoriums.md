# Data Center Moratoriums

US data center moratoriums, permanent bans and statewide permit pauses, in the
**Load** panel group next to OSM Data Centers. Registry id `dc-moratoriums`,
`urlCode` `DCM`. **Draft:** the data is not published yet. Dev reads it from
the local working copy of the future `data-moratoriums` branch.

Each measure is drawn on the geometry of the body that adopted it:

| Adopted by | Drawn as | Style layers |
|---|---|---|
| State (executive order, statute) | State polygon: light wash, dashed edge | `dcm-state-fill`, `dcm-state-line` |
| County | County polygon, filled | `dcm-county-fill`, `dcm-county-line` |
| Electric utility (with an EIA-861 utility number) | Retail service territory, clipped to the measure's state: diagonal hatch in the class colour (grey once ended), dash-dot edge | `dcm-utility-fill`, `dcm-utility-line` |
| Grid operator (the TX ERCOT large-load audit directive) | ERCOT balancing-authority polygon, drawn like a utility | same as utility |
| City, town, township, village, tribe; a utility without a territory (water and sewer authorities) | Point | `dcm-points`, `dcm-points-recent` |

Utility areas sit under the counties and points and have the lowest click
priority of the layer's style layers, so a click inside one still reaches the
county or town measure first; overlapping hits open the picker.

There is one feature per jurisdiction (per utility, for utility measures).
When a jurisdiction has several
measures, its colour is the strongest one, in this order:

1. permanent ban;
2. moratorium in effect;
3. proposed;
4. expired, lifted or replaced.

The legend's four status rows are filter checkboxes (URL group `a`, built
from `DCM_CLASSES`). They filter on that strongest class, `cls`, so
unticking "Expired, lifted or replaced" hides a jurisdiction only when all
of its measures have ended.

The popup lists every measure, newest first, followed by the jurisdiction's
latest changes. Each adopted and end date also reads as an offset from today
("6 days ago", "in 11 months"), computed when the popup opens and worded in
the active language by the browser's `Intl.RelativeTimeFormat`. A blue ring (points) or a blue edge (counties, utility areas) marks a
jurisdiction whose newest dated event falls in the last 30 days
(`DCM_RECENT_DAYS`).

## Source

| | |
|---|---|
| **Provider** | Moratorium Nation (Michael Bommarito, Alea Institute), extended with TransmissionMap research (2026-10-03 and 2026-10-07) |
| **Dataset** | [moratorium-data-2026](https://github.com/mjbommar/moratorium-data-2026): local moratorium inventory, plus its state-bill table filtered to enacted measures that pause something |
| **Version** | Upstream commit `dbaab04` (2026-09-23); seeded 2026-10-04; research merged and rebuilt 2026-10-08 |
| **Coverage** | 1,396 measures (414 county, 952 sub-county, 25 utility, 5 statewide) in 1,352 map features across 47 states: 400 counties, 927 points, 22 utility or grid-operator areas, and 3 states (AZ, NY, TX) |
| **License** | CC BY 4.0 (data); credit in the Data Credits dialog and the popup footer |
| **Served** | `dc_moratoriums.geojson` (~1.9 MB, ~420 KB gzipped) at the root of the `data-moratoriums` branch → `DATA.dc_moratoriums` (`MORATORIUM_ORIGIN` in `assets/constants.ts`) |
| **Utility geometry** | HIFLD Retail Service Territories, joined on `ID` = EIA-861 utility number (never on name); the ERCOT polygon from the EIA balancing authorities used by [`eia-ba`](eia-ba.md). Both are extracted once by `build_territories.py` |
| **Built by** | `scripts/moratoriums/rebuild.sh` (`build.py`, `build_research.py`, `build_state.py`, `sync.py`, `build_layer.py`); inputs and layout in [`scripts/moratoriums/README.md`](../../scripts/moratoriums/README.md) |

## Change tracking

The branch holds two CSVs:

- `moratoriums.csv` is the current state, one row per measure.
- `events.csv` is a change log that is only ever appended to. Each row is one
  event: `proposed`, `adopted`, `banned`, `extended`, `expired`, `lifted`,
  `replaced`, `added`, `removed` or `corrected`.

Every event carries both its real-world `event_date` and the `recorded_at`
date of the sync that found it, so a news feed ("new this week", "new near
me") and a timeline can be built from one file without walking git history.
Re-running a sync on unchanged inputs writes nothing, so every commit on the
branch is a real change. The dataset's `README.md` documents the full format.

`moratoriums.csv` carries an `eia_id` column: the EIA-861 utility number of
a utility-level measure, which selects its service territory. It is
bookkeeping, so setting or changing it logs no event.

## Weekly refresh

The workflow `.github/workflows/moratorium-refresh.yml` looks for new and
changed measures on the 1st and 15th of each month at 09:23 UTC (and on demand from the Actions
tab) and commits the result straight to `data-moratoriums`, so a week's
changes reach the map without review. A run dispatched with
`publish: pull_request` opens a pull request instead.

| Step | What runs |
|---|---|
| Follow-up | Searches for rows already in the dataset: pending measures, measures expiring within 21 days, utilities, and a rotating slice of measures with no end date |
| Discovery | A fixed list of general queries for new moratoriums, bans and utility pauses |
| Sources | [Brave Search](https://brave.com/search/api/) (news and web), tracker seed pages (savrn.com, datacenterbans.com, dcmap.us, servercountry.org, strisker briefings, the NJ Pinelands ordinance log) and SEC full-text search for utilities |
| Extraction | A cheap model (Claude Haiku) reads one fetched page at a time and fills a fixed JSON schema; a stronger one (Claude Sonnet) re-reads the harder pages. Neither chooses queries, URLs or files |
| Review | Every new row and every change to a tracked row is checked in code (duplicates, a change about a different place) and by Claude Opus against the page before it is written; a rejected change is only listed, with its reasons |
| Rebuild | The pipeline in `scripts/moratoriums/` rebuilds the four published files from the branch's `inputs/` |

Verification rule: a row is kept only when its quote (at least 40
characters) appears in the fetched page text, the place is named on that
page, the dates are valid, and the review accepts it: same place, not a
duplicate, actually adopted rather than proposed, and dates the page supports
at least as precisely as the tracked ones. Anything else is listed as a lead in
`inputs/research/weekly/<date>/notes.md`. Every new row is marked
unconfirmed, with its source attached.

Each run's report, as the commit message (or the pull request body), lists
new and changed rows, QA flags, territory warnings, fetch rate, cap use and
estimated cost. A run publishes every week, because `refresh_state.json` and
`notes.md` change on every run. Reviewing and the secrets it needs are in the
[pipeline README](../../scripts/moratoriums/README.md).

To stop it, disable the workflow in the Actions tab (Moratorium refresh,
Disable workflow). To take back a week, revert its commit on
`data-moratoriums`.

## Download pack

None yet. The CSVs on the `data-moratoriums` branch are the download.

## Fields

GeoJSON properties, one feature per jurisdiction:

| Field | % filled | Example values |
|---|---|---|
| `kind` | 100 | `state`, `county`, `utility`, `point` |
| `name` | 100 | `Mesa County, CO`, `Ada, OH`, `Texas`, `Grant County PUD, WA`, `ERCOT grid region, TX` |
| `state` | 100 | `CO` |
| `level` | 100 | `county`, `city`, `township`, `tribal`, `utility` (`state` on the ERCOT feature) |
| `cls` | 100 | `ban`, `active`, `pending`, `ended` |
| `n` | 100 | number of measures, `1`–`3` |
| `last_event` | 94 | newest dated event, `2026-09-30` |
| `items` | 100 | JSON list: name, type, status, adopted, expires, scope, summary, src, verify |
| `history` | 100 | JSON list of the last 8 events: date, event, name |

## Caveats

- **Informational only.** Ordinances change at council meetings, so confirm
  a measure's status with the jurisdiction.
- **Unconfirmed rows.** 544 measures (39%) are `verify=true`, which the popup
  shows as "unconfirmed". They are the upstream rows with `[VERIFY]` tags,
  every row added by TransmissionMap research, and every upstream row that
  research changed.
- **End dates.** 153 temporary measures that are active or extended have no
  known end date, so they can never be marked expired automatically. This
  count leaves out permanent bans, which have no end date by design.
- **Permanent bans.** Upstream excludes them, so nearly all of the 246 ban
  rows come from TransmissionMap research: 175 in force, 69 proposed, 1
  replaced and 1 withdrawn. 110 of them are in NJ, which a dedicated sweep
  covered; other states had a partial pass, so bans there are under-counted.
- **Utility measures.** 25 utility-level measures. 24 are drawn on 21 utility
  service territories: seven Washington PUDs (mostly crypto-era moratoria from
  2014 to 2019) and Avista; APS, Silicon Valley Power, Marietta, Flathead
  Electric, AEP Ohio, BrightRidge and Dominion; five NY municipal utilities;
  and Delmarva Power under the Delaware PSC order. The Ypsilanti Community
  Utilities Authority, a water and sewer authority, stays a point. A utility's
  "service pause" or "load cap" is shown as an `interconnection pause`.
- **Upstream updates.** 38 Moratorium Nation rows carry newer facts from
  TransmissionMap research: adoptions after its 2026-09-23 cutoff,
  extensions, corrections and replacements.
- **Point locations.** Sub-county measures are points at the place's
  location, not its boundary. 29 upstream points were moved to their named
  Census place.
- **Utility territories.** The HIFLD polygons are the EIA-861 service
  territories of their vintage (2022), not the utility's current tariff
  map. A territory is clipped to the state of the measure, since a state
  commission's order stops at the state line (Delmarva Power's Delaware PSC
  pause shows only the Delaware part). A measure's own scope can be narrower
  than the territory: the 2022 Dominion pause applied to eastern Loudoun
  County, while the hatch covers Dominion's whole Virginia territory. Read the
  popup's summary for the exact scope.
- **ERCOT, not Texas.** The August 2026 large-load audit directive covers the
  ERCOT grid, so it is drawn on the ERCOT balancing-authority polygon rather
  than the state outline; the TCEQ permit pause still paints Texas.
