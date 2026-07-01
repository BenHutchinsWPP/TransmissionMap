// ─── Raster LUT hover probes (wind/solar/geo/pop-density) ────────────────────
// Imported by: layer-init.ts (ensureRasterLut in addAllLayers),
//              visibility.ts (setLayerVisibility, updateRasterArrow)
// >>> ADD-LAYER: raster-probes — see docs/adding-a-layer.md §7

import { state, DATA } from './state.js';
import {
  WIND_RAMP_MAX, SOLAR_RAMP_MAX, GEO_RAMP_MAX, POP_LOG_MAX, SEIS_RAMP_MAX,
} from '../src/colors/ramps.js';

export const RASTER_PROBES: Record<string, {
  lut: () => string; meta: () => string; max: number;
  pct?: (v: number) => number; readout: (v: number) => string;
}> = {
  "nlr-wind-100m": {
    lut: () => DATA.nlr_wind_100m_lut, meta: () => DATA.nlr_wind_100m_lut_meta, max: WIND_RAMP_MAX,
    readout: (v) => `${v.toFixed(1)} m/s at cursor`,
  },
  "gsa-solar-pvout": {
    lut: () => DATA.gsa_solar_pvout_lut, meta: () => DATA.gsa_solar_pvout_lut_meta, max: SOLAR_RAMP_MAX,
    readout: (v) => `${v.toFixed(2)} kWh/kWp/day at cursor`,
  },
  "ihfc-geo-heatflow": {
    lut: () => DATA.ihfc_geo_heatflow_lut, meta: () => DATA.ihfc_geo_heatflow_lut_meta, max: GEO_RAMP_MAX,
    readout: (v) => `${v.toFixed(0)} mW/m² at cursor`,
  },
  "usgs-seismic-pga": {
    lut: () => DATA.usgs_seismic_pga_lut, meta: () => DATA.usgs_seismic_pga_lut_meta, max: SEIS_RAMP_MAX,
    readout: (v) => `${v.toFixed(3)} g PGA at cursor`,
  },
  "worldpop-pop-density": {
    lut: () => DATA.worldpop_pop_density_lut, meta: () => DATA.worldpop_pop_density_lut_meta, max: POP_LOG_MAX,
    pct: (v) => Math.log10(1 + v) / POP_LOG_MAX * 100,
    readout: (v) => `${Math.round(v).toLocaleString()} ppl/km² at cursor`,
  },
};

export async function ensureRasterLut(id: string) {
  const probe = RASTER_PROBES[id];
  if (!probe || state.rasterLut[id] || state.rasterLutLoading[id]) return;
  state.rasterLutLoading[id] = true;
  try {
    const [meta, buf] = await Promise.all([
      fetch(probe.meta()).then(r => r.json()),
      fetch(probe.lut()).then(r => r.arrayBuffer()),
    ]);
    state.rasterLut[id] = { meta, data: new Int16Array(buf) };
  } catch (err) {
    console.warn("[TransmissionMap] raster LUT load failed", id, err);
    state.rasterLutLoading[id] = false;
  }
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

export function updateRasterArrow(id: string, value: number | null) {
  const arrow   = document.getElementById(`${id}-ramp-arrow`);
  const readout = document.getElementById(`${id}-ramp-readout`);
  if (!arrow || !readout) return;
  if (value == null) { arrow.hidden = true; readout.hidden = true; return; }
  const probe = RASTER_PROBES[id];
  const pct = Math.max(0, Math.min(100,
    probe.pct ? probe.pct(value) : (value / probe.max) * 100));
  arrow.style.left = pct + "%";
  arrow.hidden = false;
  readout.textContent = probe.readout(value);
  readout.hidden = false;
}

export function initRasterProbes() {
  if (!state.map) return;
  state.map.on("mousemove", (e) => {
    for (const id of Object.keys(RASTER_PROBES)) {
      if (!state.layerVisibility[id] || !state.rasterLut[id]) continue;
      updateRasterArrow(id, sampleRaster(id, e.lngLat.lng, e.lngLat.lat));
    }
  });
  state.map.on("mouseout", () => {
    for (const id of Object.keys(RASTER_PROBES)) updateRasterArrow(id, null);
  });
}
