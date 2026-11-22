Map of this folder; each file's header comment is the source of truth.

# assets/sandbox

- **`assets/sandbox/`** — the analysis sandbox (model-written code, no network) and the canvas frame
  (model-written pages the visitor sees; CDNs and tile hosts only)
  - `geo-kit.ts` — pure geometry (point-in-polygon, bbox, length, intersection, area) inlined into the runner
  - `runner.js` — the sandbox's script; `scripts/build_sandbox.mjs` (`npm run build:sandbox`) inlines it
    with the kit into `public/sandbox.html` with its CSP hash (`default-src 'none'`; inert unless truly sandboxed)
  - `sandbox-host.ts` — `runInSandbox`: the `allow-scripts` frame, one run at a time, input/output caps,
    10 s stop, replies matched by frame and nonce
  - `canvas-runner.js` — the visible canvas frame's script (one IIFE): `showCanvas` pages (written into
    the same document, `TM_INPUT`, `TM.download`/`drawn`/`fail`/`action`/`lib`, memory-only storage shims)
    and Vega-Lite charts; libraries pinned with SRI in `src/registry/template-libs.json` (one table for
    Vega and `TM.lib`); `scripts/build_sandbox.mjs` inlines it into `public/canvas.html` (generated — never hand-edit)
    with its meta CSP: the three CDNs, Google Fonts and the tile hosts in `src/registry/canvas-hosts.json`
  - `canvas-host.ts` — `runCanvas`: the page side of a canvas frame — nonce and `event.source` matching,
    every post-render message validated, downloads checked, ≤ 3 live frames, 10 s watchdog, navigation guard;
    `template: true` frames resolve on `drawn` (15 s) and alone pass actions to `onAction` (≤ 50);
    a vega template frame alone is sent its `signals` (the selections the runner bridges to actions)

## Footguns

### Analysis sandbox / `runAnalysis`

- after editing `runner.js` or `geo-kit.ts` run `npm run build:sandbox` — the committed hash in `public/sandbox.html` must match (`node scripts/build_sandbox.mjs --check`); never add `allow-same-origin` or `unsafe-eval`; inputs are registry layers and allowlisted fields only, never My Data or services; the output is capped before the model reads it; check a change with the `sandbox` scenario of `drive-app` on a preview build

### Chat canvas / `showCanvas`

- never add `allow-same-origin` or any other sandbox flag to the frame; the canvas CSP is generated — edit `scripts/build_sandbox.mjs`, `src/registry/canvas-hosts.json` or `src/registry/template-libs.json` (re-hash with `curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`; a package file, never jsDelivr's `+esm` or generated copies), run `npm run build:sandbox`, then `node scripts/build_sandbox.mjs --check`; never put a hash or nonce in its `script-src`, or `'unsafe-inline'` is ignored and every page goes blank; the runner must stay one IIFE with no top-level names — `document.open()` keeps the Window, so a runner global collides with the model's code; an `html` write fires one extra iframe `load`, which the host's load-count guard expects — a further load or a second `ready` is a navigation; nothing from the frame reaches the model — `showCanvas` returns `shown`/`partial` or an error category only, and `toolContent` strips the rest; downloads only through the card's page-owned Save buttons; `canvas-hosts.json` must stay the tile-host subset of `CSP_HOSTS` (a parity test fails otherwise); a library pin in the prompt must load inside the frame — check it in a sandboxed frame, not top-level (MapLibre needs the worker-origin shim the prompt gives)
