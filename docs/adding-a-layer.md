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

Write the path as a plain double-quoted literal. `scripts/validate_build.py`
finds every expected layer by regexing `"data/layers/…"` out of this file, and
`scripts/publish_data.sh` publishes exactly that list — a path built with a
template literal or a `.map()` is invisible to both, so the layer never gets
pushed and `make validate` reports it as an orphan.

A layer split across several archives (see [hosting-plan.md](hosting-plan.md))
gets one `DATA` key each, and its builder opens each as a separate MapLibre
source (`layerSource(id, { id: sourceId, key })`) — see `OSM_TL_BANDS` in
`src/registry/transmission.ts` and `planTransmissionLines()` in
`assets/layers/layer-init.ts`.
Everything keyed off `LayerDef.mapLayerIds` then follows for free; the registries
keyed on a *source* or *style-layer* id do not (`assets/popup.ts`,
`assets/popup-format.ts`, `assets/ui/ui-search.ts`, `assets/hover.ts`).

For raster layers with a hover LUT, add three entries:
```ts
my_lut:      "data/layers/my_layer_lut.i16.gz",
my_lut_meta: "data/layers/my_layer_lut.json",
my_tiles:    "data/layers/my_layer.pmtiles",
```

The `.gz` suffix is load-bearing: `ensureRasterLut` picks the DecompressionStream
path by testing the URL, so a LUT written gzipped but named `.i16` is read as raw
Int16 and yields nonsense values rather than an error. `rc_write_lut` gzips, so
keep the name in step with it. The LUT is fetched whole — there is no
range-request path for it as there is for the tiles — which is why it is gzipped
and why its resolution is chosen for the wire, not the screen.

Anchor: `>>> ADD-LAYER: data-urls`

---

## 5. `src/registry/<group>.ts` — layer registry entry

Every visible layer needs an entry in the right registry file. Add it to the array in the file matching its group — the imports in `src/registry/index.ts` list every registry file (generators, transmission, pipelines, renewable, land, regions, conditions, rail, …). New sources go in `src/registry/sources.ts`.

### `src/registry/sources.ts` (if new data provider)

```ts
"my-source": {
  label: "My Source Name",
  tooltip: "Source: My Source Name — license info",
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
  // Where the map source's data lives and who it credits — see §6.
  // kind: "pmtiles" (vector tiles) | "raster" (raster tiles) | "geojson" (fetched on first enable)
  data:        { kind: "geojson", key: "my_layer", credit: '<a href="https://example.org">My Source</a>' },
  swatch:      "#6366f1",           // color dot shown in panel row
  defaultOn:   false,               // visible on page load?
  mapLayerIds: ["my-layer-circles"],// all MapLibre layer IDs this entry controls
  downloads: {
    // Format-named packs built by build_releases.py. Set the fields for this
    // layer's geometry (the dropdown label follows the field name):
    //   point   → csv
    //   line    → geojson + shp
    //   polygon → geojson + shp
    //   raster  → tif
    // Point at the un-suffixed path even for an OSM-derived layer built per
    // continent (`continental: true` in release_manifest.yaml) — the panel
    // inserts the continent code into every format it lists.
    // point example:
    csv: "data/releases/my-layer.zip",
    // line/polygon example:
    //   geojson: "data/releases/my-layer.zip",
    //   shp:     "data/releases/my-layer-shp.zip",
    // raster example:
    //   tif: "data/releases/my-layer.zip",
    url: null,                         // optional external "source data" link
  },
}
```

**Optional flags:**

| Flag | Purpose |
|---|---|
| `voltageLayer: true` | Shows the voltage legend when this layer is on |
| `fuelLayer: true` | Shows the fuel legend when this layer is on |
| `filterType: "kv"\|"fuel_osm"\|"fuel_eia"\|"pipeline_type"` | Enables a filter chip panel |
| `filterField: "nominal_kv"` | Which feature property the filter reads |
| `ramp: { stops, max, unit, minLabel?, maxLabel?, fmt? }` | Inline color-ramp legend in the panel row |
| `hoverField: "name"` | Polygon highlight on click — set to the feature property used to match the active feature |
| `lineHighlightKeys: ["name"]` | Line click-highlight — set to one or more feature properties that uniquely identify a line |
| `clickPriority: { "my-layer-circles": 500 }` | **Required for a clickable layer.** Maps each of this entry's MapLibre layer ids to its click hit-test priority — higher number tested first when overlapping features exist. `assets/popup.ts` folds every `LayerDef.clickPriority` into its query order at module load; see §10. |
| `exclusiveGroup: "county-choropleth"` | Optional. Layers sharing a group show one at a time — switching one on switches the others off and unticks their checkboxes (`setLayerVisibility()` in `assets/visibility.ts`). Give it to any new layer that paints the same shapes as an existing one, e.g. another county-keyed choropleth on `county_boundaries`. |
| `fromZoom: 3` | Optional. Withholds this layer's data fetch until the map reaches this zoom — for a heavy point dataset whose icons don't render below it anyway. Gated inside `ensureLayerData()` (`assets/layers/layer-data.ts`), which also gates any layer sharing the source and retries a held layer on zoom settle. Omit for anything fetched at its default visibility. |

**Ramp stops** are `[value, "r,g,b"]` pairs matching the gdaldem color ramp — define them as `<X>_RAMP_STOPS` / `<X>_RAMP_MAX` in `src/colors/ramps.ts` and reference them here (see **§3R**). `minLabel`/`maxLabel` override the default "0" / `max+ unit` labels.

If the ramp's unit follows the user's display-unit preference (temperature, speed, distance, area, elevation, pressure), give it `fmt` instead of `unit`/`maxLabel` — a formatter from `src/units.ts`, e.g. `fmt: fmtSpeed`. A ramp in a fixed unit (kWh/kWp, mW/m², g) keeps `unit`. It renders both ends, so they can't disagree, and it re-runs on every legend build so a preference change is picked up. `minLabel` still wins at the bottom end when a bare "0" reads better. See [settings.md](settings.md).

Anchor: `>>> ADD-LAYER: layer-sources`
Anchor: `>>> ADD-LAYER: layer-registry`

---

## 6. `assets/layers/map-layers-*.ts` — MapLibre layer builder

Add a `planMyLayer()` function in the appropriate sibling file, or create a new one (e.g., `assets/layers/map-layers-load.ts`). It returns a `LayerPlan` (`assets/layers/layer-plan.ts`) — plain data, the source and its style layers in paint order — and never touches the map:

```ts
import type { LayerPlan } from './layer-plan.js';

export function planMyLayer(): LayerPlan {
  return [
    layerSource("my-layer"),    // from the entry's `data` (./layer-source.js)
    { layer: {
      id: "my-layer-circles",
      type: "circle",           // circle | symbol | fill | line
      source: "my-layer",
      // "source-layer": "my_layer",   // PMTiles vector only — matches tippecanoe -l name
      minzoom: 4,
      // filter: [...],          // optional: a filter this layer always applies
      paint: {
        "circle-color": "#6366f1",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3, 10, 6],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
      },
    } as LayerSpecification },
    // { layer: {...}, beforeId: "other-layer" },  // slot below an existing layer
  ];
}
```

`layerSource(id)` turns the entry's `data` into the source, under the registry id: `pmtiles` → vector `pmtiles://` source, `raster` → 256 px raster source, `geojson` → empty source the loader fills (§7); every one carries `data.credit` as its attribution. Options cover the rarer shapes: `{ id, key }` for a second source of the same layer (OSM voltage bands, `wecc-path-lines`), `{ spec }` for extra source options (clustering). A source no registry layer owns (the shared county boundaries, external tiles, the weather image) is written inline, credit included.

An OSM-derived credit must start with `OSM_CREDIT` (`src/registry/sources.ts`) byte for byte, so MapLibre folds it into the OSM basemap's credit.

`applyLayerPlan()` (called once by `addAllLayers()`, §7) does the rest:

- adds every source before any layer, and skips a source or layer already on the map, so a plan can name a shared source (e.g. `countyBoundariesSource()` from `./layer-init.js`) that another plan also names;
- starts each style layer as its registry layer is in state (`visible`/`none` from `defaultOn` and the URL): the entry listing it in `mapLayerIds`. Leave `layout.visibility` unset; set it only to pin `"none"` on a display-mode sibling (a heat layer) that `applyGenMode` shows;
- registers each layer's own `filter` (null without one) as its base filter, which connects the layer to the filter UI: legend and `where` filters are combined with it, never replace it.

Common shapes have helpers in `./layer-init.js` that return plans, source included: `planPolygon` (fill + outline), `planRaster`, `planTransmissionLines`, `planSubstationPoints`. Compose plans by spreading: `[...planPolygon({...}), { layer: labelSpec }]`.

A side effect that is not a layer — a tap handler, a bus subscription, a timer — goes in its own exported function that `addAllLayers()` calls after applying the plans (see `wireWeccPaths()`; a live poll gets its own module, like `startNexradRadar()` in `assets/nexrad-radar.ts`); images a layer's paint names are added before the plans (see `addDcmHatchImages()`).

---

## 7. `assets/layers/layer-source.ts` + `add-all-layers.ts` — connect lazy loading and orchestration

### For GeoJSON layers: `data.kind: "geojson"` names the file

`layerSource()` adds an empty source under the registry id; `ensureLayerData()` (`assets/layers/layer-data.ts`) fills it on first enable from `layerDataUrl(id)` (`assets/layers/layer-source.ts`), the entry's `data.key`. When the features land it emits `layer:data` on the bus (`assets/state-bus.ts`). PMTiles and raster layers need nothing here — MapLibre tiles lazily already.

Registry layers that declare the same `data` (e.g. `wildfire-smoke` and `wildfire-incidents` on `wildfire_live`) share the first one's source: `layerSourceId()` resolves it, so switching any of them on loads it. Two rarer shapes stay as tables in `layer-source.ts`: `LAYER_SOURCE_ALIAS` for a layer loading a source that is not its data (`weather-live` → `weather-admin-lines`), and `SOURCE_DATA_URLS` for a source that is no registry layer at all (`wecc-path-lines`).

`layer-source.test.ts` checks that every `data.key` is a `DATA` key naming a file of its kind and that every declaration carries a credit; `layer-plan.test.ts` that every empty source `addAllLayers()` adds resolves to a URL (or sits on its short pinned list of sources filled another way), and pins which sources carry no attribution.

### Add the plan to `addAllLayers()` in `assets/layers/add-all-layers.ts`

Spread your plan into the `applyLayerPlan()` list in the right z-order position:

```ts
applyLayerPlan(map, [
  ...planPopDensity(),
  ...planMyLayer(),      // ← add here, grouped with similar layers
  // ...
]);
```

Z-order matters: layers earlier in the list are drawn below layers later in it. Rasters go first (bottom), then region fills, then land polygons, then point infrastructure.

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

If your layer has a filter chip panel, give its buckets `values` in `src/colors/buckets.ts` and add a `FACETS` record in `src/colors/facets.ts`; `assets/filters.ts` derives its applier, which the legend chips, Reset and every view apply run. A facet that shares map layers with another, or needs more than one field, gets a hand applier in `FACET_APPLIERS` instead. See [adding-a-filter.md](adding-a-filter.md). For a color-ramp legend, set `ramp` on the registry entry rather than registering it separately.

Anchor: `>>> ADD-LAYER: legend-filters`

---

## 10. `assets/popup.ts` — click popup

### Declare the layer's click priority

A clickable layer's hit-test priority is declared on its own `LayerDef`, not in
a hand-kept array — see `clickPriority` in **§5**:

```ts
{
  id: "my-layer",
  mapLayerIds: ["my-layer-circles"],
  clickPriority: { "my-layer-circles": 500 },  // higher number wins an overlapping click
  // ...
}
```

`assets/popup.ts` builds its query order at module load from every registered
`LayerDef.clickPriority`, sorted descending. A style layer built outside the
registry (no `LayerDef` to hang a priority on) goes in `UNOWNED_CLICKABLE` in
`assets/popup.ts` instead, with a comment naming why it has no registry entry.

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

Add to the `<ul>` in the credits `<dialog>` — the `data-source-credit` attribute must match the source's key in `LAYER_SOURCES`:

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
3. **`## Download pack`** — the ZIP contents. One pack per layer, format-named
   (point → CSV `<id>.zip`; line/polygon → GeoJSON `<id>.zip` + SHP `<id>-shp.zip`,
   each also containing the attribute CSV; raster → GeoTIFF `<id>.zip`). A
   `continental: true` layer builds each of those once per continent, as
   `<id>-<code>.zip` / `<id>-<code>-shp.zip`. Every ZIP
   also holds `<id>.txt` (doc) + `disclaimer.txt`. If no pack ships, say so
   explicitly and link the upstream source (live services, no-redistribution, or
   too-large layers — these are `skip: true` in `release_manifest.yaml`).
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
[ ] src/registry/<group>.ts               — LayerDef entry (id, urlCode, label, group, swatch, mapLayerIds, data: { kind, key, credit }…)
[ ] src/registry/<group>.ts               — clickPriority (clickable layers) / fromZoom (heavy point layers, optional)
[ ] assets/layers/map-layers-*.ts         — planMyLayer() builder: layerSource(id) + style layers, no visibility
[ ] assets/raster-probes.ts               — RASTER_PROBES entry (raster only)
[ ] assets/layers/add-all-layers.ts       — ...planMyLayer() in the applyLayerPlan() list
[ ] assets/ui/ui-search.ts               — SEARCH_SOURCES entry (sourceId, label, fields)
[ ] assets/popup-format.ts                — renderer tuple in the _defs table (clickable layers)
[ ] assets/filters.ts                     — bus subscription (if new filter type)
[ ] assets/ui/ui-filters.ts              — emit events (if new filter type)
[ ] index.html                            — layer-rows-* div (if new group: full section + the `groups` array in ui/ui-layer-rows.ts)
[ ] assets/ui/panel-mirror.ts             — a value line in syncPanel() (only if the row gets a new control whose value is view state; the template renders it neutral)
[ ] index.html                            — source credit <li data-source-credit="...">
[ ] docs/layers/my-layer.md               — layer documentation
[ ] docs/layers/README.md                  — add the layer to the index prose
[ ] docs/data-sources.md                  — summary table + feeds list
[ ] scripts/data_manifest.yaml            — provenance entry for the new tile_manifest.yaml id (label, source, url, licence, source_id; UNKNOWN where the docs above don't settle a field) — see docs/pipeline.md
```
