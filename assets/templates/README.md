Map of this folder; each file's header comment is the source of truth.

# assets/templates

- **`assets/templates/`** — page-owned visualization templates (Tools ▸ Charts, the chat's `showTemplate`)
  - `catalogue.ts` — the archetypes as entries (`ready`, params, geometry, libraries, `source`: a Vega
    builder or an html script loaded `?raw`); `templatesFor(layerId)`, `templateById`, `queryableRoles`
  - `show-template.ts` — the one path onto the screen: `validateTemplateArgs` (params checked and
    defaulted from the layer's roles and the view), `showTemplate` (→ `shapeRows` → `TemplatePayload`,
    legend folds and colours, ≤ 8 MB via `capPayload` → `host.render`; the model gets only its
    ≤ 1 KB `summary`), `renderParams` (what a card keeps to re-run: area and the `where` used),
    `formChoices`, `fieldLabel`/`measureLabel`
  - `template-actions.ts` — a template frame's actions (select / fly / table / where), checked against
    what the page sent it and the link validators: `conditionForBin` (a chart group → its condition, built
    by the page), `mergeWhere`, `templateActions` (one handler per frame: one undo step per commit, ≤ 5
    commits per 10 s, an Undo toast)
  - `groups.ts` — `topGroups` (one field's rows as ranked, labelled, coloured groups + Other; shared by the
    Vega builders and the summary), `NEUTRAL`
  - `payload.ts` — `TemplatePayload`, the `TM_INPUT` a template frame reads (types only)
  - `vega/` — the Vega-Lite builders, payload → spec with inline rows: `composition.ts`, `ranking.ts`,
    `timeline.ts` (additions or net; months when recent), `compare-regions.ts` (a panel per region),
    `distribution.ts` (a histogram over the page's bins), `common.ts` (sizes, labels, config)
  - `per-region.ts` — points-per-polygon's page half: quantile classes and ramp, region outlines for the
    frame from the app's GeoJSON boundaries (states, NERC, BA, countries, admin-1); `regionCentre` (a
    region's pie centre, pies-per-region)
  - `nearest.ts` — nearest's page half: `nearest(points, targets)` (exact haversine km over a grid index of
    the targets, antimeridian-safe), `haversineKm`; pure
  - `html/` — repo scripts run in the canvas frame as `kit.js` + one template: `kit.js` (the shared frame
    kit: header, legend, table, download menu, `TM_INPUT` reader), `lines-by-class.js` (MapLibre + d3),
    `density.js` (MapLibre + deck.gl), `points-per-polygon.js` (ranked regions; MapLibre outlines unless
    by counties, which paint the main map), `pies-per-region.js` (a pie per state, country or admin-1 on a
    MapLibre map, SVG pies sized by sqrt of the total, ≤ 250 regions; split = the region, by = the slices), `flow.js` (d3 + d3-sankey; ≤ 40 nodes), `nearest.js` (MapLibre
    map + distance ECDF + threshold slider; model told numbers only), `buildout-map.js` (MapLibre, plays and
    scrubs by year or month; no autoplay under reduced motion); `template-fakes.ts` is test support

## Footguns

### Templates (Tools ▸ Charts, `showTemplate`)

- template code comes only from repo files imported `?raw` — never model text, never a fetched script; params reach a template only as the validated `TM_INPUT` (`validateTemplateArgs`), set as text; roles drive which templates fit, so give a new field its role in `field-schema.ts` / `field-roles.ts` and regenerate `docs/templates-coverage.md` with `UPDATE_TEMPLATES_COVERAGE=1 npm test`; a layer with a columns file is read whole (`shapeRows` scope `area`, the Area applies, `complete: true`), a tiled layer without one from the current view only and takes no area, and a template's second layer or full geometry (lines-by-class) stays on the view; a frame must be on screen to draw (no animation frames off screen — cards scroll into view, a restore redraws only into free frame slots, ≤ 3 live); a one-click download is allowed only for a template frame under the gesture rule (activation + frame focus, one per gesture, counted in the cap) — everything else gets the Save button; a symbol-only layer (`osm-generators`) is read only because `clickPriority` names its icon layer — a label symbol layer never counts; map actions (`template-actions.ts`) come only from template frames — canvas-host drops a model frame's `action`, and only a vega template frame is sent `signals`; a template sends a group (`{field, bin}`) or ids it was sent, never a condition — the page builds the condition (`conditionForBin`) and merges it with the layer's `where`; every commit goes through map-api (`asOwnStep`, one undo step) and counts toward the per-frame rate limit (5 per 10 s); `fly` is camera only — no undo step, no toast; a vega group arrives as its label, so a new vega template's data needs a `key` per datum and a `VEGA_PICK` entry (a list per template: the signal, which payload field it picks, the datum's label and key fields — a month is sent as its key); the county overlay (`county-overlay.ts`, points-per-polygon by counties) is session only — never in the link, no `url:write`, no undo step, not repainted on restore (html cards come back as Re-run) — one at a time (a new paint replaces it), cleared by Reset (both Reset paths call `clearCountyOverlay` after `applyView({})`), its card's × or Clear, and the legend's Clear; it writes only the `tpl_v` feature-state key on the shared county source, so never `removeFeatureState` a whole county there (NRI/ODIN/NWS share the bag); a region outline's id is a region code, so a points-per-polygon frame may fly to it but never select or table it (`regions` in the action context); nearest's `layer2` is a GeoJSON point layer only (a tiled one would measure to the loaded tiles) and its summary to the model is numbers only — count, median / p90 km, within / beyond — never a feature or group name (chat trust model), and its `second` features are never selected; the html templates are text-only: lint over `assets/templates/html/**` rejects `innerHTML` and its kin, `setHTMLUnsafe` and a library's `.html()` (use `.text()` / `textContent`); a new param needs all three validators — the tool schema, `validateTemplateArgs` and the snapshot checks (`VIZ_PARAMS` in `drawer-snapshot.ts`, the chat card check), or a restore drops the card silently; every ready template needs its `ask → id` line in `loop.ts` `SYSTEM_PROMPT` (`loop.test.ts` checks each id), and a refusal for a param a template does not take names the templates that take it; pies-per-region takes `by` = the slices and `split` = a region field named in its signature's `regions` (states, countries, admin1 — never counties, NERC, BA or retail), draws at most `MAX_PIES` regions, and its region ids are codes, so its card is `regions: true` like points-per-polygon's
