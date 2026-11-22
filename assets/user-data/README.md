Map of this folder; each file's header comment is the source of truth.

# assets/user-data

- **`assets/user-data/`** — user-imported/drawn layers
  - `user-data.ts` — core (add/remove/render; `commitUserData` = save + render); `user-data-draw.ts` draw mode
  - `user-data-store.ts` — `createUserDataStore` over a `getItem`/`setItem` adapter: the `tm-user-data`
    payload (validated by `parsePayload`), saves held back until `load()`, then flushed once; drawn-feature cache
  - `user-data-import.ts` GeoJSON/KML/KMZ import; `user-data-export.ts` export
  - `user-data-csv.ts` CSV point import + column picker; `csv-parse.ts` pure CSV parser (unit-tested)
  - `view-file.ts` — `*.tmview.json` view files: Save view… / Open… of a view's hash through the link codec
  - `copy-fit.ts` — the one set of copy caps (1,000 features / 1.5 MB GeoJSON / 4 MB store), download fallback and credit text for every copy to My Data (popup, table, chat); a save the browser refuses rolls the copy back and offers the download
  - `copy-rows.ts` — **lazy chunk** (table drawer and `map-api.ts`): `copyAvailable`/`copyRows` for a layer's checked rows, by mode `full` (geometry files, through `lines/line-copy.ts`), `point` (a columns-file point or the max-zoom point of a tiled point layer) or `exact` (a GeoJSON layer's own geometry: cloned, `__` keys dropped, licence and source URL from the data manifest)
  - `copy-mode.ts` — `copyMode`/`copyNoun`: which copy a layer offers (`full`/`point`/`exact`/`none`); pure registry lookups, boot-bundle safe
  - `user-data-geom.ts` geometry utils; `user-data-colors.ts` color picker
  - `draw-chunk.ts` — **lazy chunk boundary**: re-exports draw/import/export; loaded on first toolbar interaction (keeps MapboxDraw/toGeoJSON/jszip out of the initial bundle)
