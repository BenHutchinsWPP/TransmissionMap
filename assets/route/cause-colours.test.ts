import { describe, it, expect } from 'vitest';
import { ROUTE_PRESETS } from '../../src/registry/route-presets.js';
import { CATEGORY_LABEL_KEYS, routeCategory } from './categories.js';
import { CAUSE_COLOURS, COLOURS, causeColour, hexRgb } from './cause-colours.js';
import { CONSTRAINT_PALETTE } from '../../src/colors/route-constraints.js';

describe('cause colours', () => {
  it('has a hex colour for every entry of the colour table', () => {
    for (const [k, v] of Object.entries(COLOURS)) expect(v, k).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('maps every known category to a hex colour and its label key', () => {
    for (const k of Object.keys(CATEGORY_LABEL_KEYS)) {
      expect(CAUSE_COLOURS[k], k).toBeDefined();
      expect(CAUSE_COLOURS[k].colour, k).toMatch(/^#[0-9a-f]{6}$/i);
      expect(CAUSE_COLOURS[k].labelKey).toBe(CATEGORY_LABEL_KEYS[k]);
    }
  });
  it('covers every preset row category', () => {
    for (const p of ROUTE_PRESETS) for (const r of p.rows) expect(CAUSE_COLOURS[routeCategory(r)], `${p.id} ${r.note}`).toBeDefined();
  });
  it('uses the layer colours for land concerns and greys for OSM, tans for terrain', () => {
    const c = (id: string) => CONSTRAINT_PALETTE.find((x) => x.id === id)!.colour;
    expect(causeColour('flags2:0').colour).toBe(c('phma'));
    expect(causeColour('flags:0').colour).toBe(c('tribal'));
    expect(causeColour('flags2:2').colour).toBe(c('floodplain'));
    for (const k of ['osm_flags:2', 'adj']) { const [r, g, b] = hexRgb(causeColour(k).colour); expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(24); }
    for (const k of ['terrain:slope', 'terrain:landcover']) { const [r, g, b] = hexRgb(causeColour(k).colour); expect(r > g && g > b).toBe(true); }
    expect(causeColour('nope').colour).toBe(causeColour('other').colour);
  });
});
