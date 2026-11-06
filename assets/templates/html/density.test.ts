import { describe, it, expect } from 'vitest';
import { frame, settle, source, type Loose } from './template-fakes.js';

const CODE = source('density.js');

const pt = (x: number, y: number, props: Record<string, unknown>) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: props });

function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1, template: 'density', params: { measure: 'capacity_mw', top: 10 }, scope: 'area',
    rows: [{ count: 3, sum: 750 }],
    features: [
      pt(-100, 40, { plant_name: 'Alpha', capacity_mw: 500 }),
      pt(-99, 41, { plant_name: 'Beta', capacity_mw: 200 }),
      pt(-98, 42, { plant_name: 'Gamma', capacity_mw: 50 }),
    ],
    roles: { by: [], measure: { name: 'capacity_mw', unit: 'MW' } },
    colours: {}, labels: { title: 'Density', locale: 'en-US', measure: 'Capacity (MW)', count: 'Count' },
    credit: 'EIA', units: {}, complete: true, truncated: false, theme: 'light', ...over,
  };
}

async function shown(over: Record<string, unknown> = {}, opts = {}) {
  const f = frame(CODE, payload(over), opts);
  await settle();
  const map = f.map();
  map.fire('load');
  const overlay = f.overlays[0];
  return { ...f, map, overlay, layer: () => overlay.props.layers[0] };
}

const txt = (s: string) => s.replace(/\u00a0/g, ' ');
const press = (doc: Loose, text: string) => {
  const b = [...doc.querySelectorAll('.dn-seg button')].find((x: Loose) => x.textContent === text) as Loose;
  b.click();
  return b;
};

describe('density template', () => {
  it('draws 3D hexagons weighted by the measure, inside the map', async () => {
    const { map, overlay, layer, sink } = await shown();
    expect(overlay.props.interleaved).toBe(true);
    expect(map.controls).toContain(overlay);
    expect(layer().constructor.name).toBe('HexagonLayer');
    const L = layer().props;
    expect(L.extruded).toBe(true);
    expect(L.getColorWeight({ w: 500 })).toBe(500);
    expect(L.radius).toBeGreaterThan(150);
    expect(map.opts.canvasContextAttributes.preserveDrawingBuffer).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });

  it('switches to 2D heat and flattens the camera, and to count', async () => {
    const { doc, map, layer } = await shown();
    press(doc, '2D heat');
    expect(layer().constructor.name).toBe('HeatmapLayer');
    expect(map.camera.at(-1).ease).toMatchObject({ pitch: 0, bearing: 0 });
    expect(doc.querySelector('.dn-ends').textContent).toBe('LowHigh');
    press(doc, 'Count');
    expect(layer().props.getWeight({ w: 500 })).toBe(1);
    press(doc, '3D hex');
    expect(layer().constructor.name).toBe('HexagonLayer');
    expect(layer().props.getColorWeight({ w: 500 })).toBe(1);
    expect(map.camera.at(-1).ease).toMatchObject({ pitch: 50 });
  });

  it('puts count, sum and the largest feature in the hexagon tooltip, as text', async () => {
    const { doc, layer } = await shown();
    layer().props.onHover({ object: { pointIndices: [1, 0] }, x: 20, y: 30 });
    const tip = doc.querySelector('.dn-tip');
    expect(tip.hidden).toBe(false);
    expect(txt(tip.textContent)).toBe('Count: 2Capacity (MW): 700 MWLargest: Alpha');
    layer().props.onHover({ object: null });
    expect(tip.hidden).toBe(true);
  });

  it('a column click offers Select (its ids, ≤ 500), Table and Zoom (its bbox)', async () => {
    const features = payload().features.map((f, i) => ({ ...f, id: `g${i}` }));
    const { doc, layer, TM } = await shown({ features });
    layer().props.onClick({ object: { pointIndices: [0, 2] }, x: 5, y: 5 });
    const items = [...doc.querySelectorAll('.kit-menu button')] as Loose[];
    expect(items.map(b => b.textContent)).toEqual(['Select on the map (2)', 'Show in table', 'Zoom the map here']);
    items[0].click();
    expect(TM.action).toHaveBeenLastCalledWith('select', { ids: ['g0', 'g2'] });
    layer().props.onClick({ object: { pointIndices: [0, 2] }, x: 5, y: 5 });
    (doc.querySelectorAll('.kit-menu button')[2] as Loose).click();
    expect(TM.action).toHaveBeenLastCalledWith('fly', { bbox: [-100, 40, -98, 42] });
  });

  it('the "Densest area: actions" button opens the same menu from the keyboard, for the densest cell', async () => {
    const features = [
      pt(-100, 40, { capacity_mw: 5 }), pt(-100.0001, 40.0001, { capacity_mw: 6 }), pt(-90, 30, { capacity_mw: 1 }),
    ].map((f, i) => ({ ...f, id: `g${i}` }));
    const { doc, map, TM } = await shown({ features });
    // Two features share a screen cell; the third is far away.
    (map as Loose).project = (c: number[]) => ({ x: (c[0] + 180) * 100, y: (c[1] + 90) * 100 });
    const btn = [...doc.querySelectorAll('.dn-seg button')].find((b: Loose) => b.textContent === 'Densest area: actions') as Loose;
    expect(btn.hasAttribute('aria-pressed')).toBe(false);
    btn.click();
    const items = [...doc.querySelectorAll('.kit-menu button')] as Loose[];
    expect(items.map(b => b.textContent)).toEqual(['Select on the map (2)', 'Show in table', 'Zoom the map here']);
    items[0].click();
    expect(TM.action).toHaveBeenLastCalledWith('select', { ids: ['g0', 'g1'] });
  });

  it('offers only Zoom for a column whose features carry no id', async () => {
    const { doc, layer } = await shown();
    layer().props.onClick({ object: { pointIndices: [0, 1] }, x: 5, y: 5 });
    expect([...doc.querySelectorAll('.kit-menu button')].map((b: Loose) => b.textContent)).toEqual(['Zoom the map here']);
  });

  it('shows the colour domain in the legend', async () => {
    const { doc, layer } = await shown();
    layer().props.onSetColorDomain([50, 700]);
    expect(doc.querySelector('.dn-leg b').textContent).toBe('Capacity (MW)');
    expect(txt(doc.querySelector('.dn-ends').textContent)).toBe('50 MW700 MW');
  });

  it('counts when the layer has no measure, with no metric toggle', async () => {
    const { doc, layer } = await shown({
      roles: { by: [], measure: { name: 'count' } }, rows: [{ count: 3 }],
      features: [pt(0, 0, { name: 'a' }), pt(1, 1, { name: 'b' })],
    });
    expect(layer().props.getColorWeight({ w: 9 })).toBe(1);
    expect([...doc.querySelectorAll('.dn-seg button')].map((b: Loose) => b.textContent)).toEqual(['3D hex', '2D heat', 'Orbit', 'Densest area: actions']);
    layer().props.onHover({ object: { pointIndices: [0] }, x: 0, y: 0 });
    expect(doc.querySelector('.dn-tip').textContent).toBe('Count: 1');
  });

  it('never moves the camera by itself under reduced motion', async () => {
    const { doc, map } = await shown({}, { reducedMotion: true });
    expect([...doc.querySelectorAll('.dn-seg button')].some((b: Loose) => b.textContent === 'Orbit')).toBe(false);
    map.fire('idle');
    expect(map.camera.some((c: Loose) => c.ease)).toBe(false);
    expect(map.camera.at(-1).jump).toMatchObject({ pitch: 50 });
  });

  it('says drawn after deck rendered and the map is idle', async () => {
    const { TM, map, overlay } = await shown();
    overlay.props.onAfterRender();
    expect(TM.drawn).not.toHaveBeenCalled();
    map.fire('idle');
    expect(TM.drawn).toHaveBeenCalledTimes(1);
  });
});
