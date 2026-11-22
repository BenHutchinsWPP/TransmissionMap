Map of this folder; each file's header comment is the source of truth.

# assets/services

- **`assets/services/`** — linked GIS services (added by URL or from the library; view state, not My Data)
  - `service-spec.ts` — the contract: `parseServiceUrl`/normalise (https only, no keys or sign-in),
    kind detection, `validateServiceSpec`, the bounded style vocabulary and `styleToLayers`
    (MapLibre source + layers); pure
  - `service-hosts.ts` — `isVetted(url, kind?)` over `src/registry/service-hosts.json` (exact host,
    or a path prefix at a segment boundary)
  - `service-trust.ts` — the per-tab approved set (`isAllowed` = vetted or approved; mirrored to
    `sessionStorage` `tm-svc-approved`)
  - `service-load.ts` — fetch for a view: ArcGIS paging, error/sign-in replies, size and time caps,
    stale replies dropped, GeoJSON; `status`, `detectDrawKind`
  - `service-render.ts` — `renderServices()`: keeps the map in step with `state.services` (called
    from `repaintView`); the only fetcher, and it draws only vetted-or-approved services; a service
    travels in a link as the `sv` section of `vx`

## Footguns

### Add a library service / vetted host

- an entry must pass the library test — the same `validateServiceSpec` a pasted URL takes, with credit and licence filled; on a shared ArcGIS host (`services*.arcgis.com`) vet by exact service root, never an org prefix unless the org is the agency itself; a credit is shown escaped in the popup and Data Credits — never put one into a MapLibre `attribution`, which is HTML

### Linked services / add-service-by-URL

- only `renderServices()` fetches, and only a vetted-or-approved service — a link, view file or Undo never approves; approval comes only from an explicit visitor click or the chat confirm, for that exact URL; the `sv` cap is UTF-8 bytes, not characters; remote strings are text-only — `npm run lint` covers `ui-services.ts`, `ui-linked-services.ts` and `services-dom.ts`, and a popup goes through `escapeHtml`; a service is draw-and-click only, never filtered or queried
