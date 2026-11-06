// @vitest-environment jsdom
// Tests for popup.ts's route-pick guard: while state.routePick is set the map
// tap handler opens (or closes) no popup, so a pick tap only places the end;
// and for the buttons a tiled feature's popup gets from the geometry files
// (Copy only once the files answer, length for lines, Line tools for transmission),
// a point layer's Copy, and edit mode's one-time probe of the files.
// Deps: popup.js, map-input.js (mocked), maplibre-gl (mocked Popup), state.js,
// lines/line-read.js (mocked).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const input = vi.hoisted(() => ({ tap: null as null | ((e: unknown) => void) }));
vi.mock('./map-input.js', () => ({
  onMapTap: (f: (e: unknown) => void) => { input.tap = f; return () => {}; },
  onMapHover: () => () => {},
  onMapPointLeave: () => () => {},
  tapBox: () => [[0, 0], [1, 1]],
}));
vi.mock('maplibre-gl', () => ({ default: { Popup: class {} }, Popup: class {} }));
const files = vi.hoisted(() => ({ index: false, geometry: 'line' as 'line' | 'polygon', probes: 0, gate: null as null | Promise<void> }));
vi.mock('./lines/line-read.js', () => ({
  lookup: async () => (files.index ? { ok: true, result: { row: 0, length_km: 2, chain: -1, circuits: 1, geometry: files.geometry } }
    : { ok: false, reason: 'unavailable' }),
  lineDataset: async () => { files.probes++; await files.gate; return files.index ? { ok: true, result: {} } : { ok: false, reason: 'unavailable' }; },
}));

const copied = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./lines/line-copy.js', () => ({
  copyLines: async (...a: unknown[]) => { copied.calls.push(a); return { kind: 'refused', reason: 'not-found' }; },
}));

const rowCopies = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./user-data/copy-rows.js', () => ({
  copyRows: async (...a: unknown[]) => { rowCopies.calls.push(a); return { kind: 'copied', n: 1, simplified: 0 }; },
}));

import { initPopups, setRouteTapClaims, resetAnalysisProbe } from './popup.js';
import { state } from './state.js';
import { layerById } from '../src/registry/index.js';
import { copyMode } from './user-data/copy-mode.js';
import { layerSourceId } from './layers/layer-source.js';

describe('popup tap handler', () => {
  const query = vi.fn(() => [] as unknown[]);
  const remove = vi.fn();

  beforeEach(() => {
    query.mockClear();
    remove.mockClear();
    state.routePick = false;
    setRouteTapClaims(null);
    state.measure.active = false;
    state.editMode = 'view';
    state.userLayers = [{ id: 'u1' }] as unknown as typeof state.userLayers;
    state.map = {
      getLayer: () => ({}),
      getSource: () => undefined,
      isMoving: () => false,
      setFilter: () => {},
      setLayoutProperty: () => {},
      setPaintProperty: () => {},
      getLayoutProperty: () => 'visible',
      queryRenderedFeatures: query,
      on: () => {},
      getCanvas: () => document.createElement('canvas'),
    } as unknown as typeof state.map;
    initPopups();
    state.popup = { remove } as unknown as typeof state.popup;
  });

  const tap = () => input.tap!({ point: { x: 5, y: 5 }, lngLat: { lng: 0, lat: 0 } });

  it('acts on a tap when not picking (empty hit closes the popup)', () => {
    tap();
    expect(query).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });

  it('does nothing on a tap the route pane claims (a hole in its similar-cost areas)', () => {
    setRouteTapClaims(() => true);
    tap();
    expect(query).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('does nothing while a route end is being picked', () => {
    state.routePick = true;
    tap();
    expect(query).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});


describe('tiled feature popups', () => {
  let content: HTMLElement;
  let featureLayer = 'osm-substations-polygons-fill';
  let geometry: unknown = { type: 'Polygon', coordinates: [] };
  const hit = (layer: string, geom: unknown, extra: Record<string, unknown> = {}) =>
    ({ id: 123, layer: { id: layer }, sourceLayer: 'x', properties: { name: 'N' }, geometry: geom, ...extra });
  const ids = () => [...content.querySelectorAll('.popup-copy-btn, .popup-line-tools-btn')].map(b => b.className.split(' ').pop());
  const settle = () => new Promise(r => setTimeout(r, 20));

  let clock = 1e9;
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 1000));   // every tap is past the double-tap window
    files.index = false; files.geometry = 'line'; files.probes = 0; files.gate = null; resetAnalysisProbe();
    state.routePick = false; state.measure.active = false; state.editMode = 'view';
    state.userLayers = [];
    content = document.createElement('div');
    content.className = 'maplibregl-popup-content';
    const el = document.createElement('div');
    el.append(content);
    state.map = {
      getLayer: (id: string) => (id === 'px-points' ? undefined : {}), getSource: () => ({ setData: () => {} }), isMoving: () => false,
      setFilter: () => {}, setLayoutProperty: () => {},
      setPaintProperty: () => {}, getLayoutProperty: () => 'visible', on: () => {}, getZoom: () => 6,
      queryRenderedFeatures: () => [hit(featureLayer, geometry)],
      getCanvas: () => document.createElement('canvas'),
    } as unknown as typeof state.map;
    initPopups();
    const popup = {
      setLngLat: () => popup, addTo: () => popup, remove: vi.fn(), getLngLat: () => ({ lng: 0, lat: 0 }),
      setHTML: (h: string) => { content.innerHTML = h; return popup; },
      getElement: () => el, isOpen: () => true,
    };
    state.popup = popup as unknown as typeof state.popup;
  });
  const tap = () => input.tap!({ point: { x: 5, y: 5 }, lngLat: { lng: 0, lat: 0 } });

  it('no index.json: a substation polygon popup has no Copy', async () => {
    tap(); await settle();
    expect(content.querySelector('.copy-popup-btn, .popup-copy-btn')).toBeNull();
    expect(content.textContent).toBeTruthy();
  });

  it('no index.json: a NERC region popup (GeoJSON, string id) has no Copy', async () => {
    expect(layerById('nerc-regions')!.data!.analysis).toBe('nerc_regions');
    featureLayer = 'nerc-fill'; geometry = { type: 'Polygon', coordinates: [] };
    state.map!.queryRenderedFeatures = (() => [hit('nerc-fill', geometry, { id: 'CA-MX US', sourceLayer: undefined, properties: { sub_nm: 'CA-MX US', region: 'WECC' } })]) as never;
    tap(); await settle();
    expect(content.textContent).toBeTruthy();
    expect(content.querySelector('.copy-popup-btn, .popup-copy-btn')).toBeNull();
  });

  it('with the files: region layers (GeoJSON and tiled) get Copy, and edit mode copies a GeoJSON region from the files by its string id', async () => {
    files.index = true; files.geometry = 'polygon';
    for (const [layer, mapLayer, id, sourceLayer] of [['nerc-regions', 'nerc-fill', 'CA-MX US', undefined],
      ['eia-ba', 'eiaba-fill', 'AESO', undefined], ['control-areas', 'ba-fill', '19547', undefined], ['retail-territories', 'retail-fill', '40429', 'retail_territories'],
      // a native tile id (not an OSM id) at the top of PAD-US's range, and a promoted integer property
      ['padus', 'padus-fill', 4503599627370495, 'padus'], ['crithab', 'crithab-fill', 11686, 'crithab'],
      // string ids that look numeric or zero-padded must reach the copy unchanged
      ['countries', 'countries-fill', '115', undefined], ['admin1', 'admin1-fill', '1110', undefined],
      ['us-states', 'us-states-fill', 'TX', undefined], ['tribal-lands', 'tribal-fill', '0010R', undefined],
      ['us-counties', 'us-counties-fill', '08123', undefined], ['us-zcta', 'us-zcta-fill', '00501', 'us_zcta'],
      ['bia-tribal-lands', 'bia-tribal-fill', 'LAR0001', undefined], ['boem-wind-leases', 'boem-wind-leases-fill', '0a1b2c3d4e5f', undefined]] as const) {
      const decl = layerById(layer)!.data!.id!;
      state.map!.queryRenderedFeatures = (() => [hit(mapLayer, { type: 'Polygon', coordinates: [] }, { id, sourceLayer, properties: decl.native ? { name: 'N' } : { [decl.field]: id, name: 'N' } })]) as never;
      resetAnalysisProbe(); state.editMode = 'view';
      tap();
      await vi.waitFor(() => expect(ids(), layer).toEqual(['popup-copy-btn']));
      copied.calls.length = 0; resetAnalysisProbe(); state.editMode = 'edit';
      tap();
      await vi.waitFor(() => expect(content.querySelector('.copy-popup-btn')).not.toBeNull());
      content.querySelector<HTMLButtonElement>('.copy-popup-btn')!.click();
      await vi.waitFor(() => expect(copied.calls.length).toBe(1));
      expect(copied.calls.map(c => [c[0], (c[1] as { fid: unknown }[])[0].fid]), layer).toEqual([[layer, id]]);
    }
  });

  describe('edit mode, no geometry files: a GeoJSON layer copies from the loaded source data', () => {
    const PIECE = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const FULL = { type: 'Polygon', coordinates: [[[0, 0], [9, 0], [9, 9], [0, 9], [0, 0]]] };
    // the one 'exact' layer that draws polygons (state fills) beside the 'full' NERC regions
    const cases = [['nerc-regions', 'nerc-fill'], ['control-areas', 'ba-fill'], ['dc-moratoriums', 'dcm-state-fill'], ['tribal-lands', 'tribal-fill'],
      ['bia-tribal-lands', 'bia-tribal-fill'], ['boem-wind-leases', 'boem-wind-leases-fill']];

    const clickOn = async (layer: string, mapLayer: string) => {
      const l = layerById(layer)!;
      const id = 'ID 1';
      const props = { [l.data!.id!.field]: id, name: 'N' };
      state.sourcesData[layerSourceId(layer)] = [
        { type: 'Feature', properties: { ...props, [l.data!.id!.field]: 'other' }, geometry: PIECE },
        { type: 'Feature', properties: props, geometry: FULL }];
      state.map!.queryRenderedFeatures = (() => [hit(mapLayer, PIECE, { id, sourceLayer: undefined, properties: props })]) as never;
      rowCopies.calls.length = 0; copied.calls.length = 0; state.editMode = 'edit';
      tap();
      await vi.waitFor(() => expect(content.querySelector('.copy-popup-btn')).not.toBeNull());
      return id;
    };

    it.each(cases)('%s: the source feature by its id, not the rendered piece', async (layer, mapLayer) => {
      expect(files.index).toBe(false);
      expect(copyMode(layer)).toBe(layer === 'dc-moratoriums' ? 'exact' : 'full');
      const id = await clickOn(layer, mapLayer);
      content.querySelector<HTMLButtonElement>('.copy-popup-btn')!.click();
      await vi.waitFor(() => expect(rowCopies.calls.length).toBe(1));
      const [layerId, rows, , , fromSource] = rowCopies.calls[0] as [string, { id: string; feature: GeoJSON.Feature }[], unknown, unknown, boolean];
      expect(layerId).toBe(layer);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].feature.geometry).toEqual(FULL);
      expect(fromSource).toBe(true);
      expect(copied.calls).toHaveLength(0);
    });

    it('no source data for the layer: nothing is copied and the can\'t-copy note shows', async () => {
      await clickOn('nerc-regions', 'nerc-fill');
      state.sourcesData[layerSourceId('nerc-regions')] = [];
      content.querySelector<HTMLButtonElement>('.copy-popup-btn')!.click();
      await vi.waitFor(() => expect(content.querySelector('.copy-popup-note')).not.toBeNull());
      expect(rowCopies.calls).toHaveLength(0);
      expect(copied.calls).toHaveLength(0);
    });
  });

  it('with the files: a polygon gets Copy, no length row and no Line tools', async () => {
    files.index = true; files.geometry = 'polygon';
    tap(); await settle();
    expect(ids()).toEqual(['popup-copy-btn']);
    expect(content.querySelector<HTMLElement>('.popup-line-length')?.hidden ?? true).toBe(true);
  });

  it('a transmission line gets its length, Copy and Line tools', async () => {
    files.index = true;
    featureLayer = 'osm-transmission-lines-hv'; geometry = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
    tap(); await settle();
    expect(ids()).toEqual(expect.arrayContaining(['popup-copy-btn', 'popup-line-tools-btn']));
    expect(content.querySelector<HTMLElement>('.popup-line-length')?.hidden).toBe(false);
  });

  it('a pipeline popup has its length and Copy but no Line tools', async () => {
    files.index = true;
    for (const [layer, mapLayer] of [['osm-pipelines-lines', 'osm-pipelines-lines'], ['hifld-natgas-lines', 'hifld-natgas-interstate']]) {
      expect(layerById(layer)!.data!.analysis, layer).toBeTruthy();
      featureLayer = mapLayer; geometry = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
      tap(); await settle();
      expect(ids(), layer).toEqual(['popup-copy-btn']);
      expect(content.querySelector<HTMLElement>('.popup-line-length')?.hidden, layer).toBe(false);
    }
  });

  it('a railroad popup has its length and Copy but no Line tools', async () => {
    files.index = true;
    expect(layerById('railroads')!.data!.analysis).toBe('railroads');
    featureLayer = 'railroads'; geometry = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
    tap(); await settle();
    expect(ids()).toEqual(['popup-copy-btn']);
    expect(content.querySelector<HTMLElement>('.popup-line-length')?.hidden).toBe(false);
  });

  it('a WECC path marker has no Line tools or length; edit mode offers the exact Copy', async () => {
    expect(layerById('wecc-paths')!.data!.analysis).toBeUndefined();
    expect(copyMode('wecc-paths')).toBe('exact');
    files.index = true;
    featureLayer = 'wecc-paths-circles'; geometry = { type: 'Point', coordinates: [0, 0] };
    state.map!.queryRenderedFeatures = (() => [hit(featureLayer, geometry, { id: undefined, sourceLayer: undefined,
      properties: { id: '66', number: 66, name: '66: California-Oregon Intertie (COI)', isCorridor: false } })]) as never;
    tap(); await settle();
    expect(ids()).toEqual([]);
    expect(content.querySelector('.popup-line-length')).toBeNull();
    state.editMode = 'edit'; resetAnalysisProbe();
    tap();
    await vi.waitFor(() => expect(content.querySelector('.copy-popup-btn')).not.toBeNull());
    expect(content.querySelector('.popup-line-tools-btn')).toBeNull();
  });

  it('a substation point gets Copy at once, files or not', () => {
    featureLayer = 'osm-substations-points-hv'; geometry = { type: 'Point', coordinates: [0, 0] };
    tap();
    expect(ids()).toEqual(['popup-copy-btn']);
  });

  it('edit mode with the files: the first click waits for the probe and opens the copy popup, not the note', async () => {
    files.index = true;
    state.editMode = 'edit';
    featureLayer = 'osm-substations-polygons-fill'; geometry = { type: 'Polygon', coordinates: [] };
    tap(); await settle();
    expect(content.querySelector('.copy-popup-btn')).not.toBeNull();
    expect(content.querySelector('.copy-popup-note')).toBeNull();
  });

  it('a probe that answers late drops its click when edit mode was left or another click came', async () => {
    files.index = true;
    let release!: () => void;
    files.gate = new Promise<void>(r => { release = r; });
    state.editMode = 'edit';
    featureLayer = 'osm-substations-polygons-fill'; geometry = { type: 'Polygon', coordinates: [] };
    tap();
    state.editMode = 'view';
    release(); await settle();
    expect(content.innerHTML).toBe('');
    resetAnalysisProbe();
    state.editMode = 'edit';
    let release2!: () => void;
    files.gate = new Promise<void>(r => { release2 = r; });
    tap();
    state.map!.queryRenderedFeatures = (() => []) as never;
    tap();   // a later click: it resolves its own, the first answer is stale
    release2(); await settle();
    expect(content.querySelector('.copy-popup-btn')).toBeNull();
  });

  it('the click resolves the features captured at click time, not what sits under the pixels when the probe answers', async () => {
    files.index = true;
    let release!: () => void;
    files.gate = new Promise<void>(r => { release = r; });
    state.editMode = 'edit';
    featureLayer = 'osm-substations-polygons-fill'; geometry = { type: 'Polygon', coordinates: [] };
    tap();
    state.map!.queryRenderedFeatures = (() => []) as never;   // the map moved on
    release(); await settle();
    expect(content.querySelector('.copy-popup-btn')).not.toBeNull();
  });

  it('a click on a feature with no geometry files does not wait for the probe', () => {
    state.editMode = 'edit';
    state.map!.queryRenderedFeatures = (() => [hit('hifld-substations-hv', { type: 'Point', coordinates: [0, 0] }, { sourceLayer: undefined })]) as never;
    tap();
    expect(files.probes).toBe(0);
    expect(content.querySelector('.copy-popup-btn')).not.toBeNull();
  });

  it('a probe that answers late drops its click when a shape is being drawn or a tool took over', async () => {
    for (const take of [() => { state.draw = { getMode: () => 'draw_polygon' } as never; }, () => { state.measure.active = true; }]) {
      files.index = true; resetAnalysisProbe(); content.innerHTML = '';
      let release!: () => void;
      files.gate = new Promise<void>(r => { release = r; });
      state.editMode = 'edit';
      featureLayer = 'osm-substations-polygons-fill'; geometry = { type: 'Polygon', coordinates: [] };
      tap();
      take();
      release(); await settle();
      expect(content.innerHTML).toBe('');
      state.draw = undefined as never; state.measure.active = false;
    }
  });

  it('edit mode probes the files once: without them a polygon is the "can\'t copy" note, a point copies', async () => {
    state.editMode = 'edit';
    featureLayer = 'osm-substations-polygons-fill'; geometry = { type: 'Polygon', coordinates: [] };
    tap();
    await vi.waitFor(() => expect(content.querySelector('.copy-popup-note')).not.toBeNull());
    expect(files.probes).toBeGreaterThan(0);
    expect(content.querySelector('.copy-popup-btn')).toBeNull();
    const n = files.probes;
    featureLayer = 'osm-substations-points-hv'; geometry = { type: 'Point', coordinates: [0, 0] };
    tap();
    await vi.waitFor(() => expect(content.querySelector('.copy-popup-btn')).not.toBeNull());
    expect(files.probes).toBe(n);   // answered: not asked again
  });
});
