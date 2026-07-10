# Map Layers

TransmissionMap groups its layers into eight panel sections. This page introduces what each
section covers and why it's useful — follow the links for field references, processing
details, and caveats per layer.

For a license and attribution index see [../data-sources.md](../data-sources.md). Full source
details, download origins, and field references are in each layer's own doc.

---

## 〰 Transmission

The backbone of the map: high-voltage lines and substations from two complementary datasets.

**OSM** ([lines](osm-transmission-lines.md) · [substations](osm-substations.md)) is community-maintained and often more current than federal data — useful for spotting recently-built infrastructure and for the richest attribute coverage on named facilities. **HIFLD** ([lines](hifld-transmission-lines.md) · [substations](hifld-substations.md)) is the US public-domain dataset maintained by DHS/CISA from national laboratory sources; it fills gaps where OSM mapping is sparse, especially at distribution voltages (69–138 kV) in rural areas. Running both together shows where the datasets agree, where one is ahead of the other, and where infrastructure genuinely differs.

**[Planned transmission](ogf-planned-transmission.md)** (Our Grid Future) overlays proposed and under-construction projects from the national database — useful context for transmission siting and interconnection analysis.

**[WECC Paths](wecc-paths.md)** marks each active WECC transmission path by its catalog number, with rating type, directional transfer limits, and the defining line list from the 2026 WECC Path Rating Catalog — context for West-wide transfer capability and interface analysis.

---

## ⚡ Generators

Power plant data at two levels of detail.

**EIA Form 860** ([eia-generators](eia-generators.md)) is the authoritative US regulatory dataset: every utility-scale plant ≥1 MW with nameplate capacity, fuel type, NERC region, and balancing authority. Updated annually. **OSM generators** ([generators](osm-generators.md) · [plants](osm-plants.md)) adds unit-level granularity (individual turbines and panel arrays) and international coverage, at the cost of less consistent attribute fill.

---

## ⛽ Fuel Delivery

Pipelines and rail — the corridors that move fuel to and between facilities.

**OSM pipelines** ([osm-pipelines](osm-pipelines.md)) covers routes and feature points (compressor stations, valves) globally. **HIFLD natural gas & petroleum** ([hifld-natgas](hifld-natgas.md)) provides the US-authoritative dataset: interstate and intrastate gas pipelines, HGL pipelines, and several thousand facility points across nine facility types (LNG terminals, underground storage, processing plants, petroleum terminals, trading hubs, SPR sites, border crossings, peak shaving, and above-ground LNG storage). **Railroads** ([railroads](railroads.md)) is the BTS/FRA North American Rail Network — included as a fuel-logistics and siting-context layer: rail corridors carry coal and other fuels and are often co-located with or adjacent to transmission rights-of-way.

---

## 🌱 Potential

Raster and point layers showing where renewable energy potential is highest.

**Wind** ([nlr-wind-100m](nlr-wind-100m.md)) is the NREL/NLR WIND Toolkit multi-year average at 100 m hub height — the standard resource layer for US wind project screening. **Solar** ([gsa-solar-pvout](gsa-solar-pvout.md)) is the Global Solar Atlas PVOUT (specific PV yield, kWh/kWp/day) — a direct proxy for panel output. **Geothermal heat flow** ([ihfc-geo-heatflow](ihfc-geo-heatflow.md)) is an IDW-gridded raster of surface heat flux (mW/m²) from tens of thousands of IHFC measurements — useful for identifying Basin and Range, Cascades, and Yellowstone corridor geothermal potential. **Hydrothermal systems** ([nrel-hydrothermal-points](nrel-hydrothermal-points.md)) places ~1,200 named low-temperature springs and wells as points, colored by reservoir temperature.

The three raster layers (wind, solar, geothermal heat flow) support a cursor hover readout that shows the value at the pointer.

---

## 🏙 Load

Where electricity demand concentrates.

**Data centers** ([osm-datacenters](osm-datacenters.md)) maps OSM-tagged data center facilities — a location-concentrated source of grid load. **Population density** ([worldpop-pop-density](worldpop-pop-density.md)) is the WorldPop 2020 raster (people/km², log-colored), a proxy for residential and commercial demand; it also supports a cursor hover readout. **Large mines** ([mines](mines.md)) plots ~2.3k active and retired US mines with peak quarterly employment ≥ 50, from the MSHA mine registry.

---

## 🏞 Land

Layers that show where land-use constraints affect transmission siting.

**PAD-US** ([padus-protected-lands](padus-protected-lands.md)) is the USGS authoritative inventory of US protected and managed lands — national forests, wilderness areas, BLM land, state parks, conservation areas, and more. Filtered to GAP status 1–3 (excludes city parks with no protection mandate). **Tribal lands** ([tribal-lands](tribal-lands.md) & [bia-tribal-lands](bia-tribal-lands.md)) shows American Indian, Alaska Native, and Native Hawaiian Areas from the Census TIGER/Line dataset, as well as the BIA AIAN-LAR dataset. **Critical Habitat** ([crithab](crithab.md)) is the USFWS national critical-habitat polygons (pre-baked to PMTiles) — threatened and endangered species designations under the Endangered Species Act.

---

## 🗺 Regions

Administrative and operational boundaries for understanding grid organization.

**HIFLD regions** ([hifld-regions](hifld-regions.md)) covers NERC reliability regions, balancing-authority / control areas, and retail electricity territories — the three boundary sets that define how the US grid is operated and regulated.

---

## 🔥 Hazards

Physical-risk layers for siting and resilience analysis.

**Seismic hazard** ([seismic-hazard](seismic-hazard.md)) is the USGS 2018 National Seismic Hazard Model peak ground acceleration (2% probability of exceedance in 50 years), a baked-color raster with a hover readout. **Wildfire hazard** ([wildfire-hazard](wildfire-hazard.md)) is the USFS RMRS Fire Lab Wildfire Hazard Potential 2023 — a categorized raster of relative wildfire risk. **Live wildfire** ([wildfire-live](wildfire-live.md)) adds three hourly-refreshed layers — active perimeters + VIIRS hotspots, named incidents, and NOAA HMS smoke — served off the orphan `data` branch. **Live weather alerts** ([nws-alerts](nws-alerts.md)) is a curated, frequently-refreshed feed of polygon-bearing NOAA/NWS active alerts (tornado, severe thunderstorm, flash flood, fire weather, heat, high wind, winter storm, tropical), colored by alert group and served off the same orphan `data` branch pattern. **Power outages** ([outages](outages.md)) is a live county-level ODIN choropleth (customers affected) joined onto the shared county-boundary tiles by MapLibre feature-state — the data file carries no geometry.

---

## Shared infrastructure (not a map layer)

**County boundaries** ([boundaries](boundaries.md)) is a Census TIGER county
tileset that draws nothing on its own. County-FIPS-keyed datasets join their
values onto it via MapLibre `feature-state` rather than shipping duplicate
polygon geometry — so such a layer is only a `{fips: value}` JSON plus a fill
layer. First consumer: [power outages](outages.md).

---

## Adding a layer

See [../adding-a-layer.md](../adding-a-layer.md) for the step-by-step guide.
