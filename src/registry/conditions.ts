// Layer registry entries — natural hazards & live conditions.
// Role: pure-data LayerDef for the conditions group; consumed by src/registry/index.ts.
// Deps: ../types (LayerDef). No side effects.
import type { LayerDef, RampDef } from '../types.js';
import {
  SEIS_RAMP_STOPS, SEIS_RAMP_MAX,
  TEMP_RAMP_STOPS, TEMP_RAMP_MIN, TEMP_RAMP_MAX,
  WEATHER_WIND_RAMP_STOPS, WEATHER_WIND_RAMP_MIN, WEATHER_WIND_RAMP_MAX,
  WEATHER_RH_RAMP_STOPS, WEATHER_RH_RAMP_MIN, WEATHER_RH_RAMP_MAX,
  WEATHER_CLOUD_RAMP_STOPS, WEATHER_CLOUD_RAMP_MIN, WEATHER_CLOUD_RAMP_MAX,
  WEATHER_PRESSURE_RAMP_STOPS, WEATHER_PRESSURE_RAMP_MIN, WEATHER_PRESSURE_RAMP_MAX,
} from '../colors/ramps.js';
import { fmtTemp, fmtSpeed, fmtPressure } from '../units.js';

// The LUT/ramp domain stays SI (°C, m/s, mb); conversion to the user's
// display-unit preference happens at the legend/hover edge via src/units.ts.
const TEMP_RAMP: RampDef = {
  stops: TEMP_RAMP_STOPS, min: TEMP_RAMP_MIN, max: TEMP_RAMP_MAX, fmt: fmtTemp,
};

const WIND_RAMP: RampDef = {
  stops: WEATHER_WIND_RAMP_STOPS, min: WEATHER_WIND_RAMP_MIN, max: WEATHER_WIND_RAMP_MAX, fmt: fmtSpeed,
};

const RH_RAMP: RampDef = {
  stops: WEATHER_RH_RAMP_STOPS, min: WEATHER_RH_RAMP_MIN, max: WEATHER_RH_RAMP_MAX,
  minLabel: "0%", maxLabel: "100%",
};
const CLOUD_RAMP: RampDef = {
  stops: WEATHER_CLOUD_RAMP_STOPS, min: WEATHER_CLOUD_RAMP_MIN, max: WEATHER_CLOUD_RAMP_MAX,
  minLabel: "0%", maxLabel: "100%",
};
const fmtPct = (v: number) => `${Math.round(v)}%`;

const PRESSURE_RAMP: RampDef = {
  stops: WEATHER_PRESSURE_RAMP_STOPS, min: WEATHER_PRESSURE_RAMP_MIN, max: WEATHER_PRESSURE_RAMP_MAX,
  fmt: fmtPressure,
};

// Weather Forecast dropdown entries, in dropdown order. Each carries its own
// color ramp (SI-unit domain, matching the .i16 LUT baked by
// scripts/fetch_weather_live.py) and a display-edge formatter — SI in, a
// display-unit string out. Consumed by ui-layer-rows.ts (dropdown + legend
// ramp), raster-probes.ts (hover readout), url-state-codec.ts (wv param).
// `file` points a combined view at another entry's baked raster/LUT files
// (no extra pipeline output); absent means the entry bakes its own. `noWash`
// suppresses the color raster image itself (weather-live.ts crossfades a
// transparent placeholder instead) while keeping particles + hover cursor —
// used by "Windstream" for a flow-only view over the basemap.
export const WEATHER_VARIABLES: {
  id: string; label: string; urlCode: string; ramp: RampDef; format: (v: number) => string;
  file?: string; noWash?: boolean;
}[] = [
  { id: "tempwind", label: "Temp & Wind",  urlCode: "tw", ramp: TEMP_RAMP,    format: fmtTemp, file: "temp" },
  { id: "temp",     label: "Temperature",  urlCode: "t", ramp: TEMP_RAMP,     format: fmtTemp },
  { id: "wind",     label: "Wind",         urlCode: "w", ramp: WIND_RAMP,     format: fmtSpeed },
  { id: "windstream", label: "Windstream", urlCode: "ws", ramp: WIND_RAMP,    format: fmtSpeed, file: "wind", noWash: true },
  { id: "gust",     label: "Wind Gust",    urlCode: "g", ramp: WIND_RAMP,     format: fmtSpeed },
  { id: "rh",       label: "Humidity",     urlCode: "h", ramp: RH_RAMP,       format: fmtPct },
  { id: "dewpoint", label: "Dew Point",    urlCode: "d", ramp: TEMP_RAMP,     format: fmtTemp },
  { id: "cloud",    label: "Cloud Cover",  urlCode: "c", ramp: CLOUD_RAMP,    format: fmtPct },
  { id: "pressure", label: "Pressure",     urlCode: "p", ramp: PRESSURE_RAMP, format: fmtPressure },
];

export const conditionLayers: LayerDef[] = [
  {
    id:          "wildfire-live",
    urlCode:     "WFL",
    label:       "Fire: Active (~24h)",
    group:       "conditions",
    sourceId:    "nasa-firms-nifc",
    swatch:      "#ff4400",
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["wildfire-perimeters-fill", "wildfire-perimeters-line", "wildfire-hotspots-heat", "wildfire-hotspots-circle"],
    downloads: {},
  },
  {
    id:          "wildfire-smoke",
    urlCode:     "SMK",
    label:       "Fire: Smoke (~24h)",
    group:       "conditions",
    sourceId:    "noaa-hms",
    swatch:      "#ff8c00",
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["wildfire-smoke-fill", "wildfire-smoke-line"],
    downloads: {},
  },
  {
    id:          "wildfire-incidents",
    urlCode:     "WFI",
    label:       "Fire: Incidents (~24h)",
    group:       "conditions",
    sourceId:    "nasa-firms-nifc",
    swatch:      "#cc0000",
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["wildfire-incidents-circle"],
    downloads: {},
  },
  {
    id:           "usfs-wildfire-potential",
    urlCode:      "WHP",
    label:        "Fire: Hazard Potential",
    group:        "conditions",
    sourceId:     "usfs-firelab",
    swatch:       "#FF0000",
    defaultOn:    false,
    mapLayerIds:  ["usfs-wildfire-potential"],
    downloads: {},
  },
  {
    id:          "nws-alerts",
    urlCode:     "NWS",
    label:       "✂️ Weather Alerts (live, Filtered)",
    group:       "conditions",
    sourceId:    "noaa-nws",
    swatch:      "#a855f7",
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["nws-alerts-fill", "nws-alerts-line"],
    downloads: {},
  },
  {
    id:          "odin-outages",
    urlCode:     "OUT",
    label:       "Power Outages (US, live)",
    group:       "conditions",
    sourceId:    "ornl-odin",
    swatch:      "#fd8d3c",   // mid-bucket (100–1k) of the YlOrRd outage ramp
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["odin-outages-fill", "odin-outages-line"],
    downloads: {},
  },
  {
    id:          "nexrad-radar",
    urlCode:     "RAD",
    label:       "Weather: Radar (live)",
    group:       "conditions",
    sourceId:    "iem-nexrad",
    swatch:      "#04e304",
    live:        true,
    defaultOn:   false,
    mapLayerIds: ["geomet-radar-rain", "geomet-radar-snow", "nexrad-radar"],
    downloads: {},
  },
  {
    id:          "weather-live",
    urlCode:     "WX",
    label:       "Weather Forecast",
    group:       "conditions",
    sourceId:    "noaa-gfs",
    swatch:      `rgb(${TEMP_RAMP_STOPS[6][1]})`,   // 30 °C — the warm end of the ramp
    // No static `ramp` here — the legend ramp swaps per-variable from
    // WEATHER_VARIABLES[].ramp (see ui-legends.ts refreshWeatherRampBlock()).
    live:        true,
    weatherVarLayer: true,
    defaultOn:   false,
    mapLayerIds: ["weather-live", "weather-live-b", "weather-admin-lines-states", "weather-admin-lines-countries"],
    downloads: {},
  },
  {
    id:           "usgs-seismic-pga",
    urlCode:      "PGA",
    label:        "Seismic Hazard (PGA, 2% in 50yr)",
    group:        "conditions",
    sourceId:     "usgs-nshm",
    swatch:       `rgb(${SEIS_RAMP_STOPS[3][1]})`,
    ramp:         { stops: SEIS_RAMP_STOPS, max: SEIS_RAMP_MAX, unit: "g" },
    defaultOn:    false,
    mapLayerIds:  ["usgs-seismic-pga"],
    downloads: {},
  },
];
