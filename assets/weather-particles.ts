// ─── Wind particle animation (Ventusky-style flow over the wind wash) ────────
// Role: advect ~2500 particles through the GFS u/v field baked to
//       data/layers/weather_live/wind_uv.png (u=R, v=G, offset-encoded over
//       [uv_min,uv_max], alpha 0 = nodata) and paint their trails on a plain
//       <canvas> stacked over the map's canvas container. NOT a MapLibre
//       custom layer — screen position is re-derived from map.project() every
//       frame, so pan/zoom need no special handling.
// Lazy chunk: this module is imported ONLY via dynamic import() from
//       weather-live.ts, the first time the Wind variable is visible — copy
//       of the assets/user-data/draw-chunk.ts boundary pattern. Never
//       statically import this file; doing so pulls it into the initial
//       bundle.
// Deps: state.ts (state.map, weatherLiveUrl). Fetches its own copy of
//       meta.json + wind_uv.png (independent of weather-live.ts's refresh
//       cache) so start/stop has no coupling to that module's internals.
// Called from: assets/weather-live.ts — startWindParticles() when the layer
//       is visible and a wind-animated variable is selected (after a fresh
//       bake, or on first enable); updateWindField() on a timebar scrub/step
//       within the same bake (hot-swaps the field, keeps trails);
//       stopWindParticles() on hide or variable switch away from wind.

import { state, weatherLiveUrl } from './state.js';

// Density-based, not a fixed count: one particle per this many CSS px² of
// canvas, so a phone viewport isn't 6× denser than a desktop window.
// (~3500 particles on a 1920×1080 window, a few hundred on a phone.)
const PARTICLE_PX2 = 600;
const MAX_PARTICLES = 3500;
const MIN_PARTICLES = 200;
// 60fps-frames before a particle is forcibly respawned, keeping the field
// from developing visible "stuck" points.
const MAX_AGE = 250;
// Per-60fps-frame trail retention (destination-in fade alpha).
const TRAIL_FADE = 0.985;
// Tuning knob: screen pixels a 1 m/s wind component moves a particle per
// 60fps frame, at ANY zoom (advection is converted to degrees using the
// current zoom's px/degree, so flow speed reads the same zoomed in or out —
// the Ventusky behavior). 10 m/s ≈ 54 px/s. The frame loop scales by the
// real elapsed time, so a 120 Hz phone display flows no faster than a 60 Hz
// desktop. Adjust this single constant to make the flow feel faster/slower.
const SPEED_PX = 0.09;

interface WindMeta {
  vars?: {
    wind?: {
      bbox: [number, number, number, number]; // [W, S, E, N]
      uv_min: number;
      uv_max: number;
    };
  };
}

interface Particle { lon: number; lat: number; age: number; }

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let rafId: number | null = null;
let particles: Particle[] = [];
let bbox: [number, number, number, number] | null = null;
let uvMin = -40;
let uvMax = 40;
let uvData: Uint8ClampedArray | null = null;
let uvWidth = 0;
let uvHeight = 0;
let running = false;
let listenersAttached = false;
// True while the map is panning/zooming. Trails are painted in screen space,
// so they can't follow the map — pause drawing and wipe the canvas on
// movestart, resume on moveend (particles keep their lon/lat, so the flow
// picks up where it left off — the Ventusky behavior).
let mapMoving = false;

function onMoveStart() {
  mapMoving = true;
  if (ctx && canvas) {
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  }
}

function onMoveEnd() {
  mapMoving = false;
}

// Bumped by every start/stop/field-swap; async loads capture it and discard
// their result if it moved while they were in flight (rapid scrubs, a stop).
let loadSeq = 0;

// Decodes one step's wind_uv png to raw RGBA via an offscreen canvas.
// Pure fetch+decode — the caller assigns the module state, so a stale
// (superseded) load can be discarded without clobbering the live field.
// `version` (the bake's generated_utc, passed in by weather-live.ts) is the
// cache-busting query — it must match preloadStep()'s warm URL byte-for-byte,
// and it keeps the field from being served from HTTP cache across bakes.
async function decodeUV(suffix: string, version: string):
    Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = `${weatherLiveUrl(`wind_uv${suffix}.png`)}?_=${encodeURIComponent(version)}`;
  await img.decode();

  const off = document.createElement('canvas');
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const offCtx = off.getContext('2d');
  if (!offCtx) return null;
  offCtx.drawImage(img, 0, 0);
  const imageData = offCtx.getImageData(0, 0, off.width, off.height);
  return { data: imageData.data, width: off.width, height: off.height };
}

// Fetches meta.json + wind_uv.png. Returns false (logs, doesn't throw) on any
// failure so a missing/broken feed just skips particles — the wash still
// shows wind.
async function loadField(suffix: string, version: string): Promise<boolean> {
  const resp = await fetch(weatherLiveUrl('meta.json'), { cache: 'no-cache' });
  if (!resp.ok) return false;
  const meta = await resp.json() as WindMeta;
  const wind = meta.vars?.wind;
  if (!wind) return false;
  bbox = wind.bbox;
  uvMin = wind.uv_min;
  uvMax = wind.uv_max;

  const uv = await decodeUV(suffix, version);
  if (!uv) return false;
  uvData = uv.data;
  uvWidth = uv.width;
  uvHeight = uv.height;
  return true;
}

// Hot-swaps the u/v field to another forecast step WITHOUT restarting the
// animation: canvas, trails and particle positions all survive; the flow just
// bends to the new hour. This is what keeps timebar playback smooth — a full
// start/stop wipes every trail each step. bbox/uv_min/uv_max are per-bake
// constants shared by all steps, so no meta.json refetch. Falls back to a
// full start if the animation isn't running (e.g. the initial load failed).
export async function updateWindField(suffix = '', version = ''): Promise<void> {
  if (!running) return startWindParticles(suffix, version);
  const seq = ++loadSeq;
  const uv = await decodeUV(suffix, version).catch((err: unknown) => {
    console.warn('[TransmissionMap] wind field step load failed', err);
    return null;
  });
  // Superseded by a newer load/stop, or failed — keep the current field.
  if (!uv || seq !== loadSeq || !running) return;
  uvData = uv.data;
  uvWidth = uv.width;
  uvHeight = uv.height;
}

// Bilinear-samples decoded (u, v) in m/s at a lon/lat; null outside the bbox
// or over a nodata (alpha=0) texel — the caller respawns on null.
function sampleUV(lon: number, lat: number): [number, number] | null {
  if (!uvData || !bbox) return null;
  const [w, s, e, n] = bbox;
  if (lon < w || lon > e || lat < s || lat > n) return null;

  const fx = ((lon - w) / (e - w)) * (uvWidth - 1);
  const fy = ((n - lat) / (n - s)) * (uvHeight - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, uvWidth - 1), y1 = Math.min(y0 + 1, uvHeight - 1);
  const tx = fx - x0, ty = fy - y0;

  const data = uvData;
  const width = uvWidth;
  const px = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 3]];
  };
  const [r00, g00, a00] = px(x0, y0);
  const [r10, g10, a10] = px(x1, y0);
  const [r01, g01, a01] = px(x0, y1);
  const [r11, g11, a11] = px(x1, y1);
  if (a00 === 0 || a10 === 0 || a01 === 0 || a11 === 0) return null;

  const decode = (raw: number) => uvMin + (raw / 255) * (uvMax - uvMin);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const u = lerp(lerp(decode(r00), decode(r10), tx), lerp(decode(r01), decode(r11), tx), ty);
  const v = lerp(lerp(decode(g00), decode(g10), tx), lerp(decode(g01), decode(g11), tx), ty);
  return [u, v];
}

// Uniform-seeds a particle over the current viewport intersected with the
// wind bbox. Falls back to bbox-wide seeding if the viewport doesn't overlap
// the bbox at all (far pan) rather than producing an inverted range.
function seedParticle(): Particle {
  const b = bbox!;
  const bounds = state.map!.getBounds();
  const w = Math.max(b[0], bounds.getWest());
  const e = Math.min(b[2], bounds.getEast());
  const s = Math.max(b[1], bounds.getSouth());
  const n = Math.min(b[3], bounds.getNorth());
  const [lonLo, lonHi] = w < e ? [w, e] : [b[0], b[2]];
  const [latLo, latHi] = s < n ? [s, n] : [b[1], b[3]];
  return {
    lon: lonLo + Math.random() * (lonHi - lonLo),
    lat: latLo + Math.random() * (latHi - latLo),
    age: Math.random() * MAX_AGE,
  };
}

function resizeCanvas() {
  if (!canvas || !state.map) return;
  const dpr = window.devicePixelRatio || 1;
  const mapCanvas = state.map.getCanvas();
  canvas.style.width = `${mapCanvas.clientWidth}px`;
  canvas.style.height = `${mapCanvas.clientHeight}px`;
  // Assigning .width/.height clears the bitmap and resets the transform, so
  // the dpr scale below never accumulates across repeated resizes.
  canvas.width = Math.round(mapCanvas.clientWidth * dpr);
  canvas.height = Math.round(mapCanvas.clientHeight * dpr);
  ctx = canvas.getContext('2d');
  ctx?.scale(dpr, dpr);
  syncParticleCount();
}

// Grows/shrinks the particle pool to match the current canvas area (also the
// initial seeding — resizeCanvas() runs once during start). Surviving
// particles keep their position across a resize.
function syncParticleCount() {
  if (!canvas || !bbox || !state.map) return;
  const dpr = window.devicePixelRatio || 1;
  const area = (canvas.width / dpr) * (canvas.height / dpr);
  const n = Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, Math.round(area / PARTICLE_PX2)));
  while (particles.length < n) particles.push(seedParticle());
  if (particles.length > n) particles.length = n;
}

// rAF timestamp of the previous frame — 0 forces the next frame to a neutral
// 1-frame dt (fresh start, resume after a map move).
let lastFrameT = 0;

function frame(now: number) {
  if (!running || !ctx || !canvas || !state.map) return;
  if (mapMoving) { lastFrameT = 0; rafId = requestAnimationFrame(frame); return; }
  // Elapsed time in 60fps-frame units: advection/aging/fade all scale by it,
  // so a 120 Hz display doesn't run the flow twice as fast. Capped so a
  // background-tab resume doesn't teleport particles.
  const dt = lastFrameT ? Math.min((now - lastFrameT) / (1000 / 60), 3) : 1;
  lastFrameT = now;
  const map = state.map;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  // Fade previous trails instead of clearing outright (destination-in keeps
  // existing pixels, scaled down by the fill's alpha).
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = `rgba(0,0,0,${Math.pow(TRAIL_FADE, dt)})`;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'source-over';

  // Screen-space advection: SPEED_PX px per 60fps frame per m/s, converted to
  // degrees at the current zoom (MapLibre 512px tiles → 512·2^z px per 360°).
  const k = SPEED_PX * dt * (360 / (512 * Math.pow(2, map.getZoom())));

  // All segments accumulate into one path, stroked twice below.
  const path = new Path2D();

  for (const p of particles) {
    const prevScreen = map.project([p.lon, p.lat]);
    const offViewport = prevScreen.x < 0 || prevScreen.x > w || prevScreen.y < 0 || prevScreen.y > h;
    const uv = offViewport ? null : sampleUV(p.lon, p.lat);
    if (!uv || p.age > MAX_AGE) {
      Object.assign(p, seedParticle());
      continue;
    }

    // Vector advection: dlat from v, dlon from u corrected for meridian
    // convergence (1/cos(lat)) — not meteorological "blowing from" direction.
    const [u, v] = uv;
    p.lat += v * k;
    p.lon += (u * k) / Math.cos((p.lat * Math.PI) / 180);
    p.age += dt;

    const newScreen = map.project([p.lon, p.lat]);
    path.moveTo(prevScreen.x, prevScreen.y);
    path.lineTo(newScreen.x, newScreen.y);
  }

  // Two-pass halo: a dark underlay keeps streaks visible over the near-white
  // low-wind wash, the white core over the dark high-wind wash.
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(0,20,40,0.35)';
  ctx.stroke(path);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke(path);

  rafId = requestAnimationFrame(frame);
}

// Starts (or restarts, if already running) the particle animation for the
// given forecast-step suffix ("" = the base "now" step; "_12h" etc — see
// meta.json `steps`). No-op if the map isn't ready or the wind field can't
// be loaded — the color wash alone still conveys wind.
export async function startWindParticles(suffix = '', version = ''): Promise<void> {
  stopWindParticles();
  if (!state.map) return;
  const seq = ++loadSeq;

  const ok = await loadField(suffix, version).catch((err: unknown) => {
    console.warn('[TransmissionMap] wind particle field failed to load', err);
    return false;
  });
  if (!ok || !bbox) return;
  // A stop() or newer start may have superseded this while loadField() was
  // in flight.
  if (!state.map || seq !== loadSeq) return;

  canvas = document.createElement('canvas');
  canvas.className = 'wind-particle-canvas';
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.pointerEvents = 'none';
  state.map.getContainer().appendChild(canvas);
  resizeCanvas(); // also seeds the area-scaled particle pool

  state.map.on('resize', resizeCanvas);
  state.map.on('movestart', onMoveStart);
  state.map.on('moveend', onMoveEnd);
  window.addEventListener('resize', resizeCanvas);
  listenersAttached = true;

  running = true;
  rafId = requestAnimationFrame(frame);
}

// Cancels the animation frame loop, detaches listeners, and removes the
// canvas — zero CPU/DOM footprint once called. Safe to call when not running.
export function stopWindParticles(): void {
  running = false;
  loadSeq++; // discard any decode still in flight
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  if (listenersAttached) {
    state.map?.off('resize', resizeCanvas);
    state.map?.off('movestart', onMoveStart);
    state.map?.off('moveend', onMoveEnd);
    window.removeEventListener('resize', resizeCanvas);
    listenersAttached = false;
  }
  mapMoving = false;
  lastFrameT = 0;
  canvas?.parentElement?.removeChild(canvas);
  canvas = null;
  ctx = null;
  particles = [];
  uvData = null;
}
