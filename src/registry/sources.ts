import type { LayerSourceDef, DownloadRegion } from '../types.js';

export const REGION_CODE_MAP: Record<DownloadRegion, string> = {
  'north-america': 'na',
  'europe': 'eu',
  'asia': 'as',
  'south-america': 'sa',
  'africa': 'af',
  'oceania': 'oc',
  'central-america': 'ca',
  'antarctica': 'an',
};

export const LAYER_SOURCES: Record<string, LayerSourceDef> = {
  "osm": {
    label: "OpenStreetMap",
    tooltip: "Source: OpenStreetMap contributors",
  },
  "hifld-power": {
    label: "HIFLD / DHS CISA",
    tooltip: "Source: HIFLD / DHS CISA electric power infrastructure",
  },
  "hifld-substations": {
    label: "HIFLD Substations",
    tooltip: "Source: HIFLD / DHS CISA substations",
  },
  "hifld-natgas": {
    label: "HIFLD / EIA",
    tooltip: "Source: HIFLD / EIA natural gas and petroleum infrastructure",
  },
  // stable id; data source is Census TIGER, not HIFLD
  "hifld-tribal": {
    label: "Census TIGER Tribal Lands",
    tooltip: "Source: U.S. Census Bureau, TIGER/Line — AIANNH areas",
  },
  "bia-bogs": {
    label: "BIA AIAN-LAR",
    tooltip: "Source: Bureau of Indian Affairs - Branch of Geospatial Support",
  },
  "hifld-nerc": {
    label: "HIFLD NERC Regions",
    tooltip: "Source: HIFLD NERC regions",
  },
  "hifld-ba": {
    label: "HIFLD Balancing Authorities",
    tooltip: "Source: HIFLD balancing authority areas",
  },
  "eia-ba": {
    label: "EIA Balancing Authorities",
    tooltip: "Source: U.S. EIA balancing authority areas (ArcGIS Online)",
  },
  "hifld-retail": {
    label: "HIFLD Retail Territories",
    tooltip: "Source: HIFLD retail service territories",
  },
  "ogf": {
    label: "Our Grid Future",
    tooltip: "Source: Our Grid Future — Horizon Energy Systems planned transmission database",
  },
  "eia": {
    label: "EIA Form 860",
    tooltip: "Source: U.S. EIA Form 860",
  },
  "msha-mines": {
    label: "MSHA Mines",
    tooltip: "Source: MSHA Mine Data — large mines (peak employment ≥ 50); filtered subset, not the full dataset. Public domain (US DOL).",
  },
  "usgs-padus": {
    label: "USGS PAD-US",
    tooltip: "Source: USGS PAD-US — filtered subset displayed for aesthetic and display clarity; not a complete or regulatory representation",
  },
  "nlr-wind": {
    label: "NREL/NLR WIND Toolkit",
    tooltip: "Source: NREL/NLR WIND Toolkit",
  },
  "global-solar-atlas": {
    label: "Global Solar Atlas",
    tooltip: "Source: Global Solar Atlas",
  },
  "ihfc-gfz": {
    label: "IHFC / GFZ Data Services",
    tooltip: "Source: IHFC / GFZ Data Services",
  },
  "nrel-doe-hydrothermal": {
    label: "NREL/DOE Hydrothermal",
    tooltip: "Source: NREL/DOE Geothermal Data Repository",
  },
  "worldpop": {
    label: "WorldPop",
    tooltip: "Source: WorldPop (University of Southampton) — CC BY 4.0",
  },
  "fws-crithab": {
    label: "USFWS ECOS",
    tooltip: "Source: USFWS ECOS — Critical Habitat for Threatened & Endangered Species (Jan 2025)",
  },
  "bts-narn": {
    label: "BTS NARN",
    tooltip: "Source: US DOT BTS / FRA North American Rail Network — US public domain",
  },
  "usfs-firelab": {
    label: "USFS RMRS Fire Lab",
    tooltip: "Source: USFS Rocky Mountain Research Station Fire Lab — Wildfire Hazard Potential 2023 (public domain)",
  },
  "usgs-nshm": {
    label: "USGS NSHM",
    tooltip: "Source: USGS 2018 National Seismic Hazard Model — Peak Ground Acceleration (PGA), 2% in 50yr (public domain)",
  },
  "nasa-firms-nifc": {
    label: "NASA FIRMS / NIFC WFIGS",
    tooltip: "Source: NASA FIRMS VIIRS active fire detections + NIFC WFIGS current fire perimeters (refreshed hourly)",
  },
  "noaa-hms": {
    label: "NOAA HMS Smoke",
    tooltip: "Source: NOAA Hazard Mapping System (HMS) — satellite smoke detection polygons (refreshed every 3 hours)",
  },
  "eia-atlas": {
    label: "EIA U.S. Energy Atlas",
    tooltip: "Source: U.S. Energy Information Administration — U.S. Energy Atlas (public domain)",
  },
  "wecc-paths": {
    label: "WECC Path Rating Catalog",
    tooltip: "Source: WECC 2026 Path Rating Catalog (Public Version) — path definitions, ratings, and directionality",
  },
  "ornl-odin": {
    label: "ORNL ODIN",
    tooltip: "Source: ORNL ODIN (Oak Ridge National Laboratory) — live county-level power-outage aggregates; utilities self-report, coverage is partial",
  },
  "noaa-nws": {
    label: "NOAA National Weather Service",
    tooltip: "Source: NOAA/NWS active alerts — US Government work, public domain",
  },
  "eccc-msc": {
    label: "Environment and Climate Change Canada (MSC GeoMet)",
    tooltip: "Source: Environment and Climate Change Canada (MSC GeoMet) — active weather alerts",
  },
  "noaa-gfs": {
    label: "NOAA/NCEP GFS",
    tooltip: "Source: NOAA/NCEP GFS 0.25° operational forecasts via AWS Open Data — temperature, wind, humidity, pressure (public domain)",
  },
  "iem-nexrad": {
    label: "Iowa Environmental Mesonet",
    tooltip: "Source: Iowa Environmental Mesonet — NEXRAD composite reflectivity tiles (public NWS data); Canada via ECCC GeoMet WMS",
  },
  "boem": {
    label: "BOEM",
    tooltip: "Source: Bureau of Ocean Energy Management (BOEM)",
  },
  "westtec": {
    label: "WestTEC 10-Year Horizon",
    tooltip: "Source: WestTEC (Western Transmission Expansion Coalition), a Western Power Pool initiative — West-Wide Transmission Study, 10-Year Horizon Report (Feb 2026)",
  },
  "cgaz-adm0": {
    label: "geoBoundaries CGAZ",
    tooltip: "Source: geoBoundaries Comprehensive Global Administrative Zones — country boundaries",
  },
  "cgaz-adm1": {
    label: "geoBoundaries CGAZ",
    tooltip: "Source: geoBoundaries Comprehensive Global Administrative Zones — state/province boundaries",
  },
  "census-states": {
    label: "Census Cartographic Boundaries",
    tooltip: "Source: U.S. Census Bureau — cartographic boundary files, state boundaries",
  },
  "census-counties": {
    label: "Census Cartographic Boundaries",
    tooltip: "Source: U.S. Census Bureau — cartographic boundary files, county boundaries",
  },
  "census-zcta": {
    label: "Census Cartographic Boundaries",
    tooltip: "Source: U.S. Census Bureau — cartographic boundary files, ZIP Code Tabulation Areas (ZCTA)",
  },
};
