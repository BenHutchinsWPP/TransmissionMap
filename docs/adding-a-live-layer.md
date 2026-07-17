# Adding a live layer

A **live layer** is one whose data changes on a timescale of minutes-to-hours
and is refetched by the browser while the map is open. This doc is the *delta*
on top of [`adding-a-layer.md`](adding-a-layer.md) — read that first for the
registry/builder/legend basics, then come back here for the parts a live layer
adds. The end-of-doc checklist is the definition of done.

Existing live layers, to copy from: **wildfire** (`wildfire-data.yml`),
**NWS alerts + ODIN outages** (`alerts-outages.yml` — two feeds, one workflow),
**NEXRAD radar** (no pipeline — see Shape B).

## Pick a shape first

| | **Shape A — baked feed** | **Shape B — direct external service** |
|---|---|---|
| Data path | GitHub Action → orphan `data` branch → `raw.githubusercontent.com` → browser | browser → upstream server directly |
| Use when | upstream has no CORS, needs a key, is slow, needs merging/reprojecting, or you want *your* color ramp | upstream already serves CORS-clean tiles in a usable style |
| Example | `wildfire_live.geojson` | NEXRAD (`iem-nexrad`) + ECCC GeoMet radar WMS |
| Cost | a workflow + a fetch script | a URL in `constants.ts` |

Shape B is far cheaper — take it if it works. You lose control of the color
ramp and you can't reliably probe pixel values, so anything that needs a
legend swatch matching the raster, or a `RASTER_PROBES` readout, wants Shape A.

Everything under "Backend" below is Shape A only. **Both shapes** need
everything under "Frontend".

---

## Backend (Shape A only)

### 1. Fetch script — `scripts/fetch_<name>.py`

- Takes `-o <output path>`, writes that file atomically.
- **Must stamp `generated_utc`** (ISO-8601 Z, the *pull* time).
  - GeoJSON: on the first feature's properties, and on the FeatureCollection.
  - Non-GeoJSON (e.g. a raster): write a JSON sidecar carrying it.
- **If the upstream has its own valid time, stamp `valid_utc` too — and drive
  the age pill off _that_.** See the two-clocks rule below.
- If it merges several upstreams, stamp a `feed_status` map too
  (`{"perimeters_us": "ok", "smoke": "failed"}`). A successful pull with one
  dead upstream must not render as a calm day — the legend surfaces this.
  Alongside it, stamp a top-level `feed_last_ok` map (subfeed → ISO time of
  its last successful pull; on failure carry the previous output's stamp via
  `geo_common.read_prev_feed_last_ok()`) so the legend chip can show outage
  duration ("… down 3h").
- Degrade, don't crash: an upstream that 500s should produce a stamped file
  with that feed marked failed, not an empty file.

### 2. Workflow — `.github/workflows/<name>.yml`

Do not write the body. Call the reusable one:

```yaml
concurrency:
  group: data-branch          # ← see below. NOT optional.
  cancel-in-progress: false

jobs:
  fetch:
    uses: ./.github/workflows/data-feed.yml
    permissions: { contents: write }
    secrets: inherit
    with:
      scripts: scripts/fetch_<name>.py
      outputs: data/layers/<name>.geojson
      endpoints: https://upstream.example.gov   # pre-flight connectivity check
      pip-packages: ""                          # only if the script needs deps
```

Three things that are easy to miss:

- **`concurrency: group: data-branch` is shared across every live workflow.**
  They all force-push the same orphan branch. Two groups means two runs check
  out the same tip and the second `--force-with-lease` is correctly rejected.
  One group, or you get random red runs.
- **The script is read from `origin/main`, not the checked-out `data` ref.**
  It must be merged to main before the workflow can run.
- **Triggers**: primary is `workflow_dispatch` fired by cron-job.org at the
  real cadence. The `schedule:` cron in the file is *disaster insurance* only
  — sparse, so that if cron-job.org dies the feed still refreshes inside the
  kill-switch window instead of silently going stale forever.

`scripts`/`outputs` are whitespace-separated parallel lists — `data-feed.yml`
passes each output to its script's `-o` and `git add`s them all. A feed that
emits **several files** (e.g. a raster: image + `.i16` LUT + `.json` meta)
needs its output to be the **directory** they all land in; the script derives
its filenames from it. `git add <dir>` stages the lot and the
`git diff --cached --quiet` no-op check still works.

A new fast-cadence feed (~10 min) should usually join `alerts-outages.yml`
(append to its lists) rather than get its own workflow: one cron-job.org
dispatch, one queue slot in the `data-branch` group. Multi-script runs are
failure-isolated — scripts run in parallel with per-attempt timeouts, and
whatever succeeded is pushed before the job reports a failure — but the
caller's insurance `schedule:` must satisfy the *tightest* co-located feed's
staleness window. A feed with its own cadence (hourly wildfire, 6-hourly
weather) keeps its own workflow.

### 3. Orphan-branch bootstrap (once, by hand)

The `data` branch already exists. Just seed your file:

```sh
git checkout data
mkdir -p data/layers
echo '{"type":"FeatureCollection","features":[]}' > data/layers/<name>.geojson
git add data/layers/<name>.geojson
git commit -m "init: <name> data"
git push origin data
git checkout main
```

`data-feed.yml` amends one rolling commit and force-pushes, so the branch never
grows history — steady-state repo cost is one copy of the file.

---

## Frontend

### 4. `assets/constants.ts`

Add the URL to `DATA`. Live feeds live on the **`data`** branch; the baked
pipeline layers live on **`data-static`**. There is no shared constant for the
live origin — each live entry spells out the DEV/PROD ternary, so local dev
reads a file you generated by running the fetch script by hand:

```ts
<name>: import.meta.env.DEV
  ? DATA_ORIGIN + "data/layers/<name>.geojson"
  : "https://raw.githubusercontent.com/BenHutchinsWPP/TransmissionMap/data/data/layers/<name>.geojson",
```

Getting the branch wrong is silent: it 404s only in prod.

### 5. `src/registry/conditions.ts`

Normal `LayerDef`, plus:

```ts
live: true,           // marks it as a live feed
rasterLayer: true,    // only if it's a raster
```

Claim a unique `urlCode` — see [`url-state.md`](url-state.md).

### 6. Legend age pill

Every live layer shows how old its data is. In `index.html`, inside the
legend title:

```html
<span class="legend-age" id="<name>Age"></span>
```

Then wire it in `assets/ui/ui-legends.ts` (see the "Live-data age readout"
block). If the feed has a `feed_status` map, add the chip → upstream mapping to
`CHIP_FEEDS` so a degraded upstream is visible.

#### Two clocks: pull time vs valid time

A live feed has **two** ages and they are not the same number:

| | meaning | stamp |
|---|---|---|
| **Pull age** | when *we* fetched the file | `generated_utc` |
| **Valid age** | the moment the data actually *describes* | `valid_utc` |

**Show the user whichever one answers "how out-of-date is what I'm looking
at?"** — and be careful, because that is usually valid age.

- **Snapshot feeds** (wildfire perimeters, NWS alerts, ODIN outages): the
  upstream *is* the current state, so pull age is valid age. `generated_utc`
  alone is fine.
- **Model/analysis fields** (temperature): the product has its own valid hour
  and publishes *late*. RTMA lands ~50–60 min after the hour it describes, so a
  file pulled ten seconds ago can hold a 1–2 h old analysis.

This is not hypothetical. The temperature layer originally reported pull age,
and a chip reading **"pulled 12m ago"** was painting Reno at 81 °F — a value
that had been correct 95 minutes earlier, before a gust front dropped the
station 4 °C in six minutes. The pipeline was accurate to 0.2 °F; the *label*
was the bug. Render valid time explicitly, and say how old it is:

> `valid 6:00 PM PDT · 1h old`

Measure staleness (`maxAgeMs`) against `valid_utc` too — not the pull.

### 7. Refresh + staleness kill-switch

For a GeoJSON feed, don't hand-roll this. Use the shared factory:

```ts
// assets/<name>-staleness.ts
import { initLiveStaleness } from './live-staleness.js';

initLiveStaleness({
  sourceKey: '<registry id>',
  layerIds:  ['<registry id>'],
  dataUrl:   () => DATA.<name>,
  refreshMs: 15 * 60_000,
  maxAgeMs:  6 * 60 * 60_000,
  dialogId: '<name>StaleDialog', ageElId: '<name>Age',
  reenableId: '…', dismissId: '…',
});
```

It auto-refetches on an interval and on return-to-page (mobile browsers freeze
background timers), and when the data is older than `maxAgeMs` it **auto-hides
every layer on that source** and shows a blocking modal until the user
explicitly accepts the risk. Add the `<dialog>` to `index.html` — copy
`#wildfireStaleDialog`.

The factory does `setData` on a `GeoJSONSource`. **A raster can't use it** —
do what `odin-outages.ts` does: own refresh timer, own age chip, console
warning instead of a modal (there's no "wrong evacuation decision" risk from a
stale temperature field).

### 8. Raster only — hover value readout

A baked-color raster can't be probed for its underlying value, so the pixel
readout rides on a **sidecar LUT**: a flat `.i16` grid of scaled integers plus
a `.json` of `{ dims, bbox, scale }`. See `nlr_wind_100m_lut` /
`usgs_seismic_pga_lut` in `constants.ts`, and `RASTER_PROBES` +
`ensureRasterLut` in `assets/raster-probes.ts`. The fetch script emits the LUT
alongside the image; the ramp used to bake the color and the ramp shown in the
legend must be the same one.

### ⚠ The coupling nobody sees

`maxAgeMs` **must be larger than the worst-case gap between successful runs** —
i.e. the insurance `schedule:` cron interval, not the cron-job.org cadence.
Tighten one without the other and the map silently disables the layer and
throws a modal at every visitor. If you change either, change both.

---

## Checklist

Backend (Shape A):

- [ ] `scripts/fetch_<name>.py` — writes atomically, stamps `generated_utc`
- [ ] Stamps `valid_utc` if the upstream has its own valid time, and the age pill uses it
- [ ] Degrades gracefully on upstream failure; stamps `feed_status` if multi-source
- [ ] `.github/workflows/<name>.yml` calls `data-feed.yml`
- [ ] `concurrency: group: data-branch`
- [ ] Sparse `schedule:` cron as insurance; cron-job.org set up as primary
- [ ] Orphan `data` branch seeded with the file
- [ ] Script merged to `main` (workflow reads it from `origin/main`)

Frontend (both shapes):

- [ ] `DATA` entry in `assets/constants.ts` (live origin, not `data-static`)
- [ ] Registry entry with `live: true`, unique `urlCode`
- [ ] Layer builder in `assets/layers/map-layers-conditions.ts`, added in `add-all-layers.ts`
- [ ] Legend + age pill (`<span class="legend-age" id="…Age">`), wired in `ui-legends.ts`
- [ ] Refresh loop: `initLiveStaleness()` for GeoJSON, hand-rolled for raster
- [ ] Stale `<dialog>` in `index.html` (GeoJSON feeds)
- [ ] Raster only: `.i16` LUT + `.json` meta emitted, wired into `RASTER_PROBES`
- [ ] `maxAgeMs` > worst-case cron gap
- [ ] Source + licence + attribution in `docs/data-sources.md` and `docs/layers/<name>.md`
- [ ] `npm run typecheck`; `npm test` if you touched tested modules
