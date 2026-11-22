Map of this folder; each file's header comment is the source of truth.

# assets/layers

- **`assets/layers/`** — MapLibre layer builders
  - `layer-plan.ts` — `LayerPlan` (a builder's sources + style layers, in paint order — plain
    data) and `applyLayerPlan(map, plan)`, the one step that puts a plan on the map: sources
    first, already-there guards, `beforeId`, each style layer's starting visibility from its
    registry layer's state (unless it pins its own), and each layer's `filter` registered as its base filter.
    A PMTiles source no starting layer draws is held without its url; `setMapLayerVisibility` (the way to
    show a style layer — `visibility.ts` and `nws-zone-join.ts` use it) reads the archive on first show;
    `npm run lint` rejects a raw `setLayoutProperty(id, "visibility", …)` outside the modules that own their sources
  - `layer-source.ts` — a registry layer's `data` declaration → its source: `layerSource(id)`
    (credited vector/raster/GeoJSON spec by `kind`; a non-native `data.id` becomes its `promoteId`), `layerDataUrl`, `layerSourceId` (layers
    declaring the same data share one source; `LAYER_SOURCE_ALIAS` for the rest), `SOURCE_DATA_URLS`
    (source-only GeoJSON), `pmtilesUrl` (non-registry join sources only)
  - `layer-init.ts` — shared plan helpers: `planPolygon`,
    `planRaster`, `planTransmissionLines`, `planSubstationPoints`,
    `countyBoundariesSource` (+ `ensureCountyBoundaries` for layers added after boot),
    `genPlantTextLayout`, `GEN_PLANT_TEXT_PAINT`
  - `layer-data.ts` — the lazy GeoJSON loader: `ensureLayerData` (with the `fromZoom` gate and
    zoom-settle retry), `loadSource` (the same without the gate, for a query), `fetchGeojson`;
    `liveFeed` — a live source's pull time and subfeed status (first feature, then FeatureCollection level); which file into which source comes from `layer-source.ts`;
    emits `layer:data` on the bus when a source's features land
  - `base-filters.ts` — zero-dependency `registerBaseFilter` + `BASE_LAYER_FILTERS`: each style
    layer's own inline filter (registered by `applyLayerPlan`), which `filters.ts`'s `effectiveFilter()` builds on
  - `add-all-layers.ts` — `addAllLayers()`: collects every builder's plan in z-order and applies
    them in one `applyLayerPlan` call, then runs the builders' non-layer side effects
  - `map-layers-{osm,hifld,eia,load,renewable,rail,conditions,mines,petroleum,wecc,westtec,admin,land}.ts` — per-source
    `plan*()` builders, each returning a `LayerPlan`
    (`conditions` = wildfire/seismic/NWS alerts/ODIN outages/FEMA NRI/NEXRAD radar — all the live + hazard layers;
    `admin` = administrative boundaries — US Counties/States/ZCTA, world Countries/Admin-1;
    `land` = PAD-US/Critical Habitat)
