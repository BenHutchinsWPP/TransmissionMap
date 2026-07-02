// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { state } from './state.js';
import { readUrlState, writeUrlState } from './url-state.js';
import { MW_SLIDER_MAX } from './filters.js';
import { LEGEND_FILTERS } from './ui/ui-legends.js';

const RESERVED_PARAMS = new Set(['l', 'mw', 'y', 'gm', 'bm', 'oc']);

function setHash(qs: string) {
  history.replaceState(null, '', '#10/39.5/-98' + (qs ? '?' + qs : ''));
}

function mockMap(): MaplibreMap {
  return {
    getCenter: () => ({ lat: 39.5, lng: -98.35 }),
    getZoom:   () => 5,
  } as unknown as MaplibreMap;
}

beforeEach(() => {
  state.layerVisibility = {};
  state.legendFilters   = {};
  state.layerFilters    = {};
  state.genMode         = {};
  state.ogfColorBy      = 'status';
  state.mwFilter        = { min: 0, max: MW_SLIDER_MAX };
  state.basemap         = 'street';
  state.yearFilter      = { enabled: false, year: 2025, min: 1900, max: 2031 };
  state.mapReady        = false;
  state.map             = null;
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
    state.basemap = 'street';
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
