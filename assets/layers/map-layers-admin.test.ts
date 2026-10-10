// @vitest-environment jsdom
// Validates every layer spec the admin-boundary builders produce, plus the
// palette expression they share.
//
// These builders cast paint/layout expressions through
// `as unknown as ExpressionSpecification`, which switches TypeScript off at
// exactly the point it would help. MapLibre then drops a spec that fails to
// type-check without throwing — the polygon renders nothing while its label
// layer still draws — so neither typecheck, lint, nor the browser console
// catches it. Every layer each builder's plan holds goes through the real
// validator here.
// Deps: map-layers-admin.ts (five builders + paletteColor),
//       @maplibre/maplibre-gl-style-spec.
import { describe, expect, it } from 'vitest';
import { createPropertyExpression, v8, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import {
  planCountries, planAdmin1, planUsStates, planUsCounties, planUsZcta, paletteColor,
} from './map-layers-admin.js';
import type { LayerPlan } from './layer-plan.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const feat = (properties: Record<string, unknown>) => ({ type: 'Feature', properties }) as any;

const BUILDERS: [string, () => LayerPlan][] = [
  ['countries', planCountries], ['admin1', planAdmin1], ['us-states', planUsStates],
  ['us-counties', planUsCounties], ['us-zcta', planUsZcta],
];

describe.each(BUILDERS)('%s layers', (_name, build) => {
  const plan = build();
  const sources = plan.flatMap(s => ('source' in s ? [s.source] : []));
  const layers = plan.flatMap(s => ('layer' in s ? [s.layer as Record<string, any>] : []));

  it('passes the MapLibre style validator', () => {
    expect(layers.length).toBeGreaterThan(0);
    // Sources become empty GeoJSON stand-ins: the validator would otherwise try
    // to resolve a pmtiles:// URL, and source wiring is not what a cast breaks.
    // `source-layer` goes with them, since it is only legal on a vector source.
    const style = {
      version: 8,
      glyphs: 'https://example.invalid/{fontstack}/{range}.pbf',
      sources: Object.fromEntries(sources.map(id =>
        [id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }])),
      layers: layers.map((l) => {
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
