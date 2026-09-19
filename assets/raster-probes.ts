// ─── Raster LUT hover probes (wind/solar/geo/pop-density) ────────────────────
// Imported by: layer-init.ts (ensureRasterLut in addAllLayers),
//              visibility.ts (setLayerVisibility, updateRasterArrow)
// Depends on: src/units.ts (fmtSpeed, fmtDensity), map-input.ts (onMapPoint, onMapPointLeave)
// >>> ADD-LAYER: raster-probes — see docs/adding-a-layer.md §7

import { state, DATA, weatherLiveUrl } from './state.js';
import type { RasterMeta } from '../src/types.js';
import { WEATHER_VARIABLES } from '../src/registry/conditions.js';
import { fmtSpeed, fmtDensity } from '../src/units.js';
import { onMapPoint, onMapPointLeave } from './map-input.js';

// Currently-selected weather variable's display config (ramp + formatter).
// Falls back to the first entry if state.weatherVar is ever unset/unknown,
// mirroring refreshWeatherRampBlock() in ui/ui-legends.ts.
function currentWeatherVar() {
  return WEATHER_VARIABLES.find(v => v.id === state.weatherVar) ?? WEATHER_VARIABLES[0];
}

// The entry whose baked files (webp/i16/meta.vars key) back the current
// selection — combined views (`file:` set, e.g. Temp & Wind) borrow another
// entry's raster, so the probe's label/format/files all follow that entry.
function probeWeatherVar() {
  const v = currentWeatherVar();
  return v.file ? WEATHER_VARIABLES.find(w => w.id === v.file)! : v;
}

const WIND_VAR = WEATHER_VARIABLES.find(v => v.id === "wind")!;

// Shape of data/layers/weather_live/meta.json — one shared sidecar for every
// weather variable (see scripts/fetch_weather_live.py). `metaTransform` below
// picks out the currently-selected variable's dims and reshapes them into the
// flat RasterMeta the generic LUT sampler expects.
interface WeatherLiveMeta {
  vars: Record<string, {
    width: number; height: number; bbox: [number, number, number, number];
    scale: number; nodata: number;
  }>;
}

// lut/meta/metaTransform trio shared by the two weather probes. `varId` is
// read per call so the main probe follows the dropdown selection. Every LUT
// ships gzipped, base and per-step alike; weatherStepSuffix is "" for the base
// step — weather-live.ts keeps it current and invalidates the cache on every
// scrub/refresh.
function weatherProbeFiles(varId: () => string) {
  return {
    lut: () => weatherLiveUrl(`${varId()}${state.weatherStepSuffix}.i16.gz`),
    meta: () => weatherLiveUrl("meta.json"),
    metaTransform: (raw: unknown): RasterMeta => {
      const v = (raw as WeatherLiveMeta).vars[varId()];
      const [w, s, e, n] = v.bbox;
      return {
        west: w, north: n, dx: (e - w) / v.width, dy: (n - s) / v.height,
        width: v.width, height: v.height, nodata: v.nodata, scale: v.scale,
      };
    },
  };
}

export const RASTER_PROBES: Record<string, {
  lut: () => string; meta: () => string;
  label: string; readout: (v: number) => string;
  metaTransform?: (raw: unknown) => RasterMeta;
  // Overrides the default `state.layerVisibility[id]` gate — for probes that
  // aren't a registry layer of their own (the Temp & Wind companion probe).
  active?: () => boolean;
  // Skip the name prefix in the multi-line bubble — for readouts whose units
  // already identify them (the weather temperature / wind lines).
  noBubbleName?: boolean;
}> = {
  "nlr-wind-100m": {
    lut: () => DATA.nlr_wind_100m_lut, meta: () => DATA.nlr_wind_100m_lut_meta,
    label: "Wind 100 m", readout: (v) => fmtSpeed(v),
  },
  "gsa-solar-pvout": {
    lut: () => DATA.gsa_solar_pvout_lut, meta: () => DATA.gsa_solar_pvout_lut_meta,
    label: "Solar", readout: (v) => `${v.toFixed(2)} kWh/kWp/day`,
  },
  "ihfc-geo-heatflow": {
    lut: () => DATA.ihfc_geo_heatflow_lut, meta: () => DATA.ihfc_geo_heatflow_lut_meta,
    label: "Heat flow", readout: (v) => `${v.toFixed(0)} mW/m²`,
  },
  "usgs-seismic-pga": {
    lut: () => DATA.usgs_seismic_pga_lut, meta: () => DATA.usgs_seismic_pga_lut_meta,
    label: "Seismic", readout: (v) => `${v.toFixed(3)} g PGA`,
  },
  // label/readout follow the currently-selected weather variable. The LUT is
  // reloaded every refresh by weather-live.ts (it invalidates state.rasterLut
  // and re-calls ensureRasterLut) and whenever the variable dropdown changes
  // (setWeatherVar). lut()/meta() read state.weatherVar so a var switch
  // fetches the right files; readout() reads it too so the bubble text swaps
  // along with the LUT.
  "weather-live": {
    ...weatherProbeFiles(() => probeWeatherVar().id),
    get label() { return probeWeatherVar().label; },
    readout: (v) => probeWeatherVar().format(v),
    noBubbleName: true,
  },
  // Companion probe for the "Temp & Wind" combined view: adds a Wind line to
  // the cursor bubble alongside the Temperature line the main probe supplies.
  // Not a registry layer — `active` gates it to the combined view; its LUT is
  // (in)validated by weather-live.ts refetch() together with the main one.
  "weather-live-wind": {
    ...weatherProbeFiles(() => "wind"),
    label: WIND_VAR.label,
    readout: (v) => WIND_VAR.format(v),
    active: () => !!state.layerVisibility["weather-live"] && state.weatherVar === "tempwind",
    noBubbleName: true,
  },
  "worldpop-pop-density": {
    lut: () => DATA.worldpop_pop_density_lut, meta: () => DATA.worldpop_pop_density_lut_meta,
    label: "Pop. density", readout: (v) => fmtDensity(v),
  },
};

// fetch() resolves on 404, and a 404 body read as Int16Array samples as
// plausible-looking values — so a missing file has to raise here instead.
async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r;
}

export async function ensureRasterLut(id: string) {
  const probe = RASTER_PROBES[id];
  if (!probe || state.rasterLut[id] || state.rasterLutLoading[id]) return;
  state.rasterLutLoading[id] = true;
  try {
    const lutUrl = probe.lut();
    const [rawMeta, buf] = await Promise.all([
      fetchOk(probe.meta()).then(r => r.json()),
      fetchOk(lutUrl).then(r => lutUrl.endsWith(".gz")
        ? new Response(r.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
        : r.arrayBuffer()),
    ]);
    const meta = probe.metaTransform ? probe.metaTransform(rawMeta) : rawMeta as RasterMeta;
    state.rasterLut[id] = { meta, data: new Int16Array(buf) };
  } catch (err) {
    console.warn("[TransmissionMap] raster LUT load failed", id, err);
    state.rasterLutLoading[id] = false;
  }
  // A bubble placed by a tap outlives the tap, so a LUT arriving late — or the
  // hourly weather swap refetching one — has to reach it. Outside the try: a
  // fault while redrawing the bubble is not a failed load.
  if (state.rasterLut[id]) resampleBubble();
}

function sampleRaster(id: string, lng: number, lat: number): number | null {
  const L = state.rasterLut[id];
  if (!L) return null;
  const { meta, data } = L;
  const col = Math.floor((lng - meta.west) / meta.dx);
  const row = Math.floor((meta.north - lat) / meta.dy);
  if (col < 0 || col >= meta.width || row < 0 || row >= meta.height) return null;
  const v = data[row * meta.width + col];
  return v > meta.nodata ? v / meta.scale : null;
}

// ── Cursor value bubble (Ventusky-style) ─────────────────────────────────────
// One floating bubble sits at the cursor — or at the last tap — and lists the
// value of every visible probed raster under it; the layer-panel rows and
// legends carry no readout of their own. The anchor is a screen position, so
// it is re-read whenever the view settles and keeps naming the place it points
// at. The legacy name updateRasterArrow is kept because visibility.ts calls it
// with null to clear a layer's line on hide.
let bubbleEl: HTMLElement | null = null;
let bubblePoint: { x: number; y: number } | null = null;
let bubbleHtml = "";
const bubbleValues: Record<string, string> = {};

function setBubbleValue(id: string, value: number | null) {
  if (value == null) delete bubbleValues[id];
  else bubbleValues[id] = RASTER_PROBES[id].readout(value);
}

function renderBubble() {
  const lines = Object.entries(bubbleValues);
  if (!lines.length || !bubblePoint || !state.map) {
    bubbleEl?.setAttribute("hidden", "");
    return;
  }
  if (!bubbleEl) {
    bubbleEl = document.createElement("div");
    bubbleEl.className = "raster-bubble";
    state.map.getContainer().appendChild(bubbleEl);
  }
  // Label each line only when more than one raster is under the cursor.
  // Rebuilt only when the text changes — position updates alone (the common
  // mousemove case) leave the DOM untouched.
  const html = lines
    .map(([id, text]) => lines.length > 1 && !RASTER_PROBES[id].noBubbleName
      ? `<div><span class="raster-bubble-name">${RASTER_PROBES[id].label}</span> ${text}</div>`
      : `<div>${text}</div>`)
    .join("");
  if (html !== bubbleHtml) { bubbleEl.innerHTML = html; bubbleHtml = html; }
  bubbleEl.removeAttribute("hidden");
  // Offset from the cursor; flip to the other side near the right/bottom edge.
  const mapEl = state.map.getContainer();
  const flipX = bubblePoint.x > mapEl.clientWidth - 150;
  const flipY = bubblePoint.y > mapEl.clientHeight - 80;
  bubbleEl.style.left = `${bubblePoint.x}px`;
  bubbleEl.style.top = `${bubblePoint.y}px`;
  bubbleEl.style.transform =
    `translate(${flipX ? "calc(-100% - 14px)" : "14px"}, ${flipY ? "calc(-100% - 14px)" : "14px"})`;
}

export function updateRasterArrow(id: string, value: number | null) {
  setBubbleValue(id, value);
  renderBubble();
}

// Reads every visible probed raster at the bubble's current screen position.
// A pointer event already carries the unprojected position, so it hands it over
// rather than paying for a second terrain readback.
function resampleBubble(at?: { lng: number; lat: number }) {
  if (!state.map || !bubblePoint) return;
  const { lng, lat } = at ?? state.map.unproject([bubblePoint.x, bubblePoint.y]);
  for (const [id, probe] of Object.entries(RASTER_PROBES)) {
    const on = probe.active ? probe.active() : state.layerVisibility[id];
    setBubbleValue(id, on && state.rasterLut[id] ? sampleRaster(id, lng, lat) : null);
  }
  renderBubble();
}

export function initRasterProbes() {
  if (!state.map) return;
  // onMapPoint rather than onMapHover: reading a value off the raster is what
  // these layers are for, so a tap has to produce it as a mouse does.
  onMapPoint((e) => {
    bubblePoint = { x: e.point.x, y: e.point.y };
    resampleBubble(e.lngLat);
  });
  onMapPointLeave(() => {
    bubblePoint = null;
    for (const id of Object.keys(RASTER_PROBES)) setBubbleValue(id, null);
    renderBubble();
  });
  // A finger has no mouseout to stand the bubble down, so it outlives the tap
  // that placed it and has to be re-read against whatever the view became.
  // The two overlap on an ordinary pan and each covers something the other
  // misses: idle is the only one that fires for a change that moves nothing —
  // a terrain or projection switch, or a raster layer switched on under a
  // parked bubble — while moveend still arrives when a source never finishes
  // loading and the map is therefore never idle. Neither fires per frame, which
  // matters because under 3D terrain map.unproject() reads the terrain coords
  // framebuffer back off the GPU; idle stays per-settle only for as long as
  // nothing in the app schedules an unconditional repaint.
  state.map.on("moveend", () => resampleBubble());
  state.map.on("idle", () => resampleBubble());
}
