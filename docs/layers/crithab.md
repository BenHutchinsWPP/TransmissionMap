# Critical Habitat (ESA)

Threatened and endangered species critical habitat designations under the US Endangered Species Act.

## Source

| | |
|---|---|
| **Provider** | [US Fish & Wildlife Service — ECOS](https://ecos.fws.gov/ecp/report/table/critical-habitat.html) |
| **Dataset** | Critical Habitat bulk download (`crithab_all_layers.zip`, CRITHAB_POLY shapefile) |
| **Source URL** | https://ecos.fws.gov/docs/crithab/crithab_all_layers.zip |
| **Coverage** | US (including territories with active designations) |
| **License** | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) |
| **Attribution** | U.S. Fish & Wildlife Service |
| **Served** | Pre-baked `data/layers/crithab.pmtiles`, hosted alongside the map |
| **Built by** | `extract_crithab.py` → `build_tiles.py` (`addCritHab()` in `layer-init.ts`) |

## Download pack

None — the layer links out to the [ECOS critical habitat report](https://ecos.fws.gov/ecp/report/table/critical-habitat.html)
("Source data ↗" in the layer panel) rather than redistributing a ZIP. Marked
`skip: true` in `scripts/release_manifest.yaml`.

## Processing

`extract_crithab.py` reads the CRITHAB_POLY shapefile from the bulk zip, keeps the
nine fields carried by the original hand-built tiles, reprojects to EPSG:4326, and
writes `data/build/crithab.gpkg`. `build_tiles.py` then tiles it to
`data/layers/crithab.pmtiles` (vector, zoom 4–13, simplification 4) per
`scripts/tile_manifest.yaml` — these settings reproduce the original tippecanoe
build. Linear critical habitat (CRITHAB_LINE) is dropped — polygons only.

Pre-baked rather than streamed live: a local PMTiles file keeps the layer
independent of live service availability and browser CORS support.

## Fields (CRITHAB_POLY shapefile, native DBF names)

| Field | Description | Example |
|---|---|---|
| `comname` | Common name of species | "California condor" |
| `sciname` | Scientific name | *Gymnogyps californianus* |
| `spcode` | FWS species code | "B002" |
| `status` | Designation status | "Final", "Proposed" |
| `listing_st` | ESA listing status (legend field) | "Endangered", "Threatened", "Proposed Endangered", "Proposed Threatened" |
| `unitname` | Critical habitat unit name | "Northern Unit" |
| `subunitnam` | Subunit name | |
| `effectdate` | Effective date of designation | "2019-01-15" |
| `entity_id` | FWS unique habitat entity id | |

## Caveats

- Polygons only; linear critical habitat (CRITHAB_LINE) is not tiled.
- Coverage: US only (including territories with active designations).
- Vintage: whatever `crithab_all_layers.zip` was last downloaded (tooltip says ~Jan 2025).
- FWS serves the zip with an incomplete cert chain — `extract_crithab.py`'s hint notes the `curl -k` workaround.
