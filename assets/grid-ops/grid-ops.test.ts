// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HourData, BaHour } from './ba-graph.js';

const HOUR = 3_600_000;
const AT = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);
const fake: HourData = {
  at: AT,
  bas: new Map<string, BaHour>([
    ['BPAT', { load: 100, gen: 150, net: 50, fuels: { hydro: 150 } }],
    ['PGE', { load: 200, gen: 50, net: -150, fuels: { gas: 50 } }],
  ]),
  pairs: [{ ba: 'BPAT', adj: 'PGE', mw: 50 }],
};
vi.mock('./eia930-read.js', () => ({
  hourRange: async () => ({ ok: true, first: AT - 10 * HOUR, last: AT }),
  readHour: async () => ({ ok: true, hour: fake }),
}));

import { state } from '../state.js';
import { setGridView, setGridNumbers, setGridGroup, ringSpec, RING_COLORS, gridShown, onGridPaint } from './grid-ops.js';
import { FUEL_LEGEND } from '../../src/colors/fuel.js';

function fakeMap() {
  const data: Record<string, { features: { properties: Record<string, unknown> }[] }> = {};
  const images = new Set<string>();
  const src = (k: string) => ({ setData: (d: unknown) => { data[k] = d as (typeof data)[string]; } });
  const sources: Record<string, ReturnType<typeof src>> = { 'ba-interchange-nodes': src('nodes'), 'ba-interchange-edges': src('edges') };
  return {
    data, images,
    map: {
      getSource: (id: string) => sources[id],
      getLayer: () => undefined,
      hasImage: (id: string) => images.has(id),
      addImage: (id: string) => { if (images.has(id)) throw new Error('exists'); images.add(id); },
      removeImage: (id: string) => { images.delete(id); },
    },
  };
}
const flush = () => new Promise(r => setTimeout(r, 20));

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    scale() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, closePath() {}, setLineDash() {},
    getImageData: () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  state.gridNumbers = null;
  state.gridGroup = 'ba';
  state.gridGlyph = 'bubble';
});

describe('setGridView numbers', () => {
  it('keeps gridNumbers when the 4th arg is omitted, sets it when given', () => {
    state.gridNumbers = true;
    setGridView(null, 'ba', 'bubble');
    expect(state.gridNumbers).toBe(true);
    setGridView(null, 'ba', 'bubble', false);
    expect(state.gridNumbers).toBe(false);
    setGridView(null, 'ba', 'bubble', null);
    expect(state.gridNumbers).toBeNull();
    setGridView(null, 'ba', 'bubble', undefined);
    expect(state.gridNumbers).toBeNull();
  });
  it('setGridGroup keeps the choice', () => {
    state.gridNumbers = false;
    setGridGroup('region');
    expect(state.gridNumbers).toBe(false);
  });
});

describe('painting', () => {
  async function paintWith(numbers: boolean | null, glyph = 'bubble') {
    const m = fakeMap();
    state.map = m.map as unknown as typeof state.map;
    state.layerVisibility['ba-interchange'] = true;
    setGridView(AT, 'ba', glyph, numbers);
    await flush();
    return m;
  }
  it('has detail lines when numbers are on and none when off; rings painted; listener fires', async () => {
    const seen: unknown[] = [];
    const off = onGridPaint(s => { seen.push(s); throw new Error('listener bug'); });
    let m = await paintWith(true);
    const on = m.data.nodes.features.find((f) => f.properties.id === 'BPAT')?.properties;
    expect(on?.detail).not.toBe('');
    expect(on?.ring).toBe('bai-ring-BPAT');
    expect((on as unknown as { early: boolean }).early).toBe(true);
    expect(m.images.has('bai-ring-BPAT')).toBe(true);
    expect(gridShown()?.nodes.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    m = await paintWith(false);
    expect(m.data.nodes.features.every((f) => f.properties.detail === '')).toBe(true);
    expect(m.data.nodes.features.every((f) => (f.properties as unknown as { early: boolean }).early === false)).toBe(true);
    off();
    state.layerVisibility['ba-interchange'] = false;
  });
  it('setGridNumbers sets state and repaints', async () => {
    const m = await paintWith(true);
    setGridNumbers(false);
    expect(state.gridNumbers).toBe(false);
    expect(m.data.nodes.features.every((f) => f.properties.detail === '')).toBe(true);
    state.layerVisibility['ba-interchange'] = false;
  });
});

describe('ringSpec', () => {
  it('maps cover to a ring', () => {
    expect(ringSpec(null)).toBeNull();
    expect(ringSpec(1)).toEqual({ full: true, frac: 1 });
    expect(ringSpec(1.7)).toEqual({ full: true, frac: 1 });
    expect(ringSpec(0.4)).toEqual({ full: false, frac: 0.4 });
    expect(ringSpec(0)).toEqual({ full: false, frac: 0 });
    expect(ringSpec(-1)).toEqual({ full: false, frac: 0 });
  });
  it('uses colours no fuel uses', () => {
    const fuel = new Set(FUEL_LEGEND.map(f => f.color.toLowerCase()));
    for (const c of RING_COLORS) expect(fuel.has(c)).toBe(false);
  });
});

describe('setGridGroup', () => {
  it('closes an open popup when the grouping changes, and only then', () => {
    const remove = vi.fn();
    state.popup = { remove } as unknown as typeof state.popup;
    state.gridGroup = 'wecc';
    setGridGroup('wecc');
    expect(remove).not.toHaveBeenCalled();
    setGridGroup('ba');
    expect(remove).toHaveBeenCalledTimes(1);
    state.popup = null;
  });
});
