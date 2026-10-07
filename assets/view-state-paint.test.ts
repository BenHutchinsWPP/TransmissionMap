// @vitest-environment jsdom
// A view's `where` and `style` on a recording fake map built by the real layer
// builders: a story carrying both leaves nothing behind for the next view or
// Reset (F3), a cold boot from a `vx` link paints both (F10), a cold boot shows
// one notice for decode and apply drops together, and a story with both
// sections stays pristine across writes (F11), and a cold-boot seed leaves the
// same state a live apply of the same view does.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';

vi.mock('./basemap.js', async () => {
  const { state } = await import('./state.js');
  return {
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

import { state } from './state.js';
import { endExperienceLink, activeExperienceId, experienceIsDirty } from './experience-link.js';
import { addAllLayers } from './layers/add-all-layers.js';
import { whereOwnership } from './filters.js';
import { LAYERS } from '../src/registry/index.js';
import { EXPERIENCES, type MapExperience } from '../src/registry/experiences.js';
import { experienceUrlState, applyExperience } from './experiences.js';
import { applyView, seedView, currentView } from './view-state.js';
import { emit } from './state-bus.js';
import { formatUrlState, defaultView } from './url-state-codec.js';
import { readUrlState, paintLinkedView, writeUrlState } from './url-state.js';
import { getDiagLog, clearDiagLog } from './diag-log.js';
import { NRI_HAZARDS, WEATHER_VARIABLES } from '../src/registry/conditions.js';

type Spec = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown };

function recordingMap() {
  const layers = new Map<string, Spec>();
  const sources = new Set<string>();
  const known: Record<string, unknown> = {
    addLayer: (spec: Spec) => { layers.set(spec.id, structuredClone(spec)); },
    addSource: (id: string) => { sources.add(id); },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => (sources.has(id) ? {} : undefined),
    getZoom: () => 5,
    getCenter: () => ({ lat: 39.5, lng: -98.35 }),
    getBearing: () => 0,
    getPitch: () => 0,
    getContainer: () => document.createElement('div'),
    getPaintProperty: (id: string, p: string) => layers.get(id)?.paint?.[p],
    getLayoutProperty: (id: string, p: string) => layers.get(id)?.layout?.[p],
    setPaintProperty: (id: string, p: string, v: unknown) => {
      const l = layers.get(id)!;
      l.paint = { ...l.paint, [p]: v };
      if (v === undefined) delete l.paint[p];
    },
    setLayoutProperty: (id: string, p: string, v: unknown) => {
      const l = layers.get(id)!;
      l.layout = { ...l.layout, [p]: v };
      if (v === undefined) delete l.layout[p];
    },
    setFilter: (id: string, f: unknown) => {
      const l = layers.get(id)!;
      l.filter = f ?? undefined;
      if (f == null) delete l.filter;
    },
  };
  const map = new Proxy(known, { get: (t, k: string) => t[k] ?? vi.fn() });
  state.map = map as unknown as typeof state.map;
  state.mapReady = true;
  addAllLayers();
  return layers;
}

// The where-owned filters and every style property a view section can touch,
// minus visibility (the presets switch layers, which is not under test here).
const WHERE_ML = Object.keys(whereOwnership(LAYERS));
function painted(layers: Map<string, Spec>) {
  return structuredClone([...layers.values()].map(l => {
    const layout: Record<string, unknown> = { ...l.layout };
    delete layout.visibility;
    return { id: l.id, paint: l.paint ?? {}, layout, filter: l.filter ?? null };
  }));
}

const KV345 = { field: 'nominal_kv', op: '>=' as const, value: 345 };
const WIND = { field: 'energy_source', op: 'in' as const, value: ['WND', 'SUN'] };
const WHERE = { 'osm-substations-points': [KV345], 'eia-generators': [WIND] };
const STYLE = {
  railroads: { opacity: 0.5, size: 2, color: '#ff0000' },
  'osm-transmission-lines': { size: 1.5 },
  'osm-generators': { opacity: 0.4 },
};
const LEAKY: MapExperience['state'] = {
  layersOn: ['railroads', 'osm-substations-points', 'eia-generators'],
  basemap: 'dark',
  where: WHERE,
  style: STYLE,
};
const PLAIN = EXPERIENCES.find(e => e.id === 'interconnections-dc-seams')!.state;

beforeEach(() => {
  // Cold boot: seedView() runs before initMap() builds the map.
  state.map = null;
  state.mapReady = false;
  state.layerVisibility = {};
  state.legendFilters = {};
  state.layerFilters = {};
  state.genMode = {};
  seedView({});
  endExperienceLink();
  clearDiagLog();
  document.body.innerHTML = '';
});

describe('seedView', () => {
  it('leaves state equal to what applyView sets for the same data', () => {
    const data = {
      ...experienceUrlState(LEAKY),
      basemap: 'dark', projection: 'globe',
      terrain3d: true, buildings3d: true, hillshade: true,
      weatherVar: WEATHER_VARIABLES[1].id, nriHazard: NRI_HAZARDS[1].id,
    };
    seedView(data);
    const seeded = structuredClone(currentView());
    expect(seeded).toMatchObject({
      basemap: 'dark', projection: 'globe', terrain3d: true, buildings3d: true, hillshade: true,
      weatherVar: WEATHER_VARIABLES[1].id, nriHazard: NRI_HAZARDS[1].id,
    });

    seedView({});
    recordingMap();
    applyView(data);
    expect(currentView()).toEqual(seeded);
  });
});

// repaintView() leaves `where` to filter:all, which it emits first.
describe('filter:all', () => {
  it('re-filters every where-owned map layer', () => {
    const layers = recordingMap();
    const hit = new Set<string>();
    const map = state.map as unknown as { setFilter: (id: string, f: unknown) => void };
    const setFilter = map.setFilter;
    map.setFilter = (id, f) => { hit.add(id); setFilter(id, f); };
    try { emit('filter:all'); } finally { map.setFilter = setFilter; }
    expect(WHERE_ML.filter(id => layers.has(id) && !hit.has(id))).toEqual([]);
  });
});

describe('a view with where and style, then a plain one', () => {
  it('leaves every where-owned filter and overridden property at its baseline', () => {
    const layers = recordingMap();
    applyView(experienceUrlState(PLAIN));
    const clean = painted(layers);

    applyView(experienceUrlState(LEAKY));
    expect(layers.get('osm-substations-points-hv')!.filter).toEqual(expect.arrayContaining([['>=', ['to-number', ['get', 'nominal_kv']], 345]]));
    expect(layers.get('railroads')!.paint!['line-color']).toBe('#ff0000');
    expect(painted(layers)).not.toEqual(clean);
    expect(getDiagLog()).toEqual([]);

    applyView(experienceUrlState(PLAIN));
    expect(painted(layers)).toEqual(clean);
    expect(WHERE_ML.length).toBeGreaterThan(10);
  });

  it('Reset (applyView({})) leaves zero conditions and zero overrides on the map', () => {
    const layers = recordingMap();
    applyView({});
    const clean = painted(layers);
    applyView(experienceUrlState(LEAKY));
    expect(layers.get('railroads')!.paint!['line-color']).toBe('#ff0000');
    applyView({});
    expect(state.where).toEqual({});
    expect(state.styleOverrides).toEqual({});
    expect(painted(layers)).toEqual(clean);
  });

  it('every curated story paints without a key the map cannot take', () => {
    recordingMap();
    for (const e of EXPERIENCES) {
      applyView(experienceUrlState(e.state));
      expect(getDiagLog(), e.id).toEqual([]);
    }
  });

  it('records a story key the map cannot take, without a notice', () => {
    recordingMap();
    applyView(experienceUrlState({ style: { 'osm-generators': { color: '#00ff00' } } }));
    expect(getDiagLog().map(e => e.detail)).toEqual([expect.stringContaining('osm-generators.color')]);
    expect(document.querySelector('[role=status]')).toBeNull();
  });
});

describe('cold boot from a vx link', () => {
  it('removes a style key the map cannot take from state and from the link', () => {
    history.replaceState(null, '', '#5/40/-100?' + formatUrlState({ ...defaultView(), style: { 'osm-generators': { color: '#00ff00' }, railroads: { opacity: 0.5 } } }).join('&'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    readUrlState();
    recordingMap();
    paintLinkedView();
    expect(state.styleOverrides).toEqual({ railroads: { opacity: 0.5 } });
    expect(JSON.stringify(formatUrlState(currentView()))).not.toContain('osm-generators');
    expect(getDiagLog().map(e => e.detail)).toEqual([expect.stringContaining('osm-generators.color')]);
    expect(document.querySelectorAll('[role=status]')).toHaveLength(1);
  });

  it('shows no notice for an exp link, whose story repaints the view', () => {
    history.replaceState(null, '', '#5/40/-100?' + formatUrlState({ ...defaultView(), style: { 'osm-generators': { color: '#00ff00' } }, experienceId: 'interconnections-dc-seams' }).join('&'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    readUrlState();
    recordingMap();
    paintLinkedView();
    expect(document.querySelector('[role=status]')).toBeNull();
    applyExperience('interconnections-dc-seams', 'jump');
    expect(activeExperienceId()).toBe('interconnections-dc-seams');
    expect(state.styleOverrides).toEqual({});
  });

  it('paints where and style at load', () => {
    history.replaceState(null, '', '#5/40/-100?' + formatUrlState({ ...defaultView(), where: WHERE, style: STYLE }).join('&'));
    readUrlState();
    const layers = recordingMap();
    const before = painted(layers);
    // map.ts's load handler, after addAllLayers().
    paintLinkedView();
    const after = painted(layers);
    const changed = after.filter((l, i) => JSON.stringify(l) !== JSON.stringify(before[i])).map(l => l.id);
    expect(changed).toContain('osm-substations-points-hv');
    expect(changed).toContain('railroads');
    expect(changed.some(id => id.startsWith('osm-transmission-lines'))).toBe(true);
    expect(layers.get('osm-substations-points-hv')!.filter).toEqual(expect.arrayContaining([['>=', ['to-number', ['get', 'nominal_kv']], 345]]));
    expect(document.querySelector('[role=status]')).toBeNull();
  });

  it('shows one notice counting decode drops and apply drops together', () => {
    const vx = formatUrlState({
      ...defaultView(),
      where: { 'not-a-layer': [KV345] },                        // dropped by the codec
      style: { 'osm-generators': { color: '#00ff00' }, railroads: { opacity: 0.5 } }, // colour dropped by the map
    }).find(p => p.startsWith('vx='))!;
    history.replaceState(null, '', '#5/40/-100?' + vx);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    readUrlState();
    expect(document.querySelector('[role=status]')).toBeNull();
    recordingMap();
    paintLinkedView();
    const notes = document.querySelectorAll('[role=status]');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain('(2)');
  });
});

describe('§ 1 for where and style', () => {
  it('a story carrying both stays pristine across writes, and an edit makes it dirty', () => {
    recordingMap();
    const exp: MapExperience = { ...EXPERIENCES[0], id: 'test-where-style', state: LEAKY };
    EXPERIENCES.push(exp);
    try {
      applyExperience(exp.id, 'jump');
      writeUrlState();
      writeUrlState();
      expect(experienceIsDirty()).toBe(false);
      expect(location.hash).toMatch(/vx=[jz][\w-]+&exp=test-where-style$/);
      state.styleOverrides = { railroads: { opacity: 0.9 } };
      writeUrlState();
      expect(experienceIsDirty()).toBe(true);
    } finally {
      EXPERIENCES.pop();
    }
  });
});
