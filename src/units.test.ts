import { describe, it, expect, beforeEach } from 'vitest';
import {
  getUnits,
  setUnits,
  DEFAULT_UNITS,
  UNIT_OPTIONS,
  fmtTemp,
  fmtSpeed,
  fmtDistance,
  fmtDistanceMi,
  fmtArea,
  fmtAreaAcres,
  fmtAreaSqFt,
  fmtElevation,
  fmtElevationRange,
  fmtPressure,
  fmtDensity,
  unitLabel,
  convTemp,
  convSpeed,
  convElevation,
  convPressure,
  convDensity,
  densityLabel,
  type UnitPrefs,
} from './units.js';

// Reset ambient module state before each test
beforeEach(() => setUnits(DEFAULT_UNITS));

describe('getUnits/setUnits', () => {
  it('getUnits returns current prefs', () => {
    expect(getUnits()).toEqual(DEFAULT_UNITS);
  });

  it('setUnits with partial update changes only specified dimension', () => {
    setUnits({ temp: 'C' });
    const prefs = getUnits();
    expect(prefs.temp).toBe('C');
    expect(prefs.speed).toBe('mph');
    expect(prefs.distance).toBe('mi');
    expect(prefs.area).toBe('acres');
    expect(prefs.elevation).toBe('ft');
    expect(prefs.pressure).toBe('mb');
  });

  it('setUnits can change multiple dimensions at once', () => {
    setUnits({ temp: 'C', speed: 'kph', distance: 'km' });
    const prefs = getUnits();
    expect(prefs.temp).toBe('C');
    expect(prefs.speed).toBe('kph');
    expect(prefs.distance).toBe('km');
    expect(prefs.area).toBe('acres');
  });
});

describe('fmtTemp', () => {
  it('formats 0°C to 32°F in Fahrenheit mode', () => {
    setUnits({ temp: 'F' });
    expect(fmtTemp(0)).toBe('32°F');
  });

  it('formats 100°C to 212°F in Fahrenheit mode', () => {
    setUnits({ temp: 'F' });
    expect(fmtTemp(100)).toBe('212°F');
  });

  it('formats 0°C as 0°C in Celsius mode', () => {
    setUnits({ temp: 'C' });
    expect(fmtTemp(0)).toBe('0°C');
  });

  it('formats 100°C as 100°C in Celsius mode', () => {
    setUnits({ temp: 'C' });
    expect(fmtTemp(100)).toBe('100°C');
  });

  it('rounds temperature values', () => {
    setUnits({ temp: 'F' });
    // 25°C = 77°F
    expect(fmtTemp(25)).toBe('77°F');
  });
});

describe('fmtSpeed', () => {
  it('formats 5 m/s to 11.2 mph', () => {
    setUnits({ speed: 'mph' });
    // 5 * 2.236936 = 11.18468
    expect(fmtSpeed(5)).toBe('11.2 mph');
  });

  it('formats 5 m/s to 16.4 ft/s', () => {
    setUnits({ speed: 'ftps' });
    // 5 * 3.28084 = 16.4042
    expect(fmtSpeed(5)).toBe('16.4 ft/s');
  });

  it('formats 5 m/s to 18.0 km/h', () => {
    setUnits({ speed: 'kph' });
    // 5 * 3.6 = 18 — the trailing .0 is kept so the unit reads at fixed width
    expect(fmtSpeed(5)).toBe('18.0 km/h');
  });

  it('formats 5 m/s to 5.0 m/s', () => {
    setUnits({ speed: 'ms' });
    expect(fmtSpeed(5)).toBe('5.0 m/s');
  });

  it('keeps one decimal in every unit', () => {
    setUnits({ speed: 'mph' });
    // 3.7 * 2.236936 = 8.2766
    expect(fmtSpeed(3.7)).toBe('8.3 mph');
    setUnits({ speed: 'ms' });
    expect(fmtSpeed(3.7)).toBe('3.7 m/s');
  });
});

describe('fmtDistance', () => {
  it('formats 1609.344 m (1 mile) to 1.00 mi', () => {
    setUnits({ distance: 'mi' });
    // 1609.344 / 1609.344 = 1.00
    expect(fmtDistance(1609.344)).toBe('1.00 mi');
  });

  it('formats 1000 m to 0.62 mi', () => {
    setUnits({ distance: 'mi' });
    // 1000 / 1609.344 = 0.6213... → 0.62
    expect(fmtDistance(1000)).toBe('0.62 mi');
  });

  it('formats 1609.344 m to 1.61 km', () => {
    setUnits({ distance: 'km' });
    // 1609.344 / 1000 = 1.609344 → 1.61
    expect(fmtDistance(1609.344)).toBe('1.61 km');
  });

  it('formats 1000 m to 1.00 km', () => {
    setUnits({ distance: 'km' });
    expect(fmtDistance(1000)).toBe('1.00 km');
  });

  it('always uses two decimal places', () => {
    setUnits({ distance: 'mi' });
    // 804.672 m (0.5 mile)
    expect(fmtDistance(804.672)).toBe('0.50 mi');
  });
});

describe('fmtDistanceMi', () => {
  it('formats 1 mile as 1.0 mi when distance is mi', () => {
    setUnits({ distance: 'mi' });
    expect(fmtDistanceMi(1)).toBe('1.0 mi');
  });

  it('formats 10 miles as 10.0 mi when distance is mi', () => {
    setUnits({ distance: 'mi' });
    expect(fmtDistanceMi(10)).toBe('10.0 mi');
  });

  it('formats 1 mile as 1.6 km when distance is km', () => {
    setUnits({ distance: 'km' });
    // 1 * 1.609344 = 1.609344 → 1.6
    expect(fmtDistanceMi(1)).toBe('1.6 km');
  });

  it('formats 10 miles as 16.1 km when distance is km', () => {
    setUnits({ distance: 'km' });
    // 10 * 1.609344 = 16.09344 → 16.1
    expect(fmtDistanceMi(10)).toBe('16.1 km');
  });
});

describe('fmtArea', () => {
  it('formats 100000 m² to 25 acres in acres mode', () => {
    setUnits({ area: 'acres' });
    // 100000 / 4046.8564224 = 24.710... → rounds to 25
    expect(fmtArea(100000)).toBe('25 acres');
  });

  it('formats 100000 m² to 10 ha in ha mode', () => {
    setUnits({ area: 'ha' });
    // 100000 / 10000 = 10 → rounds to 10
    expect(fmtArea(100000)).toBe('10 ha');
  });

  it('formats 100000 m² to 0.10 km² in km2 mode', () => {
    setUnits({ area: 'km2' });
    // 100000 / 1000000 = 0.1 → 0.10
    expect(fmtArea(100000)).toBe('0.10 km²');
  });

  it('formats 100000 m² to 0.04 mi² in mi2 mode', () => {
    setUnits({ area: 'mi2' });
    // 100000 / 2589988.110336 = 0.03861... → 0.04
    expect(fmtArea(100000)).toBe('0.04 mi²');
  });

  it('uses toLocaleString for acres and ha (whole numbers)', () => {
    setUnits({ area: 'acres' });
    // 1000000 / 4046.8564224 = 247.10... → 247
    expect(fmtArea(1000000)).toBe('247 acres');
  });

  it('uses two decimal places for km² and mi²', () => {
    setUnits({ area: 'km2' });
    // 50000 / 1000000 = 0.05
    expect(fmtArea(50000)).toBe('0.05 km²');
  });
});

describe('fmtAreaAcres', () => {
  it('formats 100 acres as 100 acres in acres mode', () => {
    setUnits({ area: 'acres' });
    expect(fmtAreaAcres(100)).toBe('100 acres');
  });

  it('formats 100 acres to 40 ha in ha mode', () => {
    setUnits({ area: 'ha' });
    // 100 * 0.40468564224 = 40.468564224 → rounds to 40
    expect(fmtAreaAcres(100)).toBe('40 ha');
  });

  it('formats 100 acres to 0.40 km² in km2 mode', () => {
    setUnits({ area: 'km2' });
    // 100 * 0.0040468564224 = 0.40468564224 → 0.40
    expect(fmtAreaAcres(100)).toBe('0.40 km²');
  });

  it('formats 100 acres to 0.16 mi² in mi2 mode', () => {
    setUnits({ area: 'mi2' });
    // 100 / 640 = 0.15625 → 0.16
    expect(fmtAreaAcres(100)).toBe('0.16 mi²');
  });
});

describe('fmtAreaSqFt', () => {
  it('formats 40468 sq ft as 40,468 sq ft in acres mode', () => {
    setUnits({ area: 'acres' });
    // 40468 sq ft → rounds to 40,468 (uses toLocaleString)
    expect(fmtAreaSqFt(40468)).toBe('40,468 sq ft');
  });

  it('formats 40468 sq ft as 40,468 sq ft in mi2 mode', () => {
    setUnits({ area: 'mi2' });
    expect(fmtAreaSqFt(40468)).toBe('40,468 sq ft');
  });

  it('formats 40468 sq ft to m² in ha mode', () => {
    setUnits({ area: 'ha' });
    // 40468 * 0.09290304 = 3759.60... → rounds to 3,760
    expect(fmtAreaSqFt(40468)).toBe('3,760 m²');
  });

  it('formats 40468 sq ft to m² in km2 mode', () => {
    setUnits({ area: 'km2' });
    // 40468 * 0.09290304 = 3759.60... → rounds to 3,760
    expect(fmtAreaSqFt(40468)).toBe('3,760 m²');
  });
});

describe('fmtElevation', () => {
  it('formats 1000 m to 3281 ft in feet mode', () => {
    setUnits({ elevation: 'ft' });
    // 1000 * 3.28084 = 3280.84 → rounds to 3281
    expect(fmtElevation(1000)).toBe('3281 ft');
  });

  it('formats 1000 m to 1000 m in metres mode', () => {
    setUnits({ elevation: 'm' });
    expect(fmtElevation(1000)).toBe('1000 m');
  });

  it('formats 500 m to 1640 ft', () => {
    setUnits({ elevation: 'ft' });
    // 500 * 3.28084 = 1640.42 → rounds to 1640
    expect(fmtElevation(500)).toBe('1640 ft');
  });
});

describe('fmtElevationRange', () => {
  it('formats range 100 to 1000 m to 328–3281 ft with EN DASH', () => {
    setUnits({ elevation: 'ft' });
    // 100 * 3.28084 = 328.084 → 328
    // 1000 * 3.28084 = 3280.84 → 3281
    expect(fmtElevationRange(100, 1000)).toBe('328–3281 ft');
  });

  it('formats range 100 to 1000 m as 100–1000 m with EN DASH', () => {
    setUnits({ elevation: 'm' });
    expect(fmtElevationRange(100, 1000)).toBe('100–1000 m');
  });

  it('uses single unit suffix for both values', () => {
    setUnits({ elevation: 'ft' });
    const result = fmtElevationRange(200, 500);
    // Should end with single " ft"
    expect(result).toMatch(/ ft$/);
    // Count occurrences of " ft" - should be only 1
    expect((result.match(/ ft/g) || []).length).toBe(1);
  });

  it('uses EN DASH (U+2013) not hyphen', () => {
    setUnits({ elevation: 'm' });
    const result = fmtElevationRange(100, 200);
    expect(result).toContain('–');
    expect(result).not.toContain('-');
  });
});

describe('fmtPressure', () => {
  it('formats 1000 mb as 1000 mb', () => {
    setUnits({ pressure: 'mb' });
    expect(fmtPressure(1000)).toBe('1000 mb');
  });

  it('formats 1000 mb to 29.53 inHg with two decimals', () => {
    setUnits({ pressure: 'inHg' });
    // 1000 * 0.02952998 = 29.52998 → 29.53
    expect(fmtPressure(1000)).toBe('29.53 inHg');
  });

  it('rounds mb values to whole numbers', () => {
    setUnits({ pressure: 'mb' });
    // 1013.25 → rounds to 1013
    expect(fmtPressure(1013.25)).toBe('1013 mb');
  });

  it('formats inHg with always two decimal places', () => {
    setUnits({ pressure: 'inHg' });
    // 1013.25 * 0.02952998 = 29.9176... → 29.92
    expect(fmtPressure(1013.25)).toBe('29.92 inHg');
  });
});

describe('fmtDensity', () => {
  it('formats 100 per km² to 259 ppl/mi² in acres mode', () => {
    setUnits({ area: 'acres' });
    // 100 * 2.58998811 = 258.998811 → rounds to 259
    expect(fmtDensity(100)).toBe('259 ppl/mi²');
  });

  it('formats 100 per km² to 259 ppl/mi² in mi2 mode', () => {
    setUnits({ area: 'mi2' });
    expect(fmtDensity(100)).toBe('259 ppl/mi²');
  });

  it('formats 100 per km² as 100 ppl/km² in ha mode', () => {
    setUnits({ area: 'ha' });
    expect(fmtDensity(100)).toBe('100 ppl/km²');
  });

  it('formats 100 per km² as 100 ppl/km² in km2 mode', () => {
    setUnits({ area: 'km2' });
    expect(fmtDensity(100)).toBe('100 ppl/km²');
  });

  it('uses toLocaleString for thousands separator', () => {
    setUnits({ area: 'acres' });
    // 10000 * 2.58998811 = 25899.8811 → rounds to 25,900
    expect(fmtDensity(10000)).toBe('25,900 ppl/mi²');
  });
});

describe('unitLabel', () => {
  it('returns °F for temp in Fahrenheit mode', () => {
    setUnits({ temp: 'F' });
    expect(unitLabel('temp')).toBe('°F');
  });

  it('returns °C for temp in Celsius mode', () => {
    setUnits({ temp: 'C' });
    expect(unitLabel('temp')).toBe('°C');
  });

  it('returns mph for speed in mph mode', () => {
    setUnits({ speed: 'mph' });
    expect(unitLabel('speed')).toBe('mph');
  });

  it('returns ft/s for speed in ftps mode', () => {
    setUnits({ speed: 'ftps' });
    expect(unitLabel('speed')).toBe('ft/s');
  });

  it('returns km/h for speed in kph mode', () => {
    setUnits({ speed: 'kph' });
    expect(unitLabel('speed')).toBe('km/h');
  });

  it('returns m/s for speed in ms mode', () => {
    setUnits({ speed: 'ms' });
    expect(unitLabel('speed')).toBe('m/s');
  });

  it('returns mi for distance in mi mode', () => {
    setUnits({ distance: 'mi' });
    expect(unitLabel('distance')).toBe('mi');
  });

  it('returns km for distance in km mode', () => {
    setUnits({ distance: 'km' });
    expect(unitLabel('distance')).toBe('km');
  });

  it('returns acres for area in acres mode', () => {
    setUnits({ area: 'acres' });
    expect(unitLabel('area')).toBe('acres');
  });

  it('returns ha for area in ha mode', () => {
    setUnits({ area: 'ha' });
    expect(unitLabel('area')).toBe('ha');
  });

  it('returns km² for area in km2 mode', () => {
    setUnits({ area: 'km2' });
    expect(unitLabel('area')).toBe('km²');
  });

  it('returns mi² for area in mi2 mode', () => {
    setUnits({ area: 'mi2' });
    expect(unitLabel('area')).toBe('mi²');
  });

  it('returns ft for elevation in feet mode', () => {
    setUnits({ elevation: 'ft' });
    expect(unitLabel('elevation')).toBe('ft');
  });

  it('returns m for elevation in metres mode', () => {
    setUnits({ elevation: 'm' });
    expect(unitLabel('elevation')).toBe('m');
  });

  it('returns mb for pressure in mb mode', () => {
    setUnits({ pressure: 'mb' });
    expect(unitLabel('pressure')).toBe('mb');
  });

  it('returns inHg for pressure in inHg mode', () => {
    setUnits({ pressure: 'inHg' });
    expect(unitLabel('pressure')).toBe('inHg');
  });
});

describe('Conversion functions', () => {
  it('convTemp converts 0°C to 32°F', () => {
    setUnits({ temp: 'F' });
    expect(convTemp(0)).toBe(32);
  });

  it('convTemp leaves 0°C as 0 in Celsius mode', () => {
    setUnits({ temp: 'C' });
    expect(convTemp(0)).toBe(0);
  });

  it('convSpeed converts 5 m/s to mph', () => {
    setUnits({ speed: 'mph' });
    // 5 * 2.236936 = 11.18468
    expect(Math.round(convSpeed(5) * 1000) / 1000).toBe(11.185);
  });

  it('convSpeed returns same value for m/s', () => {
    setUnits({ speed: 'ms' });
    expect(convSpeed(5)).toBe(5);
  });

  it('convElevation converts 1000 m to ft', () => {
    setUnits({ elevation: 'ft' });
    // 1000 * 3.28084 = 3280.84
    expect(Math.round(convElevation(1000) * 100) / 100).toBe(3280.84);
  });

  it('convElevation leaves 1000 m as 1000 in metres mode', () => {
    setUnits({ elevation: 'm' });
    expect(convElevation(1000)).toBe(1000);
  });

  it('convPressure converts 1000 mb to inHg', () => {
    setUnits({ pressure: 'inHg' });
    // 1000 * 0.02952998 = 29.52998
    expect(Math.round(convPressure(1000) * 10000) / 10000).toBeCloseTo(29.53, 2);
  });

  it('convPressure returns same value for mb', () => {
    setUnits({ pressure: 'mb' });
    expect(convPressure(1000)).toBe(1000);
  });

  it('convDensity converts per km² to per mi² in acres mode', () => {
    setUnits({ area: 'acres' });
    // 100 * 2.58998811 = 258.998811
    expect(Math.round(convDensity(100) * 10000) / 10000).toBeCloseTo(258.9988, 4);
  });

  it('convDensity converts per km² to per mi² in mi2 mode', () => {
    setUnits({ area: 'mi2' });
    expect(Math.round(convDensity(100) * 10000) / 10000).toBeCloseTo(258.9988, 4);
  });

  it('convDensity returns same value for ha', () => {
    setUnits({ area: 'ha' });
    expect(convDensity(100)).toBe(100);
  });

  it('convDensity returns same value for km2', () => {
    setUnits({ area: 'km2' });
    expect(convDensity(100)).toBe(100);
  });
});

describe('densityLabel', () => {
  it('returns ppl/mi² for acres mode', () => {
    setUnits({ area: 'acres' });
    expect(densityLabel()).toBe('ppl/mi²');
  });

  it('returns ppl/mi² for mi2 mode', () => {
    setUnits({ area: 'mi2' });
    expect(densityLabel()).toBe('ppl/mi²');
  });

  it('returns ppl/km² for ha mode', () => {
    setUnits({ area: 'ha' });
    expect(densityLabel()).toBe('ppl/km²');
  });

  it('returns ppl/km² for km2 mode', () => {
    setUnits({ area: 'km2' });
    expect(densityLabel()).toBe('ppl/km²');
  });
});

describe('UNIT_OPTIONS validation', () => {
  it('has entries for all UnitPrefs dimensions', () => {
    const keys: (keyof UnitPrefs)[] = ['temp', 'speed', 'distance', 'area', 'elevation', 'pressure'];
    for (const key of keys) {
      expect(UNIT_OPTIONS).toHaveProperty(key);
      expect(UNIT_OPTIONS[key]).toHaveProperty('label');
      expect(UNIT_OPTIONS[key]).toHaveProperty('options');
      expect(Array.isArray(UNIT_OPTIONS[key].options)).toBe(true);
    }
  });

  it('includes all DEFAULT_UNITS values in UNIT_OPTIONS', () => {
    const defaults = DEFAULT_UNITS as Record<keyof UnitPrefs, string>;
    for (const [dim, defaultValue] of Object.entries(defaults)) {
      const options = UNIT_OPTIONS[dim as keyof UnitPrefs].options;
      const values = options.map((opt) => opt.value);
      expect(values).toContain(defaultValue as never);
    }
  });

  it('temp dimension has F and C options', () => {
    const values = UNIT_OPTIONS.temp.options.map((opt) => opt.value);
    expect(values).toEqual(['F', 'C']);
  });

  it('speed dimension has all four speed options', () => {
    const values = UNIT_OPTIONS.speed.options.map((opt) => opt.value);
    expect(values).toEqual(['mph', 'ftps', 'kph', 'ms']);
  });

  it('distance dimension has mi and km options', () => {
    const values = UNIT_OPTIONS.distance.options.map((opt) => opt.value);
    expect(values).toEqual(['mi', 'km']);
  });

  it('area dimension has all four area options', () => {
    const values = UNIT_OPTIONS.area.options.map((opt) => opt.value);
    expect(values).toEqual(['acres', 'ha', 'km2', 'mi2']);
  });

  it('elevation dimension has ft and m options', () => {
    const values = UNIT_OPTIONS.elevation.options.map((opt) => opt.value);
    expect(values).toEqual(['ft', 'm']);
  });

  it('pressure dimension has mb and inHg options', () => {
    const values = UNIT_OPTIONS.pressure.options.map((opt) => opt.value);
    expect(values).toEqual(['mb', 'inHg']);
  });
});
