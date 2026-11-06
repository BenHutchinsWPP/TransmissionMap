# Service library hosts

Written by `node scripts/check_service_library.mjs`: each library entry is re-probed (layer metadata, a map
export, a capabilities document, a tile or a GeoJSON head, by kind) with `Origin: https://example.org`, and the
response must allow that origin (CORS).

| Host | Entries | Last checked | Status |
|---|---|---|---|
| apps.fs.usda.gov | usfs-forest-boundaries, usfs-ownership, usfs-roadless-areas, usfs-wui-2020, usfs-wild-scenic-rivers | 2026-10-22 | ok |
| arcgis.netl.doe.gov | netl-coal-closure, netl-energy-communities-msa, cejst-disadvantaged, netl-co2-pipelines, doe-ccus-projects, usgs-co2-storage | 2026-10-22 | ok |
| basemap.nationalmap.gov | usgs-hydro, usgs-topo, usgs-imagery, usgs-imagery-topo, usgs-shaded-relief | 2026-10-22 | ok |
| bio.discomap.eea.europa.eu | eea-natura-2000 | 2026-10-22 | ok |
| coast.noaa.gov | noaa-slr-2ft, noaa-radar-impact-zones, noaa-submarine-cables, noaa-danger-zones, noaa-marine-sanctuaries | 2026-10-22 | ok |
| earthquake.usgs.gov | usgs-qfaults, usgs-quakes-day, usgs-nshm-faults | 2026-10-22 | ok |
| elevation.nationalmap.gov | usgs-3dep-hillshade | 2026-10-22 | ok |
| energy.usgs.gov | usgs-uspvdb | 2026-10-22 | FAIL — usgs-uspvdb: HTTP 500 |
| fwspublicservices.wim.usgs.gov | nwi-wetlands | 2026-10-22 | ok |
| geoappext.nrcan.gc.ca | nacei-power-plants, nrcan-clean-generation | 2026-10-22 | ok |
| geodata.epa.gov | epa-nonattainment-ozone-2015, epa-nonattainment-pm25-2012, epa-class1-areas, epa-nonattainment-so2-2010, epa-nonattainment-ozone-2008 | 2026-10-22 | ok |
| gibs.earthdata.nasa.gov | nasa-black-marble | 2026-10-22 | ok |
| gis.blm.gov | blm-surface-management, blm-acec, blm-wilderness-study-areas, blm-plss-townships, blm-pfyc | 2026-10-22 | ok |
| hazards.fema.gov | fema-flood-zones | 2026-10-22 | ok |
| hydro.nationalmap.gov | nhd-flowlines, usgs-wbd-huc8 | 2026-10-22 | FAIL — nhd-flowlines: HTTP 502; usgs-wbd-huc8: HTTP 504 |
| image.discomap.eea.europa.eu | corine-2018 | 2026-10-22 | ok |
| index.nationalmap.gov | usgs-3dep-lidar | 2026-10-22 | ok |
| maps-cartes.ec.gc.ca | eccc-cpcad | 2026-10-22 | ok |
| mapservices.nps.gov | nps-wilderness, nps-nrhp | 2026-10-22 | ok |
| mapservices.weather.noaa.gov | spc-outlook-day1, nhc-outlook, spc-fire-weather-day1, cpc-8-14-day-temp, wpc-winter-storm-severity, cpc-seasonal-temp, cpc-seasonal-drought, cpc-hazards-temp-3-7-day, wpc-river-flood-outlook | 2026-10-22 | ok |
| mesonet.agron.iastate.edu | goes-east-visible | 2026-10-22 | ok |
| mrdata.usgs.gov | usgs-geology | 2026-10-22 | ok |
| nowcoast.noaa.gov | nowcoast-cyclone-cone, nowcoast-sea-surface-temp, nowcoast-lightning, nowcoast-water-vapor | 2026-10-22 | ok |
| raw.githubusercontent.com | natural-earth-rivers, natural-earth-countries, natural-earth-admin1 | 2026-10-22 | ok |
| sdmdataaccess.sc.egov.usda.gov | ssurgo-soils | 2026-10-22 | ok |
| services.arcgis.com | epa-repowering, uswtdb, epa-cleanups, federal-lands-2017, faa-airports, national-highway-system, dot-military-bases, fws-refuges, epa-lmop-landfill-gas, dot-alt-fuel-stations, dot-alt-fuel-corridors, hud-opportunity-zones, epa-sole-source-aquifers | 2026-10-22 | ok |
| services1.arcgis.com | blm-section-368, blm-solar-zones, ut-energy-corridors, blm-national-monuments | 2026-10-22 | ok |
| services2.arcgis.com | eia-crude-pipelines, eia-product-pipelines, conanp-protected-areas, usace-nid-dams | 2026-10-22 | ok |
| services3.arcgis.com | cdc-svi-2022-tracts | 2026-10-22 | ok |
| services6.arcgis.com | faa-obstacles, faa-class-airspace, faa-uas-facility-map, faa-military-training-routes, faa-special-use-airspace | 2026-10-22 | ok |
| services7.arcgis.com | eia-sedimentary-basins, boem-wind-turbines, boem-export-cables, boem-gom-wells, boem-cable-interconnections, boem-offshore-substations, boem-cable-landings, eia-tight-oil-shale-plays, boem-ocs-withdrawals, eia-padd, usace-principal-ports, usace-navigation-channels, usace-regulatory-districts | 2026-10-22 | ok |
| services9.arcgis.com | drought-monitor | 2026-10-22 | ok |
| storage.googleapis.com | jrc-surface-water | 2026-10-22 | ok |
| tigerweb.geo.census.gov | census-tracts, census-urban-areas, census-congressional-districts, census-places, census-county-subdivisions | 2026-10-22 | ok |
| wms.gebco.net | gebco-bathymetry | 2026-10-22 | ok |
| www.mrlc.gov | nlcd-2021 | 2026-10-22 | ok |

## Whole-host vetted hosts

These entries in `src/registry/service-hosts.json` vet every service on the host, not only the library
entries above (the other entries name a path prefix or an exact service root):

apps.fs.usda.gov, arcgis.netl.doe.gov, basemap.nationalmap.gov, bio.discomap.eea.europa.eu, coast.noaa.gov,
earthquake.usgs.gov, elevation.nationalmap.gov, energy.usgs.gov, enviroatlas.epa.gov,
fwspublicservices.wim.usgs.gov, geoappext.nrcan.gc.ca, geodata.epa.gov, gibs.earthdata.nasa.gov, gis.blm.gov,
hazards.fema.gov, hydro.nationalmap.gov, image.discomap.eea.europa.eu, index.nationalmap.gov,
maps-cartes.ec.gc.ca, mapservices.nps.gov, mapservices.weather.noaa.gov, mesonet.agron.iastate.edu,
mrdata.usgs.gov, nowcoast.noaa.gov, sdmdataaccess.sc.egov.usda.gov, tigerweb.geo.census.gov, wms.gebco.net,
www.mrlc.gov.
