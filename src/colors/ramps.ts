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

// ─── Live 2 m air temperature (GFS 0.25°) ─────────────────────────────────────
// MUST stay identical to TEMP_RAMP in scripts/fetch_weather_live.py — that script
// bakes these exact colors into the served WEBP, and this array draws the legend
// for it. The only ramp with a negative floor, hence TEMP_RAMP_MIN (RampDef.min):
// the legend gradient maps values over [min, max], not [0, max].
export const TEMP_RAMP_STOPS = [
  [-30, "37,52,148"],
  [-20, "44,127,184"],
  [-10, "65,182,196"],
  [0,   "161,218,180"],
  [10,  "255,255,178"],
  [20,  "254,204,92"],
  [30,  "253,141,60"],
  [40,  "227,26,28"],
  [45,  "128,0,38"],
];
export const TEMP_RAMP_MIN = -30;  // °C — values at/below clamp to the bottom color
export const TEMP_RAMP_MAX = 45;   // °C — values at/above clamp to the top color

// ─── Live weather: wind & gust (shared ramp) ──────────────────────────────────
// MUST stay identical to WIND_RAMP in scripts/fetch_weather_live.py.
// Ventusky's wind scale: dark gray (calm) → deep purple → dark blue → blue →
// blue-green → green → yellow → orange → red. Stops anchored at 5-mph steps
// converted to m/s (5 mph ≈ 2.2 m/s, 10 ≈ 4.5, 15 ≈ 6.7, …).
export const WEATHER_WIND_RAMP_STOPS = [
  [0,    "70,72,80"],
  [2.2,  "90,55,135"],
  [4.5,  "55,65,165"],
  [6.7,  "65,120,200"],
  [8.9,  "70,175,170"],
  [11.2, "85,185,90"],
  [13.4, "170,200,70"],
  [15.6, "230,215,70"],
  [17.9, "240,165,50"],
  [22.4, "235,90,55"],
  [26.8, "210,55,100"],
  [30,   "170,35,105"],
];
export const WEATHER_WIND_RAMP_MIN = 0;   // m/s
export const WEATHER_WIND_RAMP_MAX = 30;  // m/s — values at/above clamp to the top color

// ─── Live weather: relative humidity ──────────────────────────────────────────
// MUST stay identical to RH_RAMP in scripts/fetch_weather_live.py.
export const WEATHER_RH_RAMP_STOPS = [
  [0,   "140,81,10"],
  [25,  "191,129,45"],
  [50,  "223,194,125"],
  [75,  "128,205,193"],
  [100, "1,102,94"],
];
export const WEATHER_RH_RAMP_MIN = 0;    // %
export const WEATHER_RH_RAMP_MAX = 100;  // %

// ─── Live weather: cloud cover ────────────────────────────────────────────────
// MUST stay identical to CLOUD_RAMP in scripts/fetch_weather_live.py.
export const WEATHER_CLOUD_RAMP_STOPS = [
  [0,   "135,206,235"],
  [25,  "173,216,230"],
  [50,  "200,200,205"],
  [75,  "220,220,220"],
  [100, "245,245,245"],
];
export const WEATHER_CLOUD_RAMP_MIN = 0;    // %
export const WEATHER_CLOUD_RAMP_MAX = 100;  // %

// ─── Live weather: mean sea level pressure ────────────────────────────────────
// MUST stay identical to PRESSURE_RAMP in scripts/fetch_weather_live.py.
export const WEATHER_PRESSURE_RAMP_STOPS = [
  [960,  "84,39,143"],
  [983,  "69,117,180"],
  [1005, "255,255,191"],
  [1028, "253,174,97"],
  [1050, "241,105,19"],
];
export const WEATHER_PRESSURE_RAMP_MIN = 960;   // mb
export const WEATHER_PRESSURE_RAMP_MAX = 1050;  // mb — values at/above clamp to the top color

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
