# Data Sources & Licensing

Source details, download origins, processing notes, and field references are in each layer's
documentation linked below. This page is the license and attribution index.

---

## Upstream providers

| Source | Layers | License | Attribution |
|---|---|---|---|
| **OpenStreetMap** | [Transmission lines](layers/osm-transmission-lines.md) · [Substations](layers/osm-substations.md) · [Generators](layers/osm-generators.md) · [Plants](layers/osm-plants.md) · [Pipelines](layers/osm-pipelines.md) · [Data centers](layers/osm-datacenters.md) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) — attribution + share-alike | © OpenStreetMap contributors |
| **HIFLD** (DHS/CISA) | [Transmission lines](layers/hifld-transmission-lines.md) · [Substations](layers/hifld-substations.md) · [Natural gas & petroleum](layers/hifld-natgas.md) · [Regions](layers/hifld-regions.md) | Public domain — US federal work, [17 U.S.C. § 105](https://www.law.cornell.edu/uscode/text/17/105) | "HIFLD / DHS CISA" |
| **Census TIGER/Line** | [Tribal lands](layers/tribal-lands.md) | Public domain — US federal work, 17 U.S.C. § 105 | "U.S. Census Bureau, TIGER/Line" |
| **EIA** | [Generators (Form 860)](layers/eia-generators.md) · [Petroleum pipelines](layers/eia-petroleum-pipelines.md) | Public domain — US federal work, 17 U.S.C. § 105 | "Source: U.S. EIA, Form EIA-860" / "EIA U.S. Energy Atlas" |
| **USGS** | [PAD-US protected & managed lands](layers/padus-protected-lands.md) | Public domain — US federal work, 17 U.S.C. § 105 | USGS Gap Analysis Project |
| **MSHA** (US DOL) | [Large mines (filtered)](layers/mines.md) | Public domain — US federal work, 17 U.S.C. § 105 | "Source: MSHA Mine Data (US DOL)" |
| **NREL/NLR** | [Wind resource @ 100 m](layers/nlr-wind-100m.md) | Public domain — US federal work, 17 U.S.C. § 105 | "Source: NREL Wind Integration National Dataset (WIND) Toolkit" |
| **Global Solar Atlas** (Solargis / World Bank) | [Solar resource (PVOUT)](layers/gsa-solar-pvout.md) | **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — attribution **required** | "© 2024 Global Solar Atlas / Solargis / World Bank" |
| **IHFC / GFZ Data Services** | [Geothermal heat flow](layers/ihfc-geo-heatflow.md) | **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — attribution **required** | "© IHFC / GFZ Data Services (CC BY 4.0) — Global Heat Flow Database Release 2024" |
| **NREL/DOE** (Geothermal Data Repository) | [Hydrothermal systems](layers/nrel-hydrothermal-points.md) | Public domain — US federal work, 17 U.S.C. § 105 | "NREL/DOE Geothermal Data Repository" |
| **WorldPop** (University of Southampton) | [Population density](layers/worldpop-pop-density.md) | **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)** — attribution **required** | "WorldPop (www.worldpop.org) / University of Southampton (CC BY 4.0)" |
| **Our Grid Future** (Horizon Energy Systems) | [Planned transmission](layers/ogf-planned-transmission.md) | Custom — free for non-commercial use | Abramson et al., Horizon Energy Systems, 2026 |
| **WECC** (Western Electricity Coordinating Council) | [WECC Paths](layers/wecc-paths.md) | Public Version catalog, published by WECC | WECC 2026 Path Rating Catalog (Public Version) |
| **USFWS ECOS** | [Critical Habitat (ESA)](layers/crithab.md) | Public domain — US federal work, 17 U.S.C. § 105 | U.S. Fish & Wildlife Service |
| **BTS / FRA** (NARN) | [Railroads](layers/railroads.md) | Public domain — US federal work, 17 U.S.C. § 105 | "US DOT BTS / FRA North American Rail Network" |
| **USFS RMRS Fire Lab** | [Wildfire Hazard Potential](layers/wildfire-hazard.md) | Public domain — US federal work, 17 U.S.C. § 105 | "USFS RMRS Fire Lab — Wildfire Hazard Potential 2023" |
| **USGS NSHM** | [Seismic hazard (PGA)](layers/seismic-hazard.md) | Public domain — US federal work, 17 U.S.C. § 105 | "USGS 2018 National Seismic Hazard Model" |
| **NASA FIRMS / NIFC WFIGS** | [Live wildfire (hotspots, perimeters, incidents)](layers/wildfire-live.md) | Public domain — US federal work, 17 U.S.C. § 105 | "NASA FIRMS VIIRS + NIFC WFIGS" |
| **NOAA HMS** | [Live wildfire smoke](layers/wildfire-live.md) | Public domain — US federal work, 17 U.S.C. § 105 | "NOAA Hazard Mapping System (HMS)" |

> **License of this repo:** application code (HTML/JS/CSS/Python/shell) is MIT — see
> [`LICENSE`](../LICENSE). Data files under `data/` carry the upstream license of their
> source. OSM-derived files (PMTiles/GeoJSON incorporating OSM data) are ODbL derivative
> databases and are redistributed under ODbL.

---

## App tooling & basemaps

| Asset | Source | License |
|---|---|---|
| Map renderer | [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) | BSD-3-Clause |
| Vector tile format | [PMTiles](https://protomaps.com/docs/pmtiles) by Protomaps | BSD-3-Clause |
| Tile building | [`tippecanoe`](https://github.com/felt/tippecanoe) (Felt) + [`ogr2ogr`](https://gdal.org/programs/ogr2ogr.html) (GDAL) | MIT / X/MIT |
| Generator icons | [Google Material Symbols](https://fonts.google.com/icons) — `assets/icons.ts` | Apache 2.0 |
| Street basemap | [OpenStreetMap raster tiles](https://www.openstreetmap.org/) | ODbL — © OSM contributors |
| Aerial basemap | [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) | Esri terms of use |
| Place search | [Nominatim](https://nominatim.org/) | ODbL — © OSM contributors |
