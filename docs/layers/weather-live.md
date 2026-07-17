# Weather Forecast

**Live weather fields** over North America — temperature, wind, humidity, dew point, cloud cover, and pressure — rebuilt every ~3 hours. Panel group: **Conditions**. Continuous raster; each variable has its own hover readout in display units (°F for temperature/dew point, ft/s for wind/gust, % for humidity/cloud, mb for pressure). Internally stored in SI units (Celsius, m/s, %, mb) at 0.25° resolution; displayed at upsampled 4× finer resolution (0.0625°) as a lossy WebP.

## Source

| | |
|---|---|
| **Provider** | [NOAA/NCEP GFS](https://registry.opendata.aws/noaa-gfs-bdp-pds/) 0.25° via AWS Open Data anonymous mirror (bucket `noaa-gfs-bdp-pds`) |
| **Dataset** | GFS 0.25°; forecast cycles: 00, 06, 12, 18 UTC (published ~3.5–4.5 h after cycle time); hourly output steps f000–f120 |
| **Coverage** | Global 0.25° grid; map display spans the North American domain |
| **Variables** | 2 m temperature (`2t`), 2 m dew point (`2d`), 10 m u-wind (`10u`), 10 m v-wind (`10v`), 10 m gust wind (`10fg`), total cloud cover (`tcc`), mean sea level pressure (`msl`) |
| **Vintage** | Live forecast — each cycle (00/06/12/18 UTC) is published ~3.5–4.5 h after cycle time; the base step is the hour nearest "now". Three stamps: `run_utc` (model cycle — the age chip text), `valid_utc` (the forecast valid time — shown on the timebar) and `generated_utc` (when we pulled the cycle — the stale check and chip coloring). |
| **License** | **Public domain** — US government work, 17 U.S.C. § 105. No API key required. |
| **Attribution** | NOAA/NCEP GFS (courtesy credit; no attribution required) |
| **Served** | Per-variable rasters: `<var>.webp` (4× cubic-upsampled display), `<var>.i16` (native 0.25° int16 LUT, SI×10, nodata −32768) · Per non-base time-slider step: `<var>_<step>h.webp`, `<var>_<step>h.i16.gz`, `wind_uv_<step>h.png` · Plus: `wind_uv.png` (u/v offset-encoded for particle animation), `meta.json` (run/step/valid/generated times + feed status + `steps`, shared across all variables) — on the orphan **`data`** branch |
| **Built by** | `scripts/fetch_weather_live.py`, run every ~3 h by `.github/workflows/weather-data.yml` |
| **Download origin** | AWS S3 bucket `noaa-gfs-bdp-pds`: `s3://noaa-gfs-bdp-pds/gfs.{YYYYMMDD}/{HH}/atmos/` · Per-variable GRIBs fetched via HTTP range-request from the anonymous mirror (no key). |

## Download pack

No download pack. This is a live feed rebuilt every ~3 h — a frozen ZIP would be wrong
within the hour. GFS is freely accessible via AWS Open Data at
`https://registry.opendata.aws/noaa-gfs-bdp-pds/` (no key, public domain). Or take the pre-built served files from the `data` branch.

## Processing

`scripts/fetch_weather_live.py` (per-variable, ~2–5 s each; uses `eccodes` + `numpy` +
`scipy` + `pillow`, all pip-installable on a bare runner):

- **GRIB fetch:** The script queries the AWS S3 bucket via HTTP range-requests to fetch
  each variable's GRIB record. It reads only the bytes needed — no full file download.
  Data arrives in GFS native grid (0.25°).
- **Per-variable processing:** Each variable (temp, wind, humidity, pressure, etc.) is
  decoded from GRIB to a float array and converted to display-domain SI units (°C for
  temp/dew point, m/s for wind, % for cloud, mb for pressure). Relative humidity is
  derived from 2 m temperature and dew point using the Magnus formula.
- **Int16 LUT:** Raw SI values are packed as `int16 = round(value × 10)` on the native
  0.25° grid, with nodata set to **−32768**. Saved as `.i16` binary. (Scaling by 10
  keeps single-decimal precision for hover readout without floats.)
- **Display image:** The 0.25° field is upsampled **4× with cubic resampling** on the
  native lat/lon grid (~0.0625°, ~7 km), then colorized using the per-variable `RAMP` in the
  script, which **must stay identical to the matching ramp in `src/colors/ramps.ts`**
  (each file carries a comment pointing at the other). Saved as lossy WEBP (q85),
  ~40–60 KB per variable, served as MapLibre **`image` sources**.
- **Wind particle animation:** For u/v winds, additionally exports `wind_uv.png`
  (u/v offset-encoded as `[u+40, v+40]` clamped to [0,255] for the range [−40, 40] m/s)
  feeding `assets/weather-particles.ts` lazy-load particle trajectories.
- **Metadata sidecar:** A shared `meta.json` carries:
  - `run_utc` / `step` (forecast cycle and output step)
  - `valid_utc` (the time the forecast describes)
  - `generated_utc` (when we fetched it)
  - `feed_status` (per-variable `"ok"` / `"failed"` map, e.g. `{"temp":"ok","wind":"failed"}`)
  - `vars` (per-variable `{width, height, bbox, scale, nodata, units}`; wind also carries `uv_min`/`uv_max`)
  - `steps` (the time-slider list `[{step, valid_utc, suffix}]`)
- **Degrades, never crashes:** a failed GRIB fetch marks that variable `"failed"` in
  `feed_status` and leaves its previous output files in place; variables whose inputs
  all succeeded still publish. The script exits 0 either way. The age chip surfaces
  both a stale bake (>12 h) and per-variable feed failures.

## Cadence and staleness

### The map shows the latest forecast available

NOAA/NCEP publishes forecast cycles **~3.5–4.5 h after the cycle time** (e.g., the 00 UTC
cycle lands around 03:30–04:30 UTC). Each cycle spans 120+ hours ahead at hourly steps
f000–f120. The layer therefore stamps **three clocks**:

| Stamp | Meaning |
|---|---|
| `run_utc` | when NOAA ran the model cycle — **this is what the age chip text shows** (`run 5h ago`) |
| `generated_utc` | when the workflow pulled/processed the cycle — what the stale check and the chip's fresh/aging/stale coloring watch |
| `valid_utc` | the forecast valid time per step — shown on the timebar label, not the chip |

The age chip text reads `run_utc` (fallback: `generated_utc` if a pre-run_utc
meta is ever served) — e.g. `run 5h ago`; the pull clock + model run cycle
ride in the hover title. A healthy feed always shows a run 4–10.5 h old
(publication lag + up to 6 h between cycles), which is why the chip's
**coloring** stays on `generated_utc`: run age can't distinguish a healthy
feed from a dead one. The scrubbed step's valid time lives on the timebar
label.

| | |
|---|---|
| Upstream cadence | NOAA/NCEP GFS 00/06/12/18 UTC cycles, published ~3.5–4.5 h after cycle time, hourly steps f000–f120 |
| Primary trigger | `workflow_dispatch`, fired **every 3 h** (`:22`) by cron-job.org |
| Insurance cron | `schedule: 48 */6 * * *` — **6 h**, disaster insurance if cron-job.org dies |
| Frontend poll | 10 min (the ~300 B meta JSON only; raster reload only when `generated_utc` moves) |
| Now-tracking | 60 s tick: a display parked on the auto-selected step advances to the step nearest wall-clock "now" (flip lands at half past the hour); a scrubbed-away position or running playback is never touched |
| Stale threshold | **12 h** (`MAX_AGE_MS` in `assets/weather-live.ts`) — must stay **larger than the 6 h insurance cron**. Change one, change the other. |
| On stale | Console warning + red age chip. **No blocking modal** — a stale forecast is advisory, not a safety call like a fire perimeter. The layer keeps displaying. |

## Raster values

**Temperature** — pixel value = 2 m air temperature. Displayed in °F (°C in parentheses).

| Quantity | Typical range | Notes |
|---|---|---|
| Temperature | −30 … 45 °C (−22 … 113 °F) | Ramp clips outside this range to end colors. |
| Wind speed | 0 … 25+ m/s (0 … 82+ ft/s) | 10 m wind; displayed in ft/s. |
| Wind gust | 0 … 25+ m/s (0 … 82+ ft/s) | 10 m gust wind; displayed in ft/s. |
| Relative humidity | 0 … 100 % | Derived from temperature and dew point (Magnus). |
| Dew point | −40 … 30 °C (−40 … 86 °F) | 2 m dew point; displayed in °F (°C in parentheses). |
| Cloud cover | 0 … 100 % | Total cloud cover (0 = clear, 100 = overcast). |
| Pressure | 960 … 1050+ mb | Mean sea level pressure; typically 950–1020 mb. |

**Temp & Wind** — combined view: the temperature wash (same raster and ramp as
Temperature) with the wind particle animation drawn on top; no extra baked
files. The cursor bubble reports both values (Temperature + Wind lines).

## Caveats

- **Forecast model, not observations.** GFS is a forecast model. Values are
  predictions, not thermometer/anemometer readings at your cursor. For current conditions,
  refer to official NWS (US) or ECCC (Canada) products.
- **Upsampled display.** Native resolution 0.25° (~28 km); displayed at 4× cubic upsampling
  (~7 km). Fine detail is interpolation, not forecast detail — terrain-driven local gradients
  are smoothed.
- Public domain — no attribution required, though a courtesy credit to NOAA/NCEP GFS is appreciated.
