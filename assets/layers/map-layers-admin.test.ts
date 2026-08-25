// @vitest-environment jsdom
// Validates every layer spec the admin-boundary builders produce, plus the
// palette expression they share.
//
// These builders cast paint/layout expressions through
// `as unknown as ExpressionSpecification`, which switches TypeScript off at
// exactly the point it would help. MapLibre then drops a spec that fails to
// type-check without throwing — the polygon renders nothing while its label
// layer still draws — so neither typecheck, lint, nor the browser console
// catches it. Each builder runs against a fake map here and every captured
// layer goes through the real validator.
// Deps: map-layers-admin.ts (five builders + paletteColor), state.ts,
//       @maplibre/maplibre-gl-style-spec.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPropertyExpression, v8, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { state } from '../state.js';
import {
  addCountries, addAdmin1, addUsStates, addUsCounties, addUsZcta, paletteColor,
} from './map-layers-admin.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const feat = (properties: Record<string, unknown>) => ({ type: 'Feature', properties }) as any;

/** Fake map recording what a builder adds, so the specs can be validated. */
function captureMap() {
  const sources: Record<string, unknown> = {};
  const layers: Record<string, any>[] = [];
  return {
    sources, layers,
    addSource: (id: string, src: unknown) => { sources[id] = src; },
    addLayer: (spec: Record<string, any>) => { layers.push(spec); },
    getSource: (id: string) => sources[id],
    getLayer: (id: string) => layers.find(l => l.id === id),
    setFilter: vi.fn(),
    setPaintProperty: vi.fn(),
  };
}

const BUILDERS: [string, () => void][] = [
  ['countries', addCountries], ['admin1', addAdmin1], ['us-states', addUsStates],
  ['us-counties', addUsCounties], ['us-zcta', addUsZcta],
];

describe.each(BUILDERS)('%s layers', (_name, build) => {
  let map: ReturnType<typeof captureMap>;

  beforeEach(() => {
    map = captureMap();
    state.map = map as unknown as typeof state.map;
    build();
  });

  it('passes the MapLibre style validator', () => {
    expect(map.layers.length).toBeGreaterThan(0);
    // Sources become empty GeoJSON stand-ins: the validator would otherwise try
    // to resolve a pmtiles:// URL, and source wiring is not what a cast breaks.
    // `source-layer` goes with them, since it is only legal on a vector source.
    const style = {
      version: 8,
      glyphs: 'https://example.invalid/{fontstack}/{range}.pbf',
      sources: Object.fromEntries(Object.keys(map.sources).map(id =>
        [id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }])),
      layers: map.layers.map((l) => {
        const rest: Record<string, any> = { ...l };
        delete rest['source-layer'];
        return rest;
      }),
    };
    expect(validateStyleMin(style as never).map(e => e.message)).toEqual([]);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('paletteColor', () => {
  const parse = (prop: 'fill-color' | 'line-color') => createPropertyExpression(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    paletteColor('color_idx') as any, prop,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((prop === 'fill-color' ? v8.paint_fill : v8.paint_line) as any)[prop]);

  it('keeps the index inside the palette for any code', () => {
    const r = parse('fill-color');
    if (r.result === 'error') throw new Error('expression failed to parse');
    // An `at` index past the end of the array throws, so the modulo has to hold
    // for a five-digit ZCTA and for an absent property (to-number falls back to 0).
    for (const props of [{ color_idx: 8072 }, { color_idx: 0 }, {}]) {
      expect(() => r.value.evaluate({ zoom: 5 }, feat(props))).not.toThrow();
    }
  });
});
