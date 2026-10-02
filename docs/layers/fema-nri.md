# Natural Hazard Risk (FEMA National Risk Index)

A county-level natural-hazard risk choropleth in the **Conditions** panel group.
Registry id `fema-nri`, `urlCode` `NRI`. One layer row with a hazard picker: the
composite Risk Index or any one of FEMA's 18 hazards, one at a time. The choice
is saved in the URL as `nr=` (e.g. `nr=wfir`), omitted when it's the composite.

Like [Power Outages](outages.md), the served file carries **no geometry** — only
`FIPS → [score, rating]` per hazard. `assets/fema-nri.ts` joins the selected
hazard onto the shared `county_boundaries` PMTiles by **MapLibre `feature-state`**
(keys `nri_r`, `nri_s`, plus `nri_cr`/`nri_cs` for the composite shown in the
popup). Switching hazards re-joins the table; the paint never changes.

It shares `exclusiveGroup: "county-choropleth"` with Power Outages: both paint
the same county shapes, so switching one on switches the other off.

## Source

| | |
|---|---|
| **Provider** | Federal Emergency Management Agency (FEMA) |
| **Dataset** | [National Risk Index — Counties](https://www.arcgis.com/home/item.html?id=39485e8035d446a5bff03259508ae355) (ArcGIS FeatureServer `National_Risk_Index_Counties/FeatureServer/0`) |
| **Version** | December 2025 (1.20.0), as reported by the service's `NRI_VER` field |
| **Coverage** | 3,232 counties and county equivalents: 50 states, DC, and territories |
| **License** | FEMA National Risk Index Terms & Conditions (on the dataset item). Planning use only; users must cite the dataset and state that the product is not endorsed by FEMA (wording below). |
| **Attribution** | "This product uses the Federal Emergency Management Agency’s National Risk Index dataset API or downloadable datasets but is not endorsed by FEMA. The Federal Government or FEMA cannot vouch for the data or analyses derived from these data after the data have been retrieved from the Agency's website(s)." — carried in the Data Credits dialog; the popup footer says "not endorsed by FEMA". |
| **Raw input** | `data/raw/fema_nri/nri_counties.json` — attribute rows only, auto-downloaded (delete to refetch). Stamps `retrieved_utc`. |
| **Served** | `data/layers/fema_nri.json` (~447 KB, ~125 KB gzipped) → `DATA.fema_nri` in `assets/constants.ts` |
| **Built by** | `scripts/extract_fema_nri.py` (`make fema-nri`) |
| **Boundaries** | Joined onto `data/layers/county_boundaries.pmtiles` (Census TIGER 2024, `GEOID`). The build reports join coverage: all 3,232 NRI rows match a boundary. Three boundaries have no NRI row — American Samoa `60030`, `60040` and Northern Mariana `69085` — and stay unpainted. Connecticut uses the planning-region FIPS (`09110`–`09190`) in both. |

### Table shape

```json
{"version":"December 2025","retrieved_utc":"2026-09-27T03:46:44Z",
 "hazards":["RISK","AVLN","CFLD", "..."],
 "ratings":["Not applicable","Very Low","Relatively Low","Relatively Moderate","Relatively High","Very High","Insufficient data"],
 "counties":{"01001":[97.4,5, 12.0,1, "..."]}}
```

`counties[fips]` holds `[score, rating]` pairs in `hazards` order. `score` is the
national percentile (0–100, one decimal) or `null`. `rating` is a code into
`ratings`: 1–5 are FEMA's ratings, 6 is FEMA's "Insufficient Data", and 0 is
"Not Applicable" or "No Rating". `RISK` is the composite Risk Index; the rest are
FEMA field prefixes (`WFIR` wildfire, `HRCN` hurricane, `ISTM` ice storm, …).
`NRI_HAZARDS` in `src/registry/conditions.ts` lists the picker labels and must
use the same ids.

## Download pack

None ships. FEMA's terms keep version control with FEMA and ask users to cite the
dataset they retrieved, so the map links to the upstream
[dataset item](https://www.arcgis.com/home/item.html?id=39485e8035d446a5bff03259508ae355)
instead of repackaging it.

## Fields

Share of the 3,232 counties with a rating (codes 1–5) for each picker entry;
"insufficient" is code 6 (drawn grey), "n/a" is code 0 (unpainted). Measured off
the December 2025 build.

| Field | % filled | Insufficient | N/A |
|---|---|---|---|
| RISK (composite) | 97% | 88 | 0 |
| WFIR wildfire | 97% | 88 | 1 |
| HRCN hurricane | 69% | 88 | 914 |
| ISTM ice storm | 93% | 0 | 231 |
| SWND strong wind | 97% | 88 | 23 |
| TRND tornado | 97% | 88 | 0 |
| HWAV heat wave | 95% | 118 | 52 |
| CWAV cold wave | 95% | 88 | 67 |
| WNTW winter weather | 96% | 88 | 36 |
| IFLD inland flooding | 97% | 88 | 4 |
| CFLD coastal flooding | 13% | 88 | 2708 |
| ERQK earthquake | 97% | 88 | 7 |
| HAIL hail | 97% | 88 | 18 |
| LTNG lightning | 97% | 88 | 0 |
| DRGT drought | 85% | 88 | 384 |
| LNDS landslide | 97% | 88 | 0 |
| AVLN avalanche | 21% | 0 | 2548 |
| TSUN tsunami | 2% | 362 | 2805 |
| VLCN volcanic activity | 9% | 53 | 2896 |

The 88 "insufficient" counties recurring across hazards are the territories.

## Caveats

- **Planning use only.** FEMA built the index for broad nationwide comparison; it
  is not a substitute for a local risk assessment, and local data is often better.
- **Relative, not absolute.** Scores are national percentiles and ratings are
  FEMA's relative classes, so "Very High" means high compared with other US
  counties, not a probability or a dollar figure.
- **County resolution.** A large county carries one value; risk varies within it.
  FEMA also publishes census-tract data, not used here.
- **Unpainted ≠ no data.** An unshaded county means FEMA rates the hazard "Not
  Applicable" there (or, for three island counties, that NRI has no row). Grey
  means FEMA could not score it.
- **Static.** The table is rebuilt only when `make fema-nri` is re-run against a new
  NRI release.
