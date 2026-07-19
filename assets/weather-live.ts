// ─── Live weather raster: refresh loop + variable switch + age chip ──────────
// Role: keep the GFS-derived weather mosaic (baked by scripts/fetch_weather_live.py)
//       current while the map is open — swap the `weather-live` image source's
//       picture, reload the hover LUT, and render the legend age chip
//       (#weatherAge in index.html). Also owns the variable dropdown's effect:
//       setWeatherVar() swaps which baked file the image/LUT point at.
// Age: the chip text reports the model run's age (`run_utc` — when NOAA ran
//       the GFS cycle; falls back to `generated_utc` if absent), NOT the
//       scrubbed step's valid time (the timebar label owns that). The pull
//       clock rides in the title attribute. The fresh/aging/stale coloring
//       still watches `generated_utc` — a healthy feed always shows a run
//       4–10.5 h old (cycles publish ~3.5–4.5 h after cycle time), so run age
//       says nothing about pipeline health; only pull age tells us the feed
//       died.
// Why not initLiveStaleness(): that factory setData()s a GeoJSONSource. This is a
//       raster. Same shape as odin-outages.ts instead — own timer, own chip, and a
//       console warning (never a blocking modal) when the feed goes stale: a stale
//       weather field is cosmetic, not a safety call like a fire perimeter.
// Deps: state (map, weatherLiveUrl, layerVisibility, rasterLut), raster-probes
//       (ensureRasterLut), registry/conditions (WEATHER_VARIABLES, for the
//       feed-down label), live-staleness (fmtAgeShort, for the age chip).
//       Dynamically import()s weather-particles.ts (the
//       lazy chunk boundary — see that file's header) to start/stop the wind
//       particle animation; never a static import, or the chunk split breaks.
// Wired from ui/ui.ts init() via initWeatherLive(); setWeatherVar() is called
// from ui-filters.ts when the dropdown in the layer row changes.
// syncWeatherLiveVisibility() is also called directly from ui.ts's
// resetLayersToDefaults() (Reset Layers button) — see its own comment.

import type { ImageSource } from 'maplibre-gl';
import type { ImageCorners } from './state.js';
import { state, weatherLiveUrl, WEATHER_WASH_OPACITY, WEATHER_FADE_MS } from './state.js';
import { ensureRasterLut, updateRasterArrow } from './raster-probes.js';
import { fmtAgeShort } from './live-staleness.js';
import { WEATHER_VARIABLES } from '../src/registry/conditions.js';

// Variables that animate wind particles: Wind itself, the Temp & Wind
// combined view (temp wash + particles on top), and Windstream (particles
// only, no color wash).
const PARTICLE_VARS = new Set(["wind", "tempwind", "windstream"]);
// 1×1 transparent GIF — crossfaded in place of a real webp for `noWash`
// variables, so paintImage()'s existing A/B crossfade (which assumes the
// front layer starts near full opacity) never flashes a stale texture: the
// "flash" is transparent by construction.
const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
// The Temp & Wind companion hover probe (see raster-probes.ts) — its wind LUT
// shares the main probe's invalidate/ensure lifecycle in refetch().
const WIND_PROBE_ID = "weather-live-wind";

// Baked-file id for the current selection — combined views (`file:` on the
// WEATHER_VARIABLES entry) borrow another variable's raster.
function fileVar(): string {
  const v = WEATHER_VARIABLES.find(w => w.id === state.weatherVar);
  return v?.file ?? state.weatherVar;
}

// True for a variable that shows particles/hover cursor but no color wash
// (Windstream) — see BLANK_PIXEL above.
function noWash(): boolean {
  return !!WEATHER_VARIABLES.find(w => w.id === state.weatherVar)?.noWash;
}

// Lazily loaded on first need; keeps the particle canvas code out of the
// initial bundle (see assets/weather-particles.ts header).
let particlesModule: typeof import('./weather-particles.js') | undefined;
// `${generatedUtc}:${weatherVar}` the particles are animating against, plus
// the step suffix. Tracked separately so a step change within the same bake
// hot-swaps the field (updateWindField — trails/positions survive, which is
// what keeps playback smooth) while a new bake or variable switch restarts.
let particleBakeKey: string | undefined;
let particleSuffix: string | undefined;

// Starts/stops/restarts/retargets the particle animation to match current
// visibility + selected variable + painted field. Safe to call
// unconditionally after any visibility, variable, or data change — it no-ops
// when nothing relevant moved. Called from refetch() (new bake, var switch,
// or step change), the layer checkbox listener (show/hide), and
// setWeatherVar() (variable switch while hidden).
async function syncWindParticles(): Promise<void> {
  const shouldRun = isVisible() && PARTICLE_VARS.has(state.weatherVar);
  if (!shouldRun) {
    if (particleBakeKey !== undefined) {
      particlesModule?.stopWindParticles();
      particleBakeKey = undefined;
      particleSuffix = undefined;
    }
    return;
  }
  const bakeKey = `${generatedUtc}:${state.weatherVar}`;
  const suffix = steps[stepIdx]?.suffix ?? "";
  if (bakeKey === particleBakeKey && suffix === particleSuffix) return;
  const sameBake = bakeKey === particleBakeKey;
  particleBakeKey = bakeKey;
  particleSuffix = suffix;
  particlesModule ??= await import('./weather-particles.js');
  // generatedUtc rides along as the cache-busting query so the particle field
  // and the wash always come from the same bake.
  if (sameBake) await particlesModule.updateWindField(suffix, generatedUtc ?? "");
  else await particlesModule.startWindParticles(suffix, generatedUtc ?? "");
}

const REGISTRY_ID = "weather-live";

// The feed is rebaked every ~3h; poll the small (~300 B) meta JSON more often so
// a new bake (or a variable switch) lands within minutes.
const REFRESH_MS = 10 * 60_000;
// Stale threshold, measured against generated_utc (did the pipeline die), NOT
// valid_utc (which is always "now" by construction). MUST stay larger than the
// worst-case gap between successful workflow runs — the insurance `schedule:`
// cron in .github/workflows/weather-data.yml, NOT the cron-job.org cadence.
// Change one, change the other.
const MAX_AGE_MS = 12 * 60 * 60_000;

let runUtc: string | undefined;
let step: number | undefined;
let generatedUtc: string | undefined;
let feedStatus: Record<string, string> | undefined;
let varsMeta: Record<string, WeatherMetaVar> | undefined;
// `${generated_utc}:${weatherVar}:${stepIdx}` of what's currently painted —
// lets a var/step switch force a repaint even when generated_utc hasn't moved.
let paintedKey: string | undefined;
let inflight = false;
// Time-slider state: the baked forecast steps from meta.steps (suffix "" is
// the base "now" step) and which one is displayed. Deliberately NOT in the
// URL — a scrub position is a moment's exploration, not share-state.
let steps: WeatherMetaStep[] = [];
let stepIdx = 0;
let baseIdx = 0;    // index of the suffix-"" base step — the failed-var pin target
let defaultIdx = 0; // last auto-selected index — how a refresh tells "parked" from "scrubbed"

interface WeatherMetaVar {
  width: number; height: number; bbox: [number, number, number, number];
  scale: number; nodata: number; units?: string;
}
interface WeatherMetaStep { step: number; valid_utc: string; suffix: string }
interface WeatherMeta {
  run_utc?: string;
  step?: number;
  valid_utc?: string;
  generated_utc?: string;
  feed_status?: Record<string, string>;
  vars?: Record<string, WeatherMetaVar>;
  steps?: WeatherMetaStep[];
}

function isVisible(): boolean {
  return !!state.layerVisibility[REGISTRY_ID];
}

// Index of the step whose valid time is nearest t (0 when steps is empty).
function nearestStepIdx(t: number): number {
  let best = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(Date.parse(steps[i].valid_utc) - t)
      < Math.abs(Date.parse(steps[best].valid_utc) - t)) best = i;
  }
  return best;
}

// ── A/B crossfade painter ─────────────────────────────────────────────────────
// "weather-live" and "weather-live-b" are twin image source/layer pairs (see
// addWeatherLive in map-layers-conditions.ts). Each new image is painted onto
// the hidden partner and the pair's raster-opacity crossfades — a lone
// updateImage() swaps the texture with a hard pop. The fade is driven
// per-frame here rather than by paint-spec transitions: two LINEAR fades dip
// to ~0.54 combined coverage mid-fade (both layers near half opacity), which
// flashes the light basemap through as white. Fading the incoming layer
// linearly and giving the outgoing one the complement curve
// b = 1 − (1−W)/(1−a) keeps combined coverage 1−(1−a)(1−b) pinned at W the
// whole way. Fire-and-forget: `paintSeq` discards a paint (or a running
// fade) that a faster scrub has superseded.
const B_ID = "weather-live-b";
let frontIsB = false;
let paintSeq = 0;

async function paintImage(url: string, coords?: ImageCorners): Promise<void> {
  const map = state.map;
  if (!map) return;
  const backId = frontIsB ? REGISTRY_ID : B_ID;
  const frontId = frontIsB ? B_ID : REGISTRY_ID;
  const back = map.getSource(backId) as ImageSource | undefined;
  if (!back || !map.getLayer(frontId)) return;
  const seq = ++paintSeq;
  // Warm the HTTP cache so updateImage()'s own fetch resolves immediately —
  // otherwise the fade starts before the texture exists and pops anyway.
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode().catch(() => { /* fade unwarmed; updateImage still loads it */ });
  if (seq !== paintSeq || !state.map) return;
  back.updateImage({ url, ...(coords ? { coordinates: coords } : {}) });
  frontIsB = !frontIsB;

  const W = WEATHER_WASH_OPACITY;
  const start = performance.now();
  const fade = (now: number) => {
    if (seq !== paintSeq || !state.map?.getLayer(backId)) return;
    const t = Math.min(1, (now - start) / WEATHER_FADE_MS);
    const a = W * t;
    state.map.setPaintProperty(backId, "raster-opacity", a);
    state.map.setPaintProperty(frontId, "raster-opacity", Math.max(0, 1 - (1 - W) / (1 - a)));
    if (t < 1) requestAnimationFrame(fade);
  };
  requestAnimationFrame(fade);
}

// Warms the HTTP cache for a step's assets (webp + wind field when a particle
// variable is up) so the next playback tick / scrub swaps without a network
// stall. URLs must match the painting fetches byte-for-byte or the cache
// entry is wasted.
function preloadStep(i: number) {
  const s = steps[i];
  if (!s) return;
  const warm = (u: string) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = u;
  };
  if (!noWash()) {
    warm(`${weatherLiveUrl(`${fileVar()}${s.suffix}.webp`)}?_=${encodeURIComponent(generatedUtc ?? "")}`);
  }
  if (PARTICLE_VARS.has(state.weatherVar)) {
    warm(`${weatherLiveUrl(`wind_uv${s.suffix}.png`)}?_=${encodeURIComponent(generatedUtc ?? "")}`);
  }
}

async function refetch(): Promise<void> {
  if (!state.map?.getSource(REGISTRY_ID) || inflight) return;
  inflight = true;
  try {
    const resp = await fetch(weatherLiveUrl("meta.json"), { cache: "no-cache" });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const meta = await resp.json() as WeatherMeta;
    runUtc = meta.run_utc;
    step = meta.step;
    generatedUtc = meta.generated_utc;
    feedStatus = meta.feed_status;
    varsMeta = meta.vars;
    // Older bakes have no `steps`; synthesize a one-entry list so the rest of
    // the module (and the slider) needs no special case.
    steps = meta.steps?.length
      ? meta.steps
      : [{ step: meta.step ?? 0, valid_utc: meta.valid_utc ?? "", suffix: "" }];
    // Default (and post-refresh, unless the user has scrubbed away) is the
    // step nearest wall-clock NOW — not the bake's suffix-"" base step, which
    // is only "now as of the bake" and drifts hours behind on a stale feed.
    baseIdx = Math.max(0, steps.findIndex(s => s.suffix === ""));
    const nowIdx = nearestStepIdx(Date.now());
    if (stepIdx === defaultIdx || stepIdx >= steps.length) stepIdx = nowIdx;
    defaultIdx = nowIdx;

    // Staleness is measured against when the feed was last baked, not the
    // (always ~current) valid time — a dead pipeline still reports a valid
    // time near "now" forever, since that's how the step is chosen.
    const genThen = generatedUtc ? Date.parse(generatedUtc) : NaN;
    if (!Number.isNaN(genThen) && Date.now() - genThen > MAX_AGE_MS) {
      // Keep painting — an old bake is still broadly right, and the chip turns
      // red. No modal, unlike the wildfire kill-switch.
      console.warn("[TransmissionMap] weather feed is stale (>12h)", generatedUtc);
    }

    paintCurrent();
  } catch (err) {
    console.warn("[TransmissionMap] weather refresh failed", err);
    renderWeatherAge();
  } finally {
    inflight = false;
  }
}

// Paints the current bake/variable/step from module state — no meta fetch, so
// scrubs and playback ticks stay network-free. refetch() is the only caller
// that refreshes the state first; repaint() routes var/step changes here and
// falls back to refetch() when no meta has loaded yet.
function paintCurrent(): void {
  if (!steps.length) return;
  // A variable whose last bake failed has no per-step files (phase 3 skips it
  // and the orphan cleanup removed the previous run's) — pin it to the base
  // step, whose files are always left in place.
  if (feedStatus?.[fileVar()] === "failed") stepIdx = baseIdx;

  const key = `${generatedUtc}:${state.weatherVar}:${stepIdx}`;
  if (key === paintedKey) { renderWeatherAge(); renderTimebar(); void syncWindParticles(); return; }
  paintedKey = key;
  const suffix = steps[stepIdx].suffix;

  const v = varsMeta?.[fileVar()];
  // bbox is [w, s, e, n]; the image source wants NW, NE, SE, SW corners. Reading
  // it from the meta (rather than trusting a constant) means a grid change in
  // the fetch script needs no frontend edit.
  const b = v?.bbox;
  const coords: ImageCorners | undefined = b
    ? [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]]
    : undefined;
  // Windstream (and any future noWash variable) crossfades a transparent
  // placeholder instead of real imagery — same code path, no color wash.
  void paintImage(
    noWash()
      ? BLANK_PIXEL
      : `${weatherLiveUrl(`${fileVar()}${suffix}.webp`)}?_=${encodeURIComponent(generatedUtc ?? "")}`,
    coords,
  );
  // Warm the next step (wrapping, matching playback order) for smooth stepping.
  preloadStep((stepIdx + 1) % steps.length);

  // The cached LUT belongs to the previous bake/variable/step — drop it so
  // the hover bubble doesn't report stale values. weatherStepSuffix routes
  // raster-probes' lut() to the scrubbed step's gzipped grid (base step
  // keeps the raw .i16). ensureRasterLut self-guards on the loading flag,
  // so the first enable (where visibility.ts already called it) doesn't
  // double-fetch.
  if (state.rasterLut[REGISTRY_ID]) {
    delete state.rasterLut[REGISTRY_ID];
    state.rasterLutLoading[REGISTRY_ID] = false;
  }
  // The Temp & Wind companion probe's wind LUT tracks the same lifecycle.
  delete state.rasterLut[WIND_PROBE_ID];
  state.rasterLutLoading[WIND_PROBE_ID] = false;
  state.weatherStepSuffix = suffix;
  void ensureRasterLut(REGISTRY_ID);
  if (state.weatherVar === "tempwind") void ensureRasterLut(WIND_PROBE_ID);
  renderWeatherAge();
  renderTimebar();
  void syncWindParticles();
}

function repaint(): void {
  if (steps.length) paintCurrent();
  else void refetch();
}

// Called when the variable dropdown in the layer row changes (ui-filters.ts).
// Swaps which baked file the image/LUT point at; a no-op if it's already the
// selected variable.
// ── Time slider (Ventusky-style bottom bar) ──────────────────────────────────
// #weatherTimebar in index.html: play button + range input over meta.steps +
// a label with the scrubbed step's local day, time and short timezone, and a
// thin marker on the track at the wall-clock "now". Shown only while the
// layer is visible and the bake carries more than one step.
let playTimer: ReturnType<typeof setInterval> | null = null;
let ticksKey: string | undefined; // `${generatedUtc}:${steps.length}` of the rendered tick rail
const PLAY_STEP_MS = 900;

function stopPlayback() {
  if (playTimer != null) { clearInterval(playTimer); playTimer = null; }
  const btn = document.getElementById("weatherPlayBtn");
  if (btn) { btn.textContent = "▶"; btn.setAttribute("aria-label", "Play forecast animation"); }
}

function togglePlayback() {
  if (playTimer != null) { stopPlayback(); return; }
  const btn = document.getElementById("weatherPlayBtn");
  if (btn) { btn.textContent = "⏸"; btn.setAttribute("aria-label", "Pause forecast animation"); }
  playTimer = setInterval(() => {
    setWeatherStep((stepIdx + 1) % steps.length); // wraps back to the start
  }, PLAY_STEP_MS);
}

// Keep a parked display tracking wall-clock time between polls: when "now"
// rolls closer to the next hourly step, advance to it — but never while the
// user has scrubbed away (stepIdx !== defaultIdx) or playback is running.
// Uses the same nearest-step rule as refetch()'s re-selection so the two
// never fight; with hourly steps the flip lands at half past the hour.
function trackNow() {
  if (!isVisible() || playTimer != null || !steps.length) return;
  if (stepIdx !== defaultIdx) return;
  const nowIdx = nearestStepIdx(Date.now());
  if (nowIdx === stepIdx) return;
  stepIdx = defaultIdx = nowIdx;
  paintCurrent();
}

function renderTimebar() {
  const bar = document.getElementById("weatherTimebar");
  if (!bar) return;
  // Hidden for a failed variable too — its per-step files don't exist, so
  // there is nothing to scrub (paintCurrent pins it to the base step).
  const show = isVisible() && steps.length > 1 && feedStatus?.[fileVar()] !== "failed";
  bar.style.display = show ? "" : "none";
  // Lets the legends / layers panel yield the bottom strip to the bar via
  // CSS (see .has-timebar rules in style.css) — a layout shift, not z-order.
  bar.parentElement?.classList.toggle("has-timebar", show);
  if (!show) { stopPlayback(); return; }
  const range = bar.querySelector<HTMLInputElement>("input[type=range]");
  const label = bar.querySelector<HTMLElement>(".weather-timebar-label");
  if (!range || !label) return;
  range.max = String(steps.length - 1);
  range.value = String(stepIdx);
  const t = new Date(Date.parse(steps[stepIdx].valid_utc));
  const sameDay = t.toDateString() === new Date().toDateString();
  const day = sameDay ? "Today" : t.toLocaleDateString(undefined, { weekday: "short" });
  // Steps are exactly on the hour, so no minutes; timeZoneName:"short"
  // appends the local zone abbreviation (e.g. "CDT").
  const clock = t.toLocaleTimeString(undefined, { hour: "numeric", timeZoneName: "short" });
  // No "now" suffix — the red track marker is the current-time indicator.
  label.textContent = `${day} ${clock}`;

  // Hour ticks under the slider: dashed minor tick per step, solid tick with
  // a local-time label every 3rd hour — every 6th on a narrow rail
  // (< 520 px), where 3-hourly labels collide. Rebuilt only when the step
  // list or the label interval changes, not on every scrub.
  const ticks = bar.querySelector<HTMLElement>(".weather-timebar-ticks");
  if (ticks) {
    const labelEvery = ticks.clientWidth < 520 ? 6 : 3;
    const key = `${generatedUtc}:${steps.length}:${labelEvery}`;
    if (key !== ticksKey) {
      ticksKey = key;
      ticks.innerHTML = steps.map((s, i) => {
        const left = ((i / (steps.length - 1)) * 100).toFixed(2);
        const d = new Date(Date.parse(s.valid_utc));
        if (d.getHours() % labelEvery !== 0) return `<span class="wt-tick" style="left:${left}%"></span>`;
        const hour = d.toLocaleTimeString(undefined, { hour: "numeric" });
        return `<span class="wt-tick wt-tick--major" style="left:${left}%">`
          + `<span class="wt-tick-label">${hour}</span></span>`;
      }).join("");
    }
  }

  // Wall-clock "now" marker, positioned in the range input's index space (the
  // thumb and ticks travel by index, and a dropped step can make the step
  // list non-uniform in time): interpolate between the two steps bracketing
  // now. Hidden when now is outside the baked window (e.g. a very stale bake).
  const nowEl = bar.querySelector<HTMLElement>(".weather-timebar-now");
  if (nowEl) {
    const times = steps.map(s => Date.parse(s.valid_utc));
    const nowT = Date.now();
    const k = times.findIndex((t, i) => i + 1 < times.length && nowT >= t && nowT <= times[i + 1]);
    const frac = k >= 0
      ? (k + (nowT - times[k]) / (times[k + 1] - times[k])) / (times.length - 1)
      : -1;
    nowEl.hidden = !(frac >= 0 && frac <= 1);
    // Same coordinate frame as the tick rail (7px side margins compensating
    // for range-thumb travel): left = 7px + frac × (width − 14px).
    if (!nowEl.hidden) {
      nowEl.style.left = `calc(7px + ${(frac * 100).toFixed(2)}% - ${(frac * 14).toFixed(1)}px)`;
    }
  }
}

function setWeatherStep(i: number) {
  const clamped = Math.max(0, Math.min(i, steps.length - 1));
  if (clamped === stepIdx) return;
  stepIdx = clamped;
  paintedKey = undefined; // force a repaint even if generated_utc hasn't moved
  if (isVisible()) repaint();
}

export function setWeatherVar(v: string) {
  if (state.weatherVar === v) return;
  state.weatherVar = v;
  // Leaving the combined view with the cursor parked would otherwise leave a
  // stale Wind line in the bubble until the next mousemove.
  if (v !== "tempwind") updateRasterArrow(WIND_PROBE_ID, null);
  paintedKey = undefined; // force a repaint even if generated_utc hasn't moved
  if (isVisible()) repaint();
  else void syncWindParticles(); // e.g. switched away from wind while hidden
}

// ── Legend age chip ───────────────────────────────────────────────────────────
// Text reports the model run's age (run_utc, fallback generated_utc) — NOT
// the scrubbed step's valid time, which the timebar label already owns and
// which is ~now by construction anyway. The pull clock rides in the title
// attribute; fresh/aging/stale coloring stays on generated_utc (see module
// header — run age is 4–10.5 h on a healthy feed and can't signal a dead one).
function renderWeatherAge() {
  const el = document.getElementById("weatherAge");
  if (!el) return;
  const pulled = generatedUtc ? Date.parse(generatedUtc) : NaN;
  const run = runUtc ? Date.parse(runUtc) : NaN;
  const then = Number.isNaN(run) ? pulled : run;
  if (Number.isNaN(then)) { el.textContent = ""; el.removeAttribute("title"); return; }
  const age = Number.isNaN(run)
    ? `${fmtAgeShort(Date.now() - then)} old`
    : `run ${fmtAgeShort(Date.now() - then)}`;
  el.textContent = down().length ? `${age} · ${down().join(", ")}` : age;
  const titleParts: string[] = [];
  if (!Number.isNaN(pulled)) {
    titleParts.push(`Pulled ${new Date(pulled).toLocaleTimeString(undefined, {
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    })}`);
  }
  if (runUtc) titleParts.push(`model run ${runUtc}${step != null ? ` +${step}h` : ""}`);
  el.title = titleParts.join(" · ");
  const pulledMin = Number.isNaN(pulled) ? Infinity : Math.max(0, (Date.now() - pulled) / 60_000);
  const stale = Number.isNaN(pulled) || Date.now() - pulled > MAX_AGE_MS;
  // The bake refreshes every ~3 h, so a healthy feed sits anywhere in 0–3.5 h;
  // only beyond that does the chip go amber.
  const level = stale ? "stale" : pulledMin <= 210 ? "fresh" : "aging";
  el.className = "legend-age legend-age--"
    + (down().length && level === "fresh" ? "aging" : level);
}

// A dead upstream must not read as calm weather: surface it on the chip,
// naming whichever variable's feed_status isn't "ok".
function down(): string[] {
  return Object.entries(feedStatus ?? {})
    .filter(([, s]) => s !== "ok")
    .map(([varId]) => `${WEATHER_VARIABLES.find(w => w.id === varId)?.label ?? varId} down`);
}

// Applies state.layerVisibility["weather-live"] to particles/timebar/companion
// probe: pulls a fresh image when shown, or stops particles + hides the slider
// + clears the companion probe's bubble line when hidden (visibility.ts only
// clears the main probe's). Called on a real checkbox change (below), and
// directly by ui.ts's resetLayersToDefaults() — Reset flips
// state.layerVisibility and the map's layout visibility straight through,
// without dispatching a change event, so this is the only hook that runs.
export function syncWeatherLiveVisibility(): void {
  if (isVisible()) { void refetch(); return; }
  void syncWindParticles();
  renderTimebar();
  updateRasterArrow(WIND_PROBE_ID, null);
}

export function initWeatherLive() {
  if (!state.map) return;

  // Enabling the layer's panel checkbox pulls the image immediately — until then
  // the source is holding the transparent placeholder and nothing has downloaded.
  document.addEventListener("change", (e) => {
    const cb = (e.target as Element | null)?.closest<HTMLInputElement>(
      `input[type=checkbox][data-layer-id="${REGISTRY_ID}"]`);
    if (!cb) return;
    syncWeatherLiveVisibility();
  });

  document.getElementById("weatherTimebar")
    ?.querySelector<HTMLInputElement>("input[type=range]")
    ?.addEventListener("input", (e) => {
      stopPlayback(); // a manual scrub takes over from the animation
      setWeatherStep(Number((e.target as HTMLInputElement).value));
    });
  document.getElementById("weatherPlayBtn")?.addEventListener("click", togglePlayback);
  // Crossing the ~520 px rail threshold swaps the tick-label interval (3 h ↔ 6 h).
  window.addEventListener("resize", () => { if (isVisible()) renderTimebar(); });

  // Boot paint: addAllLayers() runs async inside the map's `load` handler
  // (after icon loads await), so the source usually doesn't exist yet when
  // this runs and refetch() would silently no-op — leaving the overlay blank
  // until the first poll tick. Wait for an `idle` where the source exists.
  const bootFetch = () => {
    if (!isVisible()) return;
    if (state.map!.getSource(REGISTRY_ID)) { void refetch(); return; }
    state.map!.once('idle', bootFetch);
  };
  bootFetch();

  setInterval(() => { if (isVisible()) void refetch(); }, REFRESH_MS);
  setInterval(() => { renderWeatherAge(); trackNow(); }, 60_000);
}
