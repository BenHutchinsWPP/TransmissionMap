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

The popup lists every measure, newest first, followed by the jurisdiction's
latest changes. Each adopted and end date also reads as an offset from today
("6 days ago", "in 11 months"), computed when the popup opens and worded in
the active language by the browser's `Intl.RelativeTimeFormat`. A blue ring (points) or a blue edge (counties, utility areas) marks a
jurisdiction whose newest dated event falls in the last 30 days
(`DCM_RECENT_DAYS`).

## Source

| | |
|---|---|
| **Provider** | Moratorium Nation (Michael Bommarito, Alea Institute), extended with TransmissionMap research |
| **Dataset** | [moratorium-data-2026](https://github.com/mjbommar/moratorium-data-2026): local moratorium inventory, plus its state-bill table filtered to enacted measures that pause something |
| **Version** | Upstream commit `dbaab04` (2026-09-23); seeded 2026-10-04 |
| **Coverage** | 1,121 measures (393 county, 723 sub-county, 5 statewide) in 1,111 jurisdictions across 47 states: 389 counties, 719 points, and 3 states (AZ, NY, TX) |
| **License** | CC BY 4.0 (data); credit in the Data Credits dialog and the popup footer |
| **Served** | `dc_moratoriums.geojson` (~1.4 MB, ~320 KB gzipped) at the root of the `data-moratoriums` branch → `DATA.dc_moratoriums` (`MORATORIUM_ORIGIN` in `assets/constants.ts`) |
| **Utility geometry** | HIFLD Retail Service Territories, joined on `ID` = EIA-861 utility number (never on name); the ERCOT polygon from the EIA balancing authorities used by [`eia-ba`](eia-ba.md). Both are extracted once by `build_territories.py` |
| **Built by** | `sync.py` then `build_layer.py`, both still in `_private/moratoriums/` |

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
- **Unconfirmed rows.** About 20% of measures carry upstream `[VERIFY]` tags
  (`verify=true`), and the popup marks them "unconfirmed". All 39 rows added
  by TransmissionMap research are flagged the same way.
- **End dates.** 149 active or extended measures (including the TransmissionMap
  additions) have no known end date, so they can never be marked expired
  automatically.
- **Permanent bans are under-counted.** Upstream excludes them; most of the
  27 shown come from TransmissionMap research.
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
