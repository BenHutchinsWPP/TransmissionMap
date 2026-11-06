# Grid Operations (EIA-930)

Hourly operations of every US balancing authority (BA): load, net generation,
net interchange and generation by fuel, drawn as a bubble per BA, plus an arrow
for the interchange between each pair of neighbouring BAs. An hour bar under
the map picks the hour and plays the hours in order. Panel group: Load.

## Source

| | |
|---|---|
| **Provider** | U.S. Energy Information Administration, Form EIA-930 (Hourly Electric Grid Monitor), as published by the [PUDL Project](https://catalyst.coop/pudl/) (Catalyst Cooperative) |
| **Dataset** | `core_eia930__hourly_operations`, `core_eia930__hourly_interchange`, `core_eia930__hourly_net_generation_by_energy_source` |
| **Version** | PUDL `v2026.8.0` (`PUDL_VERSION` in `assets/constants.ts`); hours from 2015-07-01 to the version's last hour |
| **License** | PUDL: CC-BY-4.0. The EIA data is public domain (US federal work, 17 U.S.C. § 105) |
| **Attribution** | "PUDL (EIA-930, CC-BY-4.0)" (map credit); Data Credits names the PUDL Project |
| **Served** | Nothing from this project: the browser reads PUDL's Parquet on `s3.us-west-2.amazonaws.com` by HTTP range request (`assets/grid-ops/eia930-read.ts`), only while the layer is on |
| **Built by** | `scripts/build_eia930_bas.py` (`make eia930-bas`) builds the committed `src/registry/eia930-bas.json`: each BA's name, EIA region, interconnection and bubble position |

## Download pack

None. PUDL publishes the tables themselves at the version above; this layer
adds nothing to them.

## What is drawn

| On the map | Value | EIA-930 column |
|---|---|---|
| Bubble area | the larger of load and generation, against the largest node in the same interconnection (WECC's largest BA draws as large as the East's; Canada and Mexico on their own scales; one scale when grouped by interconnection) | |
| `L` | demand, MW | `demand_adjusted_mwh` |
| `G` | net generation, MW | `net_generation_adjusted_mwh` |
| `EXP` / `IMP`; dark or white bubble | total net interchange, MW (≥ 0 exports) | `interchange_adjusted_mwh` |
| Arrow and its number | net flow between two BAs, from the exporter, MW | `interchange_reported_mwh`, both sides averaged |
| Fuel disc (glyph "Fuel mix") | positive net generation by fuel, area ∝ MW, inside a dashed ring sized by load | `net_generation_adjusted_mwh` by `generation_energy_source` |
| Ring around a node | generation ÷ load: a closed dark-blue ring when generation covers load, otherwise an orange arc of the covered fraction over a grey track | `net_generation_adjusted_mwh` ÷ `demand_adjusted_mwh` |

All values are MW at the end of the hour; PUDL's `_mwh` column names hold the same hourly MW.
The numbers sit beside each bubble (below it, or above when that collides),
so they read at any bubble size; labels that would overlap give way to the
larger BA until the map is zoomed in. The bubble popup lists that BA's numbers (load, generation,
net interchange, each fuel, each neighbour with both sides' reports).

**Numbers on bubbles** is a checkbox on the layer row. It is on by default in
the balancing authority, EIA region and interconnection groupings and off in the
WECC area grouping, where the Drawer tab carries the figures instead.

**Ring:** none when load is unknown or zero, or for nodes outside EIA-930.

**Arrow width** is linear in MW: 0.8 px at 0 MW and 9 px at 4,000 MW and
above. MW labels sit on the arrows from zoom 3; the bigger flows are placed
first, so a label that would collide gives way to a smaller one.

**Fuels** fold into the map's generator legend (`src/colors/fuel.ts`):
solar and wind with or without storage → Solar / Wind; hydro and hydro
excluding pumped storage → Hydro; pumped storage → Pumped Storage; battery,
other and unknown storage → Storage; geothermal → Geo. EIA-930 reports the
coarse categories until 2024-06 and the fine ones from 2024-07, never both in
one hour.

**Groupings**: by balancing authority, by EIA region (NW, CAL, SW, …, summed
from their BAs, as PUDL's code table assigns them) or by interconnection
(Western, Eastern, ERCOT; Canada and Mexico as their own groups). A group's
values are its members' sums; flows between members drop out. A BA with no
EIA region (GRID, CEA) stands alone as its own node in the region and WECC
area groupings rather than leaving the map.

**By WECC area** groups the western BAs by WECC area number (Area 40 Northwest,
Area 26 LADWP, Area 54 Alberta, …; table `WECC_AREAS` in `ba-graph.ts`). EIA-930
BAs do not split the way areas do, so a BA covering several areas is one node named
with all of them: Areas 22, 24, 30 (CAISO, BANC, TID), Areas 18, 64 (NV Energy) and
Areas 63, 73 (SPP West, from 2026-04-01, when WACM and WAUW (Areas 73 and 63) retired
into SWPW). Areas 17 (AEPCO), 52 (FortisBC), 78 (PRPA) and 82 (SunZia) have no BA of
their own and report inside a neighbour. Every BA outside WECC falls back to its EIA
region group, so the map stays whole; area bubbles are sized on the western scale.
Gridforce (GRID) is in no area: it is generation-only and ties to BPA in the
Northwest and to PNM, SRP and WALC in the Southwest, so it is its own node,
drawn off the Oregon coast at (−126.3, 43.0) (`OFF_AREA` in `ba-graph.ts`). Its
popup says why. In the balancing authority grouping it keeps its own position.
A new western BA in
`eia930-bas.json` must be added to the table (a test fails until it is).

**Link**: `gt=YYYYMMDDHH` (UTC hour-ending), `gg=r|i|w` (grouping), `gd=d` (fuel
discs), `gn=1|0` (numbers on bubbles, omitted when left to the default); see
[url-state.md](../url-state.md).

## Drawer tab

Tapping a bubble opens the bottom drawer's **Grid Ops** tab on that node
(`assets/ui/grid-ops-open.ts`; the tab itself is `assets/ui/ui-grid-ops.ts`). It
shows:

- the node's load, generation and net export or import for the shown hour;
- its ties, ranked by MW, each as exporter → importer. A note beside them says
  that EIA-930 interchange is metered tie flow, not schedules;
- a table of every node on the map (name, load, generation, net, top fuel).
  A row's name moves the map to that node;
- **Inside the area**, on a group of two or more BAs: switches the grouping to
  balancing authorities (one `url:write`, so Undo returns to the area view) and
  fits the map to the area's members.

The tab follows the hour bar and playback. It is session only: it is not kept
across a reload and does not appear in the link, like the Line and Proximity
tabs.

## Fields

The features are built in the browser, not served. Bubble properties:

| Field | % filled | Example values |
|---|---|---|
| `id` | 100% | `CISO`, `NW` (a group) |
| `name` | 100% | `California Independent System Operator` |
| `load`, `gen`, `net` | ~90% (null for neighbours outside EIA-930: BCHA, AESO, CEN, …) | `40941`, `39113`, `1361` |
| `fuels` | from 2018-07 | `[["solar",17152],["gas",13668],…]` |
| `ties` | 100% | `[{"with":"AZPS","mw":-524,"mine":-457,"theirs":-591}]` |

Arrow properties: `from`, `to` (exporter first), `mw` (the mean of both
reports), `a` (as `from` reported it), `b` (as `to` reported it).

## Caveats

- **Raw MW only.** No share of capacity or of a yearly maximum.
- **Arrows are metered flows, not schedules.** EIA-930 interchange is each BA's
  net metered flow on its ties. The two sides of a tie often disagree; the
  arrow shows their mean and the popups show both.
- **Net interchange need not equal generation minus load.** It is EIA's total
  interchange as reported, which can differ from `G − L` by losses, metering
  and reporting gaps.
- **Sizes compare within an interconnection only.** A WECC bubble and an
  Eastern one of the same size are not the same MW; the labels and popup carry
  the MW.
- **Positions are schematic.** Each bubble starts at a point inside its BA's
  largest polygon in the [EIA BA layer](eia-ba.md); nested and small BAs are
  pushed apart so they do not stack, and a few BAs that layer lacks are
  hand-placed (`POSITION_OVERRIDES` in the build script).
- **CSTO is not drawn:** PUDL has no rows for it.
- **Utility-scale only.** Rooftop solar is not generation in EIA-930; it shows
  up as lower load.
- **Storage is signed.** A charging battery reports negative net generation;
  the disc draws positive fuels only and the popup prints the sign.
- **Large first read.** The first hour reads the half-year's operations tables; later hours inside the same
  half-year read only the fuel rows.
