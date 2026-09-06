// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { state } from './state.js';
import { readUrlState, writeUrlState } from './url-state.js';
import { MW_SLIDER_MAX } from './filters.js';
import { LEGEND_FILTERS } from './ui/ui-legends.js';
import { getLocale, setLocale } from '../src/i18n/index.js';

const RESERVED_PARAMS = new Set(['l', 'mw', 'y', 'gm', 'bm', 'oc', 'wc', 'wv', 'so', '3d', 'hs', 'lang', 'region', 'exp']);

function setHash(qs: string) {
  history.replaceState(null, '', '#10/39.5/-98' + (qs ? '?' + qs : ''));
}

function mockMap(overrides?: { bearing?: number; pitch?: number }): MaplibreMap {
  return {
    getCenter:  () => ({ lat: 39.5, lng: -98.35 }),
    getZoom:    () => 5,
    getBearing: () => overrides?.bearing ?? 0,
    getPitch:   () => overrides?.pitch ?? 0,
  } as unknown as MaplibreMap;
}

beforeEach(() => {
  state.layerVisibility = {};
  state.legendFilters   = {};
  state.layerFilters    = {};
  state.genMode         = {};
  state.ogfColorBy      = 'status';
  state.westtecColorBy  = 'scenario';
  state.weatherVar      = 'tempwind';
  state.smokeOpacity    = 1;
  state.mwFilter        = { min: 0, max: MW_SLIDER_MAX };
  state.basemap         = 'light';
  state.projection      = 'mercator';
  state.terrain3d       = false;
  state.buildings3d     = false;
  state.hillshade       = false;
  state.yearFilter      = { enabled: false, year: 2025, min: 1900, max: 2031 };
  state.regionScope     = 'usa';
  state.mapReady        = false;
  state.map             = null;
  state.experienceId       = null;
  state.experienceDirty    = false;
  state.experiencePristine = null;
  setLocale('en');
  history.replaceState(null, '', '#');
});

describe('readUrlState – basic params', () => {
  it('parses mw=100-500 into state.mwFilter', () => {
    setHash('mw=100-500');
    readUrlState();
    expect(state.mwFilter).toEqual({ min: 100, max: 500 });
  });

  it('bm=d → dark basemap', () => {
    setHash('bm=d');
    readUrlState();
    expect(state.basemap).toBe('dark');
  });

  it('y=2020 enables yearFilter', () => {
    setHash('y=2020');
    readUrlState();
    expect(state.yearFilter.enabled).toBe(true);
    expect(state.yearFilter.year).toBe(2020);
  });

  it.each(['-1', '101', '50.5', '50px', '', 'NaN', 'Infinity'])(
    'ignores invalid smoke opacity so=%s',
    value => {
      state.smokeOpacity = 0.4;
      setHash('so=' + value);
      readUrlState();
      expect(state.smokeOpacity).toBe(0.4);
    }
  );

  it('parses lang=es into active locale', () => {
    setHash('lang=es');
    readUrlState();
    expect(getLocale()).toBe('es');
  });

  it('ignores invalid lang parameter and preserves current locale', () => {
    setLocale('en');
    setHash('lang=invalid_locale');
    readUrlState();
    expect(getLocale()).toBe('en');
  });
});

describe('readUrlState – layer visibility', () => {
  it('parses l=OTL.-HTL (OTL on, HTL off)', () => {
    // OTL is osm-transmission-lines (default on), HTL is hifld-transmission-lines (default off)
    setHash('l=OTL.-HTL');
    readUrlState();
    expect(state.layerVisibility['osm-transmission-lines']).toBe(true);
    expect(state.layerVisibility['hifld-transmission-lines']).toBe(false);
  });
});

describe('readUrlState – legend filters', () => {
  it('parses v=HFG (voltage buckets)', () => {
    // v is voltage (kv) groupCode
    // H: 550+, F: 500-549, G: 300-499
    setHash('v=HFG');
    readUrlState();
    const kv = state.legendFilters['kv'];
    expect(kv.has('550+')).toBe(true);
    expect(kv.has('500-549')).toBe(true);
    expect(kv.has('300-499')).toBe(true);
    expect(kv.has('200-299')).toBe(false);
  });

  it('parses f=ws (fuel buckets: wind, solar)', () => {
    setHash('f=ws');
    readUrlState();
    const fuel = state.legendFilters['fuel'];
    expect(fuel.has('wind')).toBe(true);
    expect(fuel.has('solar')).toBe(true);
    expect(fuel.has('coal')).toBe(false);
  });
});

describe('readUrlState – layer bucket filters', () => {
  it('parses s=er (EIA status: existing, retirement)', () => {
    // s is EIA status groupCode
    // e: existing, r: retirement
    setHash('s=er');
    readUrlState();
    const eia = state.layerFilters['eia-generators'];
    expect(eia.has('existing')).toBe(true);
    expect(eia.has('retirement')).toBe(true);
    expect(eia.has('retired')).toBe(false);
  });
});

describe('readUrlState – gen mode', () => {
  it('parses gm=oh.eb (OSM heat, EIA both)', () => {
    // o is osm-plants-points, e is eia-generators
    // h is heat, b is both
    setHash('gm=oh.eb');
    readUrlState();
    expect(state.genMode['osm-plants-points']).toBe('heat');
    expect(state.genMode['eia-generators']).toBe('both');
  });
});

describe('round-trip serialization', () => {
  beforeEach(() => {
    state.mapReady = true;
    state.map = mockMap();
  });

  it('street basemap round-trips now that light is the default', () => {
    state.basemap = 'street';
    writeUrlState();
    state.basemap = 'light';
    readUrlState();
    expect(state.basemap).toBe('street');
  });

  it('preserves complex state in URL', () => {
    state.basemap = 'dark';
    state.mwFilter = { min: 50, max: 500 };
    state.yearFilter = { enabled: true, year: 2030, min: 1900, max: 2031 };
    state.layerVisibility['hifld-transmission-lines'] = true; // default off
    state.layerVisibility['osm-transmission-lines'] = false; // default on
    state.legendFilters['fuel'] = new Set(['wind', 'nuclear']);
    state.genMode['eia-generators'] = 'heat';
    state.ogfColorBy = 'planauth';

    writeUrlState();

    // Reset state
    state.basemap = 'light';
    state.mwFilter = { min: 0, max: MW_SLIDER_MAX };
    state.yearFilter.enabled = false;
    state.layerVisibility = {};
    state.legendFilters = {};
    state.genMode = {};
    state.ogfColorBy = 'status';

    readUrlState();

    expect(state.basemap).toBe('dark');
    expect(state.mwFilter).toEqual({ min: 50, max: 500 });
    expect(state.yearFilter.enabled).toBe(true);
    expect(state.yearFilter.year).toBe(2030);
    expect(state.layerVisibility['hifld-transmission-lines']).toBe(true);
    expect(state.layerVisibility['osm-transmission-lines']).toBe(false);
    expect(state.legendFilters['fuel']).toEqual(new Set(['wind', 'nuclear']));
    expect(state.genMode['eia-generators']).toBe('heat');
    expect(state.ogfColorBy).toBe('planauth');
  });

  it('omits oc when ogfColorBy is the default "status"', () => {
    writeUrlState();
    expect(location.hash).not.toContain('oc=');
  });

  it('round-trips wc=d into westtecColorBy "dataset"', () => {
    state.westtecColorBy = 'dataset';
    writeUrlState();
    expect(location.hash).toContain('wc=d');

    state.westtecColorBy = 'scenario';
    readUrlState();
    expect(state.westtecColorBy).toBe('dataset');
  });

  it('omits wc when westtecColorBy is the default "scenario"', () => {
    writeUrlState();
    expect(location.hash).not.toContain('wc=');
  });

  it('leaves westtecColorBy at its default when wc is unknown', () => {
    setHash('wc=zzz');
    readUrlState();
    expect(state.westtecColorBy).toBe('scenario');
  });

  it('omits wv when weatherVar is the default "tempwind"', () => {
    writeUrlState();
    expect(location.hash).not.toContain('wv=');
  });

  it('parses wv=t into weatherVar "temp"', () => {
    setHash('wv=t');
    readUrlState();
    expect(state.weatherVar).toBe('temp');
  });

  it('leaves weatherVar at its default when wv is unknown', () => {
    setHash('wv=zzz');
    readUrlState();
    expect(state.weatherVar).toBe('tempwind');
  });

  it('round-trips a non-default weatherVar (wind) through wv=w', () => {
    state.weatherVar = 'wind';
    writeUrlState();
    expect(location.hash).toContain('wv=w');
    state.weatherVar = 'tempwind';
    readUrlState();
    expect(state.weatherVar).toBe('wind');
  });

  it('round-trips a non-default weatherVar (temp) through wv=t', () => {
    state.weatherVar = 'temp';
    writeUrlState();
    expect(location.hash).toContain('wv=t');
    state.weatherVar = 'tempwind';
    readUrlState();
    expect(state.weatherVar).toBe('temp');
  });

  it('round-trips smoke opacity as an integer percent', () => {
    state.smokeOpacity = 0.425;
    writeUrlState();
    expect(location.hash).toContain('so=43');
    state.smokeOpacity = 1;
    readUrlState();
    expect(state.smokeOpacity).toBe(0.43);
    writeUrlState();
    expect(location.hash).toContain('so=43');
  });

  it('restores zero smoke opacity', () => {
    setHash('so=0');
    readUrlState();
    expect(state.smokeOpacity).toBe(0);
  });

  it('omits default 100% smoke opacity', () => {
    writeUrlState();
    expect(location.hash).not.toContain('so=');
  });

  it('parses explicit 100% smoke opacity', () => {
    state.smokeOpacity = 0.4;
    setHash('so=100');
    readUrlState();
    expect(state.smokeOpacity).toBe(1);
  });

  it('omits 3d when both terrain3d and buildings3d are off (the default)', () => {
    writeUrlState();
    expect(location.hash).not.toContain('3d=');
  });

  it('round-trips 3d=t into terrain3d only', () => {
    state.terrain3d = true;
    writeUrlState();
    expect(location.hash).toContain('3d=t');
    state.terrain3d = false;
    readUrlState();
    expect(state.terrain3d).toBe(true);
    expect(state.buildings3d).toBe(false);
  });

  it('round-trips 3d=b into buildings3d only', () => {
    state.buildings3d = true;
    writeUrlState();
    expect(location.hash).toContain('3d=b');
    state.buildings3d = false;
    readUrlState();
    expect(state.buildings3d).toBe(true);
    expect(state.terrain3d).toBe(false);
  });

  it('round-trips 3d=tb into both terrain3d and buildings3d', () => {
    state.terrain3d = true;
    state.buildings3d = true;
    writeUrlState();
    expect(location.hash).toContain('3d=tb');
    state.terrain3d = false;
    state.buildings3d = false;
    readUrlState();
    expect(state.terrain3d).toBe(true);
    expect(state.buildings3d).toBe(true);
  });

  it('omits hs when state.hillshade is off (the default)', () => {
    writeUrlState();
    expect(location.hash).not.toContain('hs=');
  });

  it('round-trips hs=1 into state.hillshade', () => {
    state.hillshade = true;
    writeUrlState();
    expect(location.hash).toContain('hs=1');
    state.hillshade = false;
    readUrlState();
    expect(state.hillshade).toBe(true);
  });

  it('hs and 3d coexist: both formatted and parsed together', () => {
    state.hillshade = true;
    state.terrain3d = true;
    writeUrlState();
    expect(location.hash).toContain('3d=t');
    expect(location.hash).toContain('hs=1');
    state.hillshade = false;
    state.terrain3d = false;
    readUrlState();
    expect(state.terrain3d).toBe(true);
    expect(state.hillshade).toBe(true);
  });

  it('omits lang when getLocale() is the default "en"', () => {
    setLocale('en');
    writeUrlState();
    expect(location.hash).not.toContain('lang=');
  });

  it('round-trips a non-default lang (es) through lang=es', () => {
    setLocale('es');
    writeUrlState();
    expect(location.hash).toContain('lang=es');
    setLocale('en');
    readUrlState();
    expect(getLocale()).toBe('es');
  });

  it('round-trips lang=zh alongside other state parameters', () => {
    state.basemap = 'dark';
    state.terrain3d = true;
    setLocale('zh');
    writeUrlState();
    expect(location.hash).toContain('bm=d');
    expect(location.hash).toContain('3d=t');
    expect(location.hash).toContain('lang=zh');

    state.basemap = 'light';
    state.terrain3d = false;
    setLocale('en');
    readUrlState();
    expect(state.basemap).toBe('dark');
    expect(state.terrain3d).toBe(true);
    expect(getLocale()).toBe('zh');
  });

  it('reads and writes region parameter correctly', () => {
    state.regionScope = 'global';
    writeUrlState();
    expect(location.hash).toContain('region=global');

    state.regionScope = 'usa';
    readUrlState();
    expect(state.regionScope).toBe('global');

    // Default 'usa' is omitted from URL
    state.regionScope = 'usa';
    writeUrlState();
    expect(location.hash).not.toContain('region=');
  });

  it('ignores a continent left in an old shared link', () => {
    location.hash = '#region=europe';
    state.regionScope = 'usa';
    readUrlState();
    expect(state.regionScope).toBe('usa');
  });
});

describe('writeUrlState – bearing/pitch (rotation/tilt)', () => {
  beforeEach(() => {
    state.mapReady = true;
  });

  it('keeps the plain zoom/lat/lng hash when bearing and pitch are both 0', () => {
    state.map = mockMap();
    writeUrlState();
    const posStr = location.hash.slice(1).split('?')[0];
    expect(posStr.split('/')).toHaveLength(3);
  });

  it('appends /bearing/pitch when the view is rotated', () => {
    state.map = mockMap({ bearing: 34.5, pitch: 52 });
    writeUrlState();
    const posStr = location.hash.slice(1).split('?')[0];
    expect(posStr.split('/')).toEqual(['5.00', '39.5000', '-98.3500', '34.5', '52.0']);
  });

  it('appends /bearing/pitch when only pitch is non-zero', () => {
    state.map = mockMap({ pitch: 45 });
    writeUrlState();
    const posStr = location.hash.slice(1).split('?')[0];
    expect(posStr.split('/')).toEqual(['5.00', '39.5000', '-98.3500', '0.0', '45.0']);
  });

  it('treats a bearing that rounds to 0.0 as flat (no suffix)', () => {
    state.map = mockMap({ bearing: 0.04 });
    writeUrlState();
    const posStr = location.hash.slice(1).split('?')[0];
    expect(posStr.split('/')).toHaveLength(3);
  });
});

describe('map experiences – exp param', () => {
  beforeEach(() => {
    state.mapReady = true;
    state.map = mockMap();
  });

  it('parses a known experience slug into state', () => {
    setHash('exp=columbia-hydro');
    readUrlState();
    expect(state.experienceId).toBe('columbia-hydro');
  });

  // Existence is checked by assets/experiences.ts, not the codec — resolving it
  // here would pull the whole catalogue into the initial bundle. The codec only
  // guards the shape.
  it('accepts any well-formed slug', () => {
    setHash('exp=not-a-story-yet');
    readUrlState();
    expect(state.experienceId).toBe('not-a-story-yet');
  });

  it('rejects a malformed slug', () => {
    setHash('exp=' + encodeURIComponent('<script>'));
    readUrlState();
    expect(state.experienceId).toBeNull();
  });

  it('writes exp while the view still matches the snapshot the story left', () => {
    state.experienceId = 'columbia-hydro';
    writeUrlState();                       // records the pristine snapshot
    expect(location.hash).toContain('exp=columbia-hydro');
    writeUrlState();                       // nothing changed — still the story
    expect(location.hash).toContain('exp=columbia-hydro');
    expect(state.experienceDirty).toBe(false);
  });

  it('keeps exp across camera moves — the camera is not part of the snapshot', () => {
    state.experienceId = 'columbia-hydro';
    writeUrlState();
    state.map = mockMap({ bearing: 30, pitch: 40 });
    writeUrlState();
    expect(location.hash).toContain('exp=columbia-hydro');
    expect(state.experienceDirty).toBe(false);
  });

  it('drops exp once the user edits a param the story owns', () => {
    state.experienceId = 'columbia-hydro';
    writeUrlState();
    state.basemap = 'dark';
    writeUrlState();
    expect(state.experienceDirty).toBe(true);
    expect(location.hash).not.toContain('exp=');
    expect(location.hash).toContain('bm=d');
  });

  it('stays dirty once edited, even if the view is put back by hand', () => {
    state.experienceId = 'columbia-hydro';
    writeUrlState();
    state.basemap = 'dark';
    writeUrlState();
    state.basemap = 'light';
    writeUrlState();
    expect(state.experienceDirty).toBe(true);
    expect(location.hash).not.toContain('exp=');
  });
});

describe('reserved-param collision guard', () => {
  it('no LEGEND_FILTERS groupCode collides with reserved URL params', () => {
    for (const cfg of LEGEND_FILTERS) {
      if (cfg.groupCode) {
        expect(
          RESERVED_PARAMS.has(cfg.groupCode),
          `groupCode "${cfg.groupCode}" collides with reserved URL param`
        ).toBe(false);
      }
    }
  });

  it('no two LEGEND_FILTERS share the same groupCode', () => {
    const seen = new Set<string>();
    for (const cfg of LEGEND_FILTERS) {
      if (!cfg.groupCode) continue;
      expect(seen.has(cfg.groupCode), `duplicate groupCode "${cfg.groupCode}"`).toBe(false);
      seen.add(cfg.groupCode);
    }
  });
});
