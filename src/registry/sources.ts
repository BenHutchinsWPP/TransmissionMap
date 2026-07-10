// Data source metadata — label, tooltip, and credits dialog ID for each source.
// >>> ADD-LAYER: layer-sources — see docs/adding-a-layer.md §5
import type { LayerSourceDef } from '../types.js';

export const LAYER_SOURCES: Record<string, LayerSourceDef> = {
  "osm": {
    label: "OpenStreetMap",
    tooltip: "Source: OpenStreetMap contributors",
    creditId: "osm",
  },
  "hifld-power": {
    label: "HIFLD / DHS CISA",
    tooltip: "Source: HIFLD / DHS CISA electric power infrastructure",
    creditId: "hifld-power",
  },
  "hifld-substations": {
    label: "HIFLD Substations",
    tooltip: "Source: HIFLD / DHS CISA substations",
    creditId: "hifld-substations",
  },
  "hifld-natgas": {
    label: "HIFLD / EIA",
    tooltip: "Source: HIFLD / EIA natural gas and petroleum infrastructure",
    creditId: "hifld-natgas",
  },
  // stable id; data source is Census TIGER, not HIFLD
  "hifld-tribal": {
    label: "Census TIGER Tribal Lands",
    tooltip: "Source: U.S. Census Bureau, TIGER/Line — AIANNH areas",
    creditId: "hifld-tribal",
  },
  "bia-bogs": {
    label: "BIA AIAN-LAR",
    tooltip: "Source: Bureau of Indian Affairs - Branch of Geospatial Support",
    creditId: "bia-bogs",
  },
  "hifld-nerc": {
    label: "HIFLD NERC Regions",
    tooltip: "Source: HIFLD NERC regions",
    creditId: "hifld-nerc",
  },
  "hifld-ba": {
    label: "HIFLD Balancing Authorities",
    tooltip: "Source: HIFLD balancing authority areas",
    creditId: "hifld-ba",
  },
  "hifld-retail": {
    label: "HIFLD Retail Territories",
    tooltip: "Source: HIFLD retail service territories",
    creditId: "hifld-retail",
  },
  "ogf": {
    label: "Our Grid Future",
    tooltip: "Source: Our Grid Future — Horizon Energy Systems planned transmission database",
    creditId: "ogf",
  },
  "eia": {
    label: "EIA Form 860",
    tooltip: "Source: U.S. EIA Form 860",
    creditId: "eia",
  },
  "msha-mines": {
    label: "MSHA Mines",
    tooltip: "Source: MSHA Mine Data — large mines (peak employment ≥ 50); filtered subset, not the full dataset. Public domain (US DOL).",
    creditId: "msha-mines",
  },
  "usgs-padus": {
    label: "USGS PAD-US",
    tooltip: "Source: USGS PAD-US — filtered subset displayed for aesthetic and display clarity; not a complete or regulatory representation",
    creditId: "usgs-padus",
  },
  "nlr-wind": {
    label: "NREL/NLR WIND Toolkit",
    tooltip: "Source: NREL/NLR WIND Toolkit",
    creditId: "nlr-wind",
  },
  "global-solar-atlas": {
    label: "Global Solar Atlas",
    tooltip: "Source: Global Solar Atlas",
    creditId: "global-solar-atlas",
  },
  "ihfc-gfz": {
    label: "IHFC / GFZ Data Services",
    tooltip: "Source: IHFC / GFZ Data Services",
    creditId: "ihfc-gfz",
  },
  "nrel-doe-hydrothermal": {
    label: "NREL/DOE Hydrothermal",
    tooltip: "Source: NREL/DOE Geothermal Data Repository",
    creditId: "nrel-doe-hydrothermal",
  },
  "worldpop": {
    label: "WorldPop",
    tooltip: "Source: WorldPop (University of Southampton) — CC BY 4.0",
    creditId: "worldpop",
  },
  "fws-crithab": {
    label: "USFWS ECOS",
    tooltip: "Source: USFWS ECOS — Critical Habitat for Threatened & Endangered Species (Jan 2025)",
    creditId: "fws-crithab",
  },
  "bts-narn": {
    label: "BTS NARN",
    tooltip: "Source: US DOT BTS / FRA North American Rail Network — US public domain",
    creditId: "bts-narn",
  },
  "usfs-firelab": {
    label: "USFS RMRS Fire Lab",
    tooltip: "Source: USFS Rocky Mountain Research Station Fire Lab — Wildfire Hazard Potential 2023 (public domain)",
    creditId: "usfs-firelab",
  },
  "usgs-nshm": {
    label: "USGS NSHM",
    tooltip: "Source: USGS 2018 National Seismic Hazard Model — Peak Ground Acceleration (PGA), 2% in 50yr (public domain)",
    creditId: "usgs-nshm",
  },
  "nasa-firms-nifc": {
    label: "NASA FIRMS / NIFC WFIGS",
    tooltip: "Source: NASA FIRMS VIIRS active fire detections + NIFC WFIGS current fire perimeters (refreshed hourly)",
    creditId: "nasa-firms-nifc",
  },
  "noaa-hms": {
    label: "NOAA HMS Smoke",
    tooltip: "Source: NOAA Hazard Mapping System (HMS) — satellite smoke detection polygons (refreshed every 3 hours)",
    creditId: "noaa-hms",
  },
  "eia-atlas": {
    label: "EIA U.S. Energy Atlas",
    tooltip: "Source: U.S. Energy Information Administration — U.S. Energy Atlas (public domain)",
    creditId: "eia-atlas",
  },
  "wecc-paths": {
    label: "WECC Path Rating Catalog",
    tooltip: "Source: WECC 2026 Path Rating Catalog (Public Version) — path definitions, ratings, and directionality",
    creditId: "wecc-paths",
  },
  "ornl-odin": {
    label: "ORNL ODIN",
    tooltip: "Source: ORNL ODIN (Oak Ridge National Laboratory) — live county-level power-outage aggregates; utilities self-report, coverage is partial",
    creditId: "ornl-odin",
  },
  "noaa-nws": {
    label: "NOAA National Weather Service",
    tooltip: "Source: NOAA/NWS active alerts — US Government work, public domain",
    creditId: "noaa-nws",
  },
};
