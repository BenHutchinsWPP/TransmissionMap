// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { state } from './state.js';
import { beginExperience, endExperienceLink, activeExperienceId, experienceIsDirty } from './experience-link.js';
import { readUrlState, writeUrlState } from './url-state.js';
import { splitHash, parseCameraSegment, formatCameraSegment, parseUrlState } from './url-state-codec.js';
import { MW_SLIDER_MAX } from './filters.js';
import { LEGEND_FILTERS } from './ui/ui-legends.js';
import { getLocale, setLocale } from '../src/i18n/index.js';

const RESERVED_PARAMS = new Set(['l', 'mw', 'y', 'gm', 'bm', 'oc', 'wc', 'wv', 'nr', 'so', '3d', 'hs', 'lb', 'lang', 'region', 'vx', 'exp']);

// readUrlState() runs once, before initMap() builds the map: hide the fixture's
// map for the read, as a cold boot would, then hand it back for the writes.
function coldBoot() {
  const { map, mapReady } = state;
  state.map = null;
  state.mapReady = false;
  try { readUrlState(); } finally { state.map = map; state.mapReady = mapReady; }
}

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
  state.ogfColorBy      = 'region';
  state.westtecColorBy  = 'scenario';
  state.weatherVar      = 'tempwind';
  state.nriHazard       = 'RISK';
  state.smokeOpacity    = 1;
  state.mwFilter        = { min: 0, max: MW_SLIDER_MAX };
  state.basemap         = 'light';
  state.projection      = 'mercator';
  state.terrain3d       = false;
  state.buildings3d     = false;
  state.hillshade       = false;
  state.basemapLabels   = true;
  state.yearFilter      = { enabled: false, year: 2025, min: 1900, max: 2031 };
  state.regionScope     = 'usa';
  state.mapReady        = false;
  state.map             = null;
  endExperienceLink();
  setLocale('en');
  history.replaceState(null, '', '#');
});

describe('readUrlState – basic params', () => {
  it('parses mw=100-500 into state.mwFilter', () => {
    setHash('mw=100-500');
    coldBoot();
    expect(state.mwFilter).toEqual({ min: 100, max: 500 });
  });

  it('bm=d → dark basemap', () => {
    setHash('bm=d');
    coldBoot();
    expect(state.basemap).toBe('dark');
  });

  it('y=2020 enables yearFilter', () => {
    setHash('y=2020');
    coldBoot();
    expect(state.yearFilter.enabled).toBe(true);
    expect(state.yearFilter.year).toBe(2020);
  });

  it.each(['-1', '101', '50.5', '50px', '', 'NaN', 'Infinity'])(
    'falls back to the default for invalid smoke opacity so=%s',
    value => {
      state.smokeOpacity = 0.4;
      setHash('so=' + value);
      coldBoot();
      expect(state.smokeOpacity).toBe(1);
    }
  );

  it('parses lang=es into active locale', () => {
    setHash('lang=es');
    coldBoot();
    expect(getLocale()).toBe('es');
  });

  it('ignores invalid lang parameter and preserves current locale', () => {
    setLocale('en');
    setHash('lang=invalid_locale');
    coldBoot();
    expect(getLocale()).toBe('en');
  });
});

describe('readUrlState – layer visibility', () => {
  it('parses l=OTL.-HTL (OTL on, HTL off)', () => {
    // OTL is osm-transmission-lines (default on), HTL is hifld-transmission-lines (default off)
    setHash('l=OTL.-HTL');
    coldBoot();
    expect(state.layerVisibility['osm-transmission-lines']).toBe(true);
    expect(state.layerVisibility['hifld-transmission-lines']).toBe(false);
  });

  it('boots a link naming two members of an exclusive group with one of them on', () => {
    // odin-outages and fema-nri share 'county-choropleth'; the later one wins,
    // as it does when applyView() switches them on in registry order.
    setHash('l=OUT.NRI');
    coldBoot();
    expect(state.layerVisibility['odin-outages']).toBe(false);
    expect(state.layerVisibility['fema-nri']).toBe(true);
  });
});

describe('readUrlState – legend filters', () => {
  it('parses v=HFG (voltage buckets)', () => {
    // v is voltage (kv) groupCode
    // H: 550+, F: 500-549, G: 300-499
    setHash('v=HFG');
    coldBoot();
    const kv = state.legendFilters['kv'];
    expect(kv.has('550+')).toBe(true);
    expect(kv.has('500-549')).toBe(true);
    expect(kv.has('300-499')).toBe(true);
    expect(kv.has('200-299')).toBe(false);
  });

  it('parses f=ws (fuel buckets: wind, solar)', () => {
    setHash('f=ws');
    coldBoot();
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
    coldBoot();
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
    coldBoot();
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
    coldBoot();
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
    state.ogfColorBy = 'status';

    writeUrlState();

    // Reset state
    state.basemap = 'light';
    state.mwFilter = { min: 0, max: MW_SLIDER_MAX };
    state.yearFilter.enabled = false;
    state.layerVisibility = {};
    state.legendFilters = {};
    state.genMode = {};
    state.ogfColorBy = 'region';

    coldBoot();

    expect(state.basemap).toBe('dark');
    expect(state.mwFilter).toEqual({ min: 50, max: 500 });
    expect(state.yearFilter.enabled).toBe(true);
    expect(state.yearFilter.year).toBe(2030);
    expect(state.layerVisibility['hifld-transmission-lines']).toBe(true);
    expect(state.layerVisibility['osm-transmission-lines']).toBe(false);
    expect(state.legendFilters['fuel']).toEqual(new Set(['wind', 'nuclear']));
    expect(state.genMode['eia-generators']).toBe('heat');
    expect(state.ogfColorBy).toBe('status');
  });

  it('omits oc when ogfColorBy is the default "region"', () => {
    writeUrlState();
    expect(location.hash).not.toContain('oc=');
  });

  it('round-trips wc=d into westtecColorBy "dataset"', () => {
    state.westtecColorBy = 'dataset';
    writeUrlState();
    expect(location.hash).toContain('wc=d');

    state.westtecColorBy = 'scenario';
    coldBoot();
    expect(state.westtecColorBy).toBe('dataset');
  });

  it('omits wc when westtecColorBy is the default "scenario"', () => {
    writeUrlState();
    expect(location.hash).not.toContain('wc=');
  });

  it('leaves westtecColorBy at its default when wc is unknown', () => {
    setHash('wc=zzz');
    coldBoot();
    expect(state.westtecColorBy).toBe('scenario');
  });

  it('omits nr when the NRI hazard is the default composite', () => {
    writeUrlState();
    expect(location.hash).not.toContain('nr=');
  });

  it('round-trips a non-default NRI hazard (wildfire) through nr=wfir', () => {
    state.nriHazard = 'WFIR';
    writeUrlState();
    expect(location.hash).toContain('nr=wfir');
    state.nriHazard = 'RISK';
    coldBoot();
    expect(state.nriHazard).toBe('WFIR');
  });

  it('leaves the NRI hazard at its default when nr is unknown', () => {
    setHash('nr=zzzz');
    coldBoot();
    expect(state.nriHazard).toBe('RISK');
  });

  it('omits wv when weatherVar is the default "tempwind"', () => {
    writeUrlState();
    expect(location.hash).not.toContain('wv=');
  });

  it('parses wv=t into weatherVar "temp"', () => {
    setHash('wv=t');
    coldBoot();
    expect(state.weatherVar).toBe('temp');
  });

  it('leaves weatherVar at its default when wv is unknown', () => {
    setHash('wv=zzz');
    coldBoot();
    expect(state.weatherVar).toBe('tempwind');
  });

  it('round-trips a non-default weatherVar (wind) through wv=w', () => {
    state.weatherVar = 'wind';
    writeUrlState();
    expect(location.hash).toContain('wv=w');
    state.weatherVar = 'tempwind';
    coldBoot();
    expect(state.weatherVar).toBe('wind');
  });

  it('round-trips a non-default weatherVar (temp) through wv=t', () => {
    state.weatherVar = 'temp';
    writeUrlState();
    expect(location.hash).toContain('wv=t');
    state.weatherVar = 'tempwind';
    coldBoot();
    expect(state.weatherVar).toBe('temp');
  });

  it('round-trips smoke opacity as an integer percent', () => {
    state.smokeOpacity = 0.425;
    writeUrlState();
    expect(location.hash).toContain('so=43');
    state.smokeOpacity = 1;
    coldBoot();
    expect(state.smokeOpacity).toBe(0.43);
    writeUrlState();
    expect(location.hash).toContain('so=43');
  });

  it('restores zero smoke opacity', () => {
    setHash('so=0');
    coldBoot();
    expect(state.smokeOpacity).toBe(0);
  });

  it('omits default 100% smoke opacity', () => {
    writeUrlState();
    expect(location.hash).not.toContain('so=');
  });

  it('parses explicit 100% smoke opacity', () => {
    state.smokeOpacity = 0.4;
    setHash('so=100');
    coldBoot();
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
    coldBoot();
    expect(state.terrain3d).toBe(true);
    expect(state.buildings3d).toBe(false);
  });

  it('round-trips 3d=b into buildings3d only', () => {
    state.buildings3d = true;
    writeUrlState();
    expect(location.hash).toContain('3d=b');
    state.buildings3d = false;
    coldBoot();
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
    coldBoot();
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
    coldBoot();
    expect(state.hillshade).toBe(true);
  });

  it('omits lb when basemap labels are on (the default)', () => {
    writeUrlState();
    expect(location.hash).not.toContain('lb=');
  });

  it('round-trips labels-off through lb=0', () => {
    state.basemapLabels = false;
    writeUrlState();
    expect(location.hash).toContain('lb=0');
    state.basemapLabels = true;
    coldBoot();
    expect(state.basemapLabels).toBe(false);
  });

  it('a link without lb seeds labels on over a labels-off state', () => {
    state.basemapLabels = false;
    setHash('bm=d');
    coldBoot();
    expect(state.basemapLabels).toBe(true);
  });

  it('hs and 3d coexist: both formatted and parsed together', () => {
    state.hillshade = true;
    state.terrain3d = true;
    writeUrlState();
    expect(location.hash).toContain('3d=t');
    expect(location.hash).toContain('hs=1');
    state.hillshade = false;
    state.terrain3d = false;
    coldBoot();
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
    coldBoot();
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
    coldBoot();
    expect(state.basemap).toBe('dark');
    expect(state.terrain3d).toBe(true);
    expect(getLocale()).toBe('zh');
  });

  it('reads and writes region parameter correctly', () => {
    state.regionScope = 'global';
    writeUrlState();
    expect(location.hash).toContain('region=global');

    state.regionScope = 'usa';
    coldBoot();
    expect(state.regionScope).toBe('global');

    // Default 'usa' is omitted from URL
    state.regionScope = 'usa';
    writeUrlState();
    expect(location.hash).not.toContain('region=');
  });

  it('ignores a continent left in an old shared link', () => {
    location.hash = '#region=europe';
    state.regionScope = 'usa';
    coldBoot();
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

describe('camera segment – codec round trip', () => {
  it('round-trips the 3-segment flat, north-up view', () => {
    const view = { center: [-98.35, 39.5] as [number, number], zoom: 5, bearing: 0, pitch: 0 };
    const seg = formatCameraSegment(view);
    expect(seg).toBe('5.00/39.5000/-98.3500');
    expect(parseCameraSegment(seg)).toEqual(view);
  });

  it('round-trips the 5-segment rotated/tilted view', () => {
    const view = { center: [-122.4194, 37.7749] as [number, number], zoom: 12.25, bearing: -34.5, pitch: 52 };
    const seg = formatCameraSegment(view);
    expect(seg).toBe('12.25/37.7749/-122.4194/-34.5/52.0');
    expect(parseCameraSegment(seg)).toEqual(view);
  });

  it('reads a 3-segment hash as bearing 0, pitch 0', () => {
    expect(parseCameraSegment('4/10/20')).toEqual({ center: [20, 10], zoom: 4, bearing: 0, pitch: 0 });
  });

  it.each(['', '5/39.5', '5/39.5/-98/10', '5/91/0', '5/0/181', '23/0/0', 'a/0/0', '5/0/0/0/90'])(
    'rejects malformed segment %j', seg => {
      expect(parseCameraSegment(seg)).toBeNull();
    });

  it.each(['Infinity/0/0', '5/Infinity/0', '5/0/-Infinity', '5/0/0/Infinity/0', '5/0/0/0/Infinity'])(
    'rejects non-finite segment %j', seg => {
      expect(parseCameraSegment(seg)).toBeNull();
    });

  it('splits the camera segment from the params, with or without a leading #', () => {
    const a = splitHash('#5.00/39.5000/-98.3500?l=abc&lang=es');
    expect(a.camera).toBe('5.00/39.5000/-98.3500');
    expect(a.params.get('lang')).toBe('es');
    expect(splitHash('5/1/2').camera).toBe('5/1/2');
    expect([...splitHash('5/1/2').params]).toEqual([]);
    expect(splitHash('').camera).toBe('');
  });
});

describe('camera segment – strict numbers and wrapped longitude', () => {
  it.each(['3abc/10x/20y', '5/10/20px', '5//20', '5/10/ ', '5/0/0/10deg/0', '5/0/0/0/'])(
    'rejects segment with junk or an empty field %j', seg => {
      expect(parseCameraSegment(seg)).toBeNull();
    });

  it.each([[190, -170], [-200, 160], [540, -180]])(
    'wraps longitude %d to %d so the link reopens', (lng, wrapped) => {
      const seg = formatCameraSegment({ center: [lng, 10], zoom: 4, bearing: 0, pitch: 0 });
      expect(parseCameraSegment(seg)?.center).toEqual([wrapped, 10]);
    });
});

describe('parseUrlState – invalid values are dropped', () => {
  const parse = (qs: string) => parseUrlState(new URLSearchParams(qs));

  it('resolves only listed codes, never Object.prototype keys', () => {
    const data = parse('bm=constructor&wv=toString&oc=valueOf&wc=hasOwnProperty&l=__proto__.constructor.-toString');
    expect(data.basemap).toBeUndefined();
    expect(data.weatherVar).toBeUndefined();
    expect(data.ogfColorBy).toBeUndefined();
    expect(data.westtecColorBy).toBeUndefined();
    expect(data.layerVisibility).toEqual({});
  });

  it('keeps a gen mode only when that layer offers it', () => {
    // e = eia-generators (icons/heat/both), d = osm-datacenters (icons/clusters/heat)
    expect(parse('gm=ec').genMode).toEqual({});
    expect(parse('gm=db').genMode).toEqual({});
    expect(parse('gm=ec.dc.eb').genMode).toEqual({ 'osm-datacenters': 'clusters', 'eia-generators': 'both' });
  });

  it.each(['5-', '-5', '1e999-5', '9-3', '1e-5', 'Infinity-5', '5-10-20', ' 5-10'])(
    'drops mw=%s', mw => {
      expect(parse('mw=' + encodeURIComponent(mw)).mwFilter).toBeUndefined();
    });

  it('keeps a plain mw range, including an equal min and max', () => {
    expect(parse('mw=0-' + MW_SLIDER_MAX).mwFilter).toEqual({ min: 0, max: MW_SLIDER_MAX });
    expect(parse('mw=7.5-7.5').mwFilter).toEqual({ min: 7.5, max: 7.5 });
  });

  it('clamps an mw range past the slider to its maximum, as the slider does', () => {
    expect(parse('mw=500-' + (MW_SLIDER_MAX + 1)).mwFilter).toEqual({ min: 500, max: MW_SLIDER_MAX });
    expect(parse(`mw=${MW_SLIDER_MAX + 5}-${MW_SLIDER_MAX + 9}`).mwFilter).toEqual({ min: MW_SLIDER_MAX, max: MW_SLIDER_MAX });
  });

  it.each(['2020abc', '99999', '1899', '2032', '2020.5', '', '-2020'])('drops y=%s', y => {
    expect(parse('y=' + y).yearFilter).toBeUndefined();
  });
});

describe('map experiences – exp param', () => {
  beforeEach(() => {
    state.mapReady = true;
    state.map = mockMap();
  });

  it('parses a known experience slug into state', () => {
    setHash('exp=columbia-hydro');
    coldBoot();
    expect(activeExperienceId()).toBe('columbia-hydro');
  });

  // Existence is checked by assets/experiences.ts, not the codec — resolving it
  // here would pull the whole catalogue into the initial bundle. The codec only
  // guards the shape.
  it('accepts any well-formed slug', () => {
    setHash('exp=not-a-story-yet');
    coldBoot();
    expect(activeExperienceId()).toBe('not-a-story-yet');
  });

  it('rejects a malformed slug', () => {
    setHash('exp=' + encodeURIComponent('<script>'));
    coldBoot();
    expect(activeExperienceId()).toBeNull();
  });

  it('writes exp while the view still matches the snapshot the story left', () => {
    beginExperience('columbia-hydro');
    writeUrlState();                       // records the pristine snapshot
    expect(location.hash).toContain('exp=columbia-hydro');
    writeUrlState();                       // nothing changed — still the story
    expect(location.hash).toContain('exp=columbia-hydro');
    expect(experienceIsDirty()).toBe(false);
  });

  it('keeps exp across camera moves — the camera is not part of the snapshot', () => {
    beginExperience('columbia-hydro');
    writeUrlState();
    state.map = mockMap({ bearing: 30, pitch: 40 });
    writeUrlState();
    expect(location.hash).toContain('exp=columbia-hydro');
    expect(experienceIsDirty()).toBe(false);
  });

  it('drops exp once the user edits a param the story owns', () => {
    beginExperience('columbia-hydro');
    writeUrlState();
    state.basemap = 'dark';
    writeUrlState();
    expect(experienceIsDirty()).toBe(true);
    expect(location.hash).not.toContain('exp=');
    expect(location.hash).toContain('bm=d');
  });

  it('stays dirty once edited, even if the view is put back by hand', () => {
    beginExperience('columbia-hydro');
    writeUrlState();
    state.basemap = 'dark';
    writeUrlState();
    state.basemap = 'light';
    writeUrlState();
    expect(experienceIsDirty()).toBe(true);
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
