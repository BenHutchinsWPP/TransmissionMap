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
