---
name: drive-app
description: Launch TransmissionMap in headless Chromium, drive views, shared links, Reset and the File menu, and screenshot them. Use when asked to confirm a change in the real app or to check it by screenshots, especially links, the vx param, view files, Reset, style overrides or the dropped-settings notice.
---

# Drive the app headless

A passing Vitest suite does not prove a view renders. This is how to check it
in the real app, against the local data the dev server already serves.

Visual checks stay the user's call (AGENTS.md) — reach for this when they ask
for screenshot verification, and say what the screenshots show, not what the
checks print.

## Setup (once per session)

Work in the session scratchpad (`$W` below), never the repo.

```bash
W=<scratchpad>
cp .claude/skills/drive-app/drive.mjs "$W"/
cd "$W" && npm init -y >/dev/null && npm i playwright-core
```

`drive.mjs` launches the newest cached Playwright Chromium
(`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`). If there is none,
run `npx playwright install chromium` once, or point `TM_CHROME` at a binary.
It launches with `--no-sandbox --use-angle=swiftshader
--enable-unsafe-swiftshader`: MapLibre needs WebGL, and headless gets it from
SwiftShader.

Run it from `$W` so `playwright-core` resolves there. Env: `TM_WORK`
(screenshots and downloads, default `./shots`), `TM_URL` (default
`http://localhost:5199/`), `TM_CHROME`.

## Server

```bash
npx vite --port 5199 --strictPort > "$W/vite.log" 2>&1 &   # from the repo root; run_in_background
timeout 40 bash -c 'until curl -sf http://localhost:5199 >/dev/null; do sleep 1; done'
# ...when done:
lsof -ti:5199 -sTCP:LISTEN | xargs -r kill
```

The dev server serves `data/` locally (`DATA_ORIGIN` is empty in dev), so
layers draw from this machine's build, not the published one.

## What `drive.mjs` already knows (rediscovered the hard way)

- **The first-visit disclaimer** blocks every click. The init script sets
  `localStorage.tm_disclaimer_accepted = "1"` before the page loads.
- **Save view…** falls back to a download only when `showSaveFilePicker` is
  absent; the init script deletes it, and `page.waitForEvent('download')`
  catches the file.
- **Reset calls `window.confirm`.** Headless dismisses dialogs by default, so
  Reset silently does nothing. `open()` accepts confirms and dismisses alerts.
- **Ready** is `#logo` losing its `spin` class. **Settled** is MapLibre's
  `idle` after a short pause: polling `areTilesLoaded()` returns true before a
  just-shown layer or the basemap labels have even requested, and the
  screenshot then shows a half-drawn map while every check passes.
- **App modules import in-page.** Vite serves `await import('/assets/state.ts')`
  as the same instance the app runs, so `mod()` and `st()` drive and read live
  state. Build links with `hashFor()`, which runs the app's own codec
  (`formatUrlState` over `defaultView()`); never hand-encode a `vx`.
- **Notices:** the hidden 3D rotate hint is also `[role=status]`.
  `visibleNotices()` counts only the ones on screen. The dropped-settings
  notice stays up 8 s, so read it straight after `open()`.
- **The red dot on File** is the Diagnostics badge; a link with dropped
  settings lights it. Not an error.

## Scenarios

```bash
node drive.mjs              # all of them
node drive.mjs vx notice    # some
```

| scenario | drives | checks |
|---|---|---|
| `labels` | `#…?lb=0`, then Reset | labels off and toggle unchecked; Reset turns both back on and drops `lb` from the link |
| `vx` | a link carrying `where` (transmission ≥ 345 kV) and `style` (railroads red, ×3), then Reset | both sections in state, the override on the map, `vx` kept in the link, no notice; Reset clears state and link |
| `notice` | a link with an unknown layer, a kV value written as text, and colour on an icon layer | one visible notice at the top counting 3; the valid opacity kept; the rest dropped |
| `viewfile` | labels off + magenta railroads, File ▸ Save view…, open the file on a fresh page | a v1 `tmview` file; the opened link equals the saved one |
| `weather` | `weather-live` on, `setStyle({opacity: 0.25})`, then `clearStyle` | wash and border lines scaled ×0.25; clearing restores both exactly |

Each check prints `PASS`/`FAIL`; the run exits non-zero on any failure, and
`no console errors` closes every scenario. A new scenario is one more entry in
`SCENARIOS`, built from the exported helpers (`launch`, `open`, `settle`,
`mod`, `st`, `hashFor`, `shot`, `visibleNotices`, `check`).

## Look at every screenshot

Checks read state; a screenshot is the only proof the map drew it. Open each
PNG before claiming anything. Signs a check missed:

- no transmission lines, or no place names where labels should be on — the
  map had not settled;
- a notice that did or did not appear, or sits over the search box or panel;
- an override painting a companion layer it should not (casings stay white).

Expected, not a regression: with railroads at size ×3, darker dots show where
short rail segments overlap — the layer is slightly translucent, and that
comes from the data.
