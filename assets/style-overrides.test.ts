// @vitest-environment jsdom
// Style overrides on a recording fake map built by the real layer builders:
// every scaled size/opacity validates against the MapLibre style spec (F4),
// overrides survive the colour-by appliers and the weather crossfade (F1),
// clearing restores exact baselines, and rejections carry their reason.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';
import { createPropertyExpression, latest, type StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';
import { state } from './state.js';
import { addAllLayers } from './layers/add-all-layers.js';
import { LAYERS, layerById } from '../src/registry/index.js';
import { ogfColorExpr, westtecColorExpr } from '../src/colors/buckets.js';
import { setStyle, clearStyle, applyAllStyles, listStylable, scaleBy, effectiveOverride, setColorBy } from './style-overrides.js';
import { validateStyleOverride } from '../src/registry/view-validate.js';
import { initPolygonHover, initLineHighlight, highlightLine } from './hover.js';
import { crossfadeOpacities, initWeatherLive } from './weather-live.js';
import { WEATHER_WASH_OPACITY } from './constants.js';
import { parseUrlState } from './url-state-codec.js';

type Spec = LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown> };

function recordingMap() {
  const layers = new Map<string, Spec>();
  const sources = new Set<string>();
  const known: Record<string, unknown> = {
    addLayer: (spec: Spec) => { layers.set(spec.id, structuredClone(spec)); },
    addSource: (id: string) => { sources.add(id); },
    getLayer: (id: string) => layers.get(id),
    getSource: (id: string) => (sources.has(id) ? {} : undefined),
    getZoom: () => 0,
    getContainer: () => document.createElement('div'),
    getPaintProperty: (id: string, p: string) => layers.get(id)?.paint?.[p],
    getLayoutProperty: (id: string, p: string) => layers.get(id)?.layout?.[p],
    setPaintProperty: vi.fn((id: string, p: string, v: unknown) => {
      const l = layers.get(id)!;
      l.paint = { ...l.paint, [p]: v };
      if (v === undefined) delete l.paint[p];
    }),
    setLayoutProperty: vi.fn((id: string, p: string, v: unknown) => {
      const l = layers.get(id)!;
      l.layout = { ...l.layout, [p]: v };
      if (v === undefined) delete l.layout[p];
    }),
  };
  const map = new Proxy(known, { get: (t, k: string) => t[k] ?? vi.fn() });
  state.map = map as unknown as typeof state.map;
  state.mapReady = true;
  addAllLayers();
  return { layers, known };
}

const snapshot = (layers: Map<string, Spec>) =>
  structuredClone([...layers.values()].map(l => ({ id: l.id, paint: l.paint ?? {}, layout: l.layout ?? {} })));

beforeEach(() => {
  state.styleOverrides = {};
  state.ogfColorBy = 'status';
  state.westtecColorBy = 'scenario';
});

// ─── F4: every scaled baseline is a valid MapLibre value ──────────────────────
const SCALED: Record<string, string[]> = {
  circle: ['circle-opacity', 'circle-stroke-opacity', 'circle-radius'],
  line: ['line-opacity', 'line-width'],
  fill: ['fill-opacity'],
  symbol: ['icon-opacity', 'text-opacity', 'icon-size', 'text-size'],
  raster: ['raster-opacity'],
  heatmap: ['heatmap-opacity'],
  'fill-extrusion': ['fill-extrusion-opacity'],
};

function specFor(type: string, prop: string): StylePropertySpecification {
  const ref = latest as unknown as Record<string, Record<string, StylePropertySpecification>>;
  return ref[`paint_${type}`]?.[prop] ?? ref[`layout_${type}`][prop];
}

function validate(type: string, prop: string, value: unknown): string | null {
  const r = createPropertyExpression(value, prop, specFor(type, prop));
  return r.result === 'success' ? null : r.value.map(e => e.message).join('; ');
}

describe('scaled sizes and opacities validate (F4)', () => {
  const { layers } = recordingMap();

  it('the validator rejects zoom nested inside "*"', () => {
    const zoomed = ['interpolate', ['linear'], ['zoom'], 4, 1, 12, 3];
    expect(validate('line', 'line-width', ['*', 2, zoomed])).not.toBeNull();
    expect(validate('line', 'line-width', scaleBy(zoomed, 2))).toBeNull();
  });

  it('every registry layer × accepted size/opacity property, at k = 2 and 0.5', () => {
    const failures: string[] = [];
    let checked = 0, expressions = 0;
    for (const l of LAYERS) {
      for (const mlId of l.mapLayerIds) {
        const spec = layers.get(mlId);
        if (!spec) continue;
        for (const prop of SCALED[spec.type] ?? []) {
          const isLayout = prop === 'icon-size' || prop === 'text-size';
          const base = (isLayout ? spec.layout : spec.paint)?.[prop] ?? specFor(spec.type, prop).default;
          if (Array.isArray(base)) expressions++;
          for (const k of [2, 0.5]) {
            const scaled = scaleBy(base, k);
            if (Array.isArray(base) || (typeof base === 'number' && base !== 0)) expect(scaled).not.toEqual(base);
            const err = validate(spec.type, prop, scaled);
            if (err) failures.push(`${mlId} ${prop} ×${k}: ${err}`);
            checked++;
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(500);
    expect(expressions).toBeGreaterThan(80);
  });
});

describe('scaleBy', () => {
  it('multiplies literals, rewrites zoom stop outputs, wraps other expressions', () => {
    expect(scaleBy(2, 1.5)).toBe(3);
    expect(scaleBy(['interpolate', ['linear'], ['zoom'], 4, 1, 12, ['get', 'w']], 2))
      .toEqual(['interpolate', ['linear'], ['zoom'], 4, 2, 12, ['*', 2, ['get', 'w']]]);
    expect(scaleBy(['step', ['zoom'], 1, 8, 2], 3)).toEqual(['step', ['zoom'], 3, 8, 6]);
    const fade = ['case', ['<', ['get', 'kv'], 200], 0.5, 1];
    expect(scaleBy(fade, 0.5)).toEqual(['*', 0.5, fade]);
  });
});

// ─── setStyle / clearStyle / applyAllStyles ───────────────────────────────────
describe('setStyle', () => {
  it('scales every map layer of a registry layer and restores exact baselines', () => {
    const { layers } = recordingMap();
    const before = snapshot(layers);
    expect(setStyle('osm-transmission-lines', { size: 2, opacity: 0.5, color: '#123456' })).toBeNull();
    const lv = layers.get('osm-transmission-lines-kv100-hv')!;
    expect(lv.paint!['line-color']).toBe('#123456');
    const beforeLv = before.find(l => l.id === 'osm-transmission-lines-kv100-hv')!;
    expect(lv.paint!['line-opacity']).toEqual(scaleBy(beforeLv.paint!['line-opacity'], 0.5));
    const label = layers.get('osm-transmission-lines-label')!;
    expect(label.paint!['text-color']).toEqual(before.find(l => l.id === label.id)!.paint!['text-color']);

    clearStyle('osm-transmission-lines');
    expect(snapshot(layers)).toEqual(before);
  });

  it('every stylable layer, everything set, then clearStyle() → the builders\' map', () => {
    const { layers } = recordingMap();
    applyAllStyles();
    const before = snapshot(layers);
    const all = listStylable();
    expect(all.length).toBeGreaterThan(40);
    for (const { id, accepts } of all) {
      const o = Object.fromEntries(accepts.map(k => [k, { opacity: 0.5, size: 2, color: '#abc' }[k]]));
      expect(setStyle(id, o)).toBeNull();
    }
    expect(snapshot(layers)).not.toEqual(before);
    clearStyle();
    expect(state.styleOverrides).toEqual({});
    expect(snapshot(layers)).toEqual(before);
  });

  it('applyAllStyles() after state is emptied leaves no override on the map', () => {
    const { layers } = recordingMap();
    const before = snapshot(layers);
    setStyle('eia-generators', { size: 0.5, opacity: 0.4 });
    setStyle('padus', { color: 'rgb(10, 20, 30)' });
    setStyle('weather-live', { opacity: 0.5 });
    state.styleOverrides = {};
    applyAllStyles();
    expect(snapshot(layers)).toEqual(before);
  });

  it('applyAllStyles() paints overrides written straight into state', () => {
    const { layers } = recordingMap();
    state.styleOverrides = { railroads: { color: '#ff0000' } };
    applyAllStyles();
    expect(layers.get('railroads')!.paint!['line-color']).toBe('#ff0000');
  });

  it('an empty override deletes the key', () => {
    recordingMap();
    setStyle('railroads', { opacity: 0.5 });
    expect(setStyle('railroads', {})).toBeNull();
    expect('railroads' in state.styleOverrides).toBe(false);
  });
});

describe('rejections', () => {
  it.each([
    ['osm-generators', { color: '#ff0000' }, 'takes no color'],
    ['wildfire-smoke', { opacity: 0.5 }, 'smoke opacity slider'],
    ['railroads', { color: 'red' }, 'color must be #rgb'],
    ['railroads', { color: ['get', 'colour'] }, 'color must be #rgb'],
    ['railroads', { color: 'rgb(300, 0, 0)' }, 'color must be #rgb'],
    ['railroads', { opacity: 1.5 }, 'opacity must be a number from 0 to 1'],
    ['railroads', { size: 5 }, 'size must be a multiplier from 0.25 to 4'],
    ['railroads', { size: 0.1 }, 'size must be a multiplier from 0.25 to 4'],
    ['railroads', { width: 2 }, 'unknown style property "width"'],
    ['nope', { opacity: 0.5 }, '"nope" is not a layer id'],
    ['nlr-wind-100m', { size: 2 }, 'has no map layer that takes size'],
    ['weather-live', { size: 2 }, 'takes opacity only'],
    ['weather-live', { color: '#fff' }, 'takes opacity only'],
  ])('%s %j → %s', (id, o, reason) => {
    const { known } = recordingMap();
    state.styleOverrides = { railroads: { opacity: 0.3 } };
    const err = setStyle(id, o as never);
    expect(err).toContain(reason);
    expect(state.styleOverrides).toEqual({ railroads: { opacity: 0.3 } });
    expect(known.setPaintProperty).not.toHaveBeenCalled();
    expect(known.setLayoutProperty).not.toHaveBeenCalled();
  });

  it('listStylable: symbols take no colour, smoke takes no opacity', () => {
    recordingMap();
    const by = Object.fromEntries(listStylable().map(l => [l.id, l.accepts]));
    expect(by['osm-generators']).toEqual(['opacity', 'size']);
    expect(by['wildfire-smoke']).toEqual(['size', 'color']);
    expect(by['nlr-wind-100m']).toEqual(['opacity']);
    expect(by['osm-transmission-lines']).toEqual(['opacity', 'size', 'color']);
    expect(by['weather-live']).toEqual(['opacity']);
  });
});

describe('validateStyleOverride (map-free)', () => {
  it('needs no map and returns reasons', () => {
    state.map = null;
    expect(validateStyleOverride('railroads', { opacity: 0.5, size: 2, color: '#fff' })).toBeNull();
    expect(validateStyleOverride('nope', {})).toContain('not a layer id');
    expect(validateStyleOverride('railroads', { opacity: 2 })).toContain('opacity');
    expect(validateStyleOverride('wildfire-smoke', { opacity: 0.5 })).toContain('smoke opacity slider');
    expect(validateStyleOverride('railroads', null)).toContain('object');
  });

  it('rejects an own __proto__ key and a __proto__ id', () => {
    const o = JSON.parse('{"__proto__":{"opacity":1}}');
    expect(validateStyleOverride('railroads', o)).toContain('unknown style property');
    expect(validateStyleOverride('__proto__', {})).toContain('not a layer id');
  });

  it('effectiveOverride keeps only valid keys', () => {
    state.styleOverrides = { railroads: { opacity: 2, size: 2, color: 'red' } as never };
    expect(effectiveOverride('railroads')).toEqual({ size: 2 });
    state.styleOverrides = { 'weather-live': { opacity: 0.5, size: 2 } };
    expect(effectiveOverride('weather-live')).toEqual({ opacity: 0.5 });
    expect(effectiveOverride('__proto__')).toEqual({});
  });
});

describe('from-state apply strips only the unsupported keys', () => {
  it('paints opacity, skips colour, and reports it', () => {
    const { layers } = recordingMap();
    const base = snapshot(layers).find(l => l.id === 'osm-gen-circles')!;
    state.styleOverrides = { 'osm-generators': { opacity: 0.5, color: '#f00' } };
    const dropped = applyAllStyles();
    expect(dropped).toEqual([{ id: 'osm-generators', key: 'color', reason: expect.stringContaining('takes no color') }]);
    const cur = layers.get('osm-gen-circles')!;
    expect(cur.paint).not.toEqual(base.paint);
    expect(cur.paint!['icon-opacity']).toEqual(scaleBy(base.paint['icon-opacity'] ?? 1, 0.5));
  });

  it('reports invalid values and unknown keys', () => {
    recordingMap();
    state.styleOverrides = { railroads: { opacity: 3, width: 1, size: 2 } as never };
    const keys = applyAllStyles().map(d => d.key).sort();
    expect(keys).toEqual(['opacity', 'width']);
    expect(layerById('railroads')).toBeDefined();
  });
});

describe('casing layers keep their colour', () => {
  it.each([['ogf-planned-transmission', 'ogf-planned-lines-casing', 'ogf-planned-lines'],
    ['westtec-10yr', 'westtec-lines-casing', 'westtec-lines']])('%s', (id, casing, core) => {
    const { layers } = recordingMap();
    const before = snapshot(layers).find(l => l.id === casing)!;
    expect(setStyle(id, { color: '#ff0000', size: 2, opacity: 0.5 })).toBeNull();
    expect(layers.get(core)!.paint!['line-color']).toBe('#ff0000');
    expect(layers.get(casing)!.paint!['line-color']).toEqual(before.paint['line-color']);
    expect(layers.get(casing)!.paint!['line-width']).not.toEqual(before.paint['line-width']);
  });
});

describe('hover twins follow the size override', () => {
  it('a line highlight shown after a size override uses scaled widths', () => {
    const { layers } = recordingMap();
    state.map!.getStyle = (() => ({ layers: [...layers.values()] })) as never;
    initPolygonHover();
    initLineHighlight();
    const [mlId] = LAYERS.find(l => l.lineHighlightKeys)!.mapLayerIds.filter(id => layers.get(id)?.type === 'line');
    const lh = LAYERS.find(l => l.lineHighlightKeys)!;
    const props = Object.fromEntries(lh.lineHighlightKeys!.map(k => [k, 'x']));
    setStyle(lh.id, { size: 2 });
    expect(highlightLine(mlId, props)).toBe(true);
    const hl = [...layers.values()].find(l => l.id.endsWith('-line-hl') && l.layout?.visibility === 'visible')!;
    expect(hl.paint!['line-width']).toBe(5);
    expect(hl.paint!['line-gap-width']).toEqual(['interpolate', ['linear'], ['zoom'], 4, 3, 12, 8]);
  });
});

// ─── F1 writers ───────────────────────────────────────────────────────────────
describe('colour-by writers fold the override in', () => {
  it('OGF: override survives setColorBy; clearing returns the current colour-by', () => {
    const { layers } = recordingMap();
    const color = () => layers.get('ogf-planned-lines')!.paint!['line-color'];
    expect(setStyle('ogf-planned-transmission', { color: '#00ff00' })).toBeNull();
    expect(color()).toBe('#00ff00');
    expect(setColorBy('ogf-planned-transmission', 'region')).toBeNull();
    expect(color()).toBe('#00ff00');
    clearStyle('ogf-planned-transmission');
    expect(color()).toEqual(ogfColorExpr('region'));
  });

  it('WestTEC: same contract', () => {
    const { layers } = recordingMap();
    const color = () => layers.get('westtec-lines')!.paint!['line-color'];
    setStyle('westtec-10yr', { color: '#0000ff', size: 2 });
    setColorBy('westtec-10yr', 'dataset');
    expect(color()).toBe('#0000ff');
    clearStyle();
    expect(color()).toEqual(westtecColorExpr('dataset'));
  });
});

describe('setColorBy', () => {
  it('repaints the lines for the new mode', () => {
    const { layers } = recordingMap();
    expect(setColorBy('ogf-planned-transmission', 'region')).toBeNull();
    expect(state.ogfColorBy).toBe('region');
    expect(layers.get('ogf-planned-lines')!.paint!['line-color']).toEqual(ogfColorExpr('region'));
  });

  it('rejects an unknown mode or layer, leaving state and map untouched', () => {
    const { layers, known } = recordingMap();
    const before = snapshot(layers);
    (known.setPaintProperty as ReturnType<typeof vi.fn>).mockClear();
    expect(setColorBy('ogf-planned-transmission', 'bogus')).toMatch(/bogus/);
    expect(setColorBy('westtec-10yr', 'region')).toMatch(/region/);
    expect(setColorBy('osm-transmission-lines', 'region')).toMatch(/no colour-by/);
    expect(setColorBy('toString', 'region')).toMatch(/no colour-by/);
    expect(state.ogfColorBy).toBe('status');
    expect(state.westtecColorBy).toBe('scenario');
    expect(known.setPaintProperty).not.toHaveBeenCalled();
    expect(snapshot(layers)).toEqual(before);
  });

  it('accepts every mode a link can carry', () => {
    recordingMap();
    const chars = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
    const decoded = (param: string, field: 'ogfColorBy' | 'westtecColorBy') =>
      chars.map(c => parseUrlState(new URLSearchParams({ [param]: c }))[field]).filter(m => m !== undefined);
    const ogf = decoded('oc', 'ogfColorBy'), westtec = decoded('wc', 'westtecColorBy');
    expect(ogf.length).toBeGreaterThan(1);
    expect(westtec.length).toBeGreaterThan(1);
    for (const m of ogf) expect(setColorBy('ogf-planned-transmission', m)).toBeNull();
    for (const m of westtec) expect(setColorBy('westtec-10yr', m)).toBeNull();
  });

  it('writes state before the map exists', () => {
    state.map = null;
    state.mapReady = false;
    expect(setColorBy('westtec-10yr', 'dataset')).toBeNull();
    expect(state.westtecColorBy).toBe('dataset');
  });

  it('applyAllStyles repaints the colour-by from state', () => {
    const { layers } = recordingMap();
    state.ogfColorBy = 'region';
    state.westtecColorBy = 'dataset';
    applyAllStyles();
    expect(layers.get('ogf-planned-lines')!.paint!['line-color']).toEqual(ogfColorExpr('region'));
    expect(layers.get('westtec-lines')!.paint!['line-color']).toEqual(westtecColorExpr('dataset'));
  });
});

describe('weather crossfade folds the opacity multiplier in (R5)', () => {
  const coverage = ([a, b]: [number, number]) => 1 - (1 - a) * (1 - b);
  let wired = false;
  beforeEach(() => { if (!wired) { recordingMap(); initWeatherLive(); wired = true; } });

  it('every crossfade frame keeps combined opacity at W·k', () => {
    recordingMap();
    setStyle('weather-live', { opacity: 0.5 });
    for (const t of [0, 0.25, 0.5, 0.9, 1]) {
      expect(coverage(crossfadeOpacities(t))).toBeCloseTo(WEATHER_WASH_OPACITY * 0.5, 10);
    }
    clearStyle('weather-live');
    expect(coverage(crossfadeOpacities(0.5))).toBeCloseTo(WEATHER_WASH_OPACITY, 10);
  });

  it('setStyle repaints the settled pair; clearing restores W', () => {
    const { layers } = recordingMap();
    const op = (id: string) => layers.get(id)!.paint!['raster-opacity'];
    setStyle('weather-live', { opacity: 0.5 });
    expect(op('weather-live')).toBeCloseTo(WEATHER_WASH_OPACITY * 0.5, 10);
    expect(op('weather-live-b')).toBe(0);
    clearStyle('weather-live');
    expect(op('weather-live')).toBe(WEATHER_WASH_OPACITY);
  });
});

describe('weather opacity fades the whole layer', () => {
  const BORDERS = ['weather-admin-lines-states', 'weather-admin-lines-countries'];

  it('scales the border lines, bars size/colour, and restores baselines exactly', () => {
    const { layers } = recordingMap();
    const before = snapshot(layers);
    const op = (id: string) => layers.get(id)!.paint!['line-opacity'];
    const base = BORDERS.map(op);
    expect(setStyle('weather-live', { opacity: 0.5 })).toBeNull();
    BORDERS.forEach((id, i) => expect(op(id)).toEqual(scaleBy(base[i] ?? 1, 0.5)));
    expect(setStyle('weather-live', { size: 2 })).not.toBeNull();
    expect(setStyle('weather-live', { color: '#ff0000' })).not.toBeNull();
    clearStyle('weather-live');
    expect(snapshot(layers)).toEqual(before);
  });
});

it('every registry id named in this file exists', () => {
  for (const id of ['osm-transmission-lines', 'ogf-planned-transmission', 'westtec-10yr', 'weather-live',
    'wildfire-smoke', 'osm-generators', 'railroads', 'padus', 'eia-generators', 'nlr-wind-100m']) {
    expect(layerById(id), id).toBeDefined();
  }
});
