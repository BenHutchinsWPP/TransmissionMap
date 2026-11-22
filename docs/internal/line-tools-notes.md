# Transmission line tools: contributor notes

The public description is [`../line-tools.md`](../line-tools.md).

## Reading the files

The dev server reads the files from its own origin; a build reads them from the data host (`DATA_ORIGIN` + `data/analysis/`), by plain `Range` GETs that need only `access-control-allow-origin` and a 206 (or a 200 with the whole file) — no preflight, no exposed header. A rebuild renames the files (their names carry a content hash), so a read that meets a missing name reads `index.json` again and retries once: a tab left open across `make line-parquet` keeps working.

## Checking a change

`npm test` covers the reader over mini fixture files (`assets/lines/fixtures/`),
the geometry walk, the copy caps, the 3DEP client and the profile with fetch mocked.
In the real app, the `lines` scenario of
[`drive-app`](../../.claude/skills/drive-app/SKILL.md) drives every tool on the dev server
with USGS mocked.

## Footguns

### Transmission line tools (copy, fault locator, profile)

- `index.json` can be missing (a dev host, an unpublished build) and every entry point must hide then — the popup's length/Copy/Line tools appear only after `lookup` answers, the table's "Copy N checked lines" only after `lineDataset` does, and an edit-mode copy falls back to the "can't copy" note — never show a button that can only fail; ids are int64 for OSM (`fid`, compared as `BigInt`, statistics are bigint) and the publisher `ID` string for HIFLD (`fid_type` in the manifest), so never `Number()` a key before the lookup; HIFLD stores no direction — `SUB_1`/`SUB_2` are placed by the nearest HIFLD substations of those names (`orientEnds`), unknown order is said in words with a Swap; the fault locator and the profile never fall back to tile geometry (only a copy may, marked `geometry_source: "simplified from map tiles"`); `getSamples` without `pixelSize` reads the 1 m lidar and 504s at 30 s, and more than 1,000 points per request are silently cut to 1,000; a missing sample is null and goes to Terrarium, never 0; nothing goes to USGS before the visitor's Show click; a new elevation or data host goes in `CSP_HOSTS`, `docs/network-allowlist.md` and a Diagnostics probe; tests mock fetch — never call USGS from `npm test`; check a change with the `lines` scenario of `drive-app` (dev server)
