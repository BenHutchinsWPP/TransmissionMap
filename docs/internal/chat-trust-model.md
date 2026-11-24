# The map chat's trust model

The site is static. The browser calls OpenRouter with the visitor's own key, and a model's
tool calls drive the same view API a shared link uses. The model, the services a visitor
links and the free text in public map data (OSM names) are untrusted. These rules hold.

## The key

- Kept only when it matches `^sk-or-v1-[0-9a-f]{64}$`, on entry and on every read; memory by
  default, `localStorage` `tm-openrouter-key` only when "Remember on this device" is ticked.
- Sent only in the `Authorization` header of an OpenRouter request: never a URL, view file,
  snapshot, `recordDiagEvent` or error text. HTTP errors map to fixed codes without showing
  the body; the Diagnostics report and the chat snapshot redact anything key-shaped.

## The model is an untrusted caller

- `dispatch` refuses unknown tools and arguments outside the schema (`checkArgs`, own keys
  only). Arguments then take the validator a link's value takes; no looser path.
- Each committing call is its own undo step (`asOwnStep`).
- A tool that sends model text off the page declares `offPage`, and runs only after the
  visitor confirms the card (`fitTo({place})` → the geocoder, `addService({url})`). Only that
  confirm approves an unvetted service URL; a link, view file or Undo never does.
- No tool reads My Data. `copyToMyData` only adds a layer, asks above 50 features per ask,
  and tells the model counts only.
- The loop never starts a turn on its own.

## What reaches the model

- Results travel as `{"data": …}` under a prompt saying data is never instructions.
- Rows reach the model only through `summarise()` (≤ 50 rows / 200 groups, strings ≤ 120
  chars, ≤ 8 KB); other results ≤ 16 KB; only `allowedFields` reach a row.
- Two page-built exceptions: `showTemplate`'s summary (≤ 1 KB, group labels ≤ 60 chars;
  `nearest` sends numbers only, no feature or group names) and `planRoute`'s (numbers plus
  the end substations' HIFLD names, ≤ 60 chars, control characters stripped). The chat's ends
  snap to HIFLD only; an OpenStreetMap substation's name never reaches the model, not even on
  recall of a route the visitor placed.
- Nothing a frame computes or says reaches the model: `showCanvas` returns `shown`/`partial`
  or an error category; a chart returns `chartShown`/`chartError`.

## Rendering

Model, tool and service text is set as text (`textContent`, text nodes). Markdown in replies
is built as DOM nodes (`chat-markdown.ts`, https links only). `npm run lint` rejects the
HTML-parsing APIs in these files; a popup goes through `escapeHtml`.

## Content Security Policy

- A build carries `CSP_POLICY` as a `<meta>` tag (GitHub Pages sets no headers).
  `script-src 'self'` (no inline, no eval) and `worker-src 'self' blob:` are the guard: data
  from any host may be fetched, but none runs as code. `connect-src`/`img-src` admit any
  `https:` host because services are visitor-chosen; `CSP_HOSTS` records what the app reads.
  `frame-src 'self'`.
- A meta policy cannot carry `frame-ancestors` or reporting, and does not govern MapLibre's
  worker; tiles are data, accepted on the same ground.
- One script from another host runs in the page: the Cloudflare Web Analytics beacon
  (`ANALYTICS_SCRIPT_URL`, deployed build only). It has the page's access, the chat's stored
  key included, so the page trusts Cloudflare's copy of that file.
- The vetted host list is UX and provenance, not a security boundary.
- A link naming an unvetted service fetches nothing from it until the visitor's Load; the
  approved set lives in `sessionStorage` (a duplicated tab inherits it).

## Frames

- Analysis sandbox (`public/sandbox.html`): `default-src 'none'`, inert unless framed with an
  opaque origin; inputs are registry layers and allowed fields only; output capped.
- Canvas frame (`public/canvas.html`): `sandbox="allow-scripts"` and no other flag; its own
  CSP admits the three CDNs, Google Fonts and the tile hosts. It holds no key and no page
  data beyond the rows passed as `TM_INPUT`. The code is shown before it runs; downloads go
  only through page-validated Save buttons (mime allowlist, no SVG, ≤ 20 MB, ≤ 5 per frame).
- Carve-out: a canvas runs without an `offPage` confirm although its CDN and tile requests
  carry model-chosen paths. Accepted because the frame holds no key or page data.
- Template frames (repo code, params only) may save one file per visitor gesture and may
  send `select`/`fly`/`table`/`where` actions, each checked against what the page sent that
  frame; the page builds any condition. Model frames have no action channel.

Accepted residuals: data in a canvas (model output, `TM_INPUT`, what the visitor types) can
leave by WebRTC from a child frame or DNS prefetch, and jsDelivr/unpkg serve any npm
package; a frame can hang the tab in browsers that share its process.

## Session restore

`tm-chat` (owned by `ui-chat.ts`) and `tm-drawer` (owned by `drawer.ts`; the table's part is registered by `ui-table.ts`) (`sessionStorage`) restore only on a reload or back-forward of the
same hash. They never hold the key and are validated on read as untrusted input. To rebuild a table, a
restore reads only the site's own `data/analysis/` index and columns files (same origin as the tiles). It
sends no model, service, geocoder or third-party request, runs no model code, writes no URL and adds no undo step. The boot hook loads the drawer shell (`drawer.ts`) only for a
restorable `tm-drawer`, the table chunk only when it holds a table, and the chat chunk only when Ask was open.

## Footguns

### Map API / agent tools (what the chat may call)

- a tool's arguments take a link's validator, never a looser path; a committing call goes through `asOwnStep`, or quick calls merge into one undo step; model text sent off the page needs an `offPage` entry so `dispatch` asks first; the tool schemas have a 16,000-byte budget in `tools.test.ts` — trim descriptions rather than raise it

### Local chat commands (answered without a model)

- a name that fits several layers or areas comes back `ambiguous`, never a guess; rule order matters — the specific `show …` rules sit before `show <layer>`; a template phrase reaches flow / buildout-map / distribution only where the template's signature fits the layer (`fit`), and nearest stays the model's — its second layer and threshold are not in the phrase

### Session restore (Android discard / reload)

- a snapshot restores only when its hash equals the hash the page loaded with and the navigation is a reload/back-forward — never on a fresh link, and map.ts's reload for a pasted link calls `endSnapshots()` first, or the reload's pagehide stamps the old drawer with the new hash; never store the key, and the save redacts anything key-shaped; validate on read as untrusted input, rebuilding entries with the text-only builders; save on hidden *and* re-save on every change while hidden, since a reply can land in the background; a restore sends no request, runs no model code, writes no URL and adds no undo step; one owner per fact — whether Ask is open is `tm-drawer`'s, never `tm-chat`'s; the boot hook in `ui-menubar.ts` imports the drawer shell (`drawer.ts`, through `table-open.ts` and `drawer-open.ts`) only for a restorable `tm-drawer`, the table chunk only when it holds a table, and the chat chunk only when it had Ask open; a vector-tile table restores after the map's `idle`, and the over-2 MiB size prompt is shown, never answered for the visitor; the Visualize pane's part of `tm-drawer` keeps card params only — each passes `validateTemplateArgs` again at restore, Vega cards (chat first, then Visualize, newest first) redraw only into free frame slots (`claimRestoreSlots`, ≤ 3 live, no eviction), the rest and html cards come back as Re-run

### Agent loop / OpenRouter client / the key

- never call OpenRouter from a test; data reaches the model only through `summarise()` — the one exception is `showTemplate`'s page-computed summary (total, group count, top 3 groups or the template's own figures — `nearest` numbers only, no names; ≤ 1 KB, group labels ≤ 60 chars); the key goes in the `Authorization` header only — never a URL, error text, `recordDiagEvent` or the view; a confirm-free `dispatch` is only for the visitor's own local-command text; `planRoute`'s page-built summary — HIFLD substation names capped at 60 characters with control characters stripped, plus numbers — is a second exception to `summarise()`, recorded in the chat trust model
