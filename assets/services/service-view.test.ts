// @vitest-environment jsdom
// Linked services as view state, on a recording fake map built by the real
// layer builders: Reset clears them with every other section (an empty link),
// a cold-boot seed equals a live apply, the setters refuse past the caps
// and commit one undoable url:write, and an unvetted URL never fetches without
// the visitor's approval — not on a cold boot from a link (seedView +
// paintLinkedView, whose own write keeps the pending entry in the hash), not
// on opening a view file, and not after Load → Skip → Undo in a fresh session.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';

vi.mock('../basemap.js', async () => {
  const { state } = await import('../state.js');
  return {
    switchBasemap: vi.fn((b: string) => { state.basemap = b; }),
    switchProjection: vi.fn((p: string) => { state.projection = p; }),
    setBasemapLabels: vi.fn(),
  };
});
vi.mock('../terrain.js', async () => {
  const { state } = await import('../state.js');
  return {
    setTerrain3d: vi.fn((on: boolean) => { state.terrain3d = on; }),
    setBuildings3d: vi.fn((on: boolean) => { state.buildings3d = on; }),
    setHillshade: vi.fn((on: boolean) => { state.hillshade = on; }),
  };
});

import { state } from '../state.js';
import { addAllLayers } from '../layers/add-all-layers.js';
import { emit } from '../state-bus.js';
import {
  seedView, applyView, currentView, setServices, addService, skipService, pendingServices, approveAndLoad,
} from '../view-state.js';
import { formatUrlState, parseUrlState, splitHash, defaultView, formatCameraSegment } from '../url-state-codec.js';
import { readUrlState, paintLinkedView, writeUrlState } from '../url-state.js';
import { undo } from '../undo.js';
import { buildViewFile, openViewFile } from '../user-data/view-file.js';
import { endExperienceLink } from '../experience-link.js';
import { renderServices } from './service-render.js';
import { isAllowed, isApproved, approve, reloadApproved, MAX_APPROVED } from './service-trust.js';
import type { LinkedService } from './service-spec.js';

type Spec = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown };

const VETTED: LinkedService = {
  id: 'tw1', kind: 'arcgis-feature', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer',
  host: 'tigerweb.geo.census.gov', layer: '0', title: 'States', credit: 'US Census Bureau',
  style: { kind: 'fill', color: '#336699', opacity: 0.5 }, visible: true,
};
const UNVETTED: LinkedService = {
  id: 'px1', kind: 'geojson', url: 'https://unvetted.example.org/data/parcels.geojson', host: 'unvetted.example.org',
  title: 'Parcels', credit: 'unvetted.example.org', style: { kind: 'circle', color: '#ff0000', opacity: 1 }, visible: true,
};

// As in undo.test.ts, plus every addSource spec kept for the zero-fetch checks.
let sourceSpecs: unknown[] = [];
let sourceIds: string[] = [];
function recordingMap() {
  const layers = new Map<string, Spec>();
  const sources = new Set<string>();
  const handlers: Record<string, ((e: object) => void)[]> = {};
  const known: Record<string, unknown> = {
    on: (t: string, h: (e: object) => void) => { (handlers[t] ??= []).push(h); },
    off: (t: string, h: (e: object) => void) => { handlers[t] = (handlers[t] ?? []).filter(f => f !== h); },
    addLayer: (spec: Spec) => { layers.set(spec.id, structuredClone(spec)); },
    removeLayer: (id: string) => { layers.delete(id); },
    addSource: (id: string, spec: unknown) => { sources.add(id); sourceIds.push(id); sourceSpecs.push(spec); },
    removeSource: (id: string) => { sources.delete(id); },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => (sources.has(id) ? {
      setUrl: () => [...(handlers.sourcedata ?? [])].forEach(h => h({ type: 'sourcedata', sourceId: id, sourceDataType: 'metadata' })),
      setData: vi.fn(),
    } : undefined),
    getZoom: () => 5,
    getCenter: () => ({ lat: 39.5, lng: -98.35 }),
    getBearing: () => 0,
    getPitch: () => 0,
    getBounds: () => ({ getWest: () => -110, getSouth: () => 30, getEast: () => -90, getNorth: () => 45, toArray: () => [[-110, 30], [-90, 45]] }),
    getContainer: () => document.createElement('div'),
    getStyle: () => ({ layers: [...layers.values()] }),
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

const fetchSpy = vi.fn((_input: unknown) => Promise.reject(new Error('no network in tests')));
/** Nothing reached for the unvetted host: no fetch, no map source naming it. */
function expectUntouched() {
  expect(fetchSpy.mock.calls.filter(c => String(c[0]).includes(UNVETTED.host))).toEqual([]);
  expect(sourceSpecs.filter(s => JSON.stringify(s).includes(UNVETTED.host))).toEqual([]);
}
const linkWith = (services: LinkedService[]) =>
  '#5/40/-100?' + formatUrlState({ ...defaultView(), services }).join('&');

function freshSession() {
  sessionStorage.clear();
  reloadApproved();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('alert', vi.fn());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fetchSpy.mockClear();
  sourceSpecs = [];
  sourceIds = [];
  freshSession();
  state.map = null;
  state.mapReady = false;
  state.layerVisibility = {};
  state.legendFilters = {};
  state.layerFilters = {};
  state.genMode = {};
  seedView({});
  endExperienceLink();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A cold boot: the hash is read before the map exists, then map.ts's load
// handler paints the view and writes the link once.
function coldBoot(hash: string) {
  history.replaceState(null, '', hash);
  readUrlState();
  recordingMap();
  paintLinkedView();
  writeUrlState();
  emit('map:ready');
  vi.advanceTimersByTime(500);
}
const linkedServices = () => parseUrlState(splitHash(location.hash).params).services ?? [];

describe('the approved set', () => {
  it('is per URL, normalised, mirrored to sessionStorage and capped', () => {
    expect(isApproved(UNVETTED.url)).toBe(false);
    approve(UNVETTED.url + '?where=1%3D1#x');
    expect(isApproved(UNVETTED.url)).toBe(true);
    expect(isApproved('https://unvetted.example.org/data/other.geojson')).toBe(false);
    reloadApproved();                                   // a reload in the same tab
    expect(isApproved(UNVETTED.url)).toBe(true);
    for (let i = 0; i < MAX_APPROVED; i++) approve(`https://a${i}.example.org/x.geojson`);
    expect(isApproved(UNVETTED.url)).toBe(false);       // the oldest fell out
    expect(JSON.parse(sessionStorage.getItem('tm-svc-approved')!)).toHaveLength(MAX_APPROVED);
  });

  it('re-validates storage on read', () => {
    sessionStorage.setItem('tm-svc-approved', JSON.stringify([UNVETTED.url, 'http://evil.example/x.geojson', 7]));
    reloadApproved();
    expect(isApproved(UNVETTED.url)).toBe(true);
    expect(isApproved('http://evil.example/x.geojson')).toBe(false);
    sessionStorage.setItem('tm-svc-approved', JSON.stringify(Array(MAX_APPROVED + 1).fill(UNVETTED.url)));
    reloadApproved();
    expect(isApproved(UNVETTED.url)).toBe(false);
    sessionStorage.setItem('tm-svc-approved', '{not json');
    reloadApproved();
    expect(isApproved(UNVETTED.url)).toBe(false);
  });

  it('allows a vetted service without approval', () => {
    expect(isAllowed(VETTED)).toBe(true);
    expect(isAllowed(UNVETTED)).toBe(false);
    approve(UNVETTED.url);
    expect(isAllowed(UNVETTED)).toBe(true);
  });
});

describe('services in the view', () => {
  it('a cold-boot seed leaves the state a live apply does', () => {
    seedView({ services: [VETTED, UNVETTED] });
    const seeded = structuredClone(currentView());
    expect(seeded.services).toEqual([VETTED, UNVETTED]);
    seedView({});
    recordingMap();
    applyView({ services: [VETTED, UNVETTED] });
    expect(currentView()).toEqual(seeded);
  });

  it('Reset after a view with every section leaves an empty link', () => {
    recordingMap();
    applyView({
      where: { 'osm-substations-points': [{ field: 'nominal_kv', op: '>=', value: 345 }] },
      style: { railroads: { opacity: 0.5 } },
      area: { kind: 'states', codes: ['TX'] },
      sel: { mode: 'isolate', ids: { 'eia-generators': ['1:1'] } },
      services: [VETTED, UNVETTED],
    });
    expect(formatUrlState(currentView()).join('&')).toMatch(/^af=s\.TX&vx=/);
    applyView({});
    expect(state.services).toEqual([]);
    expect(formatUrlState(currentView())).toEqual([]);
  });

  it('the setters refuse past the caps and leave state alone', () => {
    recordingMap();
    const six = Array.from({ length: 6 }, (_, i) => ({ ...UNVETTED, id: 'u' + i }));
    expect(setServices(six)).toContain('at most 5');
    expect(setServices([...six.slice(0, 5)])).toBeNull();
    expect(addService({ ...UNVETTED, id: 'u9' })).toContain('at most 5');
    expect(state.services).toHaveLength(5);
    expect(isApproved(UNVETTED.url)).toBe(false);       // a refused add approves nothing
    expect(setServices([])).toBeNull();
    const long = { ...UNVETTED, title: 'x'.repeat(200), credit: 'y'.repeat(300) };
    expect(setServices([long, { ...long, id: 'b' }, { ...long, id: 'c' }, { ...long, id: 'd' }, { ...long, id: 'e' }]))
      .toContain('bytes in a link');
    expect(setServices([{ ...UNVETTED, url: 'http://unvetted.example.org/a.geojson' }])).not.toBeNull();
    expect(state.services).toEqual([]);
  });

  it('an add is one undo step and approves its URL; Skip then Undo brings the entry back', () => {
    coldBoot('#5/40/-100');
    expect(addService(VETTED)).toBeNull();
    vi.advanceTimersByTime(500);
    expect(addService(UNVETTED)).toBeNull();
    vi.advanceTimersByTime(500);
    expect(isApproved(UNVETTED.url)).toBe(true);
    expect(linkedServices().map(s => s.id)).toEqual(['tw1', 'px1']);
    expect(skipService('px1')).toBe(true);
    vi.advanceTimersByTime(500);
    expect(skipService('px1')).toBe(false);
    expect(state.services).toEqual([VETTED]);
    expect(undo()).toBe(true);
    expect(state.services).toEqual([VETTED, UNVETTED]);
    expect(undo()).toBe(true);
    expect(state.services).toEqual([VETTED]);
  });
});

describe('an unvetted service never fetches before the visitor approves it', () => {
  it('(a) a cold boot from a link: pending, unfetched, and still in the hash after the boot write', () => {
    coldBoot(linkWith([UNVETTED, VETTED]));
    expect(state.services).toEqual([UNVETTED, VETTED]);
    expect(pendingServices()).toEqual([UNVETTED]);
    expectUntouched();
    expect(linkedServices()).toEqual([UNVETTED, VETTED]);
  });

  it('(b) opening a view file: pending and unfetched', () => {
    recordingMap();
    const hash = formatCameraSegment({ center: [-100, 40], zoom: 5, bearing: 0, pitch: 0 }) + '?' + formatUrlState({ ...defaultView(), services: [UNVETTED] }).join('&');
    expect(openViewFile(JSON.parse(buildViewFile('T', hash)), 'a.tmview.json')).toBe(true);
    expect(state.services).toEqual([UNVETTED]);
    expect(pendingServices()).toEqual([UNVETTED]);
    expectUntouched();
  });

  it('(c) Load, Skip, Undo: the entry comes back, and in a fresh session it is pending and unfetched', () => {
    coldBoot(linkWith([UNVETTED]));
    expect(pendingServices()).toEqual([UNVETTED]);
    approveAndLoad(UNVETTED.url);
    expect(pendingServices()).toEqual([]);
    expect(skipService(UNVETTED.id)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(state.services).toEqual([]);
    expect(undo()).toBe(true);
    expect(state.services).toEqual([UNVETTED]);

    freshSession();
    fetchSpy.mockClear();
    sourceSpecs = [];
    expect(pendingServices()).toEqual([UNVETTED]);
    renderServices();
    applyView(parseUrlState(splitHash(location.hash).params));
    expect(state.services).toEqual([UNVETTED]);
    expectUntouched();
  });

  it('a vetted service is never pending and draws on a cold boot', () => {
    coldBoot(linkWith([VETTED, UNVETTED]));
    expect(pendingServices()).toEqual([UNVETTED]);
    expect(sourceIds).toContain('svc-tw1');
    expect(sourceIds).not.toContain('svc-px1');
    expectUntouched();
  });

  it('Load draws the approved service', () => {
    coldBoot(linkWith([UNVETTED]));
    expect(sourceIds).not.toContain('svc-px1');
    approveAndLoad(UNVETTED.url);
    expect(sourceIds).toContain('svc-px1');
  });
});
