Map of this folder; each file's header comment is the source of truth.

# docs

- `docs/internal/chat-trust-model.md` — the chat's trust rules and their reasons; read before changing what the chat, a service or a frame may do
- `docs/adding-a-layer.md` — **read this before adding any map layer**
- `docs/map-experiences.md` — curated guided views (`File ▸ Experiences`, `?exp=`)
- `docs/line-tools.md` — the transmission line tools (copy with full geometry, fault locator, elevation profile): data flow, limits, privacy
- `docs/proximity.md` — the Proximity check (Tools ▸ Proximity): groups and pairs, the WGS84 measure, limits, privacy; `docs/internal/proximity-notes.md` — its code layout, tests, benchmarks and change checklist
- `docs/pipeline.md` — how the data pipeline fits together
- `docs/data-sources.md` — where every dataset comes from
- `docs/layers/<layer>.md` — one doc per layer (source URL, columns, build)
- `docs/release-artifacts.md` — inventory of data files + download packs
- `docs/hosting-plan.md` — where each asset class is hosted and how the world
  transmission archive is tiled
- `docs/routing.md` — the public line-routing method: what it does, data, pricing, weights beside
  the studies, methods, checks, limits. Plain facts only; no dates or run history (check results
  name the band-spec version they were measured on)
- `docs/internal/routing-notes.md` — contributor notes for the route optimizer: cube
  contracts, build commands, engine details, checks, decisions, panel and constraints-layer rules
- `docs/templates-coverage.md` — **generated** archetype × layer fit matrix
  (`UPDATE_TEMPLATES_COVERAGE=1 npm test` rewrites it; the test fails when it is stale)
