Map of this folder; each file's header comment is the source of truth.

# assets/lines

- **`assets/lines/`** — transmission line GeoParquet tools (lazy chunks; hyparquet + fzstd load only in lazy chunks, through `assets/parquet/`)
  - `line-read.ts` — reads of `data/analysis/` (lines and polygons) over `parquet/range-io.ts` (a layer names its dataset in
    `data.analysis`; a whole-call 10 s `guard`): `lookup` (fid → exact length, one IDX request), `lineGeometry`, `chainGeometry`,
    `selectionGeometry` (≤ 1,000 ids; > 20 by the GEO bbox page index); failures are `LineOutcome` reasons
  - `line-copy.ts` — `copyLines`: full geometry + tile properties + credit into My Data (`addCopiedFeatures`),
    tile geometry marked when the files cannot answer; its caps and the GeoJSON download beyond them live in
    `user-data/copy-fit.ts`; used by the popup (length row + Copy) and the table's copy of checked lines (`copy-rows.ts`)
  - `osm-substation.ts` — `osmSubstationName(fid, at)`: an OSM chain-end substation's name from the substation points
    archive at its max zoom (the 1–4 tiles within 1.5 km of the end; pmtiles + `@mapbox/vector-tile`), whether or not the
    map has drawn it; null → the Line tab links the OSM id; also `substationPointsIn`/`substationPointsNear` (the substation points around a place, for the route planner's OpenStreetMap snap)
  - `along.ts` — walking the true geometry (pure): `assembleWays`, `pointAt`/`sliceAt`, `densify`, `faultPosition`, `orientEnds`
  - `profile.ts` — `lineProfile`: densify at max(30 m, L / 4,999), USGS 3DEP, Terrarium for what 3DEP left empty, a
    source per sample and null (a gap) where neither answered; `profileStats` (2 m hysteresis), `profileCsv`
  - `fixtures/make-fixtures.py` — the mini line files `line-read.test.ts` reads (runs `build_line_parquet.py --fixture`)
