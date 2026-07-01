# Adding a New Layer

Every layer in TransmissionMap touches the same set of files in the same order. This doc walks through both patterns — **vector** (GeoJSON or PMTiles) and **raster** (baked-color PMTiles + hover LUT) — and lists the optional extras (filter UI, popup, legend ramp).

> Every insertion point below is marked in-code with a greppable anchor:
> `rg ">>> ADD-LAYER"` lists them all; `rg ">>> ADD-LAYER: layer-registry"`
> jumps to one. Read ~30 lines around an anchor instead of whole files.

---

## 1. Decide the format

| Situation | Format |
|---|---|
| ≤ ~20k point or polygon features | **Gzipped GeoJSON** — loads once, all features available for search and popups |
| > ~20k features, or line/polygon data with complex geometry | **PMTiles** (vector) — tiled delivery, tippecanoe handles density |
| Continuous field data (wind speed, solar irradiance, population density) | **PMTiles** (raster) — baked RGBA color from gdaldem + hover LUT |

All built tiles/GeoJSON go to a single output directory: `data/layers/`.

---

## 2–3. Data pipeline — see [adding-a-dataset.md](adding-a-dataset.md)

The extract/build script, `Makefile` wiring, and `tile_manifest.yaml` block are
the data-engineering half, covered entirely in
**[adding-a-dataset.md](adding-a-dataset.md)** (model scripts to copy, shared
helpers, conventions). Do that first; come back here when the served file
exists in `data/layers/`.

One exception stays in this doc because it's half-frontend: the raster color
ramp (**§3R** below) — its stops must mirror `src/colors/ramps.ts`.

Anchor (in `tile_manifest.yaml`): `>>> ADD-LAYER: tile-build-calls`

---

## 3R. Raster color ramp (raster layers only)

Skip if you're adding a vector layer. A baked-color raster needs its colors in
**two places that must stay in sync**:

1. **`scripts/<id>_color_ramp.txt`** — the gdaldem `color-relief` file the build
   script feeds to `rc_bake_tiles`. Columns: `value R G B A`. Add an `nv … 0` row
   (transparent NoData) and a `0 … 0` row if zero should be transparent. For a
   **continuous** ramp, list a handful of stops and color-relief interpolates
   between them; for a **categorical** raster, list one row per integer class.
   Models: `scripts/seis_color_ramp.txt` (continuous), `scripts/whp_color_ramp.txt`
   (categorical).

2. **`src/colors/ramps.ts`** — export `<X>_RAMP_STOPS` (`[value, "r,g,b"]` pairs,
   mirroring the `.txt`) and `<X>_RAMP_MAX` (the clamp value). The registry entry's
   `ramp:` field (§5) reads these to draw the in-panel legend gradient, and
   `raster-probes.ts` (§7) reads `_RAMP_MAX` for the hover arrow. **Categorical
   rasters skip this** — they use a static legend in `index.html` instead (see the
   `#whpLegend` block) and have no hover LUT.

Anchor (in `src/colors/ramps.ts`): `>>> ADD-LAYER: raster-ramp`

---

## 4. `assets/constants.ts` — register the data URL

Add an entry to the `DATA` object. GeoJSON layers use the `.geojson.gz` path; PMTiles use `.pmtiles`:

```ts
my_layer: "data/layers/my_layer.geojson.gz",   // GeoJSON
// or:
my_layer: "data/layers/my_layer.pmtiles",        // PMTiles
```

For raster layers with a hover LUT, add three entries:
```ts
my_lut:      "data/layers/my_layer_lut.i16",
my_lut_meta: "data/layers/my_layer_lut.json",
my_tiles:    "data/layers/my_layer.pmtiles",
```

Anchor: `>>> ADD-LAYER: data-urls`

---

## 5. `src/registry/<group>.ts` — layer registry entry

Every visible layer needs an entry in the right registry file. Add it to the array in the file matching its group — the imports in `src/registry/index.ts` list every registry file (generators, transmission, pipelines, renewable, land, regions, hazards, rail, …). New sources go in `src/registry/sources.ts`.

### `src/registry/sources.ts` (if new data provider)

```ts
"my-source": {
  label: "My Source Name",
  tooltip: "Source: My Source Name — license info",
  creditId: "my-source",  // matches data-source-credit attribute in index.html
},
```

### Registry entry

```ts
{
  id:          "my-layer",          // unique; matches MapLibre source/layer IDs
  urlCode:     "MYL",               // 3-char URL hash code (must be unique across all layers)
  label:       "My Layer",          // shown in the layers panel
  group:       "load",              // panel group — see the `groups` array in assets/ui/ui-layer-rows.ts for the current list
  sourceId:    "my-source",         // key into LAYER_SOURCES (src/registry/sources.ts)
  swatch:      "#6366f1",           // color dot shown in panel row
  defaultOn:   false,               // visible on page load?
  mapLayerIds: ["my-layer-circles"],// all MapLibre layer IDs this entry controls
  downloads: {
    zip: "data/releases/my-layer.zip", // per-layer pack built by build_releases.py
    url: null,                         // optional external "source data" link
  },
}
```

**Optional flags:**

| Flag | Purpose |
|---|---|
| `voltageLayer: true` | Shows the voltage legend when this layer is on |
| `fuelLayer: true` | Shows the fuel legend when this layer is on |
| `rasterLayer: true` | Marks as a raster (skips vector visibility logic) |
| `filterType: "kv"\|"fuel_osm"\|"fuel_eia"\|"pipeline_type"` | Enables a filter chip panel |
| `filterField: "nominal_kv"` | Which feature property the filter reads |
| `ramp: { stops, max, unit, minLabel?, maxLabel? }` | Inline color-ramp legend in the panel row |
| `hoverField: "name"` | Polygon highlight on click — set to the feature property used to match the active feature |
| `lineHighlightKeys: ["name"]` | Line click-highlight — set to one or more feature properties that uniquely identify a line |

**Ramp stops** are `[value, "r,g,b"]` pairs matching the gdaldem color ramp — define them as `<X>_RAMP_STOPS` / `<X>_RAMP_MAX` in `src/colors/ramps.ts` and reference them here (see **§3R**). `minLabel`/`maxLabel` override the default "0" / `max+ unit` labels.

Anchor: `>>> ADD-LAYER: layer-sources`
Anchor: `>>> ADD-LAYER: layer-registry`

---

## 6. `assets/layers/map-layers-*.ts` — MapLibre layer builder

Add an `addMyLayer()` function in the appropriate sibling file, or create a new one (e.g., `assets/layers/map-layers-load.ts`). The function must be **idempotent** — check for the source before adding:

```ts
function addMyLayer() {
  if (state.map.getSource("my-layer")) return;

  state.map.addSource("my-layer", {
    type: "geojson",          // or "vector" for PMTiles
    data: EMPTY_FC,           // GeoJSON starts empty; data fetched lazily
    // url: pmtilesUrl(DATA.my_layer),  // PMTiles: use this instead
  });

  state.map.addLayer({
    id: "my-layer-circles",
    type: "circle",           // circle | symbol | fill | line
    source: "my-layer",
    // "source-layer": "my_layer",   // PMTiles vector only — matches tippecanoe -l name
    minzoom: 4,
    layout: { visibility: initialVisibility("my-layer") },
    paint: {
      "circle-color": "#6366f1",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3, 10, 6],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
    },
  });

  // If this layer participates in a filter (filterType set in registry):
  registerBaseFilter("my-layer-circles", null);
}
```

`initialVisibility(id)` returns `"visible"` or `"none"` based on the layer's `defaultOn` and any URL hash state.

`registerBaseFilter(mapLayerId, baseFilter)` connects the layer to the filter UI. Pass `null` for no additional base filter, or a MapLibre expression to always apply (e.g., only show HV lines).

---

## 7. `assets/layers/layer-init.ts` — connect lazy loading and orchestration

### For GeoJSON layers: add to `LAZY_GEOJSON`

```ts
const LAZY_GEOJSON = {
  // existing entries...
  "my-layer": DATA.my_layer,
};
```

This is what `ensureLayerData()` uses to fetch and populate the source on first enable. Do not add PMTiles layers here — MapLibre tiles lazily already.

### Call from `addAllLayers()` in `assets/layers/add-all-layers.ts`

Add your call in the right z-order position:

```ts
function addAllLayers() {
  addPopDensity();
  addMyLayer();      // ← add here, grouped with similar layers
  // ...
}
```

Z-order matters: layers added earlier are drawn below layers added later. Rasters go first (bottom), then region fills, then land polygons, then point infrastructure.

### For raster layers with hover LUT: add to `RASTER_PROBES` in `assets/raster-probes.ts`

```ts
const RASTER_PROBES = {
  // existing entries...
  "my-layer": {
    lut:     () => DATA.my_lut,
    meta:    () => DATA.my_lut_meta,
    max:     MY_MAX_VALUE,
    // Optional — only needed if the display scale is non-linear (e.g., log):
    pct:     (v: number) => Math.log10(1 + v) / MY_MAX_VALUE * 100,
    readout: (v: number) => `${v.toFixed(1)} units at cursor`,
  },
};
```

`pct` maps a raw value to a 0–100 percentage for arrow positioning on the legend ramp. Omit it for linear scales — the default uses `(value / max) * 100`.

Anchor: `>>> ADD-LAYER: lazy-geojson`
Anchor: `>>> ADD-LAYER: raster-probes`
Anchor: `>>> ADD-LAYER: add-all-layers`

---

## 8. `assets/ui/ui-search.ts` — feature search

Add an entry to `SEARCH_SOURCES` so the search box in the layers panel can find features in this layer. GeoJSON layers search the full in-memory dataset; PMTiles vector layers search only tiles in the current viewport.

```ts
const SEARCH_SOURCES = [
  // existing entries...
  { sourceId: "my-layer", sourceLayer: null, label: "My Feature", fields: ["name", "operator", "addr_city"] },
  //                       ↑ null for GeoJSON; "layer_name" for PMTiles (matches tippecanoe -l value)
];
```

- `fields[0]` is used as the display name in results; all fields are matched against the query.
- Order determines priority — put higher-signal sources earlier.
- Omitting this entry means the layer is invisible to search even when enabled.

Anchor: `>>> ADD-LAYER: search-sources`

---

## 9. Optional: filter value maps and legends

If your layer has a filter chip panel, add its value→label map to `assets/filters.ts` and wire the layer's `filterType` in the registry entry (§5). For a color-ramp legend, set `ramp` on the registry entry rather than registering it separately.

If your filter needs to be re-applied when the user resets layers (the Reset button), add it to `assets/filters.ts` following the bus pattern: subscribe `on('filter:mytype', applyMyFilter)` and add `applyMyFilter()` inside the `on('filter:all', ...)` handler. Then emit `'filter:mytype'` and `'url:write'` from `assets/ui/ui-filters.ts` wherever the user changes the filter value. See `assets/state-bus.ts` for the full event list.

Anchor: `>>> ADD-LAYER: legend-filters`

---

## 10. `assets/popup.ts` — click popup

### Add to `CLICKABLE_LAYERS`

```ts
const CLICKABLE_LAYERS = [
  // existing...
  "my-layer-circles",   // add in priority order (top = wins the click)
  // ...
];
```

### Add a renderer to the `_defs` table in `assets/popup-format.ts`

Each entry is a `[ [mapLayerIds…], (p) => html ]` tuple; a loop at the bottom of
the file registers every id into `POPUP_RENDERERS`, which `popup.ts` calls on click.

```ts
[["my-layer-circles"], (p: Record<string, unknown>) =>
  title(p.name || "My Feature") +
  row("Operator", p.operator) +
  websiteRow(p.website) +
  row("City", p.addr_city) +
  row("State", p.addr_state)],
```

`row(key, val)` renders nothing when `val` is null/empty/zero. `websiteRow(url)` renders a link or nothing. `title(text)` is the popup header.

Anchor (in `assets/popup.ts`): `>>> ADD-LAYER: clickable-layers`
Anchor (in `assets/popup-format.ts`): `>>> ADD-LAYER: popup-renderers`

---

## 11. `index.html` — panel section and credits

### Layer group section

If this is the first layer in a new group, add a collapsible section:

```html
<div class="layer-section collapsed" data-collapsible>
  <div class="section-title">
    <button class="collapse-btn" type="button" aria-label="Toggle section">▸</button>
    🏙 My Group
  </div>
  <div class="collapsible-content">
    <div id="layer-rows-mygroup"></div>
  </div>
</div>
```

Also add `"mygroup"` to the `groups` array in `buildLayersPanel()` in `assets/ui/ui-layer-rows.ts`.

### Source credit

Add to the `<ul>` in the credits `<dialog>` — the `data-source-credit` attribute must match the `creditId` in `LAYER_SOURCES`:

```html
<li data-source-credit="my-source">
  <a href="https://example.com/data" target="_blank" rel="noopener">My Source Name</a>
  — Description and license.
</li>
```

No script tag needed — Vite bundles all `assets/**/*.ts` via `src/main.ts` automatically.

Anchor: `>>> ADD-LAYER: script-tags`

---

## 12. Documentation

Create `docs/layers/my-layer.md`. **Every layer doc uses the same five required sections,
in this order** (add layer-specific sections in between as needed, e.g. "OSM tags matched",
"Classes", "Why PVOUT") :

1. **`# Title`** + a one-line intro stating what the layer is and its panel group.
2. **`## Source`** — a two-column table. Standard rows: `Provider`, `Dataset`, `License`,
   `Attribution`, `Served` (the `data/layers/*` file(s)), `Built by` (the script), and one
   of `Raw input` / `Download` / `Download origin` for the upstream file. Add `Vintage`,
   `Coverage`, `Version`, `Acquired` where known.
3. **`## Download pack`** — the ZIP contents (`<id>.zip` — list the files). If no pack ships,
   say so explicitly and link the upstream source (e.g. live services, no-redistribution,
   or too-large layers — these are `skip: true` in `release_manifest.yaml`).
4. **`## Fields`** (vector) — a table with columns `Field | % filled | Example values`. For a
   **raster**, use **`## Raster values`** instead — describe units, observed value range,
   the hover readout, and color scale (no per-feature columns).
5. **`## Caveats`** — resolution/vintage limits, completeness, and licensing constraints.
   Required even when short.

Match an existing doc of the same kind (vector vs raster) as your template.

Update `docs/data-sources.md`:
- Add to the summary table if it's a new data provider
- Add a link to the layer doc in the provider's feeds list

---

## Checklist

```
[ ] Data half done                         — script, Makefile, manifest, .gitignore, release pack: checklist in adding-a-dataset.md
[ ] scripts/<id>_color_ramp.txt            — RASTER ONLY: gdaldem color-relief ramp (value R G B A)
[ ] src/colors/ramps.ts                    — CONTINUOUS RASTER ONLY: <X>_RAMP_STOPS + <X>_RAMP_MAX (mirror the .txt)
[ ] assets/constants.ts                    — DATA.my_layer (+ lut/meta if raster)
[ ] src/registry/sources.ts               — LAYER_SOURCES entry (if new source)
[ ] src/registry/<group>.ts               — LayerDef entry (id, urlCode, label, group, swatch, mapLayerIds…)
[ ] assets/layers/map-layers-*.ts         — addMyLayer() builder
[ ] assets/layers/layer-init.ts           — LAZY_GEOJSON entry (GeoJSON only)
[ ] assets/raster-probes.ts               — RASTER_PROBES entry (raster only)
[ ] assets/layers/add-all-layers.ts       — addMyLayer() call in addAllLayers()
[ ] assets/ui/ui-search.ts               — SEARCH_SOURCES entry (sourceId, label, fields)
[ ] assets/popup.ts                       — CLICKABLE_LAYERS entry
[ ] assets/popup-format.ts                — renderer tuple in the _defs table
[ ] assets/filters.ts                     — bus subscription (if new filter type)
[ ] assets/ui/ui-filters.ts              — emit events (if new filter type)
[ ] index.html                            — layer-rows-* div (if new group: full section + ui/ui.ts)
[ ] index.html                            — source credit <li data-source-credit="...">
[ ] docs/layers/my-layer.md               — layer documentation
[ ] docs/layers/README.md                  — add the layer to the index prose
[ ] docs/data-sources.md                  — summary table + feeds list
```
