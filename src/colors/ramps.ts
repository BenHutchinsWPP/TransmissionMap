// Each ramp MUST stay in sync with the matching gdaldem color-ramp file in scripts/.
// >>> ADD-LAYER: raster-ramp — continuous raster? add RAMP_STOPS + RAMP_MAX here,
//     mirror them in scripts/<id>_color_ramp.txt. See docs/adding-a-layer.md §3R.

// ─── Wind resource ────────────────────────────────────────────────────────────
export const WIND_RAMP_STOPS = [
  [0,  "224,243,248"],
  [3,  "161,218,215"],
  [6,  "65,182,196"],
  [9,  "34,110,160"],
  [12, "12,44,110"],
];
export const WIND_RAMP_MAX = 12;  // m/s — values at/above clamp to top color

// ─── Solar resource ───────────────────────────────────────────────────────────
export const SOLAR_RAMP_STOPS = [
  [0,   "255,247,188"],
  [2.5, "254,227,145"],
  [4,   "254,178,76"],
  [5.5, "253,141,60"],
  [7,   "189,0,38"],
];
export const SOLAR_RAMP_MAX = 7;  // kWh/kWp/day — values at/above clamp to top color

// ─── Population density ───────────────────────────────────────────────────────
// log10(1+x) transformed for tiling; stops in log-space (0–4.7) = 0→~50,000 ppl/km².
export const POP_RAMP_STOPS = [
  [0,   "0,0,0"],
  [1.0, "254,217,142"],
  [2.0, "253,141,60"],
  [3.0, "227,74,51"],
  [4.0, "189,0,38"],
];
export const POP_LOG_MAX = 4.7;  // log10(1+50000) ≈ 4.7 — clamp for color + slider

// ─── Geothermal heat flow ─────────────────────────────────────────────────────
export const GEO_RAMP_STOPS = [
  [0,   "255,255,204"],
  [40,  "254,217,142"],
  [80,  "253,141,60"],
  [120, "240,59,32"],
  [150, "189,0,38"],
];
export const GEO_RAMP_MAX = 150;  // mW/m² — values at/above clamp to top color

// ─── Seismic hazard (USGS NSHM PGA, 2% in 50yr) ───────────────────────────────
// Peak Ground Acceleration in g. Yellow→red. CONUS max ≈ 2.9 g (New Madrid /
// coastal CA hotspots) but clamp at 1.5 g — above that is design-basis "very high".
export const SEIS_RAMP_STOPS = [
  [0,    "255,255,178"],
  [0.2,  "254,217,118"],
  [0.5,  "253,141,60"],
  [0.9,  "240,59,32"],
  [1.5,  "189,0,38"],
];
export const SEIS_RAMP_MAX = 1.5;  // g — values at/above clamp to top color

// ─── Generation heatmap (live MW-weighted density) ────────────────────────────
export const HEAT_MW_STOPS = [
  [0,    0.0],
  [50,   0.15],
  [200,  0.4],
  [800,  0.75],
  [2000, 1.0],
];
export const OSM_MW_FLOOR = 5;

export const HEAT_DENSITY_COLOR = [
  "interpolate", ["linear"], ["heatmap-density"],
  0.0, "rgba(0,0,0,0)",
  0.1, "rgba(33,102,172,0.5)",
  0.3, "rgb(103,169,207)",
  0.5, "rgb(253,219,199)",
  0.7, "rgb(239,138,98)",
  1.0, "rgb(178,24,43)",
];
const HEAT_RAMP_STOPS = [
  [0,   "33,102,172"],
  [25,  "103,169,207"],
  [50,  "253,219,199"],
  [75,  "239,138,98"],
  [100, "178,24,43"],
];
export const HEAT_RAMP = { stops: HEAT_RAMP_STOPS, max: 100, minLabel: "low", maxLabel: "high" };

// ─── EIA year filter (playback) bounds ────────────────────────────────────────
export const YEAR_FILTER_MIN     = 1900;
export const YEAR_FILTER_MAX     = 2031;
export const YEAR_FILTER_DEFAULT = 2025;
