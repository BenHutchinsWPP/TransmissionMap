// Display-unit preferences + SI-in/string-out formatters. Prefs are ambient
// module state read by every formatter below; tests must reset via
// setUnits(DEFAULT_UNITS) before/after exercising this module.

export type UnitPrefs = {
  temp:      'F' | 'C';
  speed:     'mph' | 'ftps' | 'kph' | 'ms';
  distance:  'mi' | 'km';
  area:      'acres' | 'ha' | 'km2' | 'mi2';
  elevation: 'ft' | 'm';
  pressure:  'mb' | 'inHg';
};

export const DEFAULT_UNITS: UnitPrefs = {
  temp: 'F', speed: 'mph', distance: 'mi', area: 'acres', elevation: 'ft', pressure: 'mb',
};

// dimension -> selectable options, consumed by the Settings dialog so it has no
// hardcoded unit list. Labels are what the user sees in the <select>.
export const UNIT_OPTIONS: {
  [K in keyof UnitPrefs]: {
    label: string;
    labelKey: string;
    options: { value: UnitPrefs[K]; label: string; optLabelKey: string }[];
  };
} = {
  temp: {
    label: 'Temperature',
    labelKey: 'units.temp',
    options: [
      { value: 'F', label: 'Fahrenheit (°F)', optLabelKey: 'units.opt.fahrenheit' },
      { value: 'C', label: 'Celsius (°C)', optLabelKey: 'units.opt.celsius' },
    ],
  },
  speed: {
    label: 'Wind speed',
    labelKey: 'units.speed',
    options: [
      { value: 'mph', label: 'Miles per hour (mph)', optLabelKey: 'units.opt.mph' },
      { value: 'ftps', label: 'Feet per second (ft/s)', optLabelKey: 'units.opt.ftps' },
      { value: 'kph', label: 'Kilometres per hour (km/h)', optLabelKey: 'units.opt.kph' },
      { value: 'ms', label: 'Metres per second (m/s)', optLabelKey: 'units.opt.ms' },
    ],
  },
  distance: {
    label: 'Distance',
    labelKey: 'units.distance',
    options: [
      { value: 'mi', label: 'Miles (mi)', optLabelKey: 'units.opt.miles' },
      { value: 'km', label: 'Kilometres (km)', optLabelKey: 'units.opt.km' },
    ],
  },
  area: {
    label: 'Area',
    labelKey: 'units.area',
    options: [
      { value: 'acres', label: 'Acres', optLabelKey: 'units.opt.acres' },
      { value: 'ha', label: 'Hectares (ha)', optLabelKey: 'units.opt.hectares' },
      { value: 'km2', label: 'Square kilometres (km²)', optLabelKey: 'units.opt.sqkm' },
      { value: 'mi2', label: 'Square miles (mi²)', optLabelKey: 'units.opt.sqmi' },
    ],
  },
  elevation: {
    label: 'Elevation / depth',
    labelKey: 'units.elevation',
    options: [
      { value: 'ft', label: 'Feet (ft)', optLabelKey: 'units.opt.feet' },
      { value: 'm', label: 'Metres (m)', optLabelKey: 'units.opt.meters' },
    ],
  },
  pressure: {
    label: 'Pressure',
    labelKey: 'units.pressure',
    options: [
      { value: 'mb', label: 'Millibars (mb)', optLabelKey: 'units.opt.mb' },
      { value: 'inHg', label: 'Inches of mercury (inHg)', optLabelKey: 'units.opt.inHg' },
    ],
  },
};

let units: UnitPrefs = { ...DEFAULT_UNITS };

// Readonly so a caller can't mutate prefs in place, which would bypass the
// saveUnits/emit('units:changed') that setUnits callers pair with.
export function getUnits(): Readonly<UnitPrefs> {
  return units;
}

export function setUnits(p: Partial<UnitPrefs>): void {
  units = { ...units, ...p };
}

// Raw numeric converters: SI in, current-preference number out.
export function convTemp(c: number): number {
  return units.temp === 'F' ? c * 9 / 5 + 32 : c;
}

export function convSpeed(ms: number): number {
  switch (units.speed) {
    case 'mph': return ms * 2.236936;
    case 'ftps': return ms * 3.28084;
    case 'kph': return ms * 3.6;
    default: return ms;
  }
}

export function convElevation(m: number): number {
  return units.elevation === 'ft' ? m * 3.28084 : m;
}

export function convPressure(mb: number): number {
  return units.pressure === 'inHg' ? mb * 0.02952998 : mb;
}

export function convDensity(perKm2: number): number {
  return units.area === 'acres' || units.area === 'mi2' ? perKm2 * 2.58998811 : perKm2;
}

// Unit suffix for the current preference, e.g. '°F', 'mph', 'mi', 'acres', 'ft', 'mb'.
export function unitLabel(dim: keyof UnitPrefs): string {
  switch (dim) {
    case 'temp': return units.temp === 'F' ? '°F' : '°C';
    case 'speed':
      switch (units.speed) {
        case 'mph': return 'mph';
        case 'ftps': return 'ft/s';
        case 'kph': return 'km/h';
        default: return 'm/s';
      }
    case 'distance': return units.distance === 'mi' ? 'mi' : 'km';
    case 'area':
      switch (units.area) {
        case 'acres': return 'acres';
        case 'ha': return 'ha';
        case 'km2': return 'km²';
        default: return 'mi²';
      }
    case 'elevation': return units.elevation === 'ft' ? 'ft' : 'm';
    case 'pressure': return units.pressure === 'mb' ? 'mb' : 'inHg';
    default: return '';
  }
}

export function densityLabel(): string {
  return units.area === 'acres' || units.area === 'mi2' ? 'ppl/mi²' : 'ppl/km²';
}

// Formatters: SI in, ready-to-display string out (number + suffix).
// Those used as a RampDef.fmt take a `mark` that goes between the number and
// the unit suffix — "+" for a clamped ramp's top end.
export function fmtTemp(c: number, mark = ''): string {
  return `${Math.round(convTemp(c))}${mark}${unitLabel('temp')}`;
}

export function fmtSpeed(ms: number, mark = ''): string {
  return `${convSpeed(ms).toFixed(1)}${mark} ${unitLabel('speed')}`;
}

export function fmtDistance(m: number): string {
  return units.distance === 'mi'
    ? `${(m / 1609.344).toFixed(2)} mi`
    : `${(m / 1000).toFixed(2)} km`;
}

export function fmtArea(m2: number): string {
  switch (units.area) {
    case 'mi2': return `${(m2 / 2589988.110336).toFixed(2)} mi²`;
    case 'km2': return `${(m2 / 1e6).toFixed(2)} km²`;
    case 'ha': return `${Math.round(m2 / 1e4).toLocaleString()} ha`;
    default: return `${Math.round(m2 / 4046.8564224).toLocaleString()} acres`;
  }
}

export function fmtElevation(m: number): string {
  return `${Math.round(convElevation(m))} ${unitLabel('elevation')}`;
}

export function fmtElevationRange(min: number, max: number): string {
  return `${Math.round(convElevation(min))}–${Math.round(convElevation(max))} ${unitLabel('elevation')}`;
}

export function fmtPressure(mb: number, mark = ''): string {
  const v = convPressure(mb);
  return units.pressure === 'mb' ? `${Math.round(v)}${mark} mb` : `${v.toFixed(2)}${mark} inHg`;
}

export function fmtDensity(perKm2: number): string {
  return `${Math.round(convDensity(perKm2)).toLocaleString()} ${densityLabel()}`;
}

// Source data that is already non-SI; converting to SI first would add float noise.
export function fmtDistanceMi(mi: number): string {
  return units.distance === 'mi'
    ? `${mi.toFixed(1)} mi`
    : `${(mi * 1.609344).toFixed(1)} km`;
}

export function fmtAreaAcres(acres: number): string {
  switch (units.area) {
    case 'ha': return `${Math.round(acres * 0.40468564224).toLocaleString()} ha`;
    case 'km2': return `${(acres * 0.0040468564224).toFixed(2)} km²`;
    case 'mi2': return `${(acres / 640).toFixed(2)} mi²`;
    default: return `${Math.round(acres).toLocaleString()} acres`;
  }
}

export function fmtAreaSqFt(sqft: number): string {
  return units.area === 'acres' || units.area === 'mi2'
    ? `${Math.round(sqft).toLocaleString()} sq ft`
    : `${Math.round(sqft * 0.09290304).toLocaleString()} m²`;
}
