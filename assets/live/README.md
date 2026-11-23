Map of this folder; each file's header comment is the source of truth.

- `live-poll.ts` — `pollWhileVisible`: **the one refresh loop every live feed runs on**
  (interval while the layer is on, plus an instant refetch on return to the tab /
  bfcache restore, at most once per 60 s); zero deps
- `live-staleness.ts` — **shared factory** for every live GeoJSON feed: auto-refresh
  (through `live-poll.ts`) + stale-data kill-switch modal. `wildfire-staleness.ts` /
  `nws-staleness.ts` are thin config shells over it that export their config (`WILDFIRE_LIVE`,
  `NWS_LIVE`), whose `maxAgeMs` the legend age chips and diagnostics read. Raster/feature-state feeds
  wire their own fetch and staleness on the same poll loop (see `odin-outages.ts`,
  `weather-live.ts`).
- `stale-dialog.ts` — `staleDialog(cfg)`: builds a feed's stale-data `<dialog>` from nodes and the
  `stale.<feed>.*` strings (called from each feed's init); no stale markup in `index.html`
- `weather-live.ts` — live GFS weather raster: image swap + hover-LUT
  reload + age chip + timebar (own fetch on `live-poll.ts`; the factory only does
  GeoJSON sources; a stale feed warns in the console, no modal)
- `nexrad-radar.ts` — NEXRAD/GeoMet radar frame poll (`startNexradRadar`, called from
  `add-all-layers.ts`): keeps every tile on one scan, refreshes on switch-on and on
  return to the tab; owns the GeoMet source table the builder reads
- `weather-particles.ts` — wind particle animation over the weather wash (lazy-loaded canvas layer)
- `odin-outages.ts` — ODIN county outage feature-state join (own fetch on `live-poll.ts`;
  stale-data modal `#odinStaleDialog` from `stale-dialog.ts`, like the factory's)
- `nws-zone-join.ts` — NWS zone/county alert feature-state join; key contract with `extract_nws_zones.py`

## Footguns

### Add a **live** layer (auto-refreshing feed)

- a live feed's workflow joins the shared `data-branch` concurrency group, and `maxAgeMs` must exceed the worst-case cron gap; the stale `<dialog>` is built by `assets/live/stale-dialog.ts` from the `stale.<feed>.*` strings, never written into `index.html`
