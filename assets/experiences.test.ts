// @vitest-environment jsdom
// Pins how a curated preset reaches the map: rendered as UrlStateData by
// experienceUrlState(), applied by view-state.ts's applyView(). Two properties are checked
// here. That the preset is expressible as a link — every story survives
// formatUrlState/parseUrlState intact, which is what keeps a story and a shared
// link showing the same map (section 1). And that applying one is complete — a
// story never inherits a value from the one before it, the property an isolated
// round-trip can't see, because leakage lives in the transition (section 2).
//
// Deps: experiences.js (the module under test), view-state.js, url-state-codec.js,
//       registry/experiences.js, state.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';

// ─── Mocks (must come before importing the module under test) ─────────────────
// view-state.js stays real: resolving each view over the defaults is what makes
// the applier complete, so a double for it would test the double instead.

vi.mock('./map.js', async () => {
  const { state } = await import('./state.js');
  return {
    initMap: vi.fn(),
    switchBasemap: vi.fn((b: string) => { state.basemap = b; }),
    switchProjection: vi.fn((p: string) => { state.projection = p; }),
    setBasemapLabels: vi.fn(),
  };
});

vi.mock('./terrain.js', async () => {
  const { state } = await import('./state.js');
  return {
    setTerrain3d: vi.fn((on: boolean) => { state.terrain3d = on; }),
    setBuildings3d: vi.fn((on: boolean) => { state.buildings3d = on; }),
    setHillshade: vi.fn((on: boolean) => { state.hillshade = on; }),
  };
});

vi.mock('./weather-live.js', async () => {
  const { state } = await import('./state.js');
  return {
    setWeatherVar: vi.fn((v: string) => { state.weatherVar = v; }),
    syncWeatherLiveVisibility: vi.fn(),
    initWeatherLive: vi.fn(),
    weatherFreshness: vi.fn(() => null),
  };
});

vi.mock('./nws-zone-join.js', () => ({
  syncZoneVisibility: vi.fn(),
  initNwsZoneJoin: vi.fn(),
  setZoneGroupFilter: vi.fn(),
  pruneExpiredZoneAlerts: vi.fn(),
  clearZoneAlerts: vi.fn(),
  refetchZoneAlerts: vi.fn(),
  zoneFeatureLit: vi.fn(() => false),
  lookupByZone: vi.fn(() => undefined),
  lookupByFips: vi.fn(() => undefined),
}));

vi.mock('./layers/map-layers-conditions.js', () => ({ applySmokeOpacity: vi.fn() }));
vi.mock('./layers/layer-init.js', () => ({
  ensureLayerData: vi.fn(),
  registerBaseFilter: vi.fn(),
  LAZY_GEOJSON: {},
  initialVisibility: vi.fn(() => 'none'),
}));
vi.mock('./raster-probes.js', () => ({
  RASTER_PROBES: {} as Record<string, unknown>,
  ensureRasterLut: vi.fn(),
  updateRasterArrow: vi.fn(),
}));

const visibilityCalls: [string, boolean][] = [];
vi.mock('./visibility.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./visibility.js')>();
  return {
    ...actual,
    setLayerVisibility: vi.fn((id: string, on: boolean) => {
      visibilityCalls.push([id, on]);
      actual.setLayerVisibility(id, on);
    }),
  };
});

const writeUrlStateCalls: (string | null)[] = [];
vi.mock('./url-state.js', async () => {
  const { state } = await import('./state.js');
  return {
    readUrlState: vi.fn(),
    // Records who the session thought the active story was at write time, which
    // is what the dirty-flag ordering turns on.
    writeUrlState: vi.fn(() => { writeUrlStateCalls.push(state.experienceId); }),
  };
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import { state } from './state.js';
import { YEAR_FILTER_DEFAULT, YEAR_FILTER_MIN, YEAR_FILTER_MAX } from '../src/colors/ramps.js';
import { formatUrlState, parseUrlState, type UrlStateData } from './url-state-codec.js';
import { EXPERIENCES, type MapExperience } from '../src/registry/experiences.js';
import { experienceUrlState, applyExperience } from './experiences.js';
import { applyView, seedView } from './view-state.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockMap(): MaplibreMap {
  return {
    getLayer: vi.fn(() => undefined),
    getSource: vi.fn(() => undefined),
    setLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn(),
    setFilter: vi.fn(),
    getZoom: vi.fn(() => 5),
    getCenter: vi.fn(() => ({ lat: 39.5, lng: -98.35 })),
    getBearing: vi.fn(() => 0),
    getPitch: vi.fn(() => 0),
    stop: vi.fn(),
    flyTo: vi.fn(),
    jumpTo: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
  } as unknown as MaplibreMap;
}

// What a shared link carries, back through the codec — the trip a preset has to
// survive for its story to be shareable.
function roundTrip(data: UrlStateData): Partial<UrlStateData> {
  return parseUrlState(new URLSearchParams(formatUrlState(data).join('&')));
}

const sets = (r: Record<string, Set<string>>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v].sort()]));

// Every field the codec can carry, in a comparable shape.
function snapshot() {
  return {
    layerVisibility: { ...state.layerVisibility },
    legendFilters: sets(state.legendFilters),
    layerFilters: sets(state.layerFilters),
    genMode: { ...state.genMode },
    mwFilter: { ...state.mwFilter },
    yearFilter: { enabled: state.yearFilter.enabled, year: state.yearFilter.year },
    ogfColorBy: state.ogfColorBy,
    westtecColorBy: state.westtecColorBy,
    weatherVar: state.weatherVar,
    nriHazard: state.nriHazard,
    smokeOpacity: state.smokeOpacity,
    basemap: state.basemap,
    projection: state.projection,
    terrain3d: state.terrain3d,
    buildings3d: state.buildings3d,
    hillshade: state.hillshade,
    regionScope: state.regionScope,
  };
}

const applyPreset = (preset: MapExperience['state']) =>
  applyView(roundTrip(experienceUrlState(preset)));

const presetOf = (id: string) => {
  const exp = EXPERIENCES.find(e => e.id === id);
  if (!exp) throw new Error(`no experience "${id}"`);
  return exp.state;
};

beforeEach(() => {
  writeUrlStateCalls.length = 0;
  visibilityCalls.length = 0;
  state.layerVisibility = {};
  state.legendFilters = {};
  state.layerFilters = {};
  state.genMode = {};
  state.yearFilter = {
    enabled: false, year: YEAR_FILTER_DEFAULT,
    min: YEAR_FILTER_MIN, max: YEAR_FILTER_MAX,
  };
  seedView({});
  state.experienceId = null;
  state.experienceDirty = false;
  state.experiencePristine = null;
  state.map = mockMap();
  state.mapReady = true;
  document.body.innerHTML = '';
});

// ─── 1. Every story is expressible as a link ──────────────────────────────────

// This is the guarantee that keeps a story and a shared link showing the same
// map: everything a preset says has to fit in the URL codec. applyExperience()
// hands its UrlStateData to applyView() directly, so the codec is not in
// the runtime path and cannot report a field it doesn't know — this loop is
// where that is checked. A field added to MapExperience.state without a
// matching format/parse pair in url-state-codec.ts lands on the map from the
// catalogue and goes missing from the link; these tests fail when it does.
// Keep them.
describe('every preset survives formatUrlState → parseUrlState', () => {
  for (const exp of EXPERIENCES) {
    it(`"${exp.id}" is carried whole by the link format`, () => {
      const data = experienceUrlState(exp.state);
      applyView(data);
      const direct = snapshot();
      // Compared after applying rather than field by field on the parsed
      // object: the codec omits every value that equals its default, and
      // applyView() is what fills those back in. A field the codec cannot
      // carry comes back at its default here and the two views differ.
      applyView(roundTrip(data));
      expect(snapshot()).toEqual(direct);
    });
  }

  it('switches layers off before it switches any on', () => {
    // columbia-hydro clears the transmission network and brings generators up —
    // a story with both halves, so the seam between them is visible.
    applyPreset(presetOf('columbia-hydro'));
    const firstOn = visibilityCalls.findIndex(([, on]) => on);
    const lastOff = visibilityCalls.map(([, on]) => on).lastIndexOf(false);
    expect(firstOn).toBeGreaterThanOrEqual(0);
    expect(lastOff).toBeGreaterThanOrEqual(0);
    expect(lastOff).toBeLessThan(firstOn);
    expect(visibilityCalls).toContainEqual(['osm-transmission-lines', false]);
    expect(visibilityCalls).toContainEqual(['eia-generators', true]);
  });

  it('carries the fields a preset actually sets, not just the defaults', () => {
    applyPreset(presetOf('columbia-hydro'));
    expect(state.basemap).toBe('hydro');
    expect(state.terrain3d).toBe(true);
    expect(state.hillshade).toBe(true);
    expect([...state.legendFilters.fuel].sort()).toEqual(['hydro', 'pumped_storage']);
    expect(state.layerVisibility['osm-transmission-lines']).toBe(false);
    expect(state.layerVisibility['eia-generators']).toBe(true);

    applyPreset(presetOf('wecc-paths-and-plans'));
    expect(state.westtecColorBy).toBe('dataset');

    applyPreset(presetOf('wildfires-and-smoke'));
    expect(state.smokeOpacity).toBe(0.7);

    applyPreset(presetOf('live-temperature-grid-load'));
    expect(state.weatherVar).toBe('temp');

    applyPreset(presetOf('population-load-density'));
    expect(state.genMode['osm-datacenters']).toBe('clusters');
  });
});

// ─── 2. The transition — a story never inherits the one before it ─────────────

describe('applying one view after another', () => {
  // No catalogue entry sets all four at once (none sets ogfColorBy at all), so
  // the worst case is built here: two colour-by modes, a smoke opacity and a
  // legend filter, every one of them a value the codec omits at its default.
  const LEAKY: MapExperience['state'] = {
    layersOn: ['ogf-planned-transmission', 'westtec-10yr', 'wildfire-smoke', 'eia-generators'],
    basemap: 'dark',
    legendFilters: { fuel: ['coal'] },
    ogfColorBy: 'planauth',
    westtecColorBy: 'dataset',
    smokeOpacity: 0.4,
    terrain3d: true,
  };
  // Layers and a basemap only — it speaks for none of the four fields above.
  const PLAIN = 'interconnections-dc-seams';

  it('a view that sets none of them comes out clean after one that sets all', () => {
    applyPreset(presetOf(PLAIN));
    const clean = snapshot();
    // Guards against a vacuous pass: the clean view really is at the defaults.
    expect(clean.ogfColorBy).toBe('status');
    expect(clean.westtecColorBy).toBe('scenario');
    expect(clean.smokeOpacity).toBe(1);
    expect(clean.terrain3d).toBe(false);

    applyPreset(LEAKY);
    expect(state.ogfColorBy).toBe('planauth');
    expect(state.westtecColorBy).toBe('dataset');
    expect(state.smokeOpacity).toBe(0.4);
    expect([...state.legendFilters.fuel]).toEqual(['coal']);

    applyPreset(presetOf(PLAIN));
    expect(snapshot()).toEqual(clean);
  });

  it('every story in the catalogue leaves the next one clean', () => {
    applyPreset(presetOf(PLAIN));
    const clean = snapshot();
    for (const exp of EXPERIENCES) {
      applyPreset(exp.state);
      applyPreset(presetOf(PLAIN));
      expect(snapshot(), `"${exp.id}" leaked into the next story`).toEqual(clean);
    }
  });
});

// ─── 3. Smoke opacity is storable in the `so` param's integer percent ─────────

describe('smokeOpacity', () => {
  it('every catalogue value fits the integer-percent param', () => {
    for (const exp of EXPERIENCES) {
      const so = exp.state.smokeOpacity;
      if (so === undefined) continue;
      expect(Math.round(so * 100) / 100, `"${exp.id}" smokeOpacity ${so}`).toBe(so);
      const data = experienceUrlState(exp.state);
      expect(roundTrip(data).smokeOpacity ?? 1, `"${exp.id}" smokeOpacity`).toBe(so);
    }
  });
});

// ─── 4. applyExperience — the dirty-flag ordering around the apply ────────────

describe('applyExperience', () => {
  it('produces the same state as applying the preset through the codec', () => {
    const exp = EXPERIENCES.find(e => e.id === 'columbia-hydro')!;
    applyPreset(exp.state);
    const direct = snapshot();
    applyExperience(exp.id, 'jump');
    expect(snapshot()).toEqual(direct);
    expect(state.experienceId).toBe(exp.id);
  });

  it('holds the story id back until the whole view has landed', () => {
    applyExperience('columbia-hydro');
    // Every write raised while the view is being built sees no active story, so
    // none of them can be read as the reader editing their way out of one. The
    // id goes on only for the final write, which records the fresh snapshot.
    expect(writeUrlStateCalls.length).toBeGreaterThan(0);
    expect(writeUrlStateCalls.slice(0, -1).every(id => id === null)).toBe(true);
    expect(writeUrlStateCalls.at(-1)).toBe('columbia-hydro');
    expect(state.experienceDirty).toBe(false);
    expect(state.experiencePristine).toBeNull();
  });

  it('flies by default and jumps for a cold deep link', () => {
    const map = state.map as unknown as { flyTo: ReturnType<typeof vi.fn>; jumpTo: ReturnType<typeof vi.fn> };
    applyExperience('pacific-hvdc-intertie');
    expect(map.flyTo).toHaveBeenCalledTimes(1);
    applyExperience('pacific-hvdc-intertie', 'jump');
    expect(map.jumpTo).toHaveBeenCalledTimes(1);
  });

  it('keeps an aerial story under the imagery ceiling', () => {
    const aerial = EXPERIENCES.find(e => e.state.basemap === 'aerial');
    if (!aerial) return;
    const map = state.map as unknown as { jumpTo: ReturnType<typeof vi.fn> };
    applyExperience(aerial.id, 'jump');
    expect(map.jumpTo.mock.calls[0][0].zoom).toBeLessThanOrEqual(15.5);
  });

  it('drops a retired slug instead of leaving it on the link', () => {
    state.experienceId = 'retired-story';
    expect(applyExperience('retired-story')).toBeNull();
    expect(state.experienceId).toBeNull();
  });
});
