# Routing constraints

What the route cube records about the land, one concern at a time: an overview of
the strongest constraint per 250 m cell ("What constrains"), the land manager, or
one mask (GAP 1–2, critical habitat, floodplain, military land, …). Panel group
**Land**. **Dev server only** until its rasters are published: the registry entry
is added under `import.meta.env.DEV` (`src/registry/land.ts`), so a production
build has no row and no source, and its legend frame and Data Credits entry
(both in `index.html`) stay hidden.

## Source

| | |
|---|---|
| **Provider** | The route cube's bands (`data/route/250m/pd_*`, and `osm_*` for the OpenStreetMap entries): USGS PAD-US, USFWS, EPA, NPS, BLM, USDA Forest Service, FAA, USACE, USGS 3DEP, NLCD (MRLC), DOE/ANL Section 368; FCC tall structures and USACE dams via HIFLD on source.coop (SeerAI); WorldPop; FEMA/ORNL USA Structures (observed footprint shares); Power of Place – West (Wu 2023; The Nature Conservancy categories); OpenStreetMap (lakes, military, existing lines and parallel-line corridors). Per-band sources and rules: [routing.md](../routing.md) |
| **Dataset** | One raster per concern in `src/colors/route-constraints.ts` (`CONCERNS`) |
| **Coverage** | CONUS. A cell with no building footprint may still have buildings; imagery dates vary by area. |
| **License** | Public domain (US federal works, 17 U.S.C. §105) for the federal bands, NLCD and DOE/ANL Section 368; CC BY 4.0 for the tall-structure / dam flag (HIFLD packaging by SeerAI), the population concern (WorldPop), the observed building-footprint concerns (USA Structures), and the TNC categories (PoPWest, Wu et al. 2023); ODbL 1.0 for the OpenStreetMap entries (© OpenStreetMap contributors). Per [data-sources.md](../data-sources.md) |
| **Attribution** | The layer's map credit (`data.credit`) and the `route-constraints` entry of the Data Credits dialog |
| **Served** | `data/route/constraints/<concern-id>.pmtiles` + `manifest.json` (paletted PNG raster PMTiles); not under `data/layers/`, so not published |
| **Built by** | `scripts/build_route_constraints.py` (`make route-constraints`; log `tmp/logs/route-constraints.log`) |
| **Raw input** | the route cube (`make route-cube`): `pd_` bands; `osm_` bands for the OpenStreetMap entries only, never the overview or land manager |

## Download pack

No download pack is built: the rasters are a display of the route cube, not a
dataset of their own. The underlying sources are listed in [routing.md](../routing.md).

## Concern picker

The row's `<select data-route-concern-select>` lists `CONCERNS` grouped by
`CONCERN_GROUPS` (Overview, Land, Protection, Wildlife, Hazards, Sites,
Population, Corridors). The choice is in the link as `rc=<concern id>` (default
`what-constrains`, omitted); see [url-state.md](../url-state.md).

## Raster values

Paletted raster, one class per colour; no hover readout. Colours come from
`src/colors/route-constraints.ts`, which the build reads as
`scripts/route_constraints.json` and the legend (`#routeConstraintsLegend`) reads
directly.

- **What constrains** — fixed precedence: tribal
  › military (PAD-US DOD) › wilderness study area › GAP 1–2 › critical habitat ›
  sage-grouse PHMA › occupied or historic site › floodplain › other federal manager.
  Overviews keep the highest-ranked class (`max`), so at low zoom a cell shows the
  highest-ranked concern nearby.
- **Land manager** — PAD-US manager colours (BLM, USFS, NPS, FWS, DOD, state, local,
  tribal, other federal, NGO); private land and no manager are left unshaded.
  Overviews take the most common manager (`mode`).
- **Masks** — one colour where the cube's rule holds. Overviews keep a set cell
  (`max`), so thin features stay visible when zoomed out.
- **Classes** — an entry with classes shades each class in its own colour. Ordered
  classes (wildfire hazard potential, slope, TNC categories) keep the highest code in
  an overview; land cover is nominal and takes the most common class (`mode`).
  The classes of one entry never share a value, so no class is hidden.

## Caveats

- 250 m cells: a feature narrower than a cell is drawn as whole cells.
- Military land here is PAD-US DOD only. OpenStreetMap military land is its own
  entry, Military land (OpenStreetMap), credited © OpenStreetMap contributors (ODbL).
- The overview is a fixed precedence for reading the land, not the routing
  weight of any method; the route panel shows a method's own drivers.
