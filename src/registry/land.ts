// Layer registry entries — protected lands, tribal lands, critical habitat, and
// (dev server only, until its rasters are published) the Routing constraints layer.
import type { LayerDef } from '../types.js';
import { CONSTRAINT_PALETTE } from '../colors/route-constraints.js';

// Routing constraints: what the route cube says about the land, one concern at a
// time (src/colors/route-constraints.ts CONCERNS; the row's picker sets
// state.routeConcern and assets/route-constraints.ts swaps the raster's url).
// Registered only on the dev server: its rasters sit beside the route cube in
// data/route/constraints/ and are not published (assets/constants.ts).
export const routeConstraintsLayer: LayerDef = {
  id:          "route-constraints",
  urlCode:     "RCN",
  label:       "Constraints",
  titleKey:    "layer.routeConstraints",
  group:       "land",
  sourceId:    "route-constraints",
  data:        { kind: "raster", key: "route_constraints",
                 credit: 'Route cube: <a href="https://www.usgs.gov/programs/gap-analysis-project">USGS PAD-US</a>, USFWS, EPA, NPS, BLM, USFS, FAA, USACE, USGS NLCD (land cover), DOE/ANL Section 368 energy corridors · PoPWest (Wu et al. 2023, PNAS 120(4) e2204098120, data <a href="https://doi.org/10.5281/zenodo.7460026">Zenodo 7460026</a>, CC BY 4.0; TNC categories) · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors (ODbL)</a>, for the OpenStreetMap entries · <a href="https://source.coop/repositories/seerai/hifld/description/">HIFLD</a> (SeerAI, CC BY 4.0) · <a href="https://www.worldpop.org/">WorldPop</a> (CC BY 4.0) · <a href="https://gis-fema.hub.arcgis.com/pages/usa-structures">USA Structures</a> (ORNL, FEMA Geospatial Response Office, CC BY 4.0)' },
  swatch:      CONSTRAINT_PALETTE.find(c => c.id === 'other-federal')!.colour,
  defaultOn:   false,
  // No static ramp: index.html #routeConstraintsLegend, drawn per concern.
  routeConcernLayer: true,
  mapLayerIds: ["route-constraints"],
  regions:     ["usa"],
  downloads:   {},
};

export const landLayers: LayerDef[] = [
  {
    id:            "padus",
    urlCode:       "PAD",
    label:         "✂️ PAD-US Protected Lands (Filtered)",
    titleKey:      "layer.padus",
    group:         "land",
    sourceId:      "usgs-padus",
    dataset:       "padus",
    // A content id (scripts/extract_padus.py): PAD-US has no key on every record.
    data:          { kind: "pmtiles", key: "padus", credit: '<a href="https://www.usgs.gov/programs/gap-analysis-project">USGS PAD-US</a>', id: { field: "fid", native: true }, analysis: "padus" },
    swatch:        "#15803d",
    defaultOn:     false,
    hoverField:    "name",
    mapLayerIds:   ["padus-fill", "padus-outline"],
    clickPriority: { "padus-fill": 520 },
    regions:       ["usa"],
    downloads: {},   // no download offered — map layer is a filtered summary subset, not the full dataset
  },
  {
    id:            "tribal-lands",
    urlCode:       "TRB",
    label:         "Tribal (Census)",
    titleKey:      "layer.tribalCensus",
    group:         "land",
    sourceId:      "hifld-tribal",
    data:          { kind: "geojson", key: "tribal_lands", credit: '<a href="https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html">Census TIGER</a>', id: { field: "geoid" },
                   analysis: "tribal_lands" },
    dataset:       "tribal_lands",
    swatch:        "#7c3aed",
    defaultOn:     false,
    hoverField:    "name",
    mapLayerIds:   ["tribal-fill", "tribal-outline"],
    clickPriority: { "tribal-fill": 540 },
    regions:       ["usa"],
    downloads: {},
  },
  {
    id:            "bia-tribal-lands",
    urlCode:       "BIA",
    label:         "Tribal (BIA AIAN-LAR)",
    titleKey:      "layer.tribalBia",
    group:         "land",
    sourceId:      "bia-bogs",
    data:          { kind: "geojson", key: "bia_tribal_lands", credit: '<a href="https://biamaps.geoplatform.gov/biatracts/">Bureau of Indian Affairs</a>', id: { field: "LARID" },
                   analysis: "bia_tribal_lands" },
    dataset:       "bia_tribal_lands",
    swatch:        "#8b5cf6",
    defaultOn:     false,
    hoverField:    "LARNAME",
    mapLayerIds:   ["bia-tribal-fill", "bia-tribal-outline"],
    clickPriority: { "bia-tribal-fill": 530 },
    regions:       ["usa"],
    downloads: {
      geojson: "data/releases/bia-tribal-lands.zip",
      shp: "data/releases/bia-tribal-lands-shp.zip",
    },
  },
  {
    id:            "mines",
    urlCode:       "MNE",
    label:         "✂️ Large Mines (MSHA, Filtered)",
    titleKey:      "layer.mines",
    group:         "load",
    sourceId:      "msha-mines",
    dataset:       "mines",
    data:          { kind: "geojson", key: "mines", credit: '<a href="https://arlweb.msha.gov/opengovernmentdata/ogimsha.asp">MSHA</a>', id: { field: "mine_id" } },
    swatch:        "#b45309",
    defaultOn:     false,
    mapLayerIds:   ["mines-icons"],
    clickPriority: { "mines-icons": 840 },
    regions:       ["usa"],
    downloads: {},   // filtered subset (peak employment ≥ 50), not the full MSHA dataset
  },
  {
    id:          "crithab",
    urlCode:     "CHB",
    label:       "Critical Habitat (ESA)",
    titleKey:    "layer.crithab",
    group:       "land",
    sourceId:    "fws-crithab",
    dataset:     "crithab",
    data:        { kind: "pmtiles", key: "crithab", credit: '<a href="https://ecos.fws.gov/ecp/report/table/critical-habitat.html">USFWS</a>', id: { field: "entity_id" }, analysis: "crithab" },
    swatch:      "#f59e0b",
    defaultOn:   false,
    mapLayerIds: ["crithab-fill", "crithab-outline"],
    clickPriority: { "crithab-fill": 510 },
    regions:     ["usa"],
    downloads: {},
  },
  ...(import.meta.env.DEV ? [routeConstraintsLayer] : []),
];
